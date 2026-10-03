-- recorded_at is the receipt/business date used by existing daily reports.
-- Keep the actual entry time separately; historical entry times are unknown.
alter table public.payments
  add column entered_at timestamptz,
  add column received_date_override date;

create function public.apply_payment_received_date()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date date := nullif(current_setting('app.payment_received_date', true), '')::date;
begin
  new.entered_at := clock_timestamp();
  new.received_date_override := v_date;
  if v_date is not null then
    if not public.is_active_user() or public.current_app_role() is distinct from 'admin' then
      raise exception 'เฉพาะแอดมินเท่านั้นที่บันทึกวันที่รับเงินย้อนหลังได้';
    end if;
    if not isfinite(v_date) or v_date >= (new.entered_at at time zone 'Asia/Bangkok')::date then
      raise exception 'วันที่รับเงินย้อนหลังต้องเป็นวันที่ก่อนวันนี้';
    end if;
    -- A date was supplied, not an exact transfer time. Store the start of that
    -- Bangkok day; entered_at retains the precise server entry timestamp.
    new.recorded_at := v_date::timestamp at time zone 'Asia/Bangkok';
  end if;
  return new;
end;
$$;

-- Run before receipt numbering and before immutable receipt snapshots, so
-- receipts, history, and daily accounting all use the same received date.
create trigger payments_00_received_date
before insert on public.payments
for each row execute function public.apply_payment_received_date();

create function public.record_backdated_collection_payment(
  p_payment_kind text,
  p_received_date date,
  p_payment_args jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_stored_date date;
  v_previous_date text := current_setting('app.payment_received_date', true);
begin
  if not public.is_active_user() or public.current_app_role() is distinct from 'admin' then
    raise exception 'เฉพาะแอดมินเท่านั้นที่บันทึกวันที่รับเงินย้อนหลังได้';
  end if;
  if p_received_date is null or not isfinite(p_received_date)
    or p_received_date >= (clock_timestamp() at time zone 'Asia/Bangkok')::date then
    raise exception 'วันที่รับเงินย้อนหลังต้องเป็นวันที่ก่อนวันนี้';
  end if;
  if jsonb_typeof(p_payment_args) is distinct from 'object'
    or nullif(p_payment_args ->> 'p_idempotency_key', '') is null then
    raise exception 'Payment arguments and idempotency key are required';
  end if;

  perform set_config('app.payment_received_date', p_received_date::text, true);
  -- Reuse the existing writers: evidence, permissions, allocations, billing
  -- scope, event context, concurrency, and idempotency checks remain in force.
  case p_payment_kind
    when 'record_regular_collection_payment' then
      v_result := public.record_regular_collection_payment(
        (p_payment_args ->> 'p_shop_id')::uuid,
        p_payment_args -> 'p_allocations',
        (p_payment_args ->> 'p_payment_method')::public.payment_method,
        (p_payment_args ->> 'p_received_amount')::numeric,
        p_payment_args ->> 'p_reference_number',
        p_payment_args ->> 'p_evidence_path',
        (p_payment_args ->> 'p_collection_run_id')::uuid,
        (p_payment_args ->> 'p_expected_outstanding_amount')::numeric,
        (p_payment_args ->> 'p_approval_id')::uuid,
        (p_payment_args ->> 'p_idempotency_key')::uuid
      );
    when 'record_billing_statement_payment' then
      v_result := public.record_billing_statement_payment(
        (p_payment_args ->> 'p_billing_statement_id')::uuid,
        p_payment_args -> 'p_allocations',
        (p_payment_args ->> 'p_payment_method')::public.payment_method,
        (p_payment_args ->> 'p_received_amount')::numeric,
        p_payment_args ->> 'p_reference_number',
        p_payment_args ->> 'p_evidence_path',
        (p_payment_args ->> 'p_collection_run_id')::uuid,
        (p_payment_args ->> 'p_expected_outstanding_amount')::numeric,
        (p_payment_args ->> 'p_idempotency_key')::uuid
      );
    when 'record_event_payment' then
      v_result := public.record_event_payment(
        (p_payment_args ->> 'p_expected_settlement_context_id')::uuid,
        (p_payment_args ->> 'p_expected_participation_id')::uuid,
        (p_payment_args ->> 'p_expected_service_date')::date,
        p_payment_args ->> 'p_expected_policy_fingerprint',
        p_payment_args -> 'p_allocations',
        (p_payment_args ->> 'p_payment_method')::public.payment_method,
        (p_payment_args ->> 'p_received_amount')::numeric,
        p_payment_args ->> 'p_reference_number',
        p_payment_args ->> 'p_evidence_path',
        (p_payment_args ->> 'p_collection_run_id')::uuid,
        (p_payment_args ->> 'p_expected_outstanding_amount')::numeric,
        (p_payment_args ->> 'p_idempotency_key')::uuid
      );
    else
      raise exception 'Unsupported collection payment kind';
  end case;

  select received_date_override into v_stored_date
  from public.payments where id = (v_result ->> 'payment_id')::uuid;
  if not found or v_stored_date is distinct from p_received_date then
    raise exception 'Idempotency key was already used for a different received date';
  end if;
  perform set_config('app.payment_received_date', coalesce(v_previous_date, ''), true);
  return v_result;
end;
$$;

revoke all on function public.apply_payment_received_date() from public, anon, authenticated;
revoke all on function public.record_backdated_collection_payment(text, date, jsonb) from public, anon;
grant execute on function public.record_backdated_collection_payment(text, date, jsonb) to authenticated;

notify pgrst, 'reload schema';
