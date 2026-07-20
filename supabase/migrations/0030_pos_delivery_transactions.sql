-- Financial-aware POS delivery context and transaction RPCs.

create or replace function public.get_delivery_pos_context(p_round_stop_id uuid)
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
  v_building_name text;
  v_floor_or_zone text;
  v_shop_image_path text;
  v_shop_source_location_id uuid;
  v_source_location_id uuid;
  v_active_holding_count integer;
  v_profile public.shop_payment_profiles%rowtype;
  v_credit_exposure numeric(12,2);
  v_result jsonb;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  end if;

  select
    stop.round_id,
    round.status,
    round.service_date,
    stop.shop_id,
    stop.shop_code_snapshot,
    stop.shop_name_snapshot,
    stop.building_name_snapshot,
    stop.floor_or_zone_snapshot,
    shop.image_path,
    shop.stock_location_id
  into
    v_round_id,
    v_round_status,
    v_service_date,
    v_shop_id,
    v_shop_code,
    v_shop_name,
    v_building_name,
    v_floor_or_zone,
    v_shop_image_path,
    v_shop_source_location_id
  from public.round_stops stop
  join public.delivery_rounds round on round.id = stop.round_id
  join public.shops shop on shop.id = stop.shop_id
  where stop.id = p_round_stop_id;

  if v_round_id is null then
    raise exception 'The selected shop is not in a delivery round';
  elsif public.current_app_role() not in ('admin', 'round_lead')
    and not public.is_round_member(v_round_id) then
    raise exception 'You are not assigned to this delivery round';
  elsif v_round_status <> 'open' then
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
    raise exception 'The selected stock source is not active';
  end if;

  select profile.* into v_profile
  from public.shop_payment_profiles profile
  where profile.shop_id = v_shop_id;

  select coalesce(sum(greatest(
    charge.original_amount - coalesce(allocation.allocated_amount, 0), 0
  )), 0)::numeric(12,2)
  into v_credit_exposure
  from public.delivery_charges charge
  left join lateral (
    select coalesce(sum(allocation.amount), 0)::numeric(12,2) as allocated_amount
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = charge.id and payment.status = 'active'
  ) allocation on true
  where charge.shop_id = v_shop_id
    and charge.payment_term = 'credit'
    and charge.status = 'active';

  select jsonb_build_object(
    'round_id', v_round_id,
    'round_stop_id', p_round_stop_id,
    'service_date', v_service_date,
    'shop', jsonb_build_object(
      'id', v_shop_id,
      'code', v_shop_code,
      'name', v_shop_name,
      'building_name', v_building_name,
      'floor_or_zone', v_floor_or_zone,
      'image_path', v_shop_image_path
    ),
    'stock_source', jsonb_build_object(
      'id', location.id,
      'code', location.code,
      'name', location.name,
      'kind', location.kind
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', ice.id,
        'code', ice.code,
        'name', ice.name,
        'unit', ice.unit,
        'image_path', ice.image_path,
        'stock_quantity', public.stock_balance_at(v_service_date, v_source_location_id, ice.id),
        'unit_price', coalesce(shop_price.unit_price, standard_price.unit_price),
        'price_source', case
          when shop_price.id is not null then 'shop_override'
          when standard_price.id is not null then 'standard'
          else null
        end,
        'price_source_id', coalesce(shop_price.id, standard_price.id)
      ) order by ice.code)
      from public.ice_types ice
      left join lateral (
        select price.id, price.unit_price
        from public.shop_ice_type_prices price
        where price.shop_id = v_shop_id
          and price.ice_type_id = ice.id
          and price.is_active
          and price.valid_from <= v_service_date
          and (price.valid_to is null or price.valid_to >= v_service_date)
        order by price.valid_from desc
        limit 1
      ) shop_price on true
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
    'payment_profile', case when v_profile.id is null then null else jsonb_build_object(
      'allowed_payment_terms', v_profile.allowed_payment_terms,
      'default_payment_term', v_profile.default_payment_term,
      'allowed_payment_methods', v_profile.allowed_payment_methods,
      'default_payment_method', v_profile.default_payment_method,
      'cash_reference_required', v_profile.cash_reference_required,
      'cash_evidence_required', v_profile.cash_evidence_required,
      'bank_transfer_reference_required', v_profile.bank_transfer_reference_required,
      'bank_transfer_evidence_required', v_profile.bank_transfer_evidence_required,
      'qr_reference_required', v_profile.qr_reference_required,
      'qr_evidence_required', v_profile.qr_evidence_required,
      'allow_outstanding', v_profile.allow_outstanding,
      'credit_due_rule', v_profile.credit_due_rule,
      'credit_days', v_profile.credit_days,
      'credit_limit', v_profile.credit_limit,
      'credit_exposure', v_credit_exposure,
      'credit_remaining', case when v_profile.credit_limit is null then null
        else greatest(v_profile.credit_limit - v_credit_exposure, 0)::numeric(12,2)
      end
    ) end
  ) into v_result
  from public.stock_locations location
  where location.id = v_source_location_id;

  return v_result;
