-- Production RPCs for measured casual-customer sales and free issues.
-- Loose/portion sales remain disabled until the aggregate close workflow can
-- reconcile them atomically.

create table public.casual_void_requests (
  idempotency_key uuid primary key,
  transaction_id uuid not null references public.casual_transactions(id) on delete restrict,
  request_fingerprint text not null,
  recorded_by uuid not null references public.users(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  constraint casual_void_requests_fingerprint_check check (
    nullif(trim(request_fingerprint), '') is not null
  )
);

alter table public.casual_void_requests enable row level security;
create policy "authorized users read casual void requests"
on public.casual_void_requests for select
using (
  public.is_active_user()
  and (
    recorded_by = auth.uid()
    or public.current_app_role() in ('admin', 'round_lead')
  )
);
revoke all on table public.casual_void_requests from anon, authenticated;
grant select on table public.casual_void_requests to authenticated;

create function public.get_casual_transaction_capability()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when public.is_active_user() then
    jsonb_build_object('enabled', true, 'version', 1, 'fulfillment_modes', jsonb_build_array('measured'))
  else
    jsonb_build_object('enabled', false, 'version', 1, 'fulfillment_modes', '[]'::jsonb)
  end;
$$;

create or replace function public.stock_balance_at(
  p_service_date date,
  p_location_id uuid,
  p_ice_type_id uuid
)
returns numeric(12, 1)
language sql
stable
security definer
set search_path = public
as $$
  with movement_totals as (
    select
      coalesce(sum(item.quantity) filter (where movement.to_location_id = p_location_id), 0)
        - coalesce(sum(item.quantity) filter (where movement.from_location_id = p_location_id), 0)
        as quantity
    from public.stock_movements movement
    join public.stock_movement_items item on item.movement_id = movement.id
    where movement.service_date = p_service_date
      and movement.status = 'active'
      and (
        movement.kind <> 'factory_order'
        or not exists (
          select 1 from public.factory_receipts receipt
          where receipt.factory_order_id = movement.id
        )
      )
      and item.ice_type_id = p_ice_type_id
      and (movement.from_location_id = p_location_id or movement.to_location_id = p_location_id)
  ), delivery_totals as (
    select (
      coalesce(sum(item.quantity), 0)
      + coalesce((
        select sum(adjustment_item.quantity_delta)
        from public.delivery_charge_adjustments adjustment
        join public.delivery_adjustment_items adjustment_item
          on adjustment_item.adjustment_id = adjustment.idempotency_key
        join public.delivery_charges charge on charge.id = adjustment.charge_id
        join public.delivery_events adjusted_event on adjusted_event.id = charge.delivery_event_id
        where adjustment.status = 'active' and adjustment.scope = 'round_closed'
          and charge.service_date = p_service_date
          and adjusted_event.source_stock_location_id = p_location_id
          and adjustment_item.ice_type_id = p_ice_type_id
      ), 0)
    ) as quantity
    from public.delivery_events event
    join public.delivery_items item on item.delivery_event_id = event.id
    join public.round_stops stop on stop.id = event.round_stop_id
    join public.delivery_rounds round on round.id = stop.round_id
    where round.service_date = p_service_date
      and event.status = 'active'
      and event.source_stock_location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
  ), casual_totals as (
    select coalesce(sum(transaction.quantity), 0) as quantity
    from public.casual_transactions transaction
    where transaction.service_date = p_service_date
      and transaction.status = 'active'
      and transaction.fulfillment_mode = 'measured'
      and transaction.source_stock_location_id = p_location_id
      and transaction.ice_type_id = p_ice_type_id
  ), receipt_totals as (
    select coalesce(sum(item.actual_quantity), 0) as quantity
    from public.factory_receipts receipt
    join public.factory_receipt_items item on item.factory_receipt_id = receipt.id
    join public.stock_movements factory_order on factory_order.id = receipt.factory_order_id
    where receipt.service_date = p_service_date
      and receipt.truck_location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
      and factory_order.status = 'active'
  ), count_adjustment as (
    select coalesce(sum(item.variance_quantity), 0) as quantity
    from public.daily_stock_closure_items item
    join public.daily_stock_closures closure on closure.service_date = item.service_date
    where item.service_date = p_service_date
      and item.location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
      and closure.status in ('closing', 'closed')
  )
  select (
    movement_totals.quantity - delivery_totals.quantity - casual_totals.quantity
    + receipt_totals.quantity + count_adjustment.quantity
  )::numeric(12, 1)
  from movement_totals, delivery_totals, casual_totals, receipt_totals, count_adjustment;
$$;

create or replace function public.daily_aggregate_stock_balance_at(
  p_service_date date,
  p_ice_type_id uuid
)
returns numeric(12,1)
language sql
stable
security definer
set search_path = public
as $$
  select case when exists (
    select 1 from public.daily_aggregate_stock_closures closure
    where closure.service_date = p_service_date and closure.status = 'closed'
  ) then 0::numeric(12,1) else (
    coalesce((
      select sum(item.quantity)
      from public.stock_movements movement
      join public.stock_movement_items item on item.movement_id = movement.id
      where movement.service_date = p_service_date and movement.status = 'active'
        and movement.kind = 'factory_order' and item.ice_type_id = p_ice_type_id
        and not exists (
          select 1 from public.factory_receipts receipt where receipt.factory_order_id = movement.id
        )
    ), 0)
    + coalesce((
      select sum(item.actual_quantity)
      from public.factory_receipts receipt
      join public.factory_receipt_items item on item.factory_receipt_id = receipt.id
      join public.stock_movements movement on movement.id = receipt.factory_order_id
      where receipt.service_date = p_service_date and movement.status = 'active'
        and item.ice_type_id = p_ice_type_id
    ), 0)
    - coalesce((
      select sum(item.quantity)
      from public.delivery_events event
      join public.delivery_items item on item.delivery_event_id = event.id
      join public.round_stops stop on stop.id = event.round_stop_id
      join public.delivery_rounds round on round.id = stop.round_id
      where round.service_date = p_service_date and event.status = 'active'
        and event.source_stock_location_id is not null and item.ice_type_id = p_ice_type_id
    ), 0)
    - coalesce((
      select sum(transaction.quantity)
      from public.casual_transactions transaction
      where transaction.service_date = p_service_date
        and transaction.status = 'active'
        and transaction.fulfillment_mode = 'measured'
        and transaction.ice_type_id = p_ice_type_id
    ), 0)
    - coalesce((
      select sum(adjustment_item.quantity_delta)
      from public.delivery_charge_adjustments adjustment
      join public.delivery_adjustment_items adjustment_item
        on adjustment_item.adjustment_id = adjustment.idempotency_key
      join public.delivery_charges charge on charge.id = adjustment.charge_id
      where adjustment.status = 'active' and adjustment.scope = 'round_closed'
        and charge.service_date = p_service_date and adjustment_item.ice_type_id = p_ice_type_id
    ), 0)
    - coalesce((
      select sum(item.quantity)
      from public.daily_stock_uses usage
      join public.daily_stock_use_items item on item.use_id = usage.id
      where usage.service_date = p_service_date and usage.status = 'active'
        and item.ice_type_id = p_ice_type_id
    ), 0)
    - coalesce((
      select sum(item.quantity)
      from public.stock_movements movement
      join public.stock_movement_items item on item.movement_id = movement.id
      where movement.service_date = p_service_date and movement.status = 'active'
        and movement.kind in ('damage', 'return_to_factory') and item.ice_type_id = p_ice_type_id
    ), 0)
  )::numeric(12,1) end;
$$;

create function public.casual_transaction_response(p_transaction_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'transaction', jsonb_build_object(
      'id', transaction.id,
      'service_date', transaction.service_date,
      'round_id', transaction.round_id,
      'ice_type_id', transaction.ice_type_id,
      'ice_type_name', ice.name,
      'ice_type_unit', ice.unit,
      'transaction_kind', transaction.transaction_kind,
      'fulfillment_mode', transaction.fulfillment_mode,
      'quantity', transaction.quantity,
      'sale_amount', transaction.sale_amount,
      'payment_method', transaction.payment_method,
      'received_amount', transaction.received_amount,
      'change_amount', transaction.change_amount,
      'reference_number', transaction.reference_number,
      'note', transaction.note,
      'receipt_number', transaction.receipt_number,
      'recorded_at', transaction.recorded_at,
      'status', transaction.status,
      'voided_at', transaction.voided_at,
      'void_reason', transaction.void_reason
    ),
    'receipt', snapshot.receipt_data
  )
  from public.casual_transactions transaction
  join public.ice_types ice on ice.id = transaction.ice_type_id
  left join public.casual_receipt_snapshots snapshot on snapshot.transaction_id = transaction.id
  where transaction.id = p_transaction_id;
$$;

create function public.get_casual_transaction_context(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_round public.delivery_rounds%rowtype;
  v_source public.stock_locations%rowtype;
  v_source_count integer;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  end if;

  select round.* into v_round
  from public.delivery_rounds round where round.id = p_round_id;
  if v_round.id is null then
    raise exception 'The selected delivery round does not exist';
  elsif public.current_app_role() = 'courier' and not public.is_round_member(p_round_id) then
    raise exception 'You are not assigned to this delivery round';
  end if;

  if public.current_app_role() = 'courier' then
    select count(*)::integer into v_source_count
    from public.stock_locations location
    where location.assigned_user_id = auth.uid()
      and location.kind in ('team', 'small_vehicle') and location.is_active;
    if v_source_count = 0 then
      raise exception 'Casual sales require one active assigned holding location; none is configured';
    elsif v_source_count > 1 then
      raise exception 'Casual sales require one active assigned holding location; multiple are configured';
    end if;
    select location.* into v_source
    from public.stock_locations location
    where location.assigned_user_id = auth.uid()
      and location.kind in ('team', 'small_vehicle') and location.is_active;
  else
    select count(*)::integer into v_source_count
    from public.stock_locations location
    where location.kind = 'truck' and location.is_courier_source and location.is_active;
    if v_source_count <> 1 then
      raise exception 'Casual sales require one configured courier source truck';
    end if;
    select location.* into v_source
    from public.stock_locations location
    where location.kind = 'truck' and location.is_courier_source and location.is_active;
  end if;

  return jsonb_build_object(
    'round_id', v_round.id,
    'service_date', v_round.service_date,
    'round_status', v_round.status,
    'stock_closed', exists (
      select 1 from public.daily_aggregate_stock_closures closure
      where closure.service_date = v_round.service_date
    ),
    'stock_source', jsonb_build_object(
      'id', v_source.id, 'code', v_source.code, 'name', v_source.name
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', ice.id,
        'code', ice.code,
        'name', ice.name,
        'unit', ice.unit,
        'available_quantity', least(
          public.stock_balance_at(v_round.service_date, v_source.id, ice.id),
          public.daily_aggregate_stock_balance_at(v_round.service_date, ice.id)
        )
      ) order by ice.code)
      from public.ice_types ice where ice.is_active
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', transaction.id,
        'ice_type_id', transaction.ice_type_id,
        'ice_type_name', ice.name,
        'ice_type_unit', ice.unit,
        'transaction_kind', transaction.transaction_kind,
        'fulfillment_mode', transaction.fulfillment_mode,
        'quantity', transaction.quantity,
        'sale_amount', transaction.sale_amount,
        'payment_method', transaction.payment_method,
        'received_amount', transaction.received_amount,
        'change_amount', transaction.change_amount,
        'receipt_number', transaction.receipt_number,
        'note', transaction.note,
        'recorded_at', transaction.recorded_at,
        'status', transaction.status,
        'voided_at', transaction.voided_at,
        'void_reason', transaction.void_reason
      ) order by transaction.recorded_at desc)
      from public.casual_transactions transaction
      join public.ice_types ice on ice.id = transaction.ice_type_id
      where transaction.round_id = v_round.id
        and transaction.service_date = v_round.service_date
        and (
          transaction.recorded_by = auth.uid()
          or public.current_app_role() in ('admin', 'round_lead')
        )
    ), '[]'::jsonb)
  );
