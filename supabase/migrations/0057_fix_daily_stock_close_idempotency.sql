-- Repair the deployed daily-close RPC. daily_stock_closures is keyed by
-- service_date, so selecting a nonexistent `id` column prevented every close.
alter table public.daily_stock_closures
  add column if not exists request_fingerprint text;

create or replace function public.close_daily_stock_v2(
  p_counts jsonb,
  p_note text default null,
  p_idempotency_key uuid default gen_random_uuid(),
  p_service_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_date date;
  v_existing_date date;
  v_existing_fingerprint text;
  v_request_fingerprint text;
  v_truck_id uuid;
  v_movement_id uuid;
  v_source record;
  v_captured_at timestamptz;
  v_open_round record;
  v_total integer;
  v_delivered integer;
  v_pending integer;
  v_problem integer;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can perform daily stock close';
  end if;

  if p_idempotency_key is null then
    raise exception 'A daily close idempotency key is required';
  end if;

  v_service_date := coalesce(
    p_service_date,
    (clock_timestamp() at time zone 'Asia/Bangkok')::date
  );

  -- Validate counts structure
  if jsonb_typeof(p_counts) is distinct from 'array'
    or exists (
      select 1
      from jsonb_to_recordset(p_counts)
        as input(location_id uuid, ice_type_id uuid, actual_quantity numeric, note text)
      left join public.stock_locations location
        on location.id = input.location_id and location.is_active and location.holds_inventory
      left join public.ice_types ice
        on ice.id = input.ice_type_id and ice.is_active
      where input.location_id is null or input.ice_type_id is null
        or input.actual_quantity is null or input.actual_quantity < 0
        or input.actual_quantity * 2 <> trunc(input.actual_quantity * 2)
        or location.id is null or ice.id is null
    )
    or exists (
      select 1
      from jsonb_to_recordset(p_counts)
        as input(location_id uuid, ice_type_id uuid, actual_quantity numeric, note text)
      group by input.location_id, input.ice_type_id
      having count(*) > 1
    )
    or (select count(*) from jsonb_to_recordset(p_counts)
          as input(location_id uuid, ice_type_id uuid, actual_quantity numeric, note text))
      <> (select count(*) from public.stock_locations location
          cross join public.ice_types ice
          where location.is_active and location.holds_inventory and ice.is_active) then
    raise exception 'Provide one non-negative whole or half-bag actual count for every active location and ice type';
  end if;

  -- Lock idempotency key
  select md5(jsonb_build_object(
    'operation', 'close_daily_stock_v2',
    'service_date', v_service_date,
    'counts', (
      select jsonb_agg(
        jsonb_build_object(
          'location_id', input.location_id,
          'ice_type_id', input.ice_type_id,
          'actual_quantity', input.actual_quantity,
          'note', nullif(trim(coalesce(input.note, '')), '')
        ) order by input.location_id, input.ice_type_id
      )
      from jsonb_to_recordset(p_counts)
        as input(location_id uuid, ice_type_id uuid, actual_quantity numeric, note text)
    ),
    'note', nullif(trim(coalesce(p_note, '')), '')
  )::text) into v_request_fingerprint;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select service_date, request_fingerprint
  into v_existing_date, v_existing_fingerprint
  from public.daily_stock_closures
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing_date <> v_service_date
      or v_existing_fingerprint is distinct from v_request_fingerprint then
      raise exception 'This idempotency key belongs to another daily stock closure request';
    end if;
    return public.get_daily_stock_close_state(null, v_service_date);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if exists (
    select 1 from public.daily_stock_closures
    where service_date = v_service_date and status = 'closed'
  ) then
    raise exception 'Daily stock has already been closed for this service date';
  end if;

  if exists (
    select 1
    from public.delivery_rounds
    where service_date = v_service_date
      and round_type = 'special'
      and status = 'open'
      and cancelled_at is null
  ) then
    raise exception 'Close every special delivery round before closing daily stock';
  end if;

  -- Verify all count variances are approved
  if exists (
    select 1
    from jsonb_to_recordset(p_counts)
      as input(location_id uuid, ice_type_id uuid, actual_quantity numeric, note text)
    join public.stock_locations location on location.id = input.location_id
    where location.requires_daily_count
      and input.actual_quantity <> public.stock_balance_at(
        v_service_date, input.location_id, input.ice_type_id
      )
      and not exists (
        select 1
        from public.stock_count_snapshots snapshot
        join public.stock_count_snapshot_items count_item
          on count_item.snapshot_id = snapshot.id
          and count_item.ice_type_id = input.ice_type_id
        join public.stock_count_variance_reviews review
          on review.snapshot_id = snapshot.id
          and review.ice_type_id = input.ice_type_id
        where snapshot.service_date = v_service_date
          and snapshot.location_id = input.location_id
          and snapshot.id = (
            select latest.id
            from public.stock_count_snapshots latest
            where latest.service_date = v_service_date
              and latest.location_id = input.location_id
            order by latest.counted_at desc, latest.id desc
            limit 1
          )
          and public.is_stock_count_snapshot_current(snapshot.id)
          and count_item.system_quantity = public.stock_balance_at(
            v_service_date, input.location_id, input.ice_type_id
          )
          and count_item.actual_quantity = input.actual_quantity
          and review.status = 'approved'
      )
  ) then
    raise exception 'Approve every variance in the latest stock counts before closing daily stock';
  end if;

  -- Persist the reconciliation before taking the round snapshot. stock_balance_at
  -- includes closure variance while status is closing, so the snapshot records
  -- the approved actual count rather than the pre-count system balance.
  insert into public.daily_stock_closures (
    service_date, status, note, idempotency_key, closed_by, request_fingerprint
  ) values (
    v_service_date, 'closing',
    nullif(trim(coalesce(p_note, '')), ''), p_idempotency_key, auth.uid(), v_request_fingerprint
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
    input.actual_quantity - public.stock_balance_at(v_service_date, input.location_id, input.ice_type_id),
    nullif(trim(coalesce(input.note, '')), '')
  from jsonb_to_recordset(p_counts)
    as input(location_id uuid, ice_type_id uuid, actual_quantity numeric, note text);

  v_captured_at := clock_timestamp();

  -- ATOMICALLY CLOSE ALL OPEN DAILY SESSIONS FOR THIS SERVICE DATE
  for v_open_round in
    select id, service_date
    from public.delivery_rounds
    where service_date = v_service_date
      and round_type = 'daily'
      and status = 'open'
      and cancelled_at is null
    for update
  loop
    select
      count(*),
      count(*) filter (where status = 'delivered'),
      count(*) filter (where status = 'pending'),
      count(*) filter (where status not in ('pending', 'delivered'))
    into v_total, v_delivered, v_pending, v_problem
    from public.round_stops
    where round_id = v_open_round.id;

    insert into public.round_close_summaries (
      round_id, total_shop_count, delivered_shop_count, pending_shop_count,
      problem_shop_count, captured_by, captured_at
    ) values (
      v_open_round.id, v_total, v_delivered, v_pending, v_problem, auth.uid(), v_captured_at
    ) on conflict (round_id) do nothing;

    insert into public.round_stock_snapshots (
      round_id, service_date, captured_by, captured_at
    ) values (
      v_open_round.id, v_service_date, auth.uid(), v_captured_at
    ) on conflict (round_id) do nothing;

    insert into public.round_stock_snapshot_items (
      round_id, location_id, location_code_snapshot, location_name_snapshot,
      location_kind_snapshot, ice_type_id, ice_type_name_snapshot, unit_snapshot, quantity
    )
    select
      v_open_round.id,
      loc.id,
      loc.code,
      loc.name,
      loc.kind,
      ice.id,
      ice.name,
      ice.unit,
      public.stock_balance_at(v_service_date, loc.id, ice.id)
    from public.stock_locations loc
    cross join public.ice_types ice
    where loc.is_active and loc.holds_inventory and ice.is_active
    on conflict (round_id, location_id, ice_type_id) do nothing;

    update public.delivery_rounds
    set status = 'closed',
        closed_by = auth.uid(),
        closed_at = v_captured_at
    where id = v_open_round.id;
  end loop;

  -- Resolve truck ID for return transfers
  select id into v_truck_id
  from public.stock_locations
  where kind = 'truck' and is_active and holds_inventory and is_courier_source
  limit 1;

  if v_truck_id is null then
    select id into v_truck_id
    from public.stock_locations
    where kind = 'truck' and is_active and holds_inventory
    order by code
    limit 1;
  end if;

  if v_truck_id is null then
    raise exception 'An active truck location is required to return stock to the factory';
  end if;

  -- Transfer actual stock from other locations to truck
  for v_source in
    select item.location_id
    from public.daily_stock_closure_items item
    join public.stock_locations loc on loc.id = item.location_id
    where item.service_date = v_service_date
      and item.location_id <> v_truck_id
      and loc.holds_inventory
      and item.actual_quantity > 0
    group by item.location_id
  loop
    insert into public.stock_movements (
      service_date, kind, from_location_id, to_location_id,
      note, idempotency_key, recorded_by
    ) values (
      v_service_date, 'transfer', v_source.location_id, v_truck_id,
      'รวบรวมยอดนับจริงเพื่อส่งคืนโรงงาน', gen_random_uuid(), auth.uid()
    ) returning id into v_movement_id;

    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    select v_movement_id, item.ice_type_id, item.actual_quantity
    from public.daily_stock_closure_items item
    where item.service_date = v_service_date
      and item.location_id = v_source.location_id
      and item.actual_quantity > 0;
  end loop;

  -- Return all stock from truck to factory
  if exists (
    select 1 from public.daily_stock_closure_items item
    join public.stock_locations loc on loc.id = item.location_id
    where item.service_date = v_service_date and item.actual_quantity > 0 and loc.holds_inventory
  ) then
    insert into public.stock_movements (
      service_date, kind, from_location_id, to_location_id,
      note, idempotency_key, recorded_by
    ) values (
      v_service_date, 'return_to_factory', v_truck_id, null,
      'ส่งยอดน้ำแข็งนับจริงคงเหลือทั้งหมดกลับโรงงาน', gen_random_uuid(), auth.uid()
    ) returning id into v_movement_id;

    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    select v_movement_id, item.ice_type_id, sum(item.actual_quantity)
    from public.daily_stock_closure_items item
    join public.stock_locations loc on loc.id = item.location_id
    where item.service_date = v_service_date and item.actual_quantity > 0 and loc.holds_inventory
    group by item.ice_type_id;
  end if;

  -- Update daily_stock_closures status to closed
  update public.daily_stock_closures
  set status = 'closed', closed_at = clock_timestamp()
  where service_date = v_service_date;

  -- Log audit entry
  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'daily_stock_closures', p_idempotency_key::text, 'closed',
    jsonb_build_object(
      'service_date', v_service_date,
      'counts', p_counts,
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return public.get_daily_stock_close_state(
    p_round_id => null,
    p_service_date => v_service_date
  );
end;
$$;

