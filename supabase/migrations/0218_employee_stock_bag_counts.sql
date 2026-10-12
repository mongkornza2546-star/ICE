-- Preserve old totals without inventing historical full/half splits.
alter table public.ice_types add column allow_half boolean not null default true;
update public.ice_types set allow_half = false where name = 'หลอดเล็กโม่';
alter table public.stock_movement_items
  add column full_bags integer,
  add column half_bags integer,
  add constraint stock_movement_items_bag_counts_check check (
    (full_bags is null and half_bags is null) or
    (full_bags is not null and half_bags is not null and full_bags >= 0 and half_bags >= 0
      and quantity = full_bags::numeric + half_bags::numeric * 0.5)
  );

-- Employee withdrawals must decode half bags without integer conversion.
-- Keep numeric unscaled until validation to reject fractions such as 0.25.

create or replace function public.record_employee_stock_transfer(
  p_round_id uuid,
  p_items jsonb,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state jsonb;
  v_service_date date;
  v_round_status public.delivery_round_status;
  v_truck_location_id uuid;
  v_holding_location_id uuid;
  v_movement_id uuid;
  v_existing_movement_id uuid;
  v_existing_round_id uuid;
  v_existing_kind public.stock_movement_kind;
  v_existing_from_location_id uuid;
  v_existing_to_location_id uuid;
  v_existing_recorded_by uuid;
  v_requested_items jsonb;
  v_existing_items jsonb;
  v_item record;
begin
  if not public.is_active_user()
    or public.current_app_role() <> 'courier' then
    raise exception 'Only an active courier can receive employee stock';
  end if;

  if p_idempotency_key is null then
    raise exception 'An idempotency key is required';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) = 0 then
    raise exception 'Employee stock items must be a non-empty JSON array';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean)
    where item.ice_type_id is null or item.quantity is null or item.quantity <= 0
      or item.quantity * 2 <> trunc(item.quantity * 2)
  ) or exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean)
    group by item.ice_type_id
    having count(*) > 1
  ) then
    raise exception 'Every employee stock item must use a distinct ice type and a positive whole or half-bag quantity';
  end if;

  -- Legacy clients may omit both counts; new clients must provide a valid exact split.
  if exists (
    select 1 from jsonb_to_recordset(p_items)
      as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric)
    join public.ice_types ice on ice.id = item.ice_type_id
    where (item."fullBags" is null) <> (item."halfBags" is null)
      or item."fullBags" < 0 or item."halfBags" < 0
      or item."fullBags" <> trunc(item."fullBags") or item."halfBags" <> trunc(item."halfBags")
      or item.quantity <> item."fullBags" + item."halfBags" * 0.5
      or (not ice.allow_half and (coalesce(item."halfBags", 0) > 0 or item.quantity <> trunc(item.quantity)))
  ) then
    raise exception 'Invalid full/half bag counts for this ice type';
  end if;

  select jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object('ice_type_id', item.ice_type_id, 'quantity', item.quantity, 'fullBags', item."fullBags", 'halfBags', item."halfBags"))
    order by item.ice_type_id
  )
  into v_requested_items
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean);

  -- Concurrent retries for one client request must observe one committed row.
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  v_state := public.get_employee_stock_state(p_round_id);
  v_service_date := (v_state ->> 'service_date')::date;
  v_truck_location_id := (v_state -> 'truck_location' ->> 'id')::uuid;
  v_holding_location_id := (v_state -> 'holding_location' ->> 'id')::uuid;

  select
    movement.id,
    movement.round_id,
    movement.kind,
    movement.from_location_id,
    movement.to_location_id,
    movement.recorded_by,
    coalesce((
      select jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object('ice_type_id', item.ice_type_id, 'quantity', item.quantity, 'fullBags', item.full_bags, 'halfBags', item.half_bags))
        order by item.ice_type_id
      )
      from public.stock_movement_items item
      where item.movement_id = movement.id
    ), '[]'::jsonb)
  into
    v_existing_movement_id,
    v_existing_round_id,
    v_existing_kind,
    v_existing_from_location_id,
    v_existing_to_location_id,
    v_existing_recorded_by,
    v_existing_items
  from public.stock_movements movement
  where movement.idempotency_key = p_idempotency_key;

  if v_existing_movement_id is not null then
    if v_existing_recorded_by <> auth.uid() then
      raise exception 'This employee stock request belongs to another user';
    end if;

    if v_existing_round_id <> p_round_id
      or v_existing_kind <> 'transfer'
      or v_existing_from_location_id <> v_truck_location_id
      or v_existing_to_location_id <> v_holding_location_id
      or v_existing_items <> v_requested_items then
      raise exception 'This idempotency key belongs to a different employee stock request';
    end if;

    return v_state;
  end if;

  select round.status, round.service_date
  into v_round_status, v_service_date
  from public.delivery_rounds round
  where round.id = p_round_id
  for update;

  if v_round_status <> 'open' then
    raise exception 'This delivery round is already closed';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean)
    left join public.ice_types ice on ice.id = item.ice_type_id and ice.is_active
    where ice.id is null
  ) then
    raise exception 'Every employee stock item must use an active ice type';
  end if;

  -- Stock transfers, deliveries, and daily close share the same service-day lock.
  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if exists (
    select 1
    from public.daily_stock_closures closure
    where closure.service_date = v_service_date
      and closure.status = 'closed'
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  for v_item in
    select item.ice_type_id, item.quantity, coalesce(item."confirmedOverstock", false) as confirmed_overstock
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean)
  loop
    if public.stock_balance_at(v_service_date, v_truck_location_id, v_item.ice_type_id)
      < v_item.quantity and not v_item.confirmed_overstock then
      raise exception 'The truck does not have enough stock';
    end if;
  end loop;

  insert into public.stock_movements (
    service_date,
    round_id,
    kind,
    from_location_id,
    to_location_id,
    idempotency_key,
    recorded_by
  ) values (
    v_service_date,
    p_round_id,
    'transfer',
    v_truck_location_id,
    v_holding_location_id,
    p_idempotency_key,
    auth.uid()
  )
  returning id into v_movement_id;

  insert into public.stock_movement_items (movement_id, ice_type_id, quantity, full_bags, half_bags)
  select v_movement_id, item.ice_type_id, item.quantity, item."fullBags"::integer, item."halfBags"::integer
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean);

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(),
    'stock_movements',
    v_movement_id,
    'created',
    jsonb_build_object(
      'round_id', p_round_id,
      'service_date', v_service_date,
      'kind', 'transfer',
      'from_location_id', v_truck_location_id,
      'to_location_id', v_holding_location_id,
      'items', v_requested_items,
      'confirmed_overstock', exists (select 1 from jsonb_array_elements(p_items) item where item ->> 'confirmedOverstock' = 'true')
    )
  );

  return public.get_employee_stock_state(p_round_id);
