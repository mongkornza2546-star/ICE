-- Daily close uses the latest physical count for every active location. A
-- count becomes stale when that location's stock ledger changes afterward.

create or replace function public.is_stock_count_snapshot_current(target_snapshot_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select
      location.is_active
      and not exists (
        select 1
        from public.ice_types ice
        where ice.is_active
          and not exists (
            select 1
            from public.stock_count_snapshot_items item
            where item.snapshot_id = snapshot.id
              and item.ice_type_id = ice.id
          )
      )
      and not exists (
        select 1
        from public.stock_movements movement
        where movement.service_date = snapshot.service_date
          and (
            movement.from_location_id = snapshot.location_id
            or movement.to_location_id = snapshot.location_id
          )
          and coalesce(movement.cancelled_at, movement.recorded_at) > snapshot.counted_at
      )
      and not exists (
        select 1
        from public.delivery_events event
        join public.round_stops stop on stop.id = event.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        join public.delivery_items item on item.delivery_event_id = event.id
        where round.service_date = snapshot.service_date
          and event.source_stock_location_id = snapshot.location_id
          and coalesce(event.cancelled_at, event.recorded_at) > snapshot.counted_at
      )
    from public.stock_count_snapshots snapshot
    join public.stock_locations location on location.id = snapshot.location_id
    where snapshot.id = target_snapshot_id
  ), false);
$$;

create or replace function public.get_daily_stock_count_readiness(
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
  v_service_date date := p_service_date;
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view stock count readiness';
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'location_id', location.id,
    'location_name', location.name,
    'status', case
      when snapshot.id is null then 'uncounted'
      when public.is_stock_count_snapshot_current(snapshot.id) then 'current'
      else 'stale'
    end,
    'snapshot', case when snapshot.id is null then null else jsonb_build_object(
      'id', snapshot.id,
      'counted_at', snapshot.counted_at,
      'note', snapshot.note,
      'location_id', location.id,
      'location_name', location.name,
      'counted_by', counter.display_name,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'ice_type_id', item.ice_type_id,
          'ice_type_name', ice.name,
          'unit', ice.unit,
          'system_quantity', item.system_quantity,
          'actual_quantity', item.actual_quantity,
          'variance_quantity', item.variance_quantity
        ) order by ice.code)
        from public.stock_count_snapshot_items item
        join public.ice_types ice on ice.id = item.ice_type_id and ice.is_active
        where item.snapshot_id = snapshot.id
      ), '[]'::jsonb)
    ) end
  ) order by location.name), '[]'::jsonb)
  into v_result
  from public.stock_locations location
  left join lateral (
    select candidate.*
    from public.stock_count_snapshots candidate
    where candidate.service_date = v_service_date
      and candidate.location_id = location.id
    order by candidate.counted_at desc, candidate.id desc
    limit 1
  ) snapshot on true
  left join public.users counter on counter.id = snapshot.counted_by
  where location.is_active;

  return v_result;
end;
$$;

create or replace function public.close_daily_stock_from_latest_counts(
  p_round_id uuid default null,
  p_note text default null,
  p_idempotency_key uuid default gen_random_uuid(),
  p_service_date date default null,
  p_use_system_for_uncounted boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_date date;
  v_service_date date := p_service_date;
  v_counts jsonb;
  v_missing_count integer;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can close daily stock';
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

  if p_idempotency_key is null then
    raise exception 'A daily-close idempotency key is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if exists (
    select 1 from public.daily_stock_closures
    where idempotency_key = p_idempotency_key
  ) then
    return public.close_daily_stock(
      p_round_id => p_round_id,
      p_counts => '[]'::jsonb,
      p_note => p_note,
      p_idempotency_key => p_idempotency_key,
      p_service_date => v_service_date
    );
  end if;

  select count(*)::integer
  into v_missing_count
  from public.stock_locations location
  left join lateral (
    select snapshot.id
    from public.stock_count_snapshots snapshot
    where snapshot.service_date = v_service_date
      and snapshot.location_id = location.id
    order by snapshot.counted_at desc, snapshot.id desc
    limit 1
  ) latest on true
  where location.is_active
    and (latest.id is null or not public.is_stock_count_snapshot_current(latest.id));

  if v_missing_count > 0 and not p_use_system_for_uncounted then
    raise exception 'Count every active stock location again before closing daily stock';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'location_id', location.id,
    'ice_type_id', ice.id,
    'actual_quantity', case
      when public.is_stock_count_snapshot_current(latest.id)
        then count_item.actual_quantity
      else public.stock_balance_at(v_service_date, location.id, ice.id)
    end,
    'note', null
  ) order by location.name, ice.code), '[]'::jsonb)
  into v_counts
  from public.stock_locations location
  cross join public.ice_types ice
  left join lateral (
    select snapshot.id
    from public.stock_count_snapshots snapshot
    where snapshot.service_date = v_service_date
      and snapshot.location_id = location.id
    order by snapshot.counted_at desc, snapshot.id desc
    limit 1
  ) latest on true
  left join public.stock_count_snapshot_items count_item
    on count_item.snapshot_id = latest.id and count_item.ice_type_id = ice.id
  where location.is_active and ice.is_active;

  return public.close_daily_stock(
    p_round_id => p_round_id,
    p_counts => v_counts,
    p_note => p_note,
    p_idempotency_key => p_idempotency_key,
    p_service_date => v_service_date
  );
end;
$$;

revoke all on function public.is_stock_count_snapshot_current(uuid) from public;
revoke all on function public.get_daily_stock_count_readiness(uuid, date) from public;
revoke all on function public.close_daily_stock_from_latest_counts(uuid, text, uuid, date, boolean) from public;
revoke execute on function public.close_daily_stock(uuid, jsonb, text, uuid, date) from authenticated;
grant execute on function public.get_daily_stock_count_readiness(uuid, date) to authenticated;
grant execute on function public.close_daily_stock_from_latest_counts(uuid, text, uuid, date, boolean) to authenticated;
