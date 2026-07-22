-- Add self-referencing foreign keys to stock_movements to link replacements
alter table public.stock_movements
  add column if not exists original_movement_id uuid references public.stock_movements(id),
  add column if not exists replacement_movement_id uuid references public.stock_movements(id),
  add column if not exists request_fingerprint text;

-- RPC for recording stock transfers with purpose validation
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
    if p_note is null or nullif(trim(p_note), '') is null then
      raise exception 'Damage requires a note';
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

-- RPC for revising/cancelling a stock movement (Append-only)
create or replace function public.revise_stock_movement(
  p_movement_id uuid,
  p_items jsonb,
  p_note text,
  p_reason text,
  p_idempotency_key uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_orig public.stock_movements%rowtype;
  v_existing_id uuid;
  v_existing_date date;
  v_replacement_id uuid;
  v_item record;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can revise stock movements';
  end if;

  if p_reason is null or nullif(trim(p_reason), '') is null then
    raise exception 'A revision reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select id, service_date into v_existing_id, v_existing_date
  from public.stock_movements
  where idempotency_key = p_idempotency_key;

  if v_existing_id is not null then
    return public.get_stock_control_summary(null, v_existing_date);
  end if;

  select * into v_orig
  from public.stock_movements
  where id = p_movement_id and status = 'active'
  for update;

  if v_orig.id is null then
    raise exception 'The stock movement does not exist or is already cancelled';
  end if;

  if exists (
    select 1 from public.daily_stock_closures
    where service_date = v_orig.service_date and status = 'closed'
  ) then
    raise exception 'Cannot revise stock movement for a closed service date';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_orig.service_date::text, 0));

  -- 1. Check if destination has enough stock to return (since we cancel it)
  if v_orig.to_location_id is not null then
    for v_item in
      select item.ice_type_id, item.quantity
      from public.stock_movement_items item
      where item.movement_id = p_movement_id
    loop
      if public.stock_balance_at(v_orig.service_date, v_orig.to_location_id, v_item.ice_type_id)
        < v_item.quantity then
        raise exception 'The destination location does not have enough stock to return';
      end if;
    end loop;
  end if;

  -- 2. Mark original movement as cancelled
  update public.stock_movements
  set status = 'cancelled',
      cancelled_by = auth.uid(),
      cancelled_at = clock_timestamp(),
      cancellation_reason = trim(p_reason)
  where id = p_movement_id;

  -- 3. Validate new items
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Stock movement items must be a JSON array';
  end if;

  -- If replacement items is empty, this is a pure cancellation without replacement
  if jsonb_array_length(p_items) > 0 then
    if exists (
      select 1
      from public.stock_locations location
      where location.id in (v_orig.from_location_id, v_orig.to_location_id)
        and (not location.is_active or not location.holds_inventory)
    ) then
      raise exception 'A revised transfer can only use active stock holders';
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

    -- 4. Check if source has enough stock for the new quantities (with original cancelled)
    if v_orig.from_location_id is not null then
      for v_item in
        select item.ice_type_id, item.quantity
        from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
      loop
        if public.stock_balance_at(v_orig.service_date, v_orig.from_location_id, v_item.ice_type_id)
          < v_item.quantity then
          raise exception 'The source location does not have enough stock for the revised transfer';
        end if;
      end loop;
    end if;

    -- 5. Insert replacement movement
    insert into public.stock_movements (
      service_date, round_id, kind, from_location_id, to_location_id,
      note, idempotency_key, recorded_by, original_movement_id
    ) values (
      v_orig.service_date, v_orig.round_id, v_orig.kind, v_orig.from_location_id, v_orig.to_location_id,
      nullif(trim(p_note), ''), p_idempotency_key, auth.uid(), p_movement_id
    )
    returning id into v_replacement_id;

    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    select v_replacement_id, item.ice_type_id, item.quantity
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric);

    -- Link back the replacement to original
    update public.stock_movements
    set replacement_movement_id = v_replacement_id
    where id = p_movement_id;
  end if;

  -- 6. Log audit records
  insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_value, after_value)
  values (
    auth.uid(),
    'stock_movements',
    p_movement_id,
    'revised',
    jsonb_build_object(
      'id', v_orig.id,
      'status', v_orig.status,
      'note', v_orig.note,
      'items', (
        select jsonb_agg(jsonb_build_object('ice_type_id', ice_type_id, 'quantity', quantity))
        from public.stock_movement_items where movement_id = p_movement_id
      )
    ),
    jsonb_build_object(
      'status', 'cancelled',
      'cancellation_reason', trim(p_reason),
      'replacement_id', v_replacement_id,
      'replacement_items', p_items,
      'replacement_note', nullif(trim(p_note), '')
    )
  );

  return public.get_stock_control_summary(null, v_orig.service_date);
end;
$$;

-- RPC for paginated movement history
create or replace function public.get_stock_movement_history_v2(
  p_service_date date,
  p_limit integer default 20,
  p_offset integer default 0
)
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
    raise exception 'Only a round lead or admin can view stock movement history';
  end if;

  select jsonb_build_object(
    'movements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'service_date', m.service_date,
        'kind', m.kind,
        'from_location_id', m.from_location_id,
        'from_location_name', from_loc.name,
        'to_location_id', m.to_location_id,
        'to_location_name', to_loc.name,
        'note', m.note,
        'status', m.status,
        'recorded_by', counter.display_name,
        'recorded_at', m.recorded_at,
        'cancelled_by', canceller.display_name,
        'cancelled_at', m.cancelled_at,
        'cancellation_reason', m.cancellation_reason,
        'original_movement_id', m.original_movement_id,
        'replacement_movement_id', m.replacement_movement_id,
        'items', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'ice_type_id', item.ice_type_id,
            'ice_type_name', ice.name,
            'unit', ice.unit,
            'quantity', item.quantity
          ) order by ice.code), '[]'::jsonb)
          from public.stock_movement_items item
          join public.ice_types ice on ice.id = item.ice_type_id
          where item.movement_id = m.id
        )
      ))
      from (
        select *
        from public.stock_movements
        where service_date = p_service_date
        order by recorded_at desc, id desc
        limit p_limit
        offset p_offset
      ) m
      left join public.stock_locations from_loc on from_loc.id = m.from_location_id
      left join public.stock_locations to_loc on to_loc.id = m.to_location_id
      left join public.users counter on counter.id = m.recorded_by
      left join public.users canceller on canceller.id = m.cancelled_by
    ), '[]'::jsonb),
    'total_count', (
      select count(*)::integer
      from public.stock_movements
      where service_date = p_service_date
    )
  ) into v_result;

  return v_result;
end;
$$;

-- Grant permissions to authenticated users
grant execute on function public.record_stock_transfer_v2(date, text, uuid, uuid, jsonb, text, uuid) to authenticated;
grant execute on function public.revise_stock_movement(uuid, jsonb, text, text, uuid) to authenticated;
grant execute on function public.get_stock_movement_history_v2(date, integer, integer) to authenticated;