end;
$$;

revoke all on function public.get_delivery_pos_context(uuid) from public;
grant execute on function public.get_delivery_pos_context(uuid) to authenticated;

create function public.delivery_request_fingerprint(
  p_round_stop_id uuid,
  p_items jsonb,
  p_stop_status public.shop_round_status,
  p_note text,
  p_payment_term public.payment_term
)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_items jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'ice_type_id', item.ice_type_id,
    'quantity', item.quantity
  ) order by item.ice_type_id), '[]'::jsonb)
  into v_items
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer);

  return md5(jsonb_build_object(
    'round_stop_id', p_round_stop_id,
    'items', v_items,
    'stop_status', p_stop_status,
    'note', nullif(trim(coalesce(p_note, '')), ''),
    'payment_term', p_payment_term
  )::text);
end;
$$;

create function public.delivery_financial_response(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'delivery_event_id', event.id,
    'round_stop_id', event.round_stop_id,
    'recorded_by', event.recorded_by,
    'recorded_at', event.recorded_at,
    'client_recorded_at', event.client_recorded_at,
    'note', event.note,
    'source_stock_location_id', event.source_stock_location_id,
    'charge_id', charge.id,
    'service_date', charge.service_date,
    'total_amount', charge.original_amount,
    'payment_term', charge.payment_term,
    'payment_status', case
      when charge.id is null then null
      when coalesce(allocation.allocated_amount, 0) <= 0 then 'unpaid'
      when allocation.allocated_amount < charge.original_amount then 'partial'
      else 'paid'
    end,
    'due_date', charge.due_date,
    'approval_id', charge.approval_request_id,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', item.ice_type_id,
        'quantity', item.quantity,
        'unit_price', item.unit_price,
        'line_total', item.line_total,
        'price_source', item.price_source,
        'price_source_id', item.price_source_id
      ) order by item.ice_type_id)
      from public.delivery_items item
      where item.delivery_event_id = event.id
    ), '[]'::jsonb)
  )
  from public.delivery_events event
  left join public.delivery_charges charge
    on charge.delivery_event_id = event.id and charge.status = 'active'
  left join lateral (
    select coalesce(sum(allocation.amount), 0)::numeric(12,2) as allocated_amount
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = charge.id and payment.status = 'active'
  ) allocation on true
  where event.id = p_event_id;
$$;

