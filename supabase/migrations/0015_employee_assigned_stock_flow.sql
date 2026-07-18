-- Employee stock is first transferred from the operational truck into the
-- employee's assigned holding point. Deliveries then consume that holding
-- point instead of deducting directly from the truck.

create or replace function public.get_employee_stock_state(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date;
  v_truck_location_id uuid;
  v_holding_location_id uuid;
  v_active_truck_count integer;
  v_active_holding_count integer;
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() <> 'courier' then
    raise exception 'Only an active courier can view employee stock';
  end if;

  select round.service_date
  into v_service_date
  from public.delivery_rounds round
  where round.id = p_round_id;

  if v_service_date is null then
    raise exception 'The selected delivery round does not exist';
  end if;

  if not public.is_round_member(p_round_id) then
    raise exception 'You are not assigned to this delivery round';
  end if;

  select location.id
  into v_truck_location_id
  from public.stock_locations location
  where location.code = 'TRUCK-MAIN'
    and location.kind = 'truck'
    and location.is_active;

  if v_truck_location_id is null then
    select count(*)::integer
    into v_active_truck_count
    from public.stock_locations location
    where location.kind = 'truck'
      and location.is_active;

    if v_active_truck_count = 0 then
      raise exception 'Employee stock requires an active truck; no active truck is configured';
    elsif v_active_truck_count > 1 then
      raise exception 'Employee stock requires one active truck when TRUCK-MAIN is unavailable';
    end if;

    select location.id
    into v_truck_location_id
    from public.stock_locations location
    where location.kind = 'truck'
      and location.is_active;
  end if;

  select count(*)::integer
  into v_active_holding_count
  from public.stock_locations location
  where location.assigned_user_id = auth.uid()
    and location.kind in ('team', 'small_vehicle')
    and location.is_active;

  if v_active_holding_count = 0 then
    raise exception 'Employee stock requires one active assigned holding location; none is configured';
  elsif v_active_holding_count > 1 then
    raise exception 'Employee stock requires one active assigned holding location; multiple are configured';
  end if;

  select location.id
  into v_holding_location_id
  from public.stock_locations location
  where location.assigned_user_id = auth.uid()
    and location.kind in ('team', 'small_vehicle')
    and location.is_active;

  select jsonb_build_object(
    'round_id', p_round_id,
    'service_date', v_service_date,
    'truck_location', jsonb_build_object(
      'id', truck.id,
      'code', truck.code,
      'name', truck.name,
      'balances', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'ice_type_id', ice.id,
            'ice_type_name', ice.name,
            'unit', ice.unit,
            'quantity', public.stock_balance_at(v_service_date, truck.id, ice.id)
          ) order by ice.code
        ), '[]'::jsonb)
        from public.ice_types ice
        where ice.is_active
      )
    ),
    'holding_location', jsonb_build_object(
      'id', holding.id,
      'code', holding.code,
      'name', holding.name,
      'balances', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'ice_type_id', ice.id,
            'ice_type_name', ice.name,
            'unit', ice.unit,
            'quantity', public.stock_balance_at(v_service_date, holding.id, ice.id)
          ) order by ice.code
        ), '[]'::jsonb)
        from public.ice_types ice
        where ice.is_active
      )
    )
  )
  into v_result
  from public.stock_locations truck
  cross join public.stock_locations holding
  where truck.id = v_truck_location_id
    and holding.id = v_holding_location_id;

  return v_result;
end;
$$;

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
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
    where item.ice_type_id is null or item.quantity is null or item.quantity <= 0
  ) or exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
    group by item.ice_type_id
    having count(*) > 1
  ) then
    raise exception 'Every employee stock item must use a distinct ice type and a positive quantity';
  end if;

  select jsonb_agg(
    jsonb_build_object('ice_type_id', item.ice_type_id, 'quantity', item.quantity)
    order by item.ice_type_id
  )
  into v_requested_items
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer);

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
        jsonb_build_object('ice_type_id', item.ice_type_id, 'quantity', item.quantity)
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
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
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
    select item.ice_type_id, item.quantity
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
  loop
    if public.stock_balance_at(v_service_date, v_truck_location_id, v_item.ice_type_id)
      < v_item.quantity then
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

  insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
  select v_movement_id, item.ice_type_id, item.quantity
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer);

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
      'items', v_requested_items
    )
  );

  return public.get_employee_stock_state(p_round_id);
end;
$$;

