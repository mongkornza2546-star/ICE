-- Courier deliveries consume stock directly from the operational truck. Manager
-- deliveries keep using the stock source configured for the selected shop.

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
  v_active_truck_count integer;
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
    select location.id into v_source_location_id
    from public.stock_locations location
    where location.code = 'TRUCK-MAIN'
      and location.kind = 'truck'
      and location.is_active;

    if v_source_location_id is null then
      select count(*)::integer into v_active_truck_count
      from public.stock_locations location
      where location.kind = 'truck'
        and location.is_active;

      if v_active_truck_count = 0 then
        raise exception 'Employee delivery requires an active stock source; no active truck is configured';
      elsif v_active_truck_count > 1 then
        raise exception 'Employee delivery requires an active stock source; multiple active trucks exist without TRUCK-MAIN';
      end if;

      select location.id into v_source_location_id
      from public.stock_locations location
      where location.kind = 'truck'
        and location.is_active;
    end if;
  else
    v_source_location_id := v_shop_source_location_id;
  end if;

  if not exists (
    select 1
    from public.stock_locations
    where id = v_source_location_id and is_active
  ) then
    raise exception 'The selected shop does not have an active stock source';
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