end;
$$;

create function public.record_casual_transaction(
  p_round_id uuid,
  p_ice_type_id uuid,
  p_quantity numeric,
  p_transaction_kind public.casual_transaction_kind,
  p_sale_amount numeric,
  p_payment_method public.payment_method,
  p_received_amount numeric,
  p_reference_number text,
  p_evidence_path text,
  p_note text,
  p_client_recorded_at timestamptz,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_context jsonb;
  v_round public.delivery_rounds%rowtype;
  v_source_location_id uuid;
  v_transaction_id uuid;
  v_existing public.casual_transactions%rowtype;
  v_change_amount numeric;
  v_receipt_number text;
  v_request_fingerprint text;
  v_receipt jsonb;
  v_ice public.ice_types%rowtype;
  v_service_date date;
  v_recorder_name text;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif p_idempotency_key is null then
    raise exception 'An idempotency key is required';
  elsif p_ice_type_id is null or p_quantity is null or p_transaction_kind is null then
    raise exception 'Ice type, quantity, and transaction kind are required';
  elsif p_quantity <= 0 or p_quantity >= 100000000000 or mod(p_quantity, 0.5) <> 0 then
    raise exception 'Casual sale quantity must increase in half-bag steps';
  elsif p_sale_amount is null or p_sale_amount <> trunc(p_sale_amount) then
    raise exception 'Casual sale amount must be a whole baht amount';
  end if;

  if p_transaction_kind = 'paid' then
    if p_sale_amount <= 0 or p_payment_method is null or p_received_amount is null
      or p_received_amount <> trunc(p_received_amount) then
      raise exception 'Paid casual sales require a positive whole-baht sale and received amount';
    elsif p_payment_method = 'cash' and p_received_amount < p_sale_amount then
      raise exception 'Cash received must cover the casual sale amount';
    elsif p_payment_method <> 'cash' and p_received_amount <> p_sale_amount then
      raise exception 'Transfer and QR payments must equal the casual sale amount';
    elsif p_payment_method <> 'cash'
      and nullif(trim(coalesce(p_evidence_path, '')), '') is null then
      raise exception 'Transfer and QR payments require evidence';
    end if;
    v_change_amount := p_received_amount - p_sale_amount;
  else
    if p_sale_amount <> 0 or p_payment_method is not null or p_received_amount is not null
      or p_reference_number is not null or p_evidence_path is not null then
      raise exception 'Free casual issues cannot include payment details';
    end if;
    v_change_amount := null;
  end if;

  if nullif(trim(coalesce(p_evidence_path, '')), '') is not null and not exists (
    select 1 from storage.objects evidence
    where evidence.bucket_id = 'payment-evidence'
      and evidence.name = trim(p_evidence_path)
      and split_part(evidence.name, '/', 1) = auth.uid()::text
  ) then
    raise exception 'Payment evidence was not uploaded by the current user';
  end if;

  select md5(jsonb_build_object(
    'operation', 'casual_measured', 'round_id', p_round_id,
    'ice_type_id', p_ice_type_id, 'quantity', p_quantity,
    'transaction_kind', p_transaction_kind, 'sale_amount', p_sale_amount,
    'payment_method', p_payment_method, 'received_amount', p_received_amount,
    'reference_number', nullif(trim(coalesce(p_reference_number, '')), ''),
    'evidence_path', nullif(trim(coalesce(p_evidence_path, '')), ''),
    'note', nullif(trim(coalesce(p_note, '')), '')
  )::text) into v_request_fingerprint;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select transaction.* into v_existing
  from public.casual_transactions transaction
  where transaction.idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    if v_existing.recorded_by <> auth.uid()
      or v_existing.request_fingerprint <> v_request_fingerprint then
      raise exception 'This idempotency key belongs to a different casual transaction request';
    end if;
    return public.casual_transaction_response(v_existing.id);
  end if;

  select round.service_date into v_service_date
  from public.delivery_rounds round where round.id = p_round_id;
  if v_service_date is null then
    raise exception 'The selected delivery round does not exist';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));
  select round.* into v_round from public.delivery_rounds round
  where round.id = p_round_id for update;
  if v_round.id is null or v_round.service_date <> v_service_date then
    raise exception 'The selected delivery round changed while recording';
  elsif v_round.status <> 'open' or v_round.cancelled_at is not null then
    raise exception 'The selected delivery round is not open';
  end if;

  v_context := public.get_casual_transaction_context(p_round_id);
  if coalesce((v_context ->> 'stock_closed')::boolean, false) then
    raise exception 'Stock for this service date is already closed';
  end if;
  v_source_location_id := (v_context -> 'stock_source' ->> 'id')::uuid;

  select ice.* into v_ice from public.ice_types ice
  where ice.id = p_ice_type_id and ice.is_active;
  if v_ice.id is null then
    raise exception 'The selected ice type is not active';
  elsif public.stock_balance_at(v_round.service_date, v_source_location_id, p_ice_type_id) < p_quantity then
    raise exception 'The employee holding does not have enough stock';
  elsif public.daily_aggregate_stock_balance_at(v_round.service_date, p_ice_type_id) < p_quantity then
    raise exception 'Daily aggregate stock is not sufficient';
  end if;

  if p_transaction_kind = 'paid' then
    v_receipt_number := public.next_sales_document_number(
      'REC', date_trunc('month', now() at time zone 'Asia/Bangkok')::date
    );
  end if;

  insert into public.casual_transactions (
    service_date, round_id, source_stock_location_id, ice_type_id,
    transaction_kind, fulfillment_mode, quantity, sale_amount, payment_method,
    received_amount, change_amount, reference_number, evidence_path, note,
    receipt_number, idempotency_key, request_fingerprint, client_recorded_at, recorded_by
  ) values (
    v_round.service_date, p_round_id, v_source_location_id, p_ice_type_id,
    p_transaction_kind, 'measured', p_quantity, p_sale_amount, p_payment_method,
    p_received_amount, v_change_amount, nullif(trim(coalesce(p_reference_number, '')), ''),
    nullif(trim(coalesce(p_evidence_path, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
    v_receipt_number, p_idempotency_key, v_request_fingerprint, p_client_recorded_at, auth.uid()
  ) returning id into v_transaction_id;

  if p_transaction_kind = 'paid' then
    select user_row.display_name into v_recorder_name
    from public.users user_row where user_row.id = auth.uid();
    v_receipt := jsonb_build_object(
      'document_type', 'REC',
      'document_number', v_receipt_number,
      'receipt_number', v_receipt_number,
      'document_title', 'ใบรับเงิน',
      'status', 'active',
      'issued_at', now(),
      'recorded_at', now(),
      'service_date', v_round.service_date,
      'shop_code', 'WALK-IN',
      'shop_name', 'ลูกค้าขาจร',
      'shop_location', v_context -> 'stock_source' ->> 'name',
      'recorded_by_name', v_recorder_name,
      'payment_term', 'immediate',
      'payment_method', p_payment_method,
      'received_amount', p_received_amount,
      'allocated_amount', p_sale_amount,
      'change_amount', v_change_amount,
      'total_amount', p_sale_amount,
      'items', jsonb_build_array(jsonb_build_object(
        'ice_type_name', v_ice.name,
        'ice_type_unit', v_ice.unit,
        'quantity', p_quantity,
        'unit_price', null,
        'line_total', p_sale_amount
      )),
      'charges', '[]'::jsonb,
      'void_info', null
    );
    insert into public.casual_receipt_snapshots (transaction_id, receipt_data)
    values (v_transaction_id, v_receipt);
  end if;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (auth.uid(), 'casual_transactions', v_transaction_id, 'created', jsonb_build_object(
    'round_id', p_round_id, 'ice_type_id', p_ice_type_id, 'quantity', p_quantity,
    'transaction_kind', p_transaction_kind, 'sale_amount', p_sale_amount,
    'payment_method', p_payment_method, 'receipt_number', v_receipt_number
  ));

  return public.casual_transaction_response(v_transaction_id);
end;
$$;

create function public.get_casual_receipt_snapshot(p_transaction_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_transaction public.casual_transactions%rowtype;
  v_snapshot jsonb;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  end if;
  select transaction.* into v_transaction
  from public.casual_transactions transaction where transaction.id = p_transaction_id;
  if v_transaction.id is null then
    raise exception 'The casual transaction does not exist';
  elsif v_transaction.recorded_by <> auth.uid()
    and public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'You cannot view this casual receipt';
  elsif v_transaction.transaction_kind <> 'paid' then
    raise exception 'Free casual issues do not have receipts';
  end if;
  select snapshot.receipt_data into v_snapshot
  from public.casual_receipt_snapshots snapshot
  where snapshot.transaction_id = p_transaction_id;
  if v_transaction.status = 'voided' then
    v_snapshot := v_snapshot || jsonb_build_object(
      'status', 'voided',
      'void_info', jsonb_build_object(
        'voided_at', v_transaction.voided_at,
        'reason', v_transaction.void_reason,
        'voided_by', v_transaction.voided_by
      )
    );
  end if;
  return v_snapshot;
end;
$$;

create function public.void_casual_transaction(
  p_transaction_id uuid,
  p_reason text,
  p_refund_method public.payment_method,
  p_reference_number text,
  p_evidence_path text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_transaction public.casual_transactions%rowtype;
  v_existing_request public.casual_void_requests%rowtype;
  v_request_fingerprint text;
  v_service_date date;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif p_transaction_id is null or p_idempotency_key is null
    or nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'Transaction, reason, and idempotency key are required';
  end if;

  select md5(jsonb_build_object(
    'operation', 'void_casual', 'transaction_id', p_transaction_id,
    'reason', trim(p_reason), 'refund_method', p_refund_method,
    'reference_number', nullif(trim(coalesce(p_reference_number, '')), ''),
    'evidence_path', nullif(trim(coalesce(p_evidence_path, '')), '')
  )::text) into v_request_fingerprint;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select request.* into v_existing_request from public.casual_void_requests request
  where request.idempotency_key = p_idempotency_key;
  if v_existing_request.idempotency_key is not null then
    if v_existing_request.recorded_by <> auth.uid()
      or v_existing_request.transaction_id <> p_transaction_id
      or v_existing_request.request_fingerprint <> v_request_fingerprint then
      raise exception 'This idempotency key belongs to a different casual void request';
    end if;
    return public.casual_transaction_response(p_transaction_id);
  end if;

  select transaction.service_date into v_service_date
  from public.casual_transactions transaction where transaction.id = p_transaction_id;
  if v_service_date is null then
    raise exception 'The casual transaction does not exist';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));
  select transaction.* into v_transaction from public.casual_transactions transaction
  where transaction.id = p_transaction_id for update;
  if v_transaction.id is null or v_transaction.service_date <> v_service_date then
    raise exception 'The casual transaction changed while voiding';
  elsif v_transaction.status <> 'active' then
    raise exception 'The casual transaction is already voided';
  elsif v_transaction.recorded_by <> auth.uid()
    and public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'You cannot void this casual transaction';
  elsif exists (
    select 1 from public.daily_aggregate_stock_closures closure
    where closure.service_date = v_transaction.service_date
  ) then
    raise exception 'Casual transactions cannot be voided after stock is closed';
  end if;

  if v_transaction.transaction_kind = 'paid' then
    if p_refund_method is null then
      raise exception 'Paid casual transactions require a refund method';
    elsif p_refund_method <> 'cash'
      and nullif(trim(coalesce(p_evidence_path, '')), '') is null then
      raise exception 'Transfer and QR refunds require evidence';
    elsif nullif(trim(coalesce(p_evidence_path, '')), '') is not null and not exists (
      select 1 from storage.objects evidence
      where evidence.bucket_id = 'payment-evidence'
        and evidence.name = trim(p_evidence_path)
        and split_part(evidence.name, '/', 1) = auth.uid()::text
    ) then
      raise exception 'Refund evidence was not uploaded by the current user';
    end if;
    insert into public.casual_refund_confirmations (
      transaction_id, refunded_amount, refund_method, reference_number,
      evidence_path, confirmed_by, idempotency_key, request_fingerprint
    ) values (
      p_transaction_id, v_transaction.sale_amount, p_refund_method,
      nullif(trim(coalesce(p_reference_number, '')), ''),
      nullif(trim(coalesce(p_evidence_path, '')), ''), auth.uid(),
      p_idempotency_key, v_request_fingerprint
    );
  elsif p_refund_method is not null or p_reference_number is not null or p_evidence_path is not null then
    raise exception 'Free casual issues cannot include refund details';
  end if;

  insert into public.casual_void_requests (
    idempotency_key, transaction_id, request_fingerprint, recorded_by
  ) values (p_idempotency_key, p_transaction_id, v_request_fingerprint, auth.uid());

  update public.casual_transactions
  set status = 'voided', voided_by = auth.uid(), voided_at = now(), void_reason = trim(p_reason)
  where id = p_transaction_id;

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, before_value, after_value, reason
  ) values (
    auth.uid(), 'casual_transactions', p_transaction_id, 'voided',
    to_jsonb(v_transaction), public.casual_transaction_response(p_transaction_id) -> 'transaction', trim(p_reason)
  );
  return public.casual_transaction_response(p_transaction_id);
end;
$$;

create function public.accounting_casual_transaction_rows(
  p_from_date date,
  p_to_date date
)
returns table (
  occurred_at timestamptz,
  service_date date,
  type text,
  group_id uuid,
  source_id uuid,
  source_table text,
  delivery_event_id uuid,
  payment_id uuid,
  document_number text,
  reference_number text,
  shop_id uuid,
  shop_code text,
  shop_name text,
  holder_name text,
  employee_id uuid,
  employee_name text,
  ice_type_id uuid,
  ice_type_name text,
  unit text,
  quantity_in numeric,
  quantity_out numeric,
  sales_amount numeric,
  cash_in numeric,
  cash_out numeric,
  receivable_delta numeric,
  status text,
  note text,
  issue_code text,
  issue_label text,
  can_correct boolean,
  details jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    transaction.recorded_at, transaction.service_date,
    case when transaction.transaction_kind = 'paid' then 'SALE' else 'FREE' end,
    transaction.id, transaction.id, 'casual_transactions', null::uuid, null::uuid,
    case when transaction.transaction_kind = 'paid' then 'SALE-' else 'FREE-' end
      || upper(left(replace(transaction.id::text, '-', ''), 8)),
    transaction.reference_number, null::uuid, 'WALK-IN', 'ลูกค้าขาจร',
    location.name, recorder.id, recorder.display_name,
    ice.id, ice.name, ice.unit, 0::numeric, transaction.quantity,
    case when transaction.transaction_kind = 'paid' then transaction.sale_amount else 0 end,
    0::numeric, 0::numeric, 0::numeric, transaction.status::text, transaction.note,
    null::text, null::text, false,
    jsonb_build_object(
      'transaction_kind', transaction.transaction_kind,
      'fulfillment_mode', transaction.fulfillment_mode,
      'payment_method', transaction.payment_method,
      'received_amount', transaction.received_amount,
      'change_amount', transaction.change_amount,
      'evidence_path', transaction.evidence_path,
      'receipt_number', transaction.receipt_number,
      'voided_at', transaction.voided_at,
      'void_reason', transaction.void_reason,
      'receipt_snapshot', snapshot.receipt_data
    )
  from public.casual_transactions transaction
  join public.stock_locations location on location.id = transaction.source_stock_location_id
  join public.users recorder on recorder.id = transaction.recorded_by
  join public.ice_types ice on ice.id = transaction.ice_type_id
  left join public.casual_receipt_snapshots snapshot on snapshot.transaction_id = transaction.id
  where transaction.service_date between p_from_date and p_to_date

  union all

  select
    transaction.recorded_at,
    (transaction.recorded_at at time zone 'Asia/Bangkok')::date,
    'REC', transaction.id, transaction.id, 'casual_transactions', null::uuid, null::uuid,
    transaction.receipt_number, transaction.reference_number,
    null::uuid, 'WALK-IN', 'ลูกค้าขาจร', location.name,
    recorder.id, recorder.display_name, null::uuid, null::text, null::text,
    0::numeric, 0::numeric, 0::numeric,
    transaction.sale_amount,
    0::numeric, 0::numeric, transaction.status::text, transaction.note,
    null::text, null::text, false,
    jsonb_build_object(
      'payment_method', transaction.payment_method,
      'received_amount', transaction.received_amount,
      'allocated_amount', transaction.sale_amount,
      'change_amount', transaction.change_amount,
      'evidence_path', transaction.evidence_path,
      'voided_at', transaction.voided_at,
      'void_reason', transaction.void_reason,
      'receipt_snapshot', snapshot.receipt_data
    )
  from public.casual_transactions transaction
  join public.stock_locations location on location.id = transaction.source_stock_location_id
  join public.users recorder on recorder.id = transaction.recorded_by
  join public.casual_receipt_snapshots snapshot on snapshot.transaction_id = transaction.id
  where transaction.transaction_kind = 'paid'
    and (transaction.recorded_at at time zone 'Asia/Bangkok')::date between p_from_date and p_to_date

  union all

  select
    confirmation.confirmed_at,
    (confirmation.confirmed_at at time zone 'Asia/Bangkok')::date,
    'REF', transaction.id, transaction.id, 'casual_refund_confirmations', null::uuid, null::uuid,
    'REF-' || upper(left(replace(transaction.id::text, '-', ''), 8)),
    confirmation.reference_number, null::uuid, 'WALK-IN', 'ลูกค้าขาจร', location.name,
    confirmer.id, confirmer.display_name, null::uuid, null::text, null::text,
    0::numeric, 0::numeric, 0::numeric, 0::numeric, confirmation.refunded_amount,
    0::numeric, 'settled', transaction.void_reason,
    null::text, null::text, false,
    jsonb_build_object(
      'refund_method', confirmation.refund_method,
      'refunded_amount', confirmation.refunded_amount,
      'evidence_path', confirmation.evidence_path,
      'receipt_number', transaction.receipt_number,
      'voided_at', transaction.voided_at,
      'void_reason', transaction.void_reason
    )
  from public.casual_refund_confirmations confirmation
  join public.casual_transactions transaction on transaction.id = confirmation.transaction_id
  join public.stock_locations location on location.id = transaction.source_stock_location_id
  join public.users confirmer on confirmer.id = confirmation.confirmed_by
  where (confirmation.confirmed_at at time zone 'Asia/Bangkok')::date between p_from_date and p_to_date;
$$;

alter function public.accounting_transaction_rows(date, date)
  rename to accounting_transaction_rows_without_casual;

create function public.accounting_transaction_rows(
  p_from_date date,
  p_to_date date
)
returns table (
  occurred_at timestamptz,
  service_date date,
  type text,
  group_id uuid,
  source_id uuid,
  source_table text,
  delivery_event_id uuid,
  payment_id uuid,
  document_number text,
  reference_number text,
  shop_id uuid,
  shop_code text,
  shop_name text,
  holder_name text,
  employee_id uuid,
  employee_name text,
  ice_type_id uuid,
  ice_type_name text,
  unit text,
  quantity_in numeric,
  quantity_out numeric,
  sales_amount numeric,
  cash_in numeric,
  cash_out numeric,
  receivable_delta numeric,
  status text,
  note text,
  issue_code text,
  issue_label text,
  can_correct boolean,
  details jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select row.* from public.accounting_transaction_rows_without_casual(p_from_date, p_to_date) row
  union all
  select row.* from public.accounting_casual_transaction_rows(p_from_date, p_to_date) row;
$$;

alter function public.accounting_aggregate_reconciliation_rows(date)
  rename to accounting_aggregate_reconciliation_rows_without_casual;

create function public.accounting_aggregate_reconciliation_rows(p_service_date date)
returns table (
  id uuid,
  code text,
  name text,
  unit text,
  factory_in numeric,
  sold numeric,
  damaged numeric,
  returned_to_factory numeric,
  expected numeric,
  actual numeric,
  variance numeric,
  count_status text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    row.id,
    row.code,
    row.name,
    row.unit,
    row.factory_in,
    row.sold + casual.quantity,
    row.damaged,
    row.returned_to_factory,
    row.expected - casual.quantity,
    row.actual,
    case when row.variance is null then null else row.variance + casual.quantity end,
    row.count_status
  from public.accounting_aggregate_reconciliation_rows_without_casual(p_service_date) row
  left join lateral (
    select coalesce(sum(transaction.quantity), 0)::numeric as quantity
    from public.casual_transactions transaction
    where transaction.service_date = p_service_date
      and transaction.status = 'active'
      and transaction.fulfillment_mode = 'measured'
      and transaction.ice_type_id = row.id
  ) casual on true;
$$;

alter function public.get_accounting_reconciliation(date)
  rename to get_accounting_reconciliation_without_casual;

create function public.get_accounting_reconciliation(p_service_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_casual_sales numeric;
  v_casual_received numeric;
  v_casual_refunded numeric;
begin
  v_result := public.get_accounting_reconciliation_without_casual(p_service_date);
  select coalesce(sum(transaction.sale_amount), 0)::numeric into v_casual_sales
  from public.casual_transactions transaction
  where transaction.service_date = p_service_date
    and transaction.status = 'active' and transaction.transaction_kind = 'paid';
  select coalesce(sum(transaction.sale_amount), 0)::numeric into v_casual_received
  from public.casual_transactions transaction
  where (transaction.recorded_at at time zone 'Asia/Bangkok')::date = p_service_date
    and transaction.transaction_kind = 'paid';
  select coalesce(sum(confirmation.refunded_amount), 0)::numeric into v_casual_refunded
  from public.casual_refund_confirmations confirmation
  where (confirmation.confirmed_at at time zone 'Asia/Bangkok')::date = p_service_date;
  v_result := jsonb_set(v_result, '{financial,effective_sales}', to_jsonb(
    coalesce((v_result #>> '{financial,effective_sales}')::numeric, 0) + v_casual_sales
  ));
  v_result := jsonb_set(v_result, '{financial,allocated_to_sales}', to_jsonb(
    coalesce((v_result #>> '{financial,allocated_to_sales}')::numeric, 0) + v_casual_sales
  ));
  v_result := jsonb_set(v_result, '{financial,cash_received}', to_jsonb(
    coalesce((v_result #>> '{financial,cash_received}')::numeric, 0) + v_casual_received
  ));
  v_result := jsonb_set(v_result, '{financial,cash_refunded}', to_jsonb(
    coalesce((v_result #>> '{financial,cash_refunded}')::numeric, 0) + v_casual_refunded
  ));
  v_result := jsonb_set(v_result, '{financial,net_cash}', to_jsonb(
    coalesce((v_result #>> '{financial,cash_received}')::numeric, 0)
      - coalesce((v_result #>> '{financial,cash_refunded}')::numeric, 0)
  ));
  v_result := jsonb_set(v_result, '{financial,casual_sales}', to_jsonb(v_casual_sales));
  v_result := jsonb_set(v_result, '{financial,casual_received}', to_jsonb(v_casual_received));
  v_result := jsonb_set(v_result, '{financial,casual_refunded}', to_jsonb(v_casual_refunded));
  return v_result;
end;
$$;

alter function public.get_accounting_shop_summary(date, date, jsonb, integer, integer)
  rename to get_accounting_shop_summary_without_casual;

create function public.get_accounting_shop_summary(
  p_from_date date,
  p_to_date date,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 100,
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
  v_casual_sales numeric := 0;
  v_casual_received numeric := 0;
  v_casual_refunded numeric := 0;
  v_casual_free_count integer := 0;
begin
  v_result := public.get_accounting_shop_summary_without_casual(
    p_from_date, p_to_date, p_filters, p_limit, p_offset
  );
  select
    coalesce(sum(transaction.sale_amount) filter (
      where transaction.status = 'active' and transaction.transaction_kind = 'paid'
    ), 0)::numeric,
    count(*) filter (
      where transaction.status = 'active' and transaction.transaction_kind = 'free'
    )::integer
  into v_casual_sales, v_casual_free_count
  from public.casual_transactions transaction
  where transaction.service_date between p_from_date and p_to_date;
  select coalesce(sum(transaction.sale_amount), 0)::numeric into v_casual_received
  from public.casual_transactions transaction
  where transaction.transaction_kind = 'paid'
    and transaction.recorded_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
    and transaction.recorded_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok';
  select coalesce(sum(confirmation.refunded_amount), 0)::numeric into v_casual_refunded
  from public.casual_refund_confirmations confirmation
  where confirmation.confirmed_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
    and confirmation.confirmed_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok';
  v_result := jsonb_set(v_result, '{totals,casual_sales_amount}', to_jsonb(v_casual_sales));
  v_result := jsonb_set(v_result, '{totals,casual_received_amount}', to_jsonb(v_casual_received));
  v_result := jsonb_set(v_result, '{totals,casual_refunded_amount}', to_jsonb(v_casual_refunded));
  v_result := jsonb_set(v_result, '{totals,casual_net_cash}', to_jsonb(
    v_casual_received - v_casual_refunded
  ));
  v_result := jsonb_set(v_result, '{totals,casual_free_count}', to_jsonb(v_casual_free_count));
  return v_result;
end;
$$;

create or replace function public.can_delete_payment_evidence(
  p_idempotency_key uuid,
  p_evidence_path text
)
returns boolean
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif p_idempotency_key is null or nullif(trim(coalesce(p_evidence_path, '')), '') is null then
    raise exception 'Idempotency key and evidence path are required';
  elsif split_part(trim(p_evidence_path), '/', 1) <> auth.uid()::text then
    raise exception 'Payment evidence does not belong to the current user';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  return not exists (
    select 1 from public.payments payment
    where payment.idempotency_key = p_idempotency_key
      or payment.evidence_path = trim(p_evidence_path)
  ) and not exists (
    select 1 from public.casual_transactions transaction
    where transaction.idempotency_key = p_idempotency_key
      or transaction.evidence_path = trim(p_evidence_path)
  ) and not exists (
    select 1 from public.casual_refund_confirmations confirmation
    where confirmation.idempotency_key = p_idempotency_key
      or confirmation.evidence_path = trim(p_evidence_path)
  );
end;
$$;

revoke all on function public.casual_transaction_response(uuid) from public, anon, authenticated;
revoke all on function public.get_casual_transaction_capability() from public, anon, authenticated;
revoke all on function public.get_casual_transaction_context(uuid) from public, anon, authenticated;
revoke all on function public.record_casual_transaction(
  uuid, uuid, numeric, public.casual_transaction_kind, numeric,
  public.payment_method, numeric, text, text, text, timestamptz, uuid
) from public, anon, authenticated;
revoke all on function public.get_casual_receipt_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.void_casual_transaction(
  uuid, text, public.payment_method, text, text, uuid
) from public, anon, authenticated;
revoke all on function public.accounting_casual_transaction_rows(date, date) from public, anon, authenticated;
revoke all on function public.accounting_transaction_rows_without_casual(date, date)
  from public, anon, authenticated;
revoke all on function public.accounting_transaction_rows(date, date)
  from public, anon, authenticated;
revoke all on function public.accounting_aggregate_reconciliation_rows_without_casual(date)
  from public, anon, authenticated;
revoke all on function public.accounting_aggregate_reconciliation_rows(date)
  from public, anon, authenticated;
revoke all on function public.get_accounting_reconciliation_without_casual(date) from public, anon, authenticated;
revoke all on function public.get_accounting_shop_summary_without_casual(date, date, jsonb, integer, integer)
  from public, anon, authenticated;
revoke all on function public.get_accounting_reconciliation(date) from public, anon, authenticated;
revoke all on function public.get_accounting_shop_summary(date, date, jsonb, integer, integer)
  from public, anon, authenticated;

grant execute on function public.get_casual_transaction_capability() to authenticated;
grant execute on function public.get_casual_transaction_context(uuid) to authenticated;
grant execute on function public.record_casual_transaction(
  uuid, uuid, numeric, public.casual_transaction_kind, numeric,
  public.payment_method, numeric, text, text, text, timestamptz, uuid
) to authenticated;
grant execute on function public.get_casual_receipt_snapshot(uuid) to authenticated;
grant execute on function public.void_casual_transaction(
  uuid, text, public.payment_method, text, text, uuid
) to authenticated;
grant execute on function public.get_accounting_reconciliation(date) to authenticated;
grant execute on function public.get_accounting_shop_summary(date, date, jsonb, integer, integer)
  to authenticated;

notify pgrst, 'reload schema';