create function public.resolve_delivery_price(
  p_shop_id uuid,
  p_ice_type_id uuid,
  p_service_date date
)
returns table (
  unit_price numeric(12,2),
  price_source public.price_source,
  price_source_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select price.unit_price, 'shop_override'::public.price_source, price.id
  from public.shop_ice_type_prices price
  where price.shop_id = p_shop_id
    and price.ice_type_id = p_ice_type_id
    and price.is_active
    and price.valid_from <= p_service_date
    and (price.valid_to is null or price.valid_to >= p_service_date)
  order by price.valid_from desc
  limit 1
  for share;

  if found then
    return;
  end if;

  return query
  select price.unit_price, 'standard'::public.price_source, price.id
  from public.ice_type_prices price
  where price.ice_type_id = p_ice_type_id
    and price.is_active
    and price.valid_from <= p_service_date
    and (price.valid_to is null or price.valid_to >= p_service_date)
  order by price.valid_from desc
  limit 1
  for share;
end;
$$;

create function public.record_delivery(
  p_round_stop_id uuid,
  p_items jsonb,
  p_stop_status public.shop_round_status,
  p_note text,
  p_client_recorded_at timestamptz,
  p_idempotency_key uuid,
  p_payment_term public.payment_term,
  p_approval_id uuid default null
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
  v_shop_id uuid;
  v_shop_source_location_id uuid;
  v_source_location_id uuid;
  v_active_holding_count integer;
  v_event_id uuid;
  v_existing_event_id uuid;
  v_existing_round_stop_id uuid;
  v_existing_fingerprint text;
  v_existing_payment_term public.payment_term;
  v_existing_approval_id uuid;
  v_request_fingerprint text;
  v_item_count integer;
  v_item record;
  v_unit_price numeric(12,2);
  v_price_source public.price_source;
  v_price_source_id uuid;
  v_total_amount numeric(12,2) := 0;
  v_profile public.shop_payment_profiles%rowtype;
  v_resolved_payment_term public.payment_term;
  v_due_date date;
  v_credit_exposure numeric(12,2);
  v_approval_shop_id uuid;
  v_approval_stop_id uuid;
  v_approval_kind public.financial_approval_kind;
  v_approval_amount numeric(12,2);
  v_approval_fingerprint text;
  v_approval_status public.financial_approval_status;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Delivery items must be a JSON array';
  end if;

  select count(*) into v_item_count
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer);

  if p_stop_status = 'pending' then
    raise exception 'A delivery record cannot reset a shop to pending';
  elsif p_stop_status = 'delivered' and v_item_count = 0 then
    raise exception 'A delivered shop requires at least one ice item';
  elsif p_stop_status <> 'delivered'
    and (v_item_count <> 0 or nullif(trim(coalesce(p_note, '')), '') is null) then
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
    group by item.ice_type_id having count(*) > 1
  ) then
    raise exception 'Every delivery item must use a distinct active ice type and a positive quantity';
  end if;

  if p_stop_status <> 'delivered' and (p_payment_term is not null or p_approval_id is not null) then
    raise exception 'A non-delivery record cannot include payment terms or approvals';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select
    event.id,
    event.round_stop_id,
    event.request_fingerprint,
    charge.payment_term,
    charge.approval_request_id
  into
    v_existing_event_id,
    v_existing_round_stop_id,
    v_existing_fingerprint,
    v_existing_payment_term,
    v_existing_approval_id
  from public.delivery_events event
  left join public.delivery_charges charge on charge.delivery_event_id = event.id
  where event.idempotency_key = p_idempotency_key;

  if v_existing_event_id is not null then
    v_request_fingerprint := public.delivery_request_fingerprint(
      p_round_stop_id, p_items, p_stop_status, p_note,
      coalesce(p_payment_term, v_existing_payment_term)
    );

    if not public.is_delivery_event_visible(v_existing_event_id) then
      raise exception 'This delivery request cannot be viewed by the current user';
    elsif v_existing_round_stop_id <> p_round_stop_id then
      raise exception 'This idempotency key belongs to a different shop';
    elsif v_existing_fingerprint is distinct from v_request_fingerprint
      or v_existing_approval_id is distinct from p_approval_id then
      raise exception 'This idempotency key was already used for a different delivery request';
    end if;

    return public.delivery_financial_response(v_existing_event_id);
  end if;

  select stop.round_id, round.status, round.service_date, stop.shop_id, shop.stock_location_id
  into v_round_id, v_round_status, v_service_date, v_shop_id, v_shop_source_location_id
  from public.round_stops stop
  join public.delivery_rounds round on round.id = stop.round_id
  join public.shops shop on shop.id = stop.shop_id
  where stop.id = p_round_stop_id
  for update of round;

  if v_round_id is null then
    raise exception 'The selected shop is not in a delivery round';
  elsif public.current_app_role() not in ('admin', 'round_lead')
    and not public.is_round_member(v_round_id) then
    raise exception 'You are not assigned to this delivery round';
  elsif v_round_status <> 'open' then
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
    raise exception 'The selected stock source is not active';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if p_stop_status = 'delivered' then
    select profile.* into v_profile
    from public.shop_payment_profiles profile
    where profile.shop_id = v_shop_id;

    if v_profile.id is null then
      raise exception 'The selected shop does not have a payment profile';
    end if;

    v_resolved_payment_term := coalesce(p_payment_term, v_profile.default_payment_term);
    if not (v_resolved_payment_term = any(v_profile.allowed_payment_terms)) then
      raise exception 'The selected payment term is not allowed for this shop';
    end if;
  end if;

  v_request_fingerprint := public.delivery_request_fingerprint(
    p_round_stop_id, p_items, p_stop_status, p_note, v_resolved_payment_term
  );

  for v_item in
    select item.ice_type_id, item.quantity
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
    order by item.ice_type_id
  loop
    if public.stock_balance_at(v_service_date, v_source_location_id, v_item.ice_type_id)
      < v_item.quantity then
      raise exception 'The source location does not have enough stock';
    end if;

    select resolved.unit_price, resolved.price_source, resolved.price_source_id
    into v_unit_price, v_price_source, v_price_source_id
    from public.resolve_delivery_price(
      v_shop_id, v_item.ice_type_id, v_service_date
    ) resolved;

    if v_unit_price is null then
      raise exception 'An effective price is required for every delivered ice type';
    end if;

    v_total_amount := v_total_amount + (v_item.quantity * v_unit_price);
  end loop;

  if p_stop_status = 'delivered' then
    perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_shop_id::text, 0));

    if v_resolved_payment_term = 'credit' then
      if v_profile.credit_due_rule = 'net_days' then
        v_due_date := v_service_date + v_profile.credit_days;
      else
        v_due_date := (date_trunc('month', v_service_date)::date
          + interval '1 month - 1 day')::date;
      end if;

      select coalesce(sum(greatest(
        charge.original_amount - coalesce(allocation.allocated_amount, 0), 0
      )), 0)::numeric(12,2)
      into v_credit_exposure
      from public.delivery_charges charge
      left join lateral (
        select coalesce(sum(allocation.amount), 0)::numeric(12,2) as allocated_amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id and payment.status = 'active'
      ) allocation on true
      where charge.shop_id = v_shop_id
        and charge.payment_term = 'credit'
        and charge.status = 'active';

      if v_profile.credit_limit is not null
        and v_credit_exposure + v_total_amount > v_profile.credit_limit then
        if p_approval_id is null then
          raise exception 'An approved credit-limit request is required for this delivery';
        end if;

        select approval.shop_id, approval.round_stop_id, approval.kind,
          approval.requested_amount, approval.request_fingerprint, approval.status
        into v_approval_shop_id, v_approval_stop_id, v_approval_kind,
          v_approval_amount, v_approval_fingerprint, v_approval_status
        from public.financial_approval_requests approval
        where approval.id = p_approval_id
        for update;

        if v_approval_status is distinct from 'approved'
          or v_approval_shop_id is distinct from v_shop_id
          or v_approval_stop_id is distinct from p_round_stop_id
          or v_approval_kind is distinct from 'credit_limit'
          or v_approval_amount is distinct from v_total_amount
          or v_approval_fingerprint is distinct from v_request_fingerprint then
          raise exception 'The financial approval does not match this delivery request';
        elsif v_service_date is distinct from
          (now() at time zone 'Asia/Bangkok')::date then
          raise exception 'Financial approval has expired';
        end if;
      elsif p_approval_id is not null then
        raise exception 'This delivery does not require a financial approval';
      end if;
    elsif p_approval_id is not null then
      raise exception 'Only a credit-limit delivery can use this approval';
    end if;
  end if;

  insert into public.delivery_events (
    round_stop_id, recorded_by, client_recorded_at, idempotency_key,
    request_fingerprint, note, source_stock_location_id
  ) values (
    p_round_stop_id, auth.uid(), p_client_recorded_at, p_idempotency_key,
    v_request_fingerprint, nullif(trim(coalesce(p_note, '')), ''), v_source_location_id
  ) returning id into v_event_id;

  for v_item in
    select item.ice_type_id, item.quantity
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
    order by item.ice_type_id
  loop
    if p_stop_status = 'delivered' then
      select resolved.unit_price, resolved.price_source, resolved.price_source_id
      into v_unit_price, v_price_source, v_price_source_id
      from public.resolve_delivery_price(
        v_shop_id, v_item.ice_type_id, v_service_date
      ) resolved;
    else
      v_unit_price := null;
      v_price_source := null;
      v_price_source_id := null;
    end if;

    insert into public.delivery_items (
      delivery_event_id, ice_type_id, quantity,
      unit_price, price_source, price_source_id
    ) values (
      v_event_id, v_item.ice_type_id, v_item.quantity,
      v_unit_price, v_price_source, v_price_source_id
    );
  end loop;

  if p_stop_status = 'delivered' then
    insert into public.delivery_charges (
      delivery_event_id, shop_id, service_date, payment_term,
      original_amount, due_date, approval_request_id
    ) values (
      v_event_id, v_shop_id, v_service_date, v_resolved_payment_term,
      v_total_amount, v_due_date, p_approval_id
    );

    if p_approval_id is not null then
      update public.financial_approval_requests
      set status = 'consumed', consumed_by_delivery_event_id = v_event_id, consumed_at = now()
      where id = p_approval_id and status = 'approved';
    end if;
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
      'round_stop_id', p_round_stop_id,
      'items', p_items,
      'stop_status', p_stop_status,
      'note', nullif(trim(coalesce(p_note, '')), ''),
      'source_stock_location_id', v_source_location_id,
      'charge_total', case when p_stop_status = 'delivered' then v_total_amount else null end,
      'payment_term', v_resolved_payment_term
    )
  );

  return public.delivery_financial_response(v_event_id);