-- Keep the existing delivery transaction intact while changing only the source
-- selected for a courier sale.
create or replace function public.record_delivery(
  p_round_stop_id uuid,
  p_items jsonb,
  p_stop_status public.shop_round_status default 'delivered',
  p_note text default null,
  p_client_recorded_at timestamptz default null,
  p_idempotency_key uuid default gen_random_uuid()
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
  v_shop_source_location_id uuid;
  v_source_location_id uuid;
  v_active_holding_count integer;
  v_event_id uuid;
  v_existing_event_id uuid;
  v_existing_round_stop_id uuid;
  v_item_count integer;
  v_item record;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  end if;

  -- A concurrent retry must observe the first committed event before checking
  -- the now-reduced stock balance.
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select e.id, e.round_stop_id
  into v_existing_event_id, v_existing_round_stop_id
  from public.delivery_events e
  where e.idempotency_key = p_idempotency_key;

  if v_existing_event_id is not null then
    if not public.is_delivery_event_visible(v_existing_event_id) then
      raise exception 'This delivery request cannot be viewed by the current user';
    end if;
    if v_existing_round_stop_id <> p_round_stop_id then
      raise exception 'This idempotency key belongs to a different shop';
    end if;
    return public.delivery_event_response(v_existing_event_id);
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Delivery items must be a JSON array';
  end if;

  select s.round_id, r.status, r.service_date, shop.stock_location_id
  into v_round_id, v_round_status, v_service_date, v_shop_source_location_id
  from public.round_stops s
  join public.delivery_rounds r on r.id = s.round_id
  join public.shops shop on shop.id = s.shop_id
  where s.id = p_round_stop_id
  for update of r;

  if v_round_id is null then
    raise exception 'The selected shop is not in a delivery round';
  end if;

  if public.current_app_role() not in ('admin', 'round_lead')
    and not public.is_round_member(v_round_id) then
    raise exception 'You are not assigned to this delivery round';
  end if;

  if v_round_status <> 'open' then
    raise exception 'This delivery round is already closed';
  end if;

  if public.current_app_role() = 'courier' then
    select count(*)::integer
    into v_active_holding_count
    from public.stock_locations location
    where location.assigned_user_id = auth.uid()
      and location.kind in ('team', 'small_vehicle')
      and location.is_active;

    if v_active_holding_count = 0 then
      raise exception 'Employee delivery requires one active assigned holding location; none is configured';
    elsif v_active_holding_count > 1 then
      raise exception 'Employee delivery requires one active assigned holding location; multiple are configured';
    end if;

    select location.id
    into v_source_location_id
    from public.stock_locations location
    where location.assigned_user_id = auth.uid()
      and location.kind in ('team', 'small_vehicle')
      and location.is_active;
  else
    v_source_location_id := v_shop_source_location_id;
  end if;

  if not exists (
    select 1
    from public.stock_locations
    where id = v_source_location_id and is_active
  ) then
    raise exception 'The selected stock source is not active';
  end if;

  -- Serialize every checked stock deduction for this service date, including
  -- deliveries from other rounds and manual transfers recorded by a manager.
  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  select count(*)
  into v_item_count
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer);

  if p_stop_status = 'pending' then
    raise exception 'A delivery record cannot reset a shop to pending';
  elsif p_stop_status = 'delivered' then
    if v_item_count = 0 then
      raise exception 'A delivered shop requires at least one ice item';
    end if;
  elsif v_item_count <> 0 or nullif(trim(coalesce(p_note, '')), '') is null then
    raise exception 'A non-delivery status requires a note and cannot include ice items';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
    left join public.ice_types ice on ice.id = item.ice_type_id and ice.is_active
    where item.ice_type_id is null or item.quantity is null or item.quantity <= 0 or ice.id is null
  ) or exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
    group by item.ice_type_id
    having count(*) > 1
  ) then
    raise exception 'Every delivery item must use a distinct active ice type and a positive quantity';
  end if;

  for v_item in
    select item.ice_type_id, item.quantity
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
  loop
    if public.stock_balance_at(v_service_date, v_source_location_id, v_item.ice_type_id)
      < v_item.quantity then
      raise exception 'The source location does not have enough stock';
    end if;
  end loop;

  insert into public.delivery_events (
    round_stop_id,
    recorded_by,
    client_recorded_at,
    idempotency_key,
    note,
    source_stock_location_id
  )
  values (
    p_round_stop_id,
    auth.uid(),
    p_client_recorded_at,
    p_idempotency_key,
    nullif(trim(coalesce(p_note, '')), ''),
    v_source_location_id
  )
  on conflict (idempotency_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select id, round_stop_id
    into v_event_id, v_existing_round_stop_id
    from public.delivery_events
    where idempotency_key = p_idempotency_key;
    if v_event_id is null or not public.is_delivery_event_visible(v_event_id) then
      raise exception 'This delivery request cannot be viewed by the current user';
    end if;
    if v_existing_round_stop_id <> p_round_stop_id then
      raise exception 'This idempotency key belongs to a different shop';
    end if;
    return public.delivery_event_response(v_event_id);
  end if;

  insert into public.delivery_items (delivery_event_id, ice_type_id, quantity)
  select v_event_id, item.ice_type_id, item.quantity
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer);

  update public.round_stops
  set status = p_stop_status,
      note = nullif(trim(coalesce(p_note, '')), ''),
      updated_by = auth.uid(),
      updated_at = now()
  where id = p_round_stop_id;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(),
    'delivery_events',
    v_event_id,
    'created',
    jsonb_build_object(
      'round_stop_id', p_round_stop_id,
      'items', p_items,
      'stop_status', p_stop_status,
      'note', nullif(trim(coalesce(p_note, '')), ''),
      'source_stock_location_id', v_source_location_id
    )
  );

  return public.delivery_event_response(v_event_id);
end;
$$;

revoke all on function public.get_employee_stock_state(uuid) from public;
revoke all on function public.record_employee_stock_transfer(uuid, jsonb, uuid) from public;
grant execute on function public.get_employee_stock_state(uuid) to authenticated;
grant execute on function public.record_employee_stock_transfer(uuid, jsonb, uuid) to authenticated;
