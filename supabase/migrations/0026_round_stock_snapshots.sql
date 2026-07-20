-- A closed round is a historical view. Capture the day-wide stock position at
-- the instant the round closes so later movements in the same service date do
-- not rewrite what users see for that round.

create table public.round_stock_snapshots (
  round_id uuid primary key references public.delivery_rounds(id) on delete cascade,
  service_date date not null,
  captured_by uuid not null references public.users(id),
  captured_at timestamptz not null
);

create table public.round_stock_snapshot_items (
  round_id uuid not null references public.round_stock_snapshots(round_id) on delete cascade,
  location_id uuid not null references public.stock_locations(id),
  location_code_snapshot text not null,
  location_name_snapshot text not null,
  location_kind_snapshot public.stock_location_kind not null,
  ice_type_id uuid not null references public.ice_types(id),
  ice_type_name_snapshot text not null,
  unit_snapshot text not null,
  quantity integer not null,
  primary key (round_id, location_id, ice_type_id)
);

create index round_stock_snapshots_service_date_idx
  on public.round_stock_snapshots (service_date, captured_at desc);

alter table public.round_stock_snapshots enable row level security;
alter table public.round_stock_snapshot_items enable row level security;

create policy "admins or leads read round stock snapshots"
  on public.round_stock_snapshots for select
  using (public.current_app_role() in ('admin', 'round_lead'));

create policy "admins or leads read round stock snapshot items"
  on public.round_stock_snapshot_items for select
  using (public.current_app_role() in ('admin', 'round_lead'));