end;
$$;

revoke all on function public.delivery_request_fingerprint(
  uuid, jsonb, public.shop_round_status, text, public.payment_term
) from public;
revoke all on function public.delivery_financial_response(uuid) from public;
revoke all on function public.resolve_delivery_price(uuid, uuid, date) from public;
revoke all on function public.record_delivery(
  uuid, jsonb, public.shop_round_status, text, timestamptz, uuid,
  public.payment_term, uuid
) from public;
grant execute on function public.record_delivery(
  uuid, jsonb, public.shop_round_status, text, timestamptz, uuid,
  public.payment_term, uuid
) to authenticated;

-- Once the revision RPC below is installed, correction inserts no longer need
-- the foundation's fail-closed guard. Cancellation and reactivation protection
-- remains centralized for every write path.
create or replace function public.protect_financial_delivery_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
    and old.status = 'active' and new.status = 'cancelled' and exists (
      select 1
      from public.delivery_charges charge
      where charge.delivery_event_id = new.id and charge.status = 'active'
    ) then
    if exists (
      select 1
      from public.delivery_charges charge
      join public.payment_allocations allocation on allocation.charge_id = charge.id
      join public.payments payment on payment.id = allocation.payment_id
      where charge.delivery_event_id = new.id
        and charge.status = 'active'
        and payment.status = 'active'
    ) then
      raise exception 'Void active payment allocations before cancelling this delivery';
    end if;

    update public.delivery_charges
    set status = 'voided',
        voided_by = new.cancelled_by,
        voided_at = new.cancelled_at,
        void_reason = new.cancellation_reason
    where delivery_event_id = new.id and status = 'active';
  elsif tg_op = 'UPDATE'
    and old.status = 'cancelled' and new.status = 'active' and exists (
      select 1
      from public.delivery_charges charge
      where charge.delivery_event_id = new.id
    ) then
    raise exception 'A financial delivery cannot be reactivated after cancellation';
  end if;

  return new;
