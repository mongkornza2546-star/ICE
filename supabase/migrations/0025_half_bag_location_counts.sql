-- A returned-stock count may be recorded in half-bag increments.  This is a
-- snapshot only; stock movements and delivery quantities remain whole bags.

alter table public.stock_count_snapshot_items
  alter column actual_quantity type numeric(12, 1) using actual_quantity::numeric(12, 1),
  alter column variance_quantity type numeric(12, 1) using variance_quantity::numeric(12, 1);

create or replace function public.record_location_count(
  p_round_id uuid default null,
  p_location_id uuid default null,
  p_counts jsonb default null,
  p_note text default null,
  p_service_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_date date;
  v_service_date date := p_service_date;
  v_snapshot_id uuid;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can count returned stock';
  end if;

  if p_round_id is not null then
    select service_date into v_round_date
    from public.delivery_rounds where id = p_round_id;
    if v_round_date is null then
      raise exception 'The selected delivery round does not exist';
    elsif v_service_date is not null and v_service_date <> v_round_date then
      raise exception 'The selected delivery round belongs to another service date';
    end if;
    v_service_date := v_round_date;
  end if;

  if v_service_date is null then
    raise exception 'A stock service date is required';
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
      from jsonb_to_recordset(p_counts) as input(ice_type_id uuid, actual_quantity numeric(12, 1))
      left join public.ice_types ice on ice.id = input.ice_type_id and ice.is_active
      where input.ice_type_id is null or input.actual_quantity is null
        or input.actual_quantity < 0
        or input.actual_quantity * 2 <> trunc(input.actual_quantity * 2)
        or ice.id is null
    )
    or exists (
      select 1
      from jsonb_to_recordset(p_counts) as input(ice_type_id uuid, actual_quantity numeric(12, 1))
      group by input.ice_type_id
      having count(*) > 1
    )
    or (select count(*) from jsonb_to_recordset(p_counts) as input(ice_type_id uuid))
      <> (select count(*) from public.ice_types where is_active) then
    raise exception 'Provide one non-negative whole or half-bag count for every active ice type';
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
    input.actual_quantity - public.stock_balance_at(
      v_service_date, p_location_id, input.ice_type_id
    )
  from jsonb_to_recordset(p_counts) as input(ice_type_id uuid, actual_quantity numeric(12, 1));

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
