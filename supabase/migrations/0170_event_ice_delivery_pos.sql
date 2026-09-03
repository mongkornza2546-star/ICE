-- Event delivery Slice C: dark-install the event-specific POS context and
-- atomic ice writer. Activation remains off until event payment, correction,
-- receipt, and accounting contracts are installed.
-- Event sales always use the effective standard price and the settlement
-- policy frozen on the event participation when the event was published.

do $$
begin
  if to_regprocedure('public.sync_daily_round_destinations(uuid)') is null
    or to_regprocedure('public.daily_aggregate_stock_balance_at(date,uuid)') is null
    or to_regprocedure('public.delivery_financial_response(uuid)') is null
    or to_regclass('public.delivery_charge_document_snapshots') is null
    or not exists (
      select 1
      from public.event_delivery_feature_settings settings
      where settings.singleton
        and settings.schema_version >= 5
        and settings.event_stops_enabled
    ) then
    raise exception
      'Migration 0170 requires migrations through 0169 with event stops enabled';
  end if;
end $$;

create or replace function public.get_event_delivery_pos_context(p_round_stop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_round_id uuid;
  v_round_status public.delivery_round_status;
  v_service_date date;
  v_shop_id uuid;
  v_shop_code text;
  v_shop_name text;
  v_shop_image_path text;
  v_shop_source_location_id uuid;
  v_source_location_id uuid;
  v_active_holding_count integer;
  v_event_name text;
  v_event_location text;
  v_event_zone text;
  v_event_operational boolean;
  v_job_status public.event_job_status;
  v_participation_status public.event_participation_status;
  v_job_start_date date;
  v_job_end_date date;
  v_participation_start_date date;
  v_participation_end_date date;
  v_config_version_id uuid;
  v_payment_term public.payment_term;
  v_allowed_payment_methods public.payment_method[];
  v_default_payment_method public.payment_method;
  v_cash_reference_required boolean;
  v_cash_evidence_required boolean;
  v_bank_transfer_reference_required boolean;
  v_bank_transfer_evidence_required boolean;
  v_qr_reference_required boolean;
  v_qr_evidence_required boolean;
  v_result jsonb;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif not exists (
    select 1
    from public.event_delivery_feature_settings settings
    where settings.singleton and settings.event_ice_delivery_enabled
  ) then
    raise exception 'Event ice delivery is not enabled';
  end if;

  select
    stop.round_id,
    round.status,
    round.service_date,
    stop.shop_id,
    stop.shop_code_snapshot,
    stop.shop_name_snapshot,
    shop.image_path,
    shop.stock_location_id,
    stop.event_job_name_snapshot,
    stop.event_location_snapshot,
    stop.event_zone_snapshot,
    stop.is_operational,
    job.status,
    participation.status,
    job.start_date,
    job.end_date,
    participation.start_date,
    participation.end_date,
    participation.config_version_id,
    participation.payment_term_snapshot,
    participation.allowed_payment_methods_snapshot,
    participation.default_payment_method_snapshot,
    participation.cash_reference_required_snapshot,
    participation.cash_evidence_required_snapshot,
    participation.bank_transfer_reference_required_snapshot,
    participation.bank_transfer_evidence_required_snapshot,
    participation.qr_reference_required_snapshot,
    participation.qr_evidence_required_snapshot
  into
    v_round_id,
    v_round_status,
    v_service_date,
    v_shop_id,
    v_shop_code,
    v_shop_name,
    v_shop_image_path,
    v_shop_source_location_id,
    v_event_name,
    v_event_location,
    v_event_zone,
    v_event_operational,
    v_job_status,
    v_participation_status,
    v_job_start_date,
    v_job_end_date,
    v_participation_start_date,
    v_participation_end_date,
    v_config_version_id,
    v_payment_term,
    v_allowed_payment_methods,
    v_default_payment_method,
    v_cash_reference_required,
    v_cash_evidence_required,
    v_bank_transfer_reference_required,
    v_bank_transfer_evidence_required,
    v_qr_reference_required,
    v_qr_evidence_required
  from public.round_stops stop
  join public.delivery_rounds round on round.id = stop.round_id
  join public.shops shop on shop.id = stop.shop_id
  join public.event_participations participation
    on participation.id = stop.event_participation_id
  join public.event_jobs job on job.id = participation.event_job_id
  where stop.id = p_round_stop_id
    and stop.destination_kind = 'event';

  if v_round_id is null then
    raise exception 'The selected destination is not an event round stop';
  elsif public.current_app_role() not in ('admin', 'round_lead')
    and not public.is_round_member(v_round_id) then
    raise exception 'You are not assigned to this delivery round';
  elsif v_round_status <> 'open' then
    raise exception 'This delivery round is already closed';
  elsif not v_event_operational
    or v_job_status <> 'published'
    or v_participation_status <> 'active'
    or v_service_date not between v_job_start_date and v_job_end_date
    or v_service_date not between v_participation_start_date and v_participation_end_date then
    raise exception 'This event destination is not operational';
  elsif v_config_version_id is null or v_payment_term <> 'end_of_day' then
    raise exception 'This event destination does not have a frozen settlement policy';
  end if;

  if public.current_app_role() = 'courier' then
    select count(*)::integer
    into v_active_holding_count
    from public.stock_locations location
    where location.assigned_user_id = auth.uid()
      and location.kind in ('team', 'small_vehicle')
      and location.is_active;

    if v_active_holding_count = 0 then
      raise exception 'Employee event delivery requires one active assigned holding location; none is configured';
    elsif v_active_holding_count > 1 then
      raise exception 'Employee event delivery requires one active assigned holding location; multiple are configured';
    end if;

    select location.id into v_source_location_id
    from public.stock_locations location
    where location.assigned_user_id = auth.uid()
      and location.kind in ('team', 'small_vehicle')
      and location.is_active;
  else
    v_source_location_id := v_shop_source_location_id;
  end if;

  if not exists (
    select 1 from public.stock_locations location
    where location.id = v_source_location_id and location.is_active
  ) then
    raise exception 'The selected event delivery stock source is not active';
  end if;

  select jsonb_build_object(
    'round_id', v_round_id,
    'round_stop_id', p_round_stop_id,
    'service_date', v_service_date,
    'shop', jsonb_build_object(
      'id', v_shop_id,
      'code', v_shop_code,
      'name', v_shop_name,
      'building_name', v_event_name,
      'floor_or_zone', coalesce(v_event_zone, v_event_location),
      'image_path', v_shop_image_path
    ),
    'stock_source', jsonb_build_object(
      'id', case when public.current_app_role() = 'courier' then location.id else null end,
      'code', case when public.current_app_role() = 'courier' then location.code else 'DAILY' end,
      'name', case when public.current_app_role() = 'courier'
        then location.name else 'สต๊อกรวมประจำวัน' end,
      'kind', case when public.current_app_role() = 'courier'
        then location.kind::text else 'daily' end
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', ice.id,
        'code', ice.code,
        'name', ice.name,
        'unit', ice.unit,
        'image_path', ice.image_path,
        'stock_quantity', case when public.current_app_role() = 'courier' then least(
          public.stock_balance_at(v_service_date, v_source_location_id, ice.id),
          public.daily_aggregate_stock_balance_at(v_service_date, ice.id)
        ) else public.daily_aggregate_stock_balance_at(v_service_date, ice.id) end,
        'unit_price', standard_price.unit_price,
        'price_source', case when standard_price.id is null then null else 'standard' end,
        'price_source_id', standard_price.id
      ) order by ice.code)
      from public.ice_types ice
      left join lateral (
        select price.id, price.unit_price
        from public.ice_type_prices price
        where price.ice_type_id = ice.id
          and price.is_active
          and price.valid_from <= v_service_date
          and (price.valid_to is null or price.valid_to >= v_service_date)
        order by price.valid_from desc
        limit 1
      ) standard_price on true
      where ice.is_active
    ), '[]'::jsonb),
    'payment_profile', jsonb_build_object(
      'allowed_payment_terms', array['end_of_day']::public.payment_term[],
      'default_payment_term', 'end_of_day'::public.payment_term,
      'allowed_payment_methods', v_allowed_payment_methods,
      'default_payment_method', v_default_payment_method,
      'cash_reference_required', v_cash_reference_required,
      'cash_evidence_required', v_cash_evidence_required,
      'bank_transfer_reference_required', v_bank_transfer_reference_required,
      'bank_transfer_evidence_required', v_bank_transfer_evidence_required,
      'qr_reference_required', v_qr_reference_required,
      'qr_evidence_required', v_qr_evidence_required,
      'allow_outstanding', true,
      'credit_due_rule', null,
      'credit_days', null,
      'credit_collection_weekday', null,
      'credit_limit', null,
      'credit_exposure', 0,
      'credit_remaining', null
    )
  ) into v_result
  from public.stock_locations location
  where location.id = v_source_location_id;

  return v_result;
