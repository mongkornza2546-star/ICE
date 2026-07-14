-- Complete the Phase 3 manager workflow: configurable operational stock points,
-- counted-return snapshots, audited delivery corrections, and atomic day close.

create table public.stock_count_snapshots (
  id uuid primary key default gen_random_uuid(),
  service_date date not null,
  round_id uuid not null references public.delivery_rounds(id),
  location_id uuid not null references public.stock_locations(id),
  note text,
  counted_by uuid not null references public.users(id),
  counted_at timestamptz not null default now()
);

create table public.stock_count_snapshot_items (
  snapshot_id uuid not null references public.stock_count_snapshots(id),
  ice_type_id uuid not null references public.ice_types(id),
  system_quantity integer not null,
  actual_quantity integer not null check (actual_quantity >= 0),
  variance_quantity integer not null,
  primary key (snapshot_id, ice_type_id),
  check (variance_quantity = actual_quantity - system_quantity)
);

create table public.daily_stock_closures (
  service_date date primary key,
  round_id uuid not null references public.delivery_rounds(id),
  status text not null default 'closing' check (status in ('closing', 'closed')),
  note text,
  idempotency_key uuid not null unique,
  closed_by uuid not null references public.users(id),
  closed_at timestamptz,
  check ((status = 'closing' and closed_at is null) or (status = 'closed' and closed_at is not null))
);

create table public.daily_stock_closure_items (
  service_date date not null references public.daily_stock_closures(service_date),
  location_id uuid not null references public.stock_locations(id),
  ice_type_id uuid not null references public.ice_types(id),
  system_quantity integer not null,
  actual_quantity integer not null check (actual_quantity >= 0),
  variance_quantity integer not null,
  note text,
  primary key (service_date, location_id, ice_type_id),
  check (variance_quantity = actual_quantity - system_quantity)
);

alter table public.delivery_events
  add column corrects_event_id uuid references public.delivery_events(id);

alter table public.stock_locations
  add column assigned_user_id uuid references public.users(id);

create table public.delivery_event_revisions (
  idempotency_key uuid primary key,
  original_event_id uuid not null references public.delivery_events(id),
  replacement_event_id uuid references public.delivery_events(id),
  action text not null check (action in ('cancel', 'correct')),
  reason text not null check (nullif(trim(reason), '') is not null),
  revised_by uuid not null references public.users(id),
  revised_at timestamptz not null default now()
);

create index stock_count_snapshots_date_location_idx
  on public.stock_count_snapshots (service_date, location_id, counted_at desc);
create index daily_stock_closure_items_location_idx
  on public.daily_stock_closure_items (location_id, ice_type_id);
create index delivery_events_corrects_event_idx
  on public.delivery_events (corrects_event_id)
  where corrects_event_id is not null;
create index stock_locations_active_assigned_user_idx
  on public.stock_locations (assigned_user_id)
  where assigned_user_id is not null and is_active;

alter table public.stock_count_snapshots enable row level security;
alter table public.stock_count_snapshot_items enable row level security;
alter table public.daily_stock_closures enable row level security;
alter table public.daily_stock_closure_items enable row level security;
alter table public.delivery_event_revisions enable row level security;

create policy "admins or leads read stock count snapshots" on public.stock_count_snapshots for select
  using (public.current_app_role() in ('admin', 'round_lead'));
create policy "admins or leads read stock count items" on public.stock_count_snapshot_items for select
  using (public.current_app_role() in ('admin', 'round_lead'));
create policy "admins or leads read daily closures" on public.daily_stock_closures for select
  using (public.current_app_role() in ('admin', 'round_lead'));
create policy "admins or leads read daily closure items" on public.daily_stock_closure_items for select
  using (public.current_app_role() in ('admin', 'round_lead'));
create policy "admins or leads read delivery revisions" on public.delivery_event_revisions for select
  using (public.current_app_role() in ('admin', 'round_lead'));

