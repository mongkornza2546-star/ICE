-- Migration 0042: Daily Work Session Architecture (1 Work Session per service_date)

-- 1. Preserve every legacy round as special. Daily sessions are created only
-- by ensure_daily_delivery_round, which always writes round_type explicitly.
alter table public.delivery_rounds
  add column if not exists round_type text;

update public.delivery_rounds
set round_type = 'special'
where round_type is null;

alter table public.delivery_rounds
  alter column round_type set default 'special',
  alter column round_type set not null;

alter table public.delivery_rounds
  add constraint delivery_rounds_round_type_check
  check (round_type in ('daily', 'special'));

-- 2. A service date has at most one non-cancelled daily session, including its
-- closed historical record.
create unique index if not exists delivery_rounds_daily_unique_idx
  on public.delivery_rounds (service_date)
  where (round_type = 'daily' and cancelled_at is null);

-- 3. Update validate_delivery_round_name trigger to exempt system daily rounds ("งานประจำวัน")
create or replace function public.validate_delivery_round_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.round_type = 'daily' then
    if new.name <> 'งานประจำวัน' then
      raise exception 'Daily delivery rounds must use the system name';
    end if;
    return new;
  end if;

  if not exists (
    select 1 from public.delivery_round_name_options option
    where option.name = new.name and option.is_active
  ) then
    raise exception 'Delivery round name must be an active configured option';
  end if;

  return new;
end;
$$;

drop trigger if exists delivery_rounds_validate_configured_name
on public.delivery_rounds;

create trigger delivery_rounds_validate_configured_name
before insert or update of name, round_type on public.delivery_rounds
for each row execute function public.validate_delivery_round_name();