-- Used only to backfill rounds that were closed before this migration. The
-- cancellation timestamps preserve records that were still active at close.
create function public.stock_balance_at_moment(
  p_service_date date,
  p_location_id uuid,
  p_ice_type_id uuid,
  p_captured_at timestamptz
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  with movement_totals as (
    select
      coalesce(sum(item.quantity) filter (where movement.to_location_id = p_location_id), 0)
        - coalesce(sum(item.quantity) filter (where movement.from_location_id = p_location_id), 0)
        as quantity
    from public.stock_movements movement
    join public.stock_movement_items item on item.movement_id = movement.id
    where movement.service_date = p_service_date
      and movement.recorded_at <= p_captured_at
      and (movement.status = 'active' or movement.cancelled_at > p_captured_at)
      and item.ice_type_id = p_ice_type_id
      and (movement.from_location_id = p_location_id or movement.to_location_id = p_location_id)
  ), delivery_totals as (
    select coalesce(sum(item.quantity), 0) as quantity
    from public.delivery_events event
    join public.delivery_items item on item.delivery_event_id = event.id
    join public.round_stops stop on stop.id = event.round_stop_id
    join public.delivery_rounds round on round.id = stop.round_id
    where round.service_date = p_service_date
      and event.recorded_at <= p_captured_at
      and (event.status = 'active' or event.cancelled_at > p_captured_at)
      and event.source_stock_location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
  )
  select (movement_totals.quantity - delivery_totals.quantity)::integer
  from movement_totals, delivery_totals;
$$;

insert into public.round_stock_snapshots (
  round_id, service_date, captured_by, captured_at
)
select
  round.id,
  round.service_date,
  coalesce(summary.captured_by, round.closed_by),
  coalesce(summary.captured_at, round.closed_at)
from public.delivery_rounds round
left join public.round_close_summaries summary on summary.round_id = round.id
where round.status = 'closed'
  and round.closed_by is not null
  and round.closed_at is not null
on conflict (round_id) do nothing;

insert into public.round_stock_snapshot_items (
  round_id,
  location_id,
  location_code_snapshot,
  location_name_snapshot,
  location_kind_snapshot,
  ice_type_id,
  ice_type_name_snapshot,
  unit_snapshot,
  quantity
)
select
  snapshot.round_id,
  location.id,
  location.code,
  location.name,
  location.kind,
  ice.id,
  ice.name,
  ice.unit,
  public.stock_balance_at_moment(
    snapshot.service_date,
    location.id,
    ice.id,
    snapshot.captured_at
  )
from public.round_stock_snapshots snapshot
cross join public.stock_locations location
cross join public.ice_types ice
on conflict (round_id, location_id, ice_type_id) do nothing;

revoke all on function public.stock_balance_at_moment(date, uuid, uuid, timestamptz) from public;

-- Transaction-start timestamps can sort a write before a snapshot even when the
-- write waited for the service-date lock and committed afterward. Stamp ledger
-- changes at the actual insert/cancellation statement instead.
create or replace function public.stamp_stock_ledger_effective_time()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.recorded_at := clock_timestamp();
  elsif new.status = 'cancelled' and old.status is distinct from new.status then
    new.cancelled_at := clock_timestamp();
  end if;

  return new;
end;
$$;

create trigger stock_movements_stamp_effective_time
before insert or update of status on public.stock_movements
for each row execute function public.stamp_stock_ledger_effective_time();

create trigger delivery_events_stamp_effective_time
before insert or update of status on public.delivery_events
for each row execute function public.stamp_stock_ledger_effective_time();

create or replace function public.close_delivery_round(
  p_round_id uuid,
  p_ice_counts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.delivery_round_status;
  v_service_date date;
  v_captured_at timestamptz;
  v_total integer;
  v_delivered integer;
  v_pending integer;
  v_problem integer;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can close a delivery round';
  end if;

  if jsonb_typeof(p_ice_counts) is distinct from 'array' then
    raise exception 'Ice counts must be a JSON array';
  end if;

  select status, service_date into v_status, v_service_date
  from public.delivery_rounds
  where id = p_round_id
  for update;

  if v_status is null then
    raise exception 'The selected delivery round does not exist';
  elsif v_status = 'closed' then
    return public.get_round_control_summary(p_round_id);
  end if;

  -- Stock writes use this same service-date lock. The snapshot and round close
  -- therefore observe one atomic point in the day-wide ledger.
  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));
  v_captured_at := clock_timestamp();

  select
    count(*),
    count(*) filter (where status = 'delivered'),
    count(*) filter (where status = 'pending'),
    count(*) filter (where status not in ('pending', 'delivered'))
  into v_total, v_delivered, v_pending, v_problem
  from public.round_stops
  where round_id = p_round_id;

  insert into public.round_close_summaries (
    round_id, total_shop_count, delivered_shop_count, pending_shop_count,
    problem_shop_count, captured_by, captured_at
  ) values (
    p_round_id, v_total, v_delivered, v_pending, v_problem, auth.uid(), v_captured_at
  );

  insert into public.round_stock_snapshots (
    round_id, service_date, captured_by, captured_at
  ) values (
    p_round_id, v_service_date, auth.uid(), v_captured_at
  );

  insert into public.round_stock_snapshot_items (
    round_id,
    location_id,
    location_code_snapshot,
    location_name_snapshot,
    location_kind_snapshot,
    ice_type_id,
    ice_type_name_snapshot,
    unit_snapshot,
    quantity
  )
  select
    p_round_id,
    location.id,
    location.code,
    location.name,
    location.kind,
    ice.id,
    ice.name,
    ice.unit,
    public.stock_balance_at(v_service_date, location.id, ice.id)
  from public.stock_locations location
  cross join public.ice_types ice
  where location.is_active and ice.is_active;

  update public.delivery_rounds
  set status = 'closed', closed_by = auth.uid(), closed_at = v_captured_at
  where id = p_round_id;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'delivery_rounds', p_round_id, 'closed',
    jsonb_build_object(
      'total_shop_count', v_total,
      'delivered_shop_count', v_delivered,
      'pending_shop_count', v_pending,
      'problem_shop_count', v_problem,
      'stock_snapshot_at', v_captured_at,
      'stock_closed', false
    )
  );

  return public.get_round_control_summary(p_round_id);
end;
$$;