create or replace function public.stock_balance_at(
  p_service_date date,
  p_location_id uuid,
  p_ice_type_id uuid
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
      and movement.status = 'active'
      and item.ice_type_id = p_ice_type_id
      and (movement.from_location_id = p_location_id or movement.to_location_id = p_location_id)
  ), delivery_totals as (
    select coalesce(sum(item.quantity), 0) as quantity
    from public.delivery_events event
    join public.delivery_items item on item.delivery_event_id = event.id
    join public.round_stops stop on stop.id = event.round_stop_id
    join public.delivery_rounds round on round.id = stop.round_id
    where round.service_date = p_service_date
      and event.status = 'active'
      and event.source_stock_location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
  ), count_adjustment as (
    select coalesce(sum(item.variance_quantity), 0) as quantity
    from public.daily_stock_closure_items item
    join public.daily_stock_closures closure on closure.service_date = item.service_date
    where item.service_date = p_service_date
      and item.location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
      and closure.status in ('closing', 'closed')
  )
  select (movement_totals.quantity - delivery_totals.quantity + count_adjustment.quantity)::integer
  from movement_totals, delivery_totals, count_adjustment;
$$;

create or replace function public.save_stock_location(
  p_code text,
  p_name text,
  p_kind public.stock_location_kind,
  p_location_id uuid default null,
  p_building_id uuid default null,
  p_assigned_user_id uuid default null,
  p_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_location_id uuid;
  v_before jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can manage operational stock locations';
  end if;

  if p_kind not in ('team', 'small_vehicle', 'reserve_bin', 'front_vehicle') then
    raise exception 'Truck and building work-site locations are managed by the system';
  end if;

  if nullif(trim(p_code), '') is null or nullif(trim(p_name), '') is null then
    raise exception 'A location code and name are required';
  end if;

  if p_building_id is not null and not exists (
    select 1 from public.buildings where id = p_building_id
  ) then
    raise exception 'The selected building does not exist';
  end if;

  if p_kind = 'team' and p_assigned_user_id is null then
    raise exception 'An employee stock location must name its assigned user';
  end if;

  if p_assigned_user_id is not null and not exists (
    select 1 from public.users where id = p_assigned_user_id and is_active
  ) then
    raise exception 'The assigned stock recipient must be an active user';
  end if;

  if p_location_id is null then
    insert into public.stock_locations (
      code, name, kind, building_id, assigned_user_id, is_active
    )
    values (
      upper(trim(p_code)), trim(p_name), p_kind, p_building_id,
      p_assigned_user_id, p_is_active
    )
    returning id into v_location_id;
  else
    select to_jsonb(location), location.id into v_before, v_location_id
    from public.stock_locations location
    where location.id = p_location_id
      and location.kind in ('team', 'small_vehicle', 'reserve_bin', 'front_vehicle')
    for update;

    if v_location_id is null then
      raise exception 'The selected operational stock location does not exist';
    end if;

    if (
      not p_is_active
      or (v_before ->> 'kind')::public.stock_location_kind <> p_kind
      or (v_before ->> 'building_id')::uuid is distinct from p_building_id
      or (v_before ->> 'assigned_user_id')::uuid is distinct from p_assigned_user_id
    ) and exists (
      select 1
      from (
        select distinct round.service_date
        from public.delivery_rounds round
        where not exists (
          select 1 from public.daily_stock_closures closure
          where closure.service_date = round.service_date and closure.status = 'closed'
        )
      ) day
      join public.ice_types ice on ice.is_active
        and public.stock_balance_at(day.service_date, p_location_id, ice.id) <> 0
    ) then
      raise exception 'A stock location with an open balance cannot be deactivated or reassigned';
    end if;

    update public.stock_locations
    set code = upper(trim(p_code)),
        name = trim(p_name),
        kind = p_kind,
        building_id = p_building_id,
        assigned_user_id = p_assigned_user_id,
        is_active = p_is_active
    where id = p_location_id;
  end if;

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, before_value, after_value
  )
  select
    auth.uid(),
    'stock_locations',
    v_location_id,
    case when v_before is null then 'created' else 'updated' end,
    v_before,
    to_jsonb(location)
  from public.stock_locations location
  where location.id = v_location_id;

  return v_location_id;