-- 4. Helper RPC: ensure_daily_delivery_round
create or replace function public.ensure_daily_delivery_round(
  p_service_date date
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_id uuid;
  v_expected_stop_count integer;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can create a daily delivery round';
  end if;

  if p_service_date is null then
    raise exception 'A service date is required to ensure a daily delivery round';
  end if;

  -- Lock service date to prevent concurrent creation race conditions
  perform pg_advisory_xact_lock(hashtextextended(p_service_date::text, 0));

  -- Check if an active daily round already exists for p_service_date
  select id into v_round_id
  from public.delivery_rounds
  where service_date = p_service_date
    and round_type = 'daily'
    and cancelled_at is null
  order by created_at asc
  limit 1;

  if v_round_id is not null then
    return v_round_id;
  end if;

  -- Verify active shops exist
  select count(*)
  into v_expected_stop_count
  from public.shops s
  join public.buildings b on b.id = s.building_id and b.is_active
  where s.status = 'active';

  if v_expected_stop_count = 0 then
    raise exception 'At least one active shop is required to create a daily delivery round';
  end if;

  -- Create new daily delivery round
  insert into public.delivery_rounds (service_date, name, round_type, status, opened_by)
  values (p_service_date, 'งานประจำวัน', 'daily', 'open', auth.uid())
  returning id into v_round_id;

  -- Bind all active couriers and round leads as members
  insert into public.delivery_round_members (round_id, user_id)
  select v_round_id, u.id
  from public.users u
  where u.is_active and u.role in ('courier', 'round_lead', 'admin')
  on conflict (round_id, user_id) do nothing;

  -- Populate round stops with active shops
  insert into public.round_stops (
    round_id,
    shop_id,
    shop_code_snapshot,
    shop_name_snapshot,
    building_id_snapshot,
    building_name_snapshot,
    floor_or_zone_snapshot,
    sequence_no,
    updated_by
  )
  select
    v_round_id,
    s.id,
    s.code,
    s.name,
    s.building_id,
    b.name,
    s.floor_or_zone,
    row_number() over (order by b.name, s.floor_or_zone, s.code),
    auth.uid()
  from public.shops s
  join public.buildings b on b.id = s.building_id and b.is_active
  where s.status = 'active';

  -- Populate ice count trackers
  insert into public.round_ice_counts (
    round_id,
    ice_type_id,
    loaded_quantity,
    replenished_quantity,
    remaining_quantity,
    damaged_quantity,
    updated_by
  )
  select
    v_round_id,
    ice.id,
    0,
    0,
    0,
    0,
    auth.uid()
  from public.ice_types ice
  where ice.is_active;

  return v_round_id;
end;
$$;

-- 5. Update record_factory_order to auto-create daily delivery round on first order of the day
create or replace function public.record_factory_order(
  p_service_date date,
  p_truck_location_id uuid,
  p_items jsonb,
  p_note text default null,
  p_idempotency_key uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.stock_movements%rowtype;
  v_item record;
  v_movement_id uuid;
  v_daily_round_id uuid;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can record factory orders';
  end if;

  if p_service_date is null then
    raise exception 'A factory order service date is required';
  end if;

  if p_truck_location_id is null then
    raise exception 'A factory order truck location is required';
  end if;

  if p_idempotency_key is null then
    raise exception 'A factory order idempotency key is required';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) = 0 then
    raise exception 'Factory order items must be a non-empty JSON array';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
    where item.ice_type_id is null
      or item.quantity is null
      or item.quantity <= 0
  ) or exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
    group by item.ice_type_id
    having count(*) > 1
  ) then
    raise exception 'Every factory order item must use a distinct ice type and a positive quantity';
  end if;

  -- Lock and resolve retry
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select movement.* into v_existing
  from public.stock_movements movement
  where movement.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.kind <> 'factory_order'
      or v_existing.service_date <> p_service_date
      or v_existing.from_location_id is not null
      or v_existing.to_location_id is distinct from p_truck_location_id
      or v_existing.note is distinct from nullif(trim(coalesce(p_note, '')), '')
      or coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'ice_type_id', item.ice_type_id,
              'quantity', item.quantity
            ) order by item.ice_type_id
          )
          from public.stock_movement_items item
          where item.movement_id = v_existing.id
        ), '[]'::jsonb) is distinct from (
          select jsonb_agg(
            jsonb_build_object(
              'ice_type_id', item.ice_type_id,
              'quantity', item.quantity
            ) order by item.ice_type_id
          )
          from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
        ) then
      raise exception 'This idempotency key belongs to another factory order';
    end if;
    return public.get_factory_order_summary(p_service_date, p_truck_location_id, 50);
  end if;

  -- Keep the original ice-retirement lock order.
  for v_item in
    select item.ice_type_id
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid)
    order by item.ice_type_id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('ice_type:' || v_item.ice_type_id::text, 0)
    );
  end loop;

  perform pg_advisory_xact_lock(hashtextextended(p_service_date::text, 0));

  if exists (
    select 1
    from public.daily_stock_closures
    where service_date = p_service_date and status = 'closed'
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  if not exists (
    select 1
    from public.stock_locations location
    where location.id = p_truck_location_id
      and location.kind = 'truck'
      and location.is_active
  ) then
    raise exception 'Factory orders require an active truck location';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid)
    left join public.ice_types ice
      on ice.id = item.ice_type_id and ice.is_active
    where ice.id is null
  ) then
    raise exception 'Every factory order item must use an active ice type';
  end if;

  -- Automatically ensure daily delivery round exists for this service_date
  v_daily_round_id := public.ensure_daily_delivery_round(p_service_date);

  insert into public.stock_movements (
    service_date,
    round_id,
    kind,
    from_location_id,
    to_location_id,
    note,
    idempotency_key,
    recorded_by
  ) values (
    p_service_date,
    v_daily_round_id,
    'factory_order',
    null,
    p_truck_location_id,
    nullif(trim(coalesce(p_note, '')), ''),
    p_idempotency_key,
    auth.uid()
  ) returning id into v_movement_id;

  insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
  select v_movement_id, item.ice_type_id, item.quantity
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer);

  insert into public.audit_logs (
    actor_id,
    entity_type,
    entity_id,
    action,
    after_value
  ) values (
    auth.uid(),
    'stock_movements',
    v_movement_id,
    'created',
    jsonb_build_object(
      'round_id', v_daily_round_id,
      'service_date', p_service_date,
      'kind', 'factory_order',
      'from_location_id', null,
      'truck_location_id', p_truck_location_id,
      'items', p_items,
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return public.get_factory_order_summary(p_service_date, p_truck_location_id, 50);
end;
$$;

-- 6. Server-Side Employee Active Session Resolution RPC
create or replace function public.get_employee_active_session(
  p_service_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_date date := coalesce(
    p_service_date,
    (clock_timestamp() at time zone 'Asia/Bangkok')::date
  );
  v_rounds jsonb;
  v_count integer;
begin
  if not public.is_active_user() then
    raise exception 'User is not active';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'id', r.id,
      'service_date', r.service_date,
      'name', r.name,
      'round_type', r.round_type,
      'status', r.status,
      'opened_at', r.opened_at,
      'cancelled_at', r.cancelled_at
    ) order by r.created_at asc
  ), count(*)
  into v_rounds, v_count
  from public.delivery_rounds r
  where r.service_date = v_service_date
    and r.status = 'open'
    and r.cancelled_at is null
    and (
      public.current_app_role() in ('admin', 'round_lead')
      or exists (
        select 1
        from public.delivery_round_members member
        where member.round_id = r.id
          and member.user_id = auth.uid()
      )
    );

  v_rounds := coalesce(v_rounds, '[]'::jsonb);

  return jsonb_build_object(
    'single_session', (v_count = 1),
    'active_round', case when v_count = 1 then v_rounds->0 else null end,
    'sessions', v_rounds
  );
end;
$$;

-- 7. Atomic EOD Daily Stock & Session Closure (Problem 1 Fix)
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
  v_existing_id uuid;
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

  select id, service_date, request_fingerprint
  into v_existing_id, v_existing_date, v_existing_fingerprint
  from public.daily_stock_closures
  where idempotency_key = p_idempotency_key;

  if v_existing_id is not null then
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

-- The ensure helper is internal to privileged SECURITY DEFINER workflows.
revoke all on function public.ensure_daily_delivery_round(date) from public;
revoke all on function public.get_employee_active_session(date) from public;
grant execute on function public.get_employee_active_session(date) to authenticated;