create or replace function public.get_stock_control_summary(
  p_round_id uuid default null,
  p_service_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_round_date date;
  v_round_status public.delivery_round_status;
  v_service_date date := p_service_date;
  v_is_snapshot boolean := false;
  v_snapshot_at timestamptz;
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view stock control';
  end if;

  if p_round_id is not null then
    select service_date, status into v_round_date, v_round_status
    from public.delivery_rounds
    where id = p_round_id;

    if v_round_date is null then
      raise exception 'The selected delivery round does not exist';
    elsif v_service_date is not null and v_service_date <> v_round_date then
      raise exception 'The selected delivery round belongs to another service date';
    end if;
    v_service_date := v_round_date;

    if v_round_status = 'closed' then
      select captured_at into v_snapshot_at
      from public.round_stock_snapshots
      where round_id = p_round_id;

      if v_snapshot_at is null then
        raise exception 'The closed delivery round does not have a stock snapshot';
      end if;
      v_is_snapshot := true;
    end if;
  end if;

  if v_service_date is null then
    raise exception 'A stock service date is required';
  end if;

  select jsonb_build_object(
    'service_date', v_service_date,
    'is_snapshot', v_is_snapshot,
    'snapshot_at', v_snapshot_at,
    'locations', case when v_is_snapshot then coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', location.location_id,
          'code', location.location_code_snapshot,
          'name', location.location_name_snapshot,
          'kind', location.location_kind_snapshot,
          'balances', (
            select coalesce(jsonb_agg(
              jsonb_build_object(
                'ice_type_id', item.ice_type_id,
                'ice_type_name', item.ice_type_name_snapshot,
                'unit', item.unit_snapshot,
                'quantity', item.quantity
              ) order by item.ice_type_name_snapshot
            ), '[]'::jsonb)
            from public.round_stock_snapshot_items item
            where item.round_id = p_round_id
              and item.location_id = location.location_id
          )
        ) order by
          case location.location_kind_snapshot
            when 'truck' then 0
            when 'work_site' then 1
            when 'team' then 2
            when 'small_vehicle' then 3
            when 'reserve_bin' then 4
            else 5
          end,
          location.location_name_snapshot
      )
      from (
        select distinct
          item.location_id,
          item.location_code_snapshot,
          item.location_name_snapshot,
          item.location_kind_snapshot
        from public.round_stock_snapshot_items item
        where item.round_id = p_round_id
      ) location
    ), '[]'::jsonb) else coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', location.id,
          'code', location.code,
          'name', location.name,
          'kind', location.kind,
          'balances', (
            select coalesce(jsonb_agg(
              jsonb_build_object(
                'ice_type_id', ice.id,
                'ice_type_name', ice.name,
                'unit', ice.unit,
                'quantity', public.stock_balance_at(v_service_date, location.id, ice.id)
              ) order by ice.code
            ), '[]'::jsonb)
            from public.ice_types ice
            where ice.is_active
          )
        ) order by
          case location.kind
            when 'truck' then 0
            when 'work_site' then 1
            when 'team' then 2
            when 'small_vehicle' then 3
            when 'reserve_bin' then 4
            else 5
          end,
          location.name
      )
      from public.stock_locations location
      where location.is_active
    ), '[]'::jsonb) end,
    'recent_movements', coalesce((
      select jsonb_agg(to_jsonb(recent) order by recent.recorded_at desc)
      from (
        select
          movement.id,
          movement.kind,
          movement.recorded_at,
          movement.note,
          source.name as from_location_name,
          destination.name as to_location_name,
          recorder.display_name as recorded_by,
          (
            select coalesce(jsonb_agg(
              jsonb_build_object(
                'ice_type_id', ice.id,
                'ice_type_name', ice.name,
                'unit', ice.unit,
                'quantity', item.quantity
              ) order by ice.code
            ), '[]'::jsonb)
            from public.stock_movement_items item
            join public.ice_types ice on ice.id = item.ice_type_id
            where item.movement_id = movement.id
          ) as items
        from public.stock_movements movement
        left join public.stock_locations source on source.id = movement.from_location_id
        left join public.stock_locations destination on destination.id = movement.to_location_id
        join public.users recorder on recorder.id = movement.recorded_by
        where movement.service_date = v_service_date
          and (
            (not v_is_snapshot and movement.status = 'active')
            or (
              v_is_snapshot
              and movement.recorded_at <= v_snapshot_at
              and (movement.status = 'active' or movement.cancelled_at > v_snapshot_at)
            )
          )
        order by movement.recorded_at desc
        limit 12
      ) recent
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.close_delivery_round(uuid, jsonb) from public;
revoke all on function public.get_stock_control_summary(uuid, date) from public;
grant execute on function public.close_delivery_round(uuid, jsonb) to authenticated;
grant execute on function public.get_stock_control_summary(uuid, date) to authenticated;