end;
$$;

create or replace function public.record_location_count(
  p_round_id uuid,
  p_location_id uuid,
  p_counts jsonb,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_date date;
  v_snapshot_id uuid;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can count returned stock';
  end if;

  select service_date into v_service_date
  from public.delivery_rounds
  where id = p_round_id;

  if v_service_date is null then
    raise exception 'The selected delivery round does not exist';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if exists (
    select 1 from public.daily_stock_closures
    where service_date = v_service_date and status = 'closed'
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  if not exists (
    select 1 from public.stock_locations where id = p_location_id and is_active
  ) then
    raise exception 'The selected stock location is not active';
  end if;

  if jsonb_typeof(p_counts) is distinct from 'array'
    or exists (
      select 1
      from jsonb_to_recordset(p_counts) as input(ice_type_id uuid, actual_quantity integer)
      left join public.ice_types ice on ice.id = input.ice_type_id and ice.is_active
      where input.ice_type_id is null or input.actual_quantity is null
        or input.actual_quantity < 0 or ice.id is null
    )
    or exists (
      select 1
      from jsonb_to_recordset(p_counts) as input(ice_type_id uuid, actual_quantity integer)
      group by input.ice_type_id
      having count(*) > 1
    )
    or (select count(*) from jsonb_to_recordset(p_counts) as input(ice_type_id uuid))
      <> (select count(*) from public.ice_types where is_active) then
    raise exception 'Provide one non-negative actual count for every active ice type';
  end if;

  insert into public.stock_count_snapshots (
    service_date, round_id, location_id, note, counted_by
  ) values (
    v_service_date, p_round_id, p_location_id,
    nullif(trim(coalesce(p_note, '')), ''), auth.uid()
  ) returning id into v_snapshot_id;

  insert into public.stock_count_snapshot_items (
    snapshot_id, ice_type_id, system_quantity, actual_quantity, variance_quantity
  )
  select
    v_snapshot_id,
    input.ice_type_id,
    public.stock_balance_at(v_service_date, p_location_id, input.ice_type_id),
    input.actual_quantity,
    input.actual_quantity - public.stock_balance_at(v_service_date, p_location_id, input.ice_type_id)
  from jsonb_to_recordset(p_counts) as input(ice_type_id uuid, actual_quantity integer);

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'stock_count_snapshots', v_snapshot_id, 'counted',
    jsonb_build_object(
      'round_id', p_round_id,
      'service_date', v_service_date,
      'location_id', p_location_id,
      'counts', p_counts,
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return jsonb_build_object('snapshot_id', v_snapshot_id);
end;
$$;

create or replace function public.get_location_count_history(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date;
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view stock counts';
  end if;

  select service_date into v_service_date
  from public.delivery_rounds where id = p_round_id;

  if v_service_date is null then
    raise exception 'The selected delivery round does not exist';
  end if;

  select coalesce(jsonb_agg(to_jsonb(history) order by history.counted_at desc), '[]'::jsonb)
  into v_result
  from (
    select
      snapshot.id,
      snapshot.counted_at,
      snapshot.note,
      location.id as location_id,
      location.name as location_name,
      counter.display_name as counted_by,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'ice_type_id', item.ice_type_id,
          'ice_type_name', ice.name,
          'unit', ice.unit,
          'system_quantity', item.system_quantity,
          'actual_quantity', item.actual_quantity,
          'variance_quantity', item.variance_quantity
        ) order by ice.code), '[]'::jsonb)
        from public.stock_count_snapshot_items item
        join public.ice_types ice on ice.id = item.ice_type_id
        where item.snapshot_id = snapshot.id
      ) as items
    from public.stock_count_snapshots snapshot
    join public.stock_locations location on location.id = snapshot.location_id
    join public.users counter on counter.id = snapshot.counted_by
    where snapshot.service_date = v_service_date
    order by snapshot.counted_at desc
    limit 20
  ) history;

  return v_result;
