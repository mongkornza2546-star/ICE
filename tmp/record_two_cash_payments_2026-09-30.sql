-- One-off receipt entry requested for 30 September 2026 (Asia/Bangkok).
-- AA15: unnumbered immediate sale, 75.00 THB.
-- CC23: INV2609-00632, 180.00 THB.
-- The exact payment time was not supplied; 23:59 is an end-of-day placeholder.
-- Run once in the ICE production Supabase SQL Editor after reviewing the targets.

begin;

set local request.jwt.claim.sub = '5047b139-345c-4173-b3dd-b5fe5a13bd2e';
set local request.jwt.claim.role = 'authenticated';

create temporary table requested_cash_receipts (
  payment_id uuid primary key,
  charge_id uuid not null unique,
  shop_code text not null unique,
  charge_number text,
  service_date date not null,
  payment_term public.payment_term not null,
  amount numeric(12,2) not null,
  recorded_at timestamptz not null
) on commit drop;

insert into requested_cash_receipts values
  (
    md5('2026-09-30|AA15|68b8c6a2-8961-42a5-a361-fa053ca4d679|cash')::uuid,
    '68b8c6a2-8961-42a5-a361-fa053ca4d679',
    'AA15', null, date '2026-09-30', 'immediate', 75.00,
    timestamp '2026-09-30 23:59:00' at time zone 'Asia/Bangkok'
  ),
  (
    md5('2026-09-30|CC23|INV2609-00632|cash')::uuid,
    '6a596f98-861f-47fb-8d7f-fdd9cb28ec98',
    'CC23', 'INV2609-00632', date '2026-09-29', 'end_of_day', 180.00,
    timestamp '2026-09-30 23:59:00' at time zone 'Asia/Bangkok'
  );

do $record_requested_cash_receipts$
declare
  target record;
  charge_row record;
  sep30_run_id uuid;
  already_paid numeric(12,2);
  outstanding numeric(12,2);
  allocations jsonb;
begin
  if (select count(*) from requested_cash_receipts) <> 2 then
    raise exception 'Expected exactly two requested receipts';
  end if;

  select id into strict sep30_run_id
  from public.collection_runs
  where service_date = date '2026-09-30' and status = 'open';

  if exists (
    select 1 from public.daily_aggregate_stock_closures
    where service_date = date '2026-09-30'
  ) then
    raise exception '30 September is already closed; review the daily close before backdating payments';
  end if;

  for target in select * from requested_cash_receipts order by shop_code loop
    select charge.*, shop.code as actual_shop_code
    into strict charge_row
    from public.delivery_charges charge
    join public.shops shop on shop.id = charge.shop_id
    where charge.id = target.charge_id
    for update of charge;

    if charge_row.actual_shop_code <> target.shop_code
      or charge_row.charge_number is distinct from target.charge_number
      or charge_row.service_date <> target.service_date
      or charge_row.payment_term <> target.payment_term
      or charge_row.original_amount <> target.amount
      or charge_row.status <> 'active'
      or charge_row.event_settlement_context_id is not null
      or not public.is_charge_collectible_in_run(target.charge_id, sep30_run_id)
    then
      raise exception 'Target charge changed or is not collectible: %', target.shop_code;
    end if;

    select coalesce(sum(allocation.amount), 0)::numeric(12,2)
    into already_paid
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = target.charge_id and payment.status = 'active';

    outstanding := public.effective_delivery_charge_amount(target.charge_id) - already_paid;
    if already_paid <> 0 or outstanding <> target.amount then
      raise exception 'Outstanding balance changed for %: paid %, outstanding %',
        target.shop_code, already_paid, outstanding;
    end if;

    if exists (
      select 1 from public.payments
      where id = target.payment_id or idempotency_key = target.payment_id
    ) then
      raise exception 'Receipt for % was already entered', target.shop_code;
    end if;

    allocations := jsonb_build_array(jsonb_build_object(
      'charge_id', target.charge_id, 'amount', target.amount
    ));

    insert into public.payments (
      id, shop_id, collection_run_id, payment_method,
      received_amount, allocated_amount, change_amount,
      reference_number, evidence_path, idempotency_key,
      request_fingerprint, request_fingerprint_version,
      status, recorded_by, recorded_at
    ) values (
      target.payment_id, charge_row.shop_id, sep30_run_id, 'cash',
      target.amount, target.amount, 0,
      null, null, target.payment_id,
      public.financial_payment_request_fingerprint_v2(
        'regular', jsonb_build_object(
          'shop_id', charge_row.shop_id,
          'settlement_context_id', null,
          'allocations', allocations,
          'expected_outstanding_amount', target.amount,
          'payment_method', 'cash',
          'received_amount', target.amount,
          'reference_number', null,
          'evidence_path', null,
          'collection_run_id', sep30_run_id,
          'approval_id', null
        )
      ),
      2, 'active', '5047b139-345c-4173-b3dd-b5fe5a13bd2e', target.recorded_at
    );

    insert into public.payment_allocations (payment_id, charge_id, amount)
    values (target.payment_id, target.charge_id, target.amount);

    insert into public.audit_logs (
      actor_id, entity_type, entity_id, action, after_value, reason
    ) values (
      '5047b139-345c-4173-b3dd-b5fe5a13bd2e',
      'payments', target.payment_id, 'historical_cash_receipt_recorded',
      jsonb_build_object(
        'shop_code', target.shop_code,
        'charge_id', target.charge_id,
        'charge_number', target.charge_number,
        'amount', target.amount,
        'payment_method', 'cash',
        'payment_date', '2026-09-30',
        'recorded_at', target.recorded_at,
        'time_is_placeholder', true
      ),
      'User requested the two cash receipts be recorded for 30 September 2026'
    );
  end loop;
end;
$record_requested_cash_receipts$;

-- Force deferred allocation and receipt-snapshot checks before commit.
set constraints all immediate;

do $verify_requested_cash_receipts$
begin
  if (
    select count(*) from requested_cash_receipts target
    join public.payments payment on payment.id = target.payment_id
    join public.payment_receipt_snapshots snapshot on snapshot.payment_id = payment.id
    join public.payment_allocations allocation
      on allocation.payment_id = payment.id and allocation.charge_id = target.charge_id
    where payment.status = 'active'
      and payment.payment_method = 'cash'
      and payment.received_amount = target.amount
      and payment.allocated_amount = target.amount
      and payment.change_amount = 0
      and payment.recorded_at = target.recorded_at
      and payment.collection_run_id = (
        select id from public.collection_runs where service_date = date '2026-09-30'
      )
      and allocation.amount = target.amount
      and (snapshot.receipt_data ->> 'recorded_at')::timestamptz = target.recorded_at
      and payment.receipt_number like 'REC2609-%'
  ) <> 2 then
    raise exception 'Post-insert receipt verification failed';
  end if;
end;
$verify_requested_cash_receipts$;

commit;

select shop.code as shop_code, payment.receipt_number, payment.received_amount,
  payment.recorded_at at time zone 'Asia/Bangkok' as recorded_bangkok,
  charge.charge_number, charge.service_date
from public.payments payment
join public.shops shop on shop.id = payment.shop_id
join public.payment_allocations allocation on allocation.payment_id = payment.id
join public.delivery_charges charge on charge.id = allocation.charge_id
where payment.id in (
  md5('2026-09-30|AA15|68b8c6a2-8961-42a5-a361-fa053ca4d679|cash')::uuid,
  md5('2026-09-30|CC23|INV2609-00632|cash')::uuid
)
order by shop.code;