end;
$$;

revoke all on function public.record_employee_stock_transfer(uuid, jsonb, uuid) from public;
grant execute on function public.record_employee_stock_transfer(uuid, jsonb, uuid) to authenticated;

-- Let couriers return remaining stock from their assigned holding point to
-- the configured courier-source truck while the round and stock day are open.

create or replace function public.record_employee_stock_return(
  p_round_id uuid,
  p_items jsonb,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state jsonb;
  v_service_date date;
  v_round_status public.delivery_round_status;
  v_truck_location_id uuid;
  v_holding_location_id uuid;
  v_movement_id uuid;
  v_existing_movement_id uuid;
  v_existing_round_id uuid;
  v_existing_kind public.stock_movement_kind;
  v_existing_recorded_by uuid;
  v_request_fingerprint text;
  v_existing_request_fingerprint text;
  v_requested_items jsonb;
  v_existing_items jsonb;
  v_item record;
begin
  if not public.is_active_user()
    or public.current_app_role() <> 'courier' then
    raise exception 'Only an active courier can return employee stock';
  end if;

  if p_idempotency_key is null then
    raise exception 'An idempotency key is required';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) = 0 then
    raise exception 'Employee stock return items must be a non-empty JSON array';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean)
    where item.ice_type_id is null or item.quantity is null or item.quantity <= 0
      or item.quantity * 2 <> trunc(item.quantity * 2)
  ) or exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean)
    group by item.ice_type_id
    having count(*) > 1
  ) then
    raise exception 'Every employee stock return item must use a distinct ice type and a positive whole or half-bag quantity';
  end if;

  -- Legacy clients may omit both counts; new clients must provide a valid exact split.
  if exists (
    select 1 from jsonb_to_recordset(p_items)
      as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric)
    join public.ice_types ice on ice.id = item.ice_type_id
    where (item."fullBags" is null) <> (item."halfBags" is null)
      or item."fullBags" < 0 or item."halfBags" < 0
      or item."fullBags" <> trunc(item."fullBags") or item."halfBags" <> trunc(item."halfBags")
      or item.quantity <> item."fullBags" + item."halfBags" * 0.5
      or (not ice.allow_half and (coalesce(item."halfBags", 0) > 0 or item.quantity <> trunc(item.quantity)))
  ) then
    raise exception 'Invalid full/half bag counts for this ice type';
  end if;

  select jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object('ice_type_id', item.ice_type_id, 'quantity', item.quantity, 'fullBags', item."fullBags", 'halfBags', item."halfBags"))
    order by item.ice_type_id
  )
  into v_requested_items
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean);

  -- Confirmation authorizes a new overdraw; it is not movement identity.
  -- Omitting it also preserves fingerprints written by quantity-only clients.
  select md5(jsonb_build_object(
    'operation', 'employee_stock_return',
    'round_id', p_round_id,
    'items', v_requested_items
  )::text)
  into v_request_fingerprint;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  v_state := public.get_employee_stock_state(p_round_id);
  v_service_date := (v_state ->> 'service_date')::date;
  v_truck_location_id := (v_state -> 'truck_location' ->> 'id')::uuid;
  v_holding_location_id := (v_state -> 'holding_location' ->> 'id')::uuid;

  select
    movement.id,
    movement.round_id,
    movement.kind,
    movement.recorded_by,
    movement.request_fingerprint,
    coalesce((
      select jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object('ice_type_id', item.ice_type_id, 'quantity', item.quantity, 'fullBags', item.full_bags, 'halfBags', item.half_bags))
        order by item.ice_type_id
      )
      from public.stock_movement_items item
      where item.movement_id = movement.id
    ), '[]'::jsonb)
  into
    v_existing_movement_id,
    v_existing_round_id,
    v_existing_kind,
    v_existing_recorded_by,
    v_existing_request_fingerprint,
    v_existing_items
  from public.stock_movements movement
  where movement.idempotency_key = p_idempotency_key;

  if v_existing_movement_id is not null then
    if v_existing_recorded_by <> auth.uid() then
      raise exception 'This employee stock return request belongs to another user';
    end if;

    if v_existing_round_id <> p_round_id
      or v_existing_kind <> 'transfer'
      or v_existing_request_fingerprint is distinct from v_request_fingerprint
      or v_existing_items <> v_requested_items then
      raise exception 'This idempotency key belongs to a different employee stock return request';
    end if;

    return v_state;
  end if;

  select round.status, round.service_date
  into v_round_status, v_service_date
  from public.delivery_rounds round
  where round.id = p_round_id
  for update;

  if v_round_status <> 'open' then
    raise exception 'This delivery round is already closed';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean)
    left join public.ice_types ice on ice.id = item.ice_type_id and ice.is_active
    where ice.id is null
  ) then
    raise exception 'Every employee stock return item must use an active ice type';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if exists (
    select 1
    from public.daily_stock_closures closure
    where closure.service_date = v_service_date
      and closure.status = 'closed'
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  for v_item in
    select item.ice_type_id, item.quantity, coalesce(item."confirmedOverstock", false) as confirmed_overstock
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean)
  loop
    if public.stock_balance_at(v_service_date, v_holding_location_id, v_item.ice_type_id)
      < v_item.quantity and not v_item.confirmed_overstock then
      raise exception 'The employee holding does not have enough stock';
    end if;
  end loop;

  insert into public.stock_movements (
    service_date,
    round_id,
    kind,
    from_location_id,
    to_location_id,
    idempotency_key,
    request_fingerprint,
    recorded_by
  ) values (
    v_service_date,
    p_round_id,
    'transfer',
    v_holding_location_id,
    v_truck_location_id,
    p_idempotency_key,
    v_request_fingerprint,
    auth.uid()
  )
  returning id into v_movement_id;

  insert into public.stock_movement_items (movement_id, ice_type_id, quantity, full_bags, half_bags)
  select v_movement_id, item.ice_type_id, item.quantity, item."fullBags"::integer, item."halfBags"::integer
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean);

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(),
    'stock_movements',
    v_movement_id,
    'created',
    jsonb_build_object(
      'round_id', p_round_id,
      'service_date', v_service_date,
      'kind', 'transfer',
      'purpose', 'employee_return',
      'from_location_id', v_holding_location_id,
      'to_location_id', v_truck_location_id,
      'items', v_requested_items,
      'confirmed_overstock', exists (select 1 from jsonb_array_elements(p_items) item where item ->> 'confirmedOverstock' = 'true')
    )
  );

  return public.get_employee_stock_state(p_round_id);