end;
$$;

create or replace function public.get_manager_delivery_events(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can review delivery events';
  end if;

  if not exists (select 1 from public.delivery_rounds where id = p_round_id) then
    raise exception 'The selected delivery round does not exist';
  end if;

  select jsonb_build_object(
    'ice_types', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ice.id, 'code', ice.code, 'name', ice.name, 'unit', ice.unit
      ) order by ice.code)
      from public.ice_types ice where ice.is_active
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(event_row) order by event_row.recorded_at desc)
      from (
        select
          event.id,
          event.round_stop_id,
          stop.shop_code_snapshot as shop_code,
          stop.shop_name_snapshot as shop_name,
          recorder.display_name as recorded_by,
          event.recorded_at,
          event.note,
          coalesce(
            (
              select log.after_value ->> 'stop_status'
              from public.audit_logs log
              where log.entity_type = 'delivery_events' and log.entity_id = event.id
                and log.after_value ? 'stop_status'
              order by log.occurred_at
              limit 1
            ),
            case when exists (
              select 1 from public.delivery_items item where item.delivery_event_id = event.id
            ) then 'delivered' else 'issue' end
          ) as stop_status,
          (
            select coalesce(jsonb_agg(jsonb_build_object(
              'ice_type_id', item.ice_type_id,
              'quantity', item.quantity
            ) order by ice.code), '[]'::jsonb)
            from public.delivery_items item
            join public.ice_types ice on ice.id = item.ice_type_id
            where item.delivery_event_id = event.id
          ) as items
        from public.delivery_events event
        join public.round_stops stop on stop.id = event.round_stop_id
        join public.users recorder on recorder.id = event.recorded_by
        where stop.round_id = p_round_id and event.status = 'active'
      ) event_row
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- A round groups sales and members; it is not a stock container. Replace the
-- earlier close RPC so it snapshots shop progress only. Day stock is closed by
-- close_daily_stock after every round for the service date has been closed.
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

  select status into v_status
  from public.delivery_rounds
  where id = p_round_id
  for update;

  if v_status is null then
    raise exception 'The selected delivery round does not exist';
  elsif v_status = 'closed' then
    return public.get_round_control_summary(p_round_id);
  end if;

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
    p_round_id, v_total, v_delivered, v_pending, v_problem, auth.uid(), now()
  );

  update public.delivery_rounds
  set status = 'closed', closed_by = auth.uid(), closed_at = now()
  where id = p_round_id;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'delivery_rounds', p_round_id, 'closed',
    jsonb_build_object(
      'total_shop_count', v_total,
      'delivered_shop_count', v_delivered,
      'pending_shop_count', v_pending,
      'problem_shop_count', v_problem,
      'stock_closed', false
    )
  );

  return public.get_round_control_summary(p_round_id);
end;
$$;