end;
$$;

create or replace function public.record_event_ice_delivery(
  p_round_stop_id uuid,
  p_items jsonb,
  p_stop_status public.shop_round_status,
  p_note text,
  p_client_recorded_at timestamptz,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock_service_date date;
  v_round_id uuid;
  v_round_status public.delivery_round_status;
  v_service_date date;
  v_shop_id uuid;
  v_shop_source_location_id uuid;
  v_source_location_id uuid;
  v_active_holding_count integer;
  v_event_operational boolean;
  v_job_status public.event_job_status;
  v_participation_status public.event_participation_status;
  v_job_start_date date;
  v_job_end_date date;
  v_participation_start_date date;
  v_participation_end_date date;
  v_config_version_id uuid;
  v_payment_term public.payment_term;
  v_event_id uuid;
  v_existing_event_id uuid;
  v_existing_round_stop_id uuid;
  v_existing_fingerprint text;
  v_request_fingerprint text;
  v_item_count integer;
  v_item record;
  v_unit_price numeric(12,2);
  v_price_source_id uuid;
  v_total_amount numeric(12,2) := 0;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif not exists (
    select 1
    from public.event_delivery_feature_settings settings
    where settings.singleton and settings.event_ice_delivery_enabled
  ) then
    raise exception 'Event ice delivery is not enabled';
  elsif jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Delivery items must be a JSON array';
  end if;

  select count(*) into v_item_count
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric);

  if p_stop_status = 'pending' then
    raise exception 'A delivery record cannot reset a destination to pending';
  elsif p_stop_status = 'delivered' and v_item_count = 0 then
    raise exception 'A delivered destination requires at least one ice item';
  elsif p_stop_status <> 'delivered'
    and (v_item_count <> 0 or nullif(trim(coalesce(p_note, '')), '') is null) then
    raise exception 'A non-delivery status requires a note and cannot include ice items';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
    left join public.ice_types ice on ice.id = item.ice_type_id and ice.is_active
    where item.ice_type_id is null
      or item.quantity is null
      or item.quantity <= 0
      or mod(item.quantity, 0.5) <> 0
      or ice.id is null
  ) or exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
    group by item.ice_type_id having count(*) > 1
  ) then
    raise exception 'Every delivery item must use a distinct active ice type and a positive half-unit quantity';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select event.id, event.round_stop_id, event.request_fingerprint
  into v_existing_event_id, v_existing_round_stop_id, v_existing_fingerprint
  from public.delivery_events event
  where event.idempotency_key = p_idempotency_key;

  v_request_fingerprint := public.delivery_request_fingerprint(
    p_round_stop_id,
    p_items,
    p_stop_status,
    p_note,
    case when p_stop_status = 'delivered'
      then 'end_of_day'::public.payment_term else null end
  );

  if v_existing_event_id is not null then
    if not public.is_delivery_event_visible(v_existing_event_id) then
      raise exception 'This delivery request cannot be viewed by the current user';
    elsif v_existing_round_stop_id <> p_round_stop_id then
      raise exception 'This idempotency key belongs to a different destination';
    elsif v_existing_fingerprint is distinct from v_request_fingerprint then
      raise exception 'This idempotency key was already used for a different delivery request';
    end if;
    return public.delivery_financial_response(v_existing_event_id);
  end if;

  select round.service_date into v_lock_service_date
  from public.round_stops stop
  join public.delivery_rounds round on round.id = stop.round_id
  where stop.id = p_round_stop_id
    and stop.destination_kind = 'event';

  if v_lock_service_date is null then
    raise exception 'The selected destination is not an event round stop';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_lock_service_date::text, 0));

  select
    stop.round_id,
    round.status,
    round.service_date,
    stop.shop_id,
    shop.stock_location_id,
    stop.is_operational,
    job.status,
    participation.status,
    job.start_date,
    job.end_date,
    participation.start_date,
    participation.end_date,
    participation.config_version_id,
    participation.payment_term_snapshot
  into
    v_round_id,
    v_round_status,
    v_service_date,
    v_shop_id,
    v_shop_source_location_id,
    v_event_operational,
    v_job_status,
    v_participation_status,
    v_job_start_date,
    v_job_end_date,
    v_participation_start_date,
    v_participation_end_date,
    v_config_version_id,
    v_payment_term
  from public.round_stops stop
  join public.delivery_rounds round on round.id = stop.round_id
  join public.shops shop on shop.id = stop.shop_id
  join public.event_participations participation
    on participation.id = stop.event_participation_id
  join public.event_jobs job on job.id = participation.event_job_id
  where stop.id = p_round_stop_id
    and stop.destination_kind = 'event'
  for update of round, job, participation;

  if v_service_date is distinct from v_lock_service_date then
    raise exception 'The delivery round changed service date; retry the request';
  elsif public.current_app_role() not in ('admin', 'round_lead')
    and not public.is_round_member(v_round_id) then
    raise exception 'You are not assigned to this delivery round';
  elsif v_round_status <> 'open' then
    raise exception 'This delivery round is already closed';
  elsif not v_event_operational
    or v_job_status <> 'published'
    or v_participation_status <> 'active'
    or v_service_date not between v_job_start_date and v_job_end_date
    or v_service_date not between v_participation_start_date and v_participation_end_date then
    raise exception 'This event destination is not operational';
  elsif v_config_version_id is null or v_payment_term <> 'end_of_day' then
    raise exception 'This event destination does not have a frozen settlement policy';
  end if;

  if public.current_app_role() = 'courier' then
    select count(*)::integer
    into v_active_holding_count
    from public.stock_locations location
    where location.assigned_user_id = auth.uid()
      and location.kind in ('team', 'small_vehicle')
      and location.is_active;

    if v_active_holding_count = 0 then
      raise exception 'Employee event delivery requires one active assigned holding location; none is configured';
    elsif v_active_holding_count > 1 then
      raise exception 'Employee event delivery requires one active assigned holding location; multiple are configured';
    end if;

    select location.id into v_source_location_id
    from public.stock_locations location
    where location.assigned_user_id = auth.uid()
      and location.kind in ('team', 'small_vehicle')
      and location.is_active;
  else
    v_source_location_id := v_shop_source_location_id;
  end if;

  if not exists (
    select 1 from public.stock_locations location
    where location.id = v_source_location_id and location.is_active
  ) then
    raise exception 'The selected event delivery stock source is not active';
  elsif v_service_date > (clock_timestamp() at time zone 'Asia/Bangkok')::date then
    raise exception 'A delivery cannot be recorded for a future service date';
  elsif exists (
    select 1 from public.daily_aggregate_stock_closures
    where service_date = v_service_date
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  if p_stop_status = 'delivered' then
    perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_shop_id::text, 0));
  end if;

  for v_item in
    select item.ice_type_id, item.quantity
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
    order by item.ice_type_id
  loop
    if public.current_app_role() = 'courier'
      and public.stock_balance_at(v_service_date, v_source_location_id, v_item.ice_type_id)
        < v_item.quantity then
      raise exception 'Employee holding does not have enough stock';
    elsif public.daily_aggregate_stock_balance_at(v_service_date, v_item.ice_type_id)
      < v_item.quantity then
      raise exception 'Daily aggregate stock is not sufficient';
    end if;

    select price.unit_price, price.id
    into v_unit_price, v_price_source_id
    from public.ice_type_prices price
    where price.ice_type_id = v_item.ice_type_id
      and price.is_active
      and price.valid_from <= v_service_date
      and (price.valid_to is null or price.valid_to >= v_service_date)
    order by price.valid_from desc
    limit 1
    for share;

    if v_unit_price is null then
      raise exception 'An effective standard price is required for every delivered ice type';
    end if;
    v_total_amount := v_total_amount + (v_item.quantity * v_unit_price);
  end loop;

  insert into public.delivery_events (
    round_stop_id, recorded_by, client_recorded_at, idempotency_key,
    request_fingerprint, note, source_stock_location_id
  ) values (
    p_round_stop_id, auth.uid(), p_client_recorded_at, p_idempotency_key,
    v_request_fingerprint, nullif(trim(coalesce(p_note, '')), ''), v_source_location_id
  ) returning id into v_event_id;

  for v_item in
    select item.ice_type_id, item.quantity
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
    order by item.ice_type_id
  loop
    if p_stop_status = 'delivered' then
      select price.unit_price, price.id
      into v_unit_price, v_price_source_id
      from public.ice_type_prices price
      where price.ice_type_id = v_item.ice_type_id
        and price.is_active
        and price.valid_from <= v_service_date
        and (price.valid_to is null or price.valid_to >= v_service_date)
      order by price.valid_from desc
      limit 1
      for share;
    else
      v_unit_price := null;
      v_price_source_id := null;
    end if;

    insert into public.delivery_items (
      delivery_event_id, ice_type_id, quantity,
      unit_price, price_source, price_source_id
    ) values (
      v_event_id, v_item.ice_type_id, v_item.quantity,
      v_unit_price,
      case when v_unit_price is null then null else 'standard'::public.price_source end,
      v_price_source_id
    );
  end loop;

  if p_stop_status = 'delivered' then
    insert into public.delivery_charges (
      delivery_event_id, shop_id, service_date, payment_term,
      original_amount, due_date, approval_request_id
    ) values (
      v_event_id, v_shop_id, v_service_date, 'end_of_day',
      v_total_amount, null, null
    );
  end if;

  update public.round_stops
  set status = p_stop_status,
      note = nullif(trim(coalesce(p_note, '')), ''),
      updated_by = auth.uid(),
      updated_at = now()
  where id = p_round_stop_id;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'delivery_events', v_event_id, 'created',
    jsonb_build_object(
      'destination_kind', 'event',
      'round_stop_id', p_round_stop_id,
      'items', p_items,
      'stop_status', p_stop_status,
      'note', nullif(trim(coalesce(p_note, '')), ''),
      'source_stock_location_id', v_source_location_id,
      'charge_total', case when p_stop_status = 'delivered' then v_total_amount else null end,
      'payment_term', case when p_stop_status = 'delivered' then 'end_of_day' else null end,
      'price_source', case when p_stop_status = 'delivered' then 'standard' else null end
    )
  );

  return public.delivery_financial_response(v_event_id);