end;
$$;

alter table public.delivery_event_revisions
  add column request_fingerprint text;

drop function if exists public.revise_delivery_event(
  uuid, text, jsonb, public.shop_round_status, text, text, uuid
);

create function public.revise_delivery_event(
  p_event_id uuid,
  p_action text,
  p_items jsonb,
  p_stop_status public.shop_round_status,
  p_note text,
  p_reason text,
  p_idempotency_key uuid,
  p_approval_id uuid default null
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
  v_round_stop_id uuid;
  v_shop_id uuid;
  v_source_location_id uuid;
  v_event_status public.delivery_event_status;
  v_original_charge_id uuid;
  v_payment_term public.payment_term;
  v_due_date date;
  v_replacement_id uuid;
  v_existing_original_id uuid;
  v_existing_action text;
  v_existing_fingerprint text;
  v_existing_approval_id uuid;
  v_request_fingerprint text;
  v_revision_fingerprint text;
  v_item_count integer;
  v_item record;
  v_unit_price numeric(12,2);
  v_price_source public.price_source;
  v_price_source_id uuid;
  v_total_amount numeric(12,2) := 0;
  v_profile public.shop_payment_profiles%rowtype;
  v_credit_exposure numeric(12,2);
  v_approval_shop_id uuid;
  v_approval_stop_id uuid;
  v_approval_kind public.financial_approval_kind;
  v_approval_amount numeric(12,2);
  v_approval_fingerprint text;
  v_approval_status public.financial_approval_status;
  v_latest_status public.shop_round_status;
  v_latest_note text;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can revise delivery events';
  elsif p_action not in ('cancel', 'correct') then
    raise exception 'The revision action must be cancel or correct';
  elsif nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A revision reason is required';
  elsif jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Delivery items must be a JSON array';
  elsif p_action = 'cancel' and p_approval_id is not null then
    raise exception 'A cancellation cannot use a financial approval';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select revision.original_event_id, revision.action, revision.request_fingerprint,
    replacement_charge.approval_request_id
  into v_existing_original_id, v_existing_action,
    v_existing_fingerprint, v_existing_approval_id
  from public.delivery_event_revisions revision
  left join public.delivery_charges replacement_charge
    on replacement_charge.delivery_event_id = revision.replacement_event_id
  where revision.idempotency_key = p_idempotency_key;

  if v_existing_original_id is not null then
    select charge.payment_term into v_payment_term
    from public.delivery_charges charge
    where charge.delivery_event_id = p_event_id;

    v_request_fingerprint := public.delivery_request_fingerprint(
      (select event.round_stop_id from public.delivery_events event where event.id = p_event_id),
      p_items, p_stop_status, p_note, v_payment_term
    );
    v_revision_fingerprint := md5(jsonb_build_object(
      'action', p_action,
      'reason', trim(p_reason),
      'delivery_fingerprint', v_request_fingerprint
    )::text);

    if v_existing_original_id <> p_event_id or v_existing_action <> p_action then
      raise exception 'This idempotency key belongs to another revision';
    elsif (v_existing_fingerprint is not null
        and v_existing_fingerprint is distinct from v_revision_fingerprint)
      or v_existing_approval_id is distinct from p_approval_id then
      raise exception 'This idempotency key was already used for a different revision request';
    end if;

    select stop.round_id into v_round_id
    from public.delivery_events event
    join public.round_stops stop on stop.id = event.round_stop_id
    where event.id = p_event_id;
    return public.get_manager_delivery_events(v_round_id);
  end if;

  select
    stop.round_id,
    round.status,
    round.service_date,
    event.round_stop_id,
    stop.shop_id,
    event.source_stock_location_id,
    event.status
  into
    v_round_id,
    v_round_status,
    v_service_date,
    v_round_stop_id,
    v_shop_id,
    v_source_location_id,
    v_event_status
  from public.delivery_events event
  join public.round_stops stop on stop.id = event.round_stop_id
  join public.delivery_rounds round on round.id = stop.round_id
  where event.id = p_event_id
  for update of event, round;

  if v_round_id is null then
    raise exception 'The selected delivery event does not exist';
  elsif v_event_status <> 'active' then
    raise exception 'The selected delivery event is already cancelled';
  elsif v_round_status <> 'open' then
    raise exception 'Delivery events can only be revised before the round is closed';
  end if;

  with recursive event_lineage as (
    select event.id, event.corrects_event_id, 0 as depth
    from public.delivery_events event
    where event.id = p_event_id

    union all

    select parent.id, parent.corrects_event_id, lineage.depth + 1
    from public.delivery_events parent
    join event_lineage lineage on parent.id = lineage.corrects_event_id
  )
  select charge.id, charge.payment_term, charge.due_date
  into v_original_charge_id, v_payment_term, v_due_date
  from event_lineage lineage
  join public.delivery_charges charge on charge.delivery_event_id = lineage.id
  order by lineage.depth
  limit 1;

  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if exists (
    select 1 from public.daily_stock_closures
    where service_date = v_service_date and status = 'closed'
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  if p_action = 'correct' then
    if v_source_location_id is null then
      raise exception 'A legacy delivery without a captured stock source cannot be corrected';
    end if;

    select count(*) into v_item_count
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer);

    if p_stop_status = 'pending' then
      raise exception 'A delivery correction cannot reset a shop to pending';
    elsif p_stop_status = 'delivered' and v_item_count = 0 then
      raise exception 'A delivered shop requires at least one ice item';
    elsif p_stop_status <> 'delivered'
      and (v_item_count <> 0 or nullif(trim(coalesce(p_note, '')), '') is null) then
      raise exception 'A non-delivery status requires a note and cannot include ice items';
    end if;

    if exists (
      select 1
      from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
      left join public.ice_types ice on ice.id = item.ice_type_id and ice.is_active
      where item.ice_type_id is null or item.quantity is null
        or item.quantity <= 0 or ice.id is null
    ) or exists (
      select 1
      from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
      group by item.ice_type_id having count(*) > 1
    ) then
      raise exception 'Every delivery item must use a distinct active ice type and a positive quantity';
    end if;

    if v_original_charge_id is null and p_approval_id is not null then
      raise exception 'A legacy unpriced correction cannot use a financial approval';
    end if;

    if v_original_charge_id is not null and p_stop_status <> 'delivered'
      and p_approval_id is not null then
      raise exception 'A non-delivery correction cannot use a financial approval';
    end if;
  end if;

  v_request_fingerprint := public.delivery_request_fingerprint(
    v_round_stop_id, p_items, p_stop_status, p_note, v_payment_term
  );
  v_revision_fingerprint := md5(jsonb_build_object(
    'action', p_action,
    'reason', trim(p_reason),
    'delivery_fingerprint', v_request_fingerprint
  )::text);

  update public.delivery_events
  set status = 'cancelled',
      cancelled_by = auth.uid(),
      cancelled_at = now(),
      cancellation_reason = trim(p_reason)
  where id = p_event_id;

  if p_action = 'correct' then
    for v_item in
      select item.ice_type_id, item.quantity
      from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
      order by item.ice_type_id
    loop
      if public.stock_balance_at(v_service_date, v_source_location_id, v_item.ice_type_id)
        < v_item.quantity then
        raise exception 'The source location does not have enough stock for the corrected delivery';
      end if;

      if v_original_charge_id is not null then
        select resolved.unit_price, resolved.price_source, resolved.price_source_id
        into v_unit_price, v_price_source, v_price_source_id
        from public.resolve_delivery_price(
          v_shop_id, v_item.ice_type_id, v_service_date
        ) resolved;

        if v_unit_price is null then
          raise exception 'An effective price is required for every corrected ice type';
        end if;
        v_total_amount := v_total_amount + (v_item.quantity * v_unit_price);
      end if;
    end loop;

    if v_original_charge_id is not null and p_stop_status = 'delivered' then
      perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_shop_id::text, 0));

      if v_payment_term = 'credit' then
        select profile.* into v_profile
        from public.shop_payment_profiles profile
        where profile.shop_id = v_shop_id;

        if v_profile.id is null or not ('credit' = any(v_profile.allowed_payment_terms)) then
          raise exception 'The selected shop does not have an active credit payment profile';
        end if;

        select coalesce(sum(greatest(
          charge.original_amount - coalesce(allocation.allocated_amount, 0), 0
        )), 0)::numeric(12,2)
        into v_credit_exposure
        from public.delivery_charges charge
        left join lateral (
          select coalesce(sum(allocation.amount), 0)::numeric(12,2) as allocated_amount
          from public.payment_allocations allocation
          join public.payments payment on payment.id = allocation.payment_id
          where allocation.charge_id = charge.id and payment.status = 'active'
        ) allocation on true
        where charge.shop_id = v_shop_id
          and charge.payment_term = 'credit'
          and charge.status = 'active';

        if v_profile.credit_limit is not null
          and v_credit_exposure + v_total_amount > v_profile.credit_limit then
          if p_approval_id is null then
            raise exception 'An approved credit-limit request is required for this correction';
          end if;

          select approval.shop_id, approval.round_stop_id, approval.kind,
            approval.requested_amount, approval.request_fingerprint, approval.status
          into v_approval_shop_id, v_approval_stop_id, v_approval_kind,
            v_approval_amount, v_approval_fingerprint, v_approval_status
          from public.financial_approval_requests approval
          where approval.id = p_approval_id
          for update;

          if v_approval_status is distinct from 'approved'
            or v_approval_shop_id is distinct from v_shop_id
            or v_approval_stop_id is distinct from v_round_stop_id
            or v_approval_kind is distinct from 'credit_limit'
            or v_approval_amount is distinct from v_total_amount
            or v_approval_fingerprint is distinct from v_request_fingerprint then
            raise exception 'The financial approval does not match this correction request';
          elsif v_service_date is distinct from
            (now() at time zone 'Asia/Bangkok')::date then
            raise exception 'Financial approval has expired';
          end if;
        elsif p_approval_id is not null then
          raise exception 'This correction does not require a financial approval';
        end if;
      elsif p_approval_id is not null then
        raise exception 'Only a credit-limit correction can use this approval';
      end if;
    end if;

    insert into public.delivery_events (
      round_stop_id, recorded_by, idempotency_key, request_fingerprint, note,
      source_stock_location_id, corrects_event_id
    ) values (
      v_round_stop_id, auth.uid(), p_idempotency_key, v_request_fingerprint,
      nullif(trim(coalesce(p_note, '')), ''), v_source_location_id, p_event_id
    ) returning id into v_replacement_id;

    for v_item in
      select item.ice_type_id, item.quantity
      from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
      order by item.ice_type_id
    loop
      if v_original_charge_id is not null and p_stop_status = 'delivered' then
        select resolved.unit_price, resolved.price_source, resolved.price_source_id
        into v_unit_price, v_price_source, v_price_source_id
        from public.resolve_delivery_price(
          v_shop_id, v_item.ice_type_id, v_service_date
        ) resolved;
      else
        v_unit_price := null;
        v_price_source := null;
        v_price_source_id := null;
      end if;

      insert into public.delivery_items (
        delivery_event_id, ice_type_id, quantity,
        unit_price, price_source, price_source_id
      ) values (
        v_replacement_id, v_item.ice_type_id, v_item.quantity,
        v_unit_price, v_price_source, v_price_source_id
      );
    end loop;

    if v_original_charge_id is not null and p_stop_status = 'delivered' then
      insert into public.delivery_charges (
        delivery_event_id, shop_id, service_date, payment_term,
        original_amount, due_date, approval_request_id
      ) values (
        v_replacement_id, v_shop_id, v_service_date, v_payment_term,
        v_total_amount, v_due_date, p_approval_id
      );

      if p_approval_id is not null then
        update public.financial_approval_requests
        set status = 'consumed', consumed_by_delivery_event_id = v_replacement_id,
            consumed_at = now()
        where id = p_approval_id and status = 'approved';
      end if;
    end if;

    update public.round_stops
    set status = p_stop_status,
        note = nullif(trim(coalesce(p_note, '')), ''),
        updated_by = auth.uid(),
        updated_at = now()
    where id = v_round_stop_id;

    insert into public.audit_logs (
      actor_id, entity_type, entity_id, action, after_value, reason
    ) values (
      auth.uid(), 'delivery_events', v_replacement_id, 'corrected',
      jsonb_build_object(
        'corrects_event_id', p_event_id,
        'round_stop_id', v_round_stop_id,
        'items', p_items,
        'stop_status', p_stop_status,
        'note', nullif(trim(coalesce(p_note, '')), ''),
        'source_stock_location_id', v_source_location_id,
        'charge_total', case
          when v_original_charge_id is not null and p_stop_status = 'delivered'
            then v_total_amount
          else null
        end,
        'payment_term', v_payment_term
      ), trim(p_reason)
    );
  else
    select
      coalesce((
        select (log.after_value ->> 'stop_status')::public.shop_round_status
        from public.audit_logs log
        where log.entity_type = 'delivery_events' and log.entity_id = event.id
          and log.after_value ? 'stop_status'
        order by log.occurred_at
        limit 1
      ), case when exists (
        select 1 from public.delivery_items item where item.delivery_event_id = event.id
      ) then 'delivered'::public.shop_round_status else 'issue'::public.shop_round_status end),
      event.note
    into v_latest_status, v_latest_note
    from public.delivery_events event
    where event.round_stop_id = v_round_stop_id and event.status = 'active'
    order by event.recorded_at desc
    limit 1;

    update public.round_stops
    set status = coalesce(v_latest_status, 'pending'),
        note = v_latest_note,
        updated_by = auth.uid(),
        updated_at = now()
    where id = v_round_stop_id;
  end if;

  insert into public.delivery_event_revisions (
    idempotency_key, original_event_id, replacement_event_id,
    action, reason, revised_by, request_fingerprint
  ) values (
    p_idempotency_key, p_event_id, v_replacement_id,
    p_action, trim(p_reason), auth.uid(), v_revision_fingerprint
  );

  return public.get_manager_delivery_events(v_round_id);
end;
$$;

revoke all on function public.revise_delivery_event(
  uuid, text, jsonb, public.shop_round_status, text, text, uuid, uuid
) from public;
grant execute on function public.revise_delivery_event(
  uuid, text, jsonb, public.shop_round_status, text, text, uuid, uuid
) to authenticated;