create or replace function public.revise_delivery_event(
  p_event_id uuid,
  p_action text,
  p_items jsonb,
  p_stop_status public.shop_round_status,
  p_note text,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_id uuid;
  v_round_status public.delivery_round_status;
  v_service_date date;
  v_round_stop_id uuid;
  v_source_location_id uuid;
  v_event_status public.delivery_event_status;
  v_replacement_id uuid;
  v_existing_original_id uuid;
  v_existing_action text;
  v_item_count integer;
  v_item record;
  v_latest_status public.shop_round_status;
  v_latest_note text;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can revise delivery events';
  end if;

  if p_action not in ('cancel', 'correct') then
    raise exception 'The revision action must be cancel or correct';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A revision reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select original_event_id, action
  into v_existing_original_id, v_existing_action
  from public.delivery_event_revisions
  where idempotency_key = p_idempotency_key;

  if v_existing_original_id is not null then
    if v_existing_original_id <> p_event_id or v_existing_action <> p_action then
      raise exception 'This idempotency key belongs to another revision';
    end if;
    select stop.round_id into v_round_id
    from public.delivery_events event
    join public.round_stops stop on stop.id = event.round_stop_id
    where event.id = p_event_id;
    return public.get_manager_delivery_events(v_round_id);
  end if;

  select
    stop.round_id, round.status, round.service_date, event.round_stop_id,
    event.source_stock_location_id, event.status
  into
    v_round_id, v_round_status, v_service_date, v_round_stop_id,
    v_source_location_id, v_event_status
  from public.delivery_events event
  join public.round_stops stop on stop.id = event.round_stop_id
  join public.delivery_rounds round on round.id = stop.round_id
  where event.id = p_event_id
  for update of event, round;

  if v_round_id is null then
    raise exception 'The selected delivery event does not exist';
  elsif v_event_status <> 'active' then
    raise exception 'The selected delivery event is already cancelled';
  elsif v_round_status <> 'open' then
    raise exception 'Delivery events can only be revised before the round is closed';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if exists (
    select 1 from public.daily_stock_closures
    where service_date = v_service_date and status = 'closed'
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  if p_action = 'correct' then
    if v_source_location_id is null then
      raise exception 'A legacy delivery without a captured stock source cannot be corrected';
    end if;

    if jsonb_typeof(p_items) is distinct from 'array' then
      raise exception 'Delivery items must be a JSON array';
    end if;

    select count(*) into v_item_count
    from jsonb_to_recordset(p_items) as input(ice_type_id uuid, quantity integer);

    if p_stop_status = 'pending' then
      raise exception 'A delivery correction cannot reset a shop to pending';
    elsif p_stop_status = 'delivered' and v_item_count = 0 then
      raise exception 'A delivered shop requires at least one ice item';
    elsif p_stop_status <> 'delivered'
      and (v_item_count <> 0 or nullif(trim(coalesce(p_note, '')), '') is null) then
      raise exception 'A non-delivery status requires a note and cannot include ice items';
    end if;

    if exists (
      select 1
      from jsonb_to_recordset(p_items) as input(ice_type_id uuid, quantity integer)
      left join public.ice_types ice on ice.id = input.ice_type_id and ice.is_active
      where input.ice_type_id is null or input.quantity is null
        or input.quantity <= 0 or ice.id is null
    ) or exists (
      select 1
      from jsonb_to_recordset(p_items) as input(ice_type_id uuid, quantity integer)
      group by input.ice_type_id
      having count(*) > 1
    ) then
      raise exception 'Every delivery item must use a distinct active ice type and a positive quantity';
    end if;
  end if;

  update public.delivery_events
  set status = 'cancelled',
      cancelled_by = auth.uid(),
      cancelled_at = now(),
      cancellation_reason = trim(p_reason)
  where id = p_event_id;

  if p_action = 'correct' then
    for v_item in
      select input.ice_type_id, input.quantity
      from jsonb_to_recordset(p_items) as input(ice_type_id uuid, quantity integer)
    loop
      if public.stock_balance_at(v_service_date, v_source_location_id, v_item.ice_type_id)
        < v_item.quantity then
        raise exception 'The source location does not have enough stock for the corrected delivery';
      end if;
    end loop;

    insert into public.delivery_events (
      round_stop_id, recorded_by, idempotency_key, note,
      source_stock_location_id, corrects_event_id
    ) values (
      v_round_stop_id, auth.uid(), p_idempotency_key,
      nullif(trim(coalesce(p_note, '')), ''), v_source_location_id, p_event_id
    ) returning id into v_replacement_id;

    insert into public.delivery_items (delivery_event_id, ice_type_id, quantity)
    select v_replacement_id, input.ice_type_id, input.quantity
    from jsonb_to_recordset(p_items) as input(ice_type_id uuid, quantity integer);

    update public.round_stops
    set status = p_stop_status,
        note = nullif(trim(coalesce(p_note, '')), ''),
        updated_by = auth.uid(),
        updated_at = now()
    where id = v_round_stop_id;

    insert into public.audit_logs (
      actor_id, entity_type, entity_id, action, after_value, reason
    ) values (
      auth.uid(), 'delivery_events', v_replacement_id, 'corrected',
      jsonb_build_object(
        'corrects_event_id', p_event_id,
        'round_stop_id', v_round_stop_id,
        'items', p_items,
        'stop_status', p_stop_status,
        'note', nullif(trim(coalesce(p_note, '')), ''),
        'source_stock_location_id', v_source_location_id
      ), trim(p_reason)
    );
  else
    select
      coalesce((
        select (log.after_value ->> 'stop_status')::public.shop_round_status
        from public.audit_logs log
        where log.entity_type = 'delivery_events' and log.entity_id = event.id
          and log.after_value ? 'stop_status'
        order by log.occurred_at
        limit 1
      ), case when exists (
        select 1 from public.delivery_items item where item.delivery_event_id = event.id
      ) then 'delivered'::public.shop_round_status else 'issue'::public.shop_round_status end),
      event.note
    into v_latest_status, v_latest_note
    from public.delivery_events event
    where event.round_stop_id = v_round_stop_id and event.status = 'active'
    order by event.recorded_at desc
    limit 1;

    update public.round_stops
    set status = coalesce(v_latest_status, 'pending'),
        note = v_latest_note,
        updated_by = auth.uid(),
        updated_at = now()
    where id = v_round_stop_id;
  end if;

  insert into public.delivery_event_revisions (
    idempotency_key, original_event_id, replacement_event_id,
    action, reason, revised_by
  ) values (
    p_idempotency_key, p_event_id, v_replacement_id,
    p_action, trim(p_reason), auth.uid()
  );

  return public.get_manager_delivery_events(v_round_id);
end;
$$;

create or replace function public.get_daily_stock_close_state(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date;
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view daily stock close';
  end if;

  select service_date into v_service_date
  from public.delivery_rounds where id = p_round_id;

  if v_service_date is null then
    raise exception 'The selected delivery round does not exist';
  end if;

  select jsonb_build_object(
    'service_date', v_service_date,
    'open_round_count', (
      select count(*) from public.delivery_rounds
      where service_date = v_service_date and status = 'open'
    ),
    'is_closed', coalesce(closure.status = 'closed', false),
    'closed_at', closure.closed_at,
    'closed_by', closer.display_name,
    'note', closure.note,
    'counts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'location_id', item.location_id,
        'location_name', location.name,
        'ice_type_id', item.ice_type_id,
        'ice_type_name', ice.name,
        'unit', ice.unit,
        'system_quantity', item.system_quantity,
        'actual_quantity', item.actual_quantity,
        'variance_quantity', item.variance_quantity,
        'note', item.note
      ) order by location.name, ice.code)
      from public.daily_stock_closure_items item
      join public.stock_locations location on location.id = item.location_id
      join public.ice_types ice on ice.id = item.ice_type_id
      where item.service_date = v_service_date
    ), '[]'::jsonb)
  ) into v_result
  from (select 1) seed
  left join public.daily_stock_closures closure on closure.service_date = v_service_date
  left join public.users closer on closer.id = closure.closed_by;

  return v_result;