end;
$$;

create or replace function public.event_delivery_history_status(p_event_id uuid)
returns public.shop_round_status
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select (audit.after_value ->> 'stop_status')::public.shop_round_status
      from public.audit_logs audit
      where audit.entity_type = 'delivery_events'
        and audit.entity_id = p_event_id
        and audit.after_value ? 'stop_status'
      order by audit.occurred_at
      limit 1
    ),
    case when exists (
      select 1 from public.delivery_items item
      where item.delivery_event_id = p_event_id
    ) then 'delivered'::public.shop_round_status else 'issue'::public.shop_round_status end
  );
$$;

do $event_delivery_history_status$
declare
  v_function regprocedure := 'public.get_event_delivery_cards(uuid,uuid,text)'::regprocedure;
  v_definition text;
  v_updated_definition text;
  v_marker constant text := $fragment$'note', delivery.note,$fragment$;
  v_replacement constant text := $fragment$'note', delivery.note,
          'stop_status', public.event_delivery_history_status(delivery.id),$fragment$;
begin
  select pg_get_functiondef(v_function) into v_definition;
  v_updated_definition := replace(v_definition, v_marker, v_replacement);
  if v_updated_definition = v_definition then
    raise exception 'get_event_delivery_cards does not contain the expected history status marker';
  end if;
  execute v_updated_definition;
