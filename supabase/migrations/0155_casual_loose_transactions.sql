-- Walk-in fragments are recorded against an ice type with a displayed quantity
-- of zero. They are auditable sales/free issues but never change stock.

create or replace function public.get_casual_transaction_capability()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when public.is_active_user() then
    jsonb_build_object('enabled', true, 'version', 2, 'fulfillment_modes', jsonb_build_array('measured', 'loose'))
  else
    jsonb_build_object('enabled', false, 'version', 2, 'fulfillment_modes', '[]'::jsonb)
  end;
$$;

create function public.record_casual_loose_transaction(
  p_round_id uuid,
  p_ice_type_id uuid,
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
  elsif p_ice_type_id is null or p_transaction_kind is null then
    raise exception 'Ice type and transaction kind are required';
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
    'operation', 'casual_loose', 'round_id', p_round_id,
    'ice_type_id', p_ice_type_id, 'transaction_kind', p_transaction_kind,
    'sale_amount', p_sale_amount, 'payment_method', p_payment_method,
    'received_amount', p_received_amount,
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
    p_transaction_kind, 'loose', null, p_sale_amount, p_payment_method,
    p_received_amount, v_change_amount, nullif(trim(coalesce(p_reference_number, '')), ''),
    nullif(trim(coalesce(p_evidence_path, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
    v_receipt_number, p_idempotency_key, v_request_fingerprint, p_client_recorded_at, auth.uid()
  ) returning id into v_transaction_id;

  if p_transaction_kind = 'paid' then
    select user_row.display_name into v_recorder_name
    from public.users user_row where user_row.id = auth.uid();
    v_receipt := jsonb_build_object(
      'document_type', 'REC', 'document_number', v_receipt_number,
      'receipt_number', v_receipt_number, 'document_title', 'ใบรับเงิน',
      'status', 'active', 'issued_at', now(), 'recorded_at', now(),
      'service_date', v_round.service_date, 'shop_code', 'WALK-IN',
      'shop_name', 'ลูกค้าขาจร', 'shop_location', v_context -> 'stock_source' ->> 'name',
      'recorded_by_name', v_recorder_name, 'payment_term', 'immediate',
      'payment_method', p_payment_method, 'received_amount', p_received_amount,
      'allocated_amount', p_sale_amount, 'change_amount', v_change_amount,
      'total_amount', p_sale_amount,
      'items', jsonb_build_array(jsonb_build_object(
        'ice_type_name', v_ice.name, 'ice_type_unit', v_ice.unit,
        'quantity', 0, 'unit_price', null, 'line_total', p_sale_amount
      )), 'charges', '[]'::jsonb, 'void_info', null
    );
    insert into public.casual_receipt_snapshots (transaction_id, receipt_data)
    values (v_transaction_id, v_receipt);
  end if;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (auth.uid(), 'casual_transactions', v_transaction_id, 'created', jsonb_build_object(
    'round_id', p_round_id, 'ice_type_id', p_ice_type_id, 'quantity', 0,
    'transaction_kind', p_transaction_kind, 'fulfillment_mode', 'loose',
    'sale_amount', p_sale_amount, 'payment_method', p_payment_method,
    'receipt_number', v_receipt_number
  ));

  return public.casual_transaction_response(v_transaction_id);
end;
$$;

alter function public.accounting_casual_transaction_rows(date, date)
  rename to accounting_casual_transaction_rows_with_nullable_quantity;

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
    row.occurred_at,
    row.service_date,
    row.type,
    row.group_id,
    row.source_id,
    row.source_table,
    row.delivery_event_id,
    row.payment_id,
    row.document_number,
    row.reference_number,
    row.shop_id,
    row.shop_code,
    row.shop_name,
    row.holder_name,
    row.employee_id,
    row.employee_name,
    row.ice_type_id,
    row.ice_type_name,
    row.unit,
    row.quantity_in,
    coalesce(row.quantity_out, 0),
    row.sales_amount,
    row.cash_in,
    row.cash_out,
    row.receivable_delta,
    row.status,
    row.note,
    row.issue_code,
    row.issue_label,
    row.can_correct,
    row.details
  from public.accounting_casual_transaction_rows_with_nullable_quantity(
    p_from_date,
    p_to_date
  ) row;
$$;

revoke all on function public.record_casual_loose_transaction(
  uuid, uuid, public.casual_transaction_kind, numeric, public.payment_method,
  numeric, text, text, text, timestamptz, uuid
) from public, anon, authenticated;
revoke all on function public.accounting_casual_transaction_rows(date, date)
  from public, anon, authenticated;
grant execute on function public.record_casual_loose_transaction(
  uuid, uuid, public.casual_transaction_kind, numeric, public.payment_method,
  numeric, text, text, text, timestamptz, uuid
) to authenticated;