end;
$$;

create or replace function public.reject_closed_service_day()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_date date;
begin
  if tg_table_name = 'stock_movements' then
    v_service_date := new.service_date;
  else
    select round.service_date into v_service_date
    from public.round_stops stop
    join public.delivery_rounds round on round.id = stop.round_id
    where stop.id = new.round_stop_id;
  end if;

  if exists (
    select 1 from public.daily_stock_closures
    where service_date = v_service_date and status = 'closed'
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  return new;
end;
$$;

create trigger stock_movements_reject_closed_day
  before insert on public.stock_movements
  for each row execute function public.reject_closed_service_day();

create trigger delivery_events_reject_closed_day
  before insert on public.delivery_events
  for each row execute function public.reject_closed_service_day();

create or replace function public.reject_round_on_closed_day()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'open' then
    perform pg_advisory_xact_lock(hashtextextended(new.service_date::text, 0));

    if exists (
      select 1 from public.daily_stock_closures
      where service_date = new.service_date and status = 'closed'
    ) then
      raise exception 'Stock for this service date is already closed';
    end if;
  end if;
  return new;
end;
$$;

create trigger delivery_rounds_reject_closed_day
  before insert or update of service_date, status on public.delivery_rounds
  for each row execute function public.reject_round_on_closed_day();

create or replace function public.close_daily_stock(
  p_round_id uuid,
  p_counts jsonb,
  p_note text default null,
  p_idempotency_key uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_date date;
  v_existing_round_id uuid;
  v_existing_key uuid;
  v_truck_id uuid;
  v_source record;
  v_movement_id uuid;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can close daily stock';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select round_id, idempotency_key into v_existing_round_id, v_existing_key
  from public.daily_stock_closures
  where idempotency_key = p_idempotency_key;

  if v_existing_round_id is not null then
    if v_existing_round_id <> p_round_id then
      raise exception 'This idempotency key belongs to another service day';
    end if;
    return public.get_daily_stock_close_state(p_round_id);
  end if;

  select service_date into v_service_date
  from public.delivery_rounds
  where id = p_round_id;

  if v_service_date is null then
    raise exception 'The selected delivery round does not exist';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  select round_id, idempotency_key into v_existing_round_id, v_existing_key
  from public.daily_stock_closures
  where service_date = v_service_date
  for update;

  if v_existing_round_id is not null then
    raise exception 'Stock for this service date is already closed';
  end if;

  if exists (
    select 1 from public.delivery_rounds
    where service_date = v_service_date and status = 'open'
  ) then
    raise exception 'Close every delivery round before closing daily stock';
  end if;

  if jsonb_typeof(p_counts) is distinct from 'array'
    or exists (
      select 1
      from jsonb_to_recordset(p_counts)
        as input(location_id uuid, ice_type_id uuid, actual_quantity integer, note text)
      left join public.stock_locations location
        on location.id = input.location_id and location.is_active
      left join public.ice_types ice
        on ice.id = input.ice_type_id and ice.is_active
      where input.location_id is null or input.ice_type_id is null
        or input.actual_quantity is null or input.actual_quantity < 0
        or location.id is null or ice.id is null
    )
    or exists (
      select 1
      from jsonb_to_recordset(p_counts)
        as input(location_id uuid, ice_type_id uuid, actual_quantity integer, note text)
      group by input.location_id, input.ice_type_id
      having count(*) > 1
    )
    or (select count(*) from jsonb_to_recordset(p_counts)
          as input(location_id uuid, ice_type_id uuid, actual_quantity integer, note text))
      <> (select count(*) from public.stock_locations location
          cross join public.ice_types ice
          where location.is_active and ice.is_active) then
    raise exception 'Provide one non-negative actual count for every active location and ice type';
  end if;

  select id into v_truck_id
  from public.stock_locations
  where kind = 'truck' and is_active
  order by created_at
  limit 1;

  if v_truck_id is null then
    raise exception 'An active truck location is required to return stock to the factory';
  end if;

  insert into public.daily_stock_closures (
    service_date, round_id, status, note, idempotency_key, closed_by
  ) values (
    v_service_date, p_round_id, 'closing',
    nullif(trim(coalesce(p_note, '')), ''), p_idempotency_key, auth.uid()
  );

  insert into public.daily_stock_closure_items (
    service_date, location_id, ice_type_id,
    system_quantity, actual_quantity, variance_quantity, note
  )
  select
    v_service_date,
    input.location_id,
    input.ice_type_id,
    public.stock_balance_at(v_service_date, input.location_id, input.ice_type_id),
    input.actual_quantity,
    input.actual_quantity - public.stock_balance_at(
      v_service_date, input.location_id, input.ice_type_id
    ),
    nullif(trim(coalesce(input.note, '')), '')
  from jsonb_to_recordset(p_counts)
    as input(location_id uuid, ice_type_id uuid, actual_quantity integer, note text);

  for v_source in
    select item.location_id
    from public.daily_stock_closure_items item
    where item.service_date = v_service_date
      and item.location_id <> v_truck_id
      and item.actual_quantity > 0
    group by item.location_id
  loop
    insert into public.stock_movements (
      service_date, round_id, kind, from_location_id, to_location_id,
      note, idempotency_key, recorded_by
    ) values (
      v_service_date, p_round_id, 'transfer', v_source.location_id, v_truck_id,
      'รวบรวมยอดนับจริงเพื่อส่งคืนโรงงาน', gen_random_uuid(), auth.uid()
    ) returning id into v_movement_id;

    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    select v_movement_id, item.ice_type_id, item.actual_quantity
    from public.daily_stock_closure_items item
    where item.service_date = v_service_date
      and item.location_id = v_source.location_id
      and item.actual_quantity > 0;
  end loop;

  if exists (
    select 1 from public.daily_stock_closure_items
    where service_date = v_service_date and actual_quantity > 0
  ) then
    insert into public.stock_movements (
      service_date, round_id, kind, from_location_id, to_location_id,
      note, idempotency_key, recorded_by
    ) values (
      v_service_date, p_round_id, 'return_to_factory', v_truck_id, null,
      'ส่งยอดน้ำแข็งนับจริงคงเหลือทั้งหมดกลับโรงงาน', gen_random_uuid(), auth.uid()
    ) returning id into v_movement_id;

    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    select v_movement_id, item.ice_type_id, sum(item.actual_quantity)::integer
    from public.daily_stock_closure_items item
    where item.service_date = v_service_date and item.actual_quantity > 0
    group by item.ice_type_id;
  end if;

  update public.daily_stock_closures
  set status = 'closed', closed_at = now()
  where service_date = v_service_date;

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, after_value
  ) values (
    auth.uid(), 'daily_stock_closures', p_round_id, 'closed',
    jsonb_build_object(
      'service_date', v_service_date,
      'counts', p_counts,
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return public.get_daily_stock_close_state(p_round_id);
end;
$$;

revoke all on function public.save_stock_location(
  text, text, public.stock_location_kind, uuid, uuid, uuid, boolean
) from public;
revoke all on function public.record_location_count(uuid, uuid, jsonb, text) from public;
revoke all on function public.get_location_count_history(uuid) from public;
revoke all on function public.get_manager_delivery_events(uuid) from public;
revoke all on function public.close_delivery_round(uuid, jsonb) from public;
revoke all on function public.revise_delivery_event(
  uuid, text, jsonb, public.shop_round_status, text, text, uuid
) from public;
revoke all on function public.get_daily_stock_close_state(uuid) from public;
revoke all on function public.close_daily_stock(uuid, jsonb, text, uuid) from public;

grant execute on function public.save_stock_location(
  text, text, public.stock_location_kind, uuid, uuid, uuid, boolean
) to authenticated;
grant execute on function public.record_location_count(uuid, uuid, jsonb, text) to authenticated;
grant execute on function public.get_location_count_history(uuid) to authenticated;
grant execute on function public.get_manager_delivery_events(uuid) to authenticated;
grant execute on function public.close_delivery_round(uuid, jsonb) to authenticated;
grant execute on function public.revise_delivery_event(
  uuid, text, jsonb, public.shop_round_status, text, text, uuid
) to authenticated;
grant execute on function public.get_daily_stock_close_state(uuid) to authenticated;
grant execute on function public.close_daily_stock(uuid, jsonb, text, uuid) to authenticated;