end;
$event_delivery_history_status$;

-- Event documents show the event destination instead of the shop's regular site.
create or replace function public.build_charge_print_document(p_charge_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'document_type', 'INV',
    'document_number', charge.charge_number,
    'document_title', 'ใบส่งของ / ใบแจ้งหนี้',
    'payment_term', charge.payment_term,
    'issued_at', charge.created_at,
    'service_date', charge.service_date,
    'due_date', charge.due_date,
    'shop_code', stop.shop_code_snapshot,
    'shop_name', stop.shop_name_snapshot,
    'shop_location', case when stop.destination_kind = 'event'
      then nullif(concat_ws(' · ', stop.event_job_name_snapshot,
        stop.event_location_snapshot, stop.event_zone_snapshot, stop.event_booth_snapshot), '')
      else nullif(concat_ws(' · ', stop.building_name_snapshot, stop.floor_or_zone_snapshot), '')
    end,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_name', ice.name,
        'ice_type_unit', ice.unit,
        'quantity', item.quantity,
        'unit_price', item.unit_price,
        'line_total', item.line_total
      ) order by ice.code)
      from public.delivery_items item
      join public.ice_types ice on ice.id = item.ice_type_id
      where item.delivery_event_id = charge.delivery_event_id
    ), '[]'::jsonb),
    'total_amount', charge.original_amount
  )
  from public.delivery_charges charge
  join public.delivery_events event on event.id = charge.delivery_event_id
  join public.round_stops stop on stop.id = event.round_stop_id
  where charge.id = p_charge_id and charge.charge_number is not null;
$$;

update public.event_delivery_feature_settings
set schema_version = greatest(schema_version, 6),
    event_ice_delivery_enabled = false,
    updated_at = now()
where singleton;

revoke all on function public.get_event_delivery_pos_context(uuid) from public, anon;
revoke all on function public.record_event_ice_delivery(
  uuid, jsonb, public.shop_round_status, text, timestamptz, uuid
) from public, anon;
revoke all on function public.build_charge_print_document(uuid)
  from public, anon, authenticated;
revoke all on function public.event_delivery_history_status(uuid)
  from public, anon, authenticated;
grant execute on function public.get_event_delivery_pos_context(uuid) to authenticated;
grant execute on function public.record_event_ice_delivery(
  uuid, jsonb, public.shop_round_status, text, timestamptz, uuid
) to authenticated;

notify pgrst, 'reload schema';