end;
$$;

revoke all on function public.record_employee_stock_return(uuid, jsonb, uuid) from public;
grant execute on function public.record_employee_stock_return(uuid, jsonb, uuid) to authenticated;

-- Let an assigned courier record melted or damaged stock only from their own
-- holding location while the selected round and stock day remain open.

create or replace function public.record_employee_stock_damage(
  p_round_id uuid,
  p_items jsonb,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state jsonb;
  v_service_date date;
  v_round_status public.delivery_round_status;
  v_holding_location_id uuid;
  v_movement_id uuid;
  v_existing_movement_id uuid;
  v_existing_round_id uuid;
  v_existing_kind public.stock_movement_kind;
  v_existing_recorded_by uuid;
  v_request_fingerprint text;
  v_existing_request_fingerprint text;
  v_requested_items jsonb;
  v_existing_items jsonb;
  v_item record;
begin
  if not public.is_active_user() or public.current_app_role() <> 'courier' then
    raise exception 'Only an active courier can record employee stock damage';
  end if;

  if p_idempotency_key is null then
    raise exception 'An idempotency key is required';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Employee stock damage items must be a non-empty JSON array';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean)
    where item.ice_type_id is null or item.quantity is null or item.quantity <= 0
      or item.quantity * 2 <> trunc(item.quantity * 2)
  ) or exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean)
    group by item.ice_type_id
    having count(*) > 1
  ) then
    raise exception 'Every employee stock damage item must use a distinct ice type and a positive whole or half-bag quantity';
  end if;

  -- Legacy clients may omit both counts; new clients must provide a valid exact split.
  if exists (
    select 1 from jsonb_to_recordset(p_items)
      as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric)
    join public.ice_types ice on ice.id = item.ice_type_id
    where (item."fullBags" is null) <> (item."halfBags" is null)
      or item."fullBags" < 0 or item."halfBags" < 0
      or item."fullBags" <> trunc(item."fullBags") or item."halfBags" <> trunc(item."halfBags")
      or item.quantity <> item."fullBags" + item."halfBags" * 0.5
      or (not ice.allow_half and (coalesce(item."halfBags", 0) > 0 or item.quantity <> trunc(item.quantity)))
  ) then
    raise exception 'Invalid full/half bag counts for this ice type';
  end if;

  select jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object('ice_type_id', item.ice_type_id, 'quantity', item.quantity, 'fullBags', item."fullBags", 'halfBags', item."halfBags"))
    order by item.ice_type_id
  ) into v_requested_items
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean);

  -- Keep retry identity stable across balance refreshes and legacy clients.
  select md5(jsonb_build_object(
    'operation', 'employee_stock_damage',
    'round_id', p_round_id,
    'items', v_requested_items
  )::text) into v_request_fingerprint;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  v_state := public.get_employee_stock_state(p_round_id);
  v_service_date := (v_state ->> 'service_date')::date;
  v_holding_location_id := (v_state -> 'holding_location' ->> 'id')::uuid;

  select movement.id, movement.round_id, movement.kind, movement.recorded_by,
    movement.request_fingerprint,
    coalesce((
      select jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object('ice_type_id', item.ice_type_id, 'quantity', item.quantity, 'fullBags', item.full_bags, 'halfBags', item.half_bags))
        order by item.ice_type_id
      )
      from public.stock_movement_items item
      where item.movement_id = movement.id
    ), '[]'::jsonb)
  into v_existing_movement_id, v_existing_round_id, v_existing_kind,
    v_existing_recorded_by, v_existing_request_fingerprint, v_existing_items
  from public.stock_movements movement
  where movement.idempotency_key = p_idempotency_key;

  if v_existing_movement_id is not null then
    if v_existing_recorded_by <> auth.uid() then
      raise exception 'This employee stock damage request belongs to another user';
    end if;
    if v_existing_round_id <> p_round_id or v_existing_kind <> 'damage'
      or v_existing_request_fingerprint is distinct from v_request_fingerprint
      or v_existing_items <> v_requested_items then
      raise exception 'This idempotency key belongs to a different employee stock damage request';
    end if;
    return v_state;
  end if;

  select round.status, round.service_date
  into v_round_status, v_service_date
  from public.delivery_rounds round
  where round.id = p_round_id
  for update;

  if v_round_status <> 'open' then
    raise exception 'This delivery round is already closed';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean)
    left join public.ice_types ice on ice.id = item.ice_type_id and ice.is_active
    where ice.id is null
  ) then
    raise exception 'Every employee stock damage item must use an active ice type';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if exists (
    select 1 from public.daily_stock_closures closure
    where closure.service_date = v_service_date and closure.status = 'closed'
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  for v_item in
    select item.ice_type_id, item.quantity, coalesce(item."confirmedOverstock", false) as confirmed_overstock
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean)
  loop
    if public.stock_balance_at(v_service_date, v_holding_location_id, v_item.ice_type_id)
      < v_item.quantity and not v_item.confirmed_overstock then
      raise exception 'The employee holding does not have enough stock';
    end if;
    if public.daily_aggregate_stock_balance_at(v_service_date, v_item.ice_type_id)
      < v_item.quantity and not v_item.confirmed_overstock then
      raise exception 'Daily aggregate stock does not have enough stock';
    end if;
  end loop;

  insert into public.stock_movements (
    service_date, round_id, kind, from_location_id, to_location_id,
    idempotency_key, request_fingerprint, recorded_by
  ) values (
    v_service_date, p_round_id, 'damage', v_holding_location_id, null,
    p_idempotency_key, v_request_fingerprint, auth.uid()
  ) returning id into v_movement_id;

  insert into public.stock_movement_items (movement_id, ice_type_id, quantity, full_bags, half_bags)
  select v_movement_id, item.ice_type_id, item.quantity, item."fullBags"::integer, item."halfBags"::integer
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric, "fullBags" numeric, "halfBags" numeric, "confirmedOverstock" boolean);

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'stock_movements', v_movement_id, 'created',
    jsonb_build_object(
      'round_id', p_round_id, 'service_date', v_service_date,
      'kind', 'damage', 'purpose', 'employee_damage',
      'from_location_id', v_holding_location_id, 'items', v_requested_items,
      'confirmed_overstock', exists (select 1 from jsonb_array_elements(p_items) item where item ->> 'confirmedOverstock' = 'true')
    )
  );

  return public.get_employee_stock_state(p_round_id);
end;
$$;

revoke all on function public.record_employee_stock_damage(uuid, jsonb, uuid) from public;
grant execute on function public.record_employee_stock_damage(uuid, jsonb, uuid) to authenticated;

