-- Damage movements are day-level, source-only stock movements. They do not
-- belong to a delivery round and their operator note is optional.

alter table public.stock_movements
  drop constraint if exists stock_movements_round_or_factory_order_check;

alter table public.stock_movements
  add constraint stock_movements_round_or_factory_order_check
  check (
    round_id is not null
    or kind in ('factory_order', 'transfer', 'return_to_factory', 'damage')
  );

create or replace function public.record_stock_transfer_v2(
  p_service_date date,
  p_purpose text,
  p_from_location_id uuid,
  p_to_location_id uuid,
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
  v_movement_id uuid;
  v_existing_id uuid;
  v_existing_date date;
  v_existing_fingerprint text;
  v_request_fingerprint text;
  v_from_kind public.stock_location_kind;
  v_from_holds boolean;
  v_from_courier boolean;
  v_from_active boolean;
  v_to_kind public.stock_location_kind;
  v_to_holds boolean;
  v_to_courier boolean;
  v_to_active boolean;
  v_movement_kind public.stock_movement_kind;
  v_db_to_location_id uuid;
  v_purpose text := p_purpose;
  v_item record;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can record stock transfers';
  end if;

  if p_service_date is null then
    raise exception 'A stock service date is required';
  end if;

  if p_idempotency_key is null then
    raise exception 'A stock-transfer idempotency key is required';
  end if;

  -- Validate and normalize items before comparing an idempotent replay.
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Stock transfer items must be a non-empty JSON array';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
    left join public.ice_types ice on ice.id = item.ice_type_id and ice.is_active
    where item.ice_type_id is null or item.quantity is null or item.quantity <= 0
      or item.quantity * 2 <> trunc(item.quantity * 2) or ice.id is null
  ) or exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
    group by item.ice_type_id
    having count(*) > 1
  ) then
    raise exception 'Every stock item must use a distinct active ice type and a positive whole or half-bag quantity';
  end if;

  select md5(jsonb_build_object(
    'operation', 'stock_transfer_v2',
    'service_date', p_service_date,
    'purpose', p_purpose,
    'from_location_id', p_from_location_id,
    'to_location_id', p_to_location_id,
    'items', (
      select jsonb_agg(
        jsonb_build_object('ice_type_id', item.ice_type_id, 'quantity', item.quantity)
        order by item.ice_type_id
      )
      from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
    ),
    'note', nullif(trim(p_note), '')
  )::text) into v_request_fingerprint;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select m.id, m.service_date, m.request_fingerprint
  into v_existing_id, v_existing_date, v_existing_fingerprint
  from public.stock_movements m
  where m.idempotency_key = p_idempotency_key;

  if v_existing_id is not null then
    if v_existing_date <> p_service_date
      or v_existing_fingerprint is distinct from v_request_fingerprint then
      raise exception 'This idempotency key belongs to another stock transfer request';
    end if;
    return public.get_stock_control_summary(null, v_existing_date);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_service_date::text, 0));

  if exists (
    select 1 from public.daily_stock_closures
    where service_date = p_service_date and status = 'closed'
  ) then
    raise exception 'Cannot record stock transfer for a closed service date';
  end if;

  -- Load endpoint metadata
  select kind, holds_inventory, is_courier_source, is_active
  into v_from_kind, v_from_holds, v_from_courier, v_from_active
  from public.stock_locations where id = p_from_location_id;

  if p_to_location_id is not null then
    select kind, holds_inventory, is_courier_source, is_active
    into v_to_kind, v_to_holds, v_to_courier, v_to_active
    from public.stock_locations where id = p_to_location_id;
  end if;

  if v_purpose = 'auto' then
    v_purpose := case
      when v_from_kind = 'truck' and coalesce(v_from_courier, false)
        and v_to_kind in ('team', 'small_vehicle') then 'central_issue'
      when v_from_kind in ('team', 'small_vehicle')
        and v_to_kind in ('team', 'small_vehicle') then 'employee_handoff'
      when v_from_kind in ('team', 'small_vehicle', 'reserve_bin', 'front_vehicle')
        and v_to_kind = 'truck' and coalesce(v_to_courier, false) then 'return_to_central'
      else null
    end;
  end if;

  -- Validate active endpoints
  if p_from_location_id is not null and not coalesce(v_from_active, false) then
    raise exception 'Source location must be active';
  end if;
  if not coalesce(v_from_holds, false) then
    raise exception 'Source location must be a valid stock holder';
  end if;
  if v_purpose not in ('return_to_factory', 'damage') and p_to_location_id is not null and not coalesce(v_to_active, false) then
    raise exception 'Destination location must be active';
  end if;
  if p_to_location_id is not null and not coalesce(v_to_holds, false) then
    raise exception 'Destination location must be a valid stock holder';
  end if;

  -- Purpose matrix validation
  if v_purpose = 'central_issue' then
    if not coalesce(v_from_courier, false) or v_from_kind <> 'truck' then
      raise exception 'Source location must be the courier source truck';
    end if;
    if v_to_kind not in ('team', 'small_vehicle') then
      raise exception 'Destination location must be an employee holder';
    end if;
  elsif v_purpose = 'employee_handoff' then
    if v_from_kind not in ('team', 'small_vehicle') or v_to_kind not in ('team', 'small_vehicle') then
      raise exception 'Both source and destination must be employee holders';
    end if;
    if p_from_location_id = p_to_location_id then
      raise exception 'Source and destination locations cannot be the same';
    end if;
  elsif v_purpose = 'return_to_central' then
    if v_from_kind not in ('team', 'small_vehicle', 'reserve_bin', 'front_vehicle') then
      raise exception 'Source location must be an employee or fixed holder';
    end if;
    if not coalesce(v_to_courier, false) or v_to_kind <> 'truck' then
      raise exception 'Destination location must be the courier source truck';
    end if;
  elsif v_purpose = 'return_to_factory' then
    if not coalesce(v_from_holds, false) then
      raise exception 'Source location must be a valid stock holder';
    end if;
  elsif v_purpose = 'damage' then
    if not coalesce(v_from_holds, false) then
      raise exception 'Source location must be a valid stock holder';
    end if;
  else
    raise exception 'Invalid stock transfer purpose';
  end if;

  -- Check source balance
  for v_item in
    select item.ice_type_id, item.quantity
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
  loop
    if public.stock_balance_at(p_service_date, p_from_location_id, v_item.ice_type_id)
      < v_item.quantity then
      raise exception 'The source location does not have enough stock';
    end if;
  end loop;

  v_db_to_location_id := case when v_purpose in ('return_to_factory', 'damage') then null else p_to_location_id end;
  v_movement_kind := case
    when v_purpose = 'damage' then 'damage'::public.stock_movement_kind
    when v_purpose = 'return_to_factory' then 'return_to_factory'::public.stock_movement_kind
    else 'transfer'::public.stock_movement_kind
  end;

  insert into public.stock_movements (
    service_date, kind, from_location_id, to_location_id,
    note, idempotency_key, request_fingerprint, recorded_by
  ) values (
    p_service_date, v_movement_kind, p_from_location_id, v_db_to_location_id,
    nullif(trim(p_note), ''), p_idempotency_key, v_request_fingerprint, auth.uid()
  )
  returning id into v_movement_id;

  insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
  select v_movement_id, item.ice_type_id, item.quantity
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric);

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(),
    'stock_movements',
    v_movement_id,
    'created',
    jsonb_build_object(
      'service_date', p_service_date,
      'purpose', v_purpose,
      'kind', v_movement_kind,
      'from_location_id', p_from_location_id,
      'to_location_id', v_db_to_location_id,
      'items', p_items,
      'note', nullif(trim(p_note), '')
    )
  );

  return public.get_stock_control_summary(null, p_service_date);
end;
$$;

grant execute on function public.record_stock_transfer_v2(
  date, text, uuid, uuid, jsonb, text, uuid
) to authenticated;
