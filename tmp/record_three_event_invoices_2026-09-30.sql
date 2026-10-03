-- One-off event cash receipts requested for 30 September 2026 (Asia/Bangkok).
-- INV2609-00634 (100) + INV2609-00636 (60): one receipt for their shared context.
-- INV2609-00637 (60): a second receipt for its distinct 27 September context.
-- Exact payment times were not provided. 23:59 is an end-of-day placeholder.
-- Review and run once in the ICE production Supabase SQL Editor.

begin;
set local request.jwt.claim.sub = '5047b139-345c-4173-b3dd-b5fe5a13bd2e';
set local request.jwt.claim.role = 'authenticated';

create temporary table requested_event_receipts (
  payment_id uuid primary key,
  context_id uuid not null unique,
  context_service_date date not null,
  amount numeric(12,2) not null,
  recorded_at timestamptz not null
) on commit drop;

insert into requested_event_receipts values
  (
    md5('2026-09-30|INV2609-00634+INV2609-00636|cash')::uuid,
    '3c989db4-dafc-4f86-b987-139b21cf9637', date '2026-09-30', 160.00,
    timestamp '2026-09-30 23:59:00' at time zone 'Asia/Bangkok'
  ),
  (
    md5('2026-09-30|INV2609-00637|cash')::uuid,
    'e7c5af76-dbb5-42ed-989f-2e0ac13a54db', date '2026-09-27', 60.00,
    timestamp '2026-09-30 23:59:00' at time zone 'Asia/Bangkok'
  );

create temporary table requested_event_charges (
  charge_number text primary key,
  charge_id uuid not null unique,
  context_id uuid not null references requested_event_receipts(context_id),
  service_date date not null,
  amount numeric(12,2) not null
) on commit drop;

insert into requested_event_charges values
  ('INV2609-00634', 'be79277f-116e-4f1d-9b28-8f7c03bb0bdb',
    '3c989db4-dafc-4f86-b987-139b21cf9637', date '2026-09-30', 100.00),
  ('INV2609-00636', '51e9f3f0-4174-4ae6-87f4-a6522974f6a7',
    '3c989db4-dafc-4f86-b987-139b21cf9637', date '2026-09-30', 60.00),
  ('INV2609-00637', '0f4675fb-a398-4e1e-badd-ad365286fab5',
    'e7c5af76-dbb5-42ed-989f-2e0ac13a54db', date '2026-09-27', 60.00);

do $record_requested_event_receipts$
declare
  batch record;
  target record;
  charge_row record;
  context_row public.event_settlement_contexts%rowtype;
  participation_row public.event_participations%rowtype;
  sep30_run_id uuid;
  paid numeric(12,2);
  allocations jsonb;
begin
  if (select count(*) from requested_event_receipts) <> 2
    or (select count(*) from requested_event_charges) <> 3 then
    raise exception 'Expected exactly two receipts for three charges';
  end if;

  select id into strict sep30_run_id
  from public.collection_runs
  where service_date = date '2026-09-30' and status = 'open';

  if exists (select 1 from public.daily_aggregate_stock_closures
    where service_date = date '2026-09-30') then
    raise exception '30 September is already closed; review the daily close before recording payments';
  end if;

  for batch in select * from requested_event_receipts order by context_id loop
    if exists (select 1 from public.payments
      where id = batch.payment_id or idempotency_key = batch.payment_id) then
      raise exception 'Receipt for event context % already exists', batch.context_id;
    end if;

    select * into strict context_row
    from public.event_settlement_contexts
    where id = batch.context_id for update;

    if context_row.shop_id <> 'c4d37821-0d62-41ea-8279-5eb1b9e15c79'::uuid
      or context_row.service_date <> batch.context_service_date
      or context_row.event_participation_id
        <> '7c1c2b50-ec4a-47d6-b777-ae38924a765b'::uuid then
      raise exception 'Event settlement identity changed for %', batch.context_id;
    end if;

    select * into strict participation_row
    from public.event_participations
    where id = context_row.event_participation_id;
    if not ('cash'::public.payment_method = any(participation_row.allowed_payment_methods_snapshot))
      or participation_row.cash_reference_required_snapshot
      or participation_row.cash_evidence_required_snapshot then
      raise exception 'Cash payment requirements changed for %', batch.context_id;
    end if;

    if (select coalesce(sum(amount), 0) from requested_event_charges
      where context_id = batch.context_id) <> batch.amount then
      raise exception 'Requested charge amounts do not match receipt amount for %', batch.context_id;
    end if;

    for target in select * from requested_event_charges
      where context_id = batch.context_id order by charge_id loop
      select charge.*, shop.code as actual_shop_code
      into strict charge_row
      from public.delivery_charges charge
      join public.shops shop on shop.id = charge.shop_id
      where charge.id = target.charge_id for update of charge;

      if charge_row.charge_number <> target.charge_number
        or charge_row.shop_id <> context_row.shop_id
        or charge_row.event_settlement_context_id <> target.context_id
        or charge_row.service_date <> target.service_date
        or charge_row.payment_term <> 'end_of_day'
        or charge_row.original_amount <> target.amount
        or charge_row.status <> 'active'
        or not public.is_charge_collectible_in_run(target.charge_id, sep30_run_id) then
        raise exception 'Target event invoice changed: %', target.charge_number;
      end if;

      select coalesce(sum(allocation.amount), 0)::numeric(12,2)
      into paid
      from public.payment_allocations allocation
      join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = target.charge_id
        and payment.status = 'active';

      if paid <> 0
        or public.effective_delivery_charge_amount(target.charge_id) - paid <> target.amount then
        raise exception 'Outstanding balance changed for %', target.charge_number;
      end if;
    end loop;

    select jsonb_agg(jsonb_build_object(
      'charge_id', charge_id, 'amount', amount
    ) order by charge_id) into allocations
    from requested_event_charges where context_id = batch.context_id;

    insert into public.payments (
      id, shop_id, collection_run_id, payment_method,
      received_amount, allocated_amount, change_amount,
      reference_number, evidence_path, idempotency_key,
      request_fingerprint, request_fingerprint_version,
      status, recorded_by, recorded_at,
      operation_kind, event_settlement_context_id
    ) values (
      batch.payment_id, context_row.shop_id, sep30_run_id, 'cash',
      batch.amount, batch.amount, 0,
      null, null, batch.payment_id,
      public.financial_payment_request_fingerprint_v2('event', jsonb_build_object(
        'settlement_context_id', batch.context_id,
        'participation_id', context_row.event_participation_id,
        'service_date', context_row.service_date,
        'policy_fingerprint', context_row.settlement_policy_fingerprint,
        'allocations', allocations,
        'expected_outstanding_amount', null,
        'payment_method', 'cash',
        'received_amount', batch.amount,
        'reference_number', null,
        'evidence_path', null,
        'collection_run_id', sep30_run_id
      )),
      2, 'active', '5047b139-345c-4173-b3dd-b5fe5a13bd2e', batch.recorded_at,
      'event', batch.context_id
    );

    insert into public.payment_allocations (payment_id, charge_id, amount)
    select batch.payment_id, charge_id, amount
    from requested_event_charges where context_id = batch.context_id;

    insert into public.audit_logs (
      actor_id, entity_type, entity_id, action, after_value, reason
    ) values (
      '5047b139-345c-4173-b3dd-b5fe5a13bd2e',
      'payments', batch.payment_id, 'historical_event_cash_receipt_recorded',
      jsonb_build_object(
        'context_id', batch.context_id,
        'shop_id', context_row.shop_id,
        'allocations', allocations,
        'amount', batch.amount,
        'payment_method', 'cash',
        'payment_date', '2026-09-30',
        'recorded_at', batch.recorded_at,
        'time_is_placeholder', true
      ),
      'User requested event invoices 00634, 00636, 00637 be paid on 30 September 2026'
    );
  end loop;
end;
$record_requested_event_receipts$;

set constraints all immediate;

do $verify_requested_event_receipts$
begin
  if (select count(*) from requested_event_receipts batch
    join public.payments payment on payment.id = batch.payment_id
    join public.payment_receipt_snapshots snapshot on snapshot.payment_id = payment.id
    where payment.status = 'active'
      and payment.operation_kind = 'event'
      and payment.event_settlement_context_id = batch.context_id
      and payment.payment_method = 'cash'
      and payment.received_amount = batch.amount
      and payment.allocated_amount = batch.amount
      and payment.change_amount = 0
      and payment.recorded_at = batch.recorded_at
      and (snapshot.receipt_data ->> 'recorded_at')::timestamptz = batch.recorded_at
      and payment.receipt_number like 'REC2609-%') <> 2 then
    raise exception 'Receipt verification failed';
  end if;

  if (select count(*) from requested_event_charges target
    join requested_event_receipts batch on batch.context_id = target.context_id
    join public.payment_allocations allocation
      on allocation.payment_id = batch.payment_id
      and allocation.charge_id = target.charge_id
      and allocation.amount = target.amount) <> 3 then
    raise exception 'Allocation verification failed';
  end if;
end;
$verify_requested_event_receipts$;

commit;

select payment.receipt_number, payment.received_amount,
  payment.recorded_at at time zone 'Asia/Bangkok' as recorded_bangkok,
  string_agg(charge.charge_number, ', ' order by charge.charge_number) as invoices
from public.payments payment
join public.payment_allocations allocation on allocation.payment_id = payment.id
join public.delivery_charges charge on charge.id = allocation.charge_id
where payment.id in (
  md5('2026-09-30|INV2609-00634+INV2609-00636|cash')::uuid,
  md5('2026-09-30|INV2609-00637|cash')::uuid
)
group by payment.id, payment.receipt_number, payment.received_amount, payment.recorded_at
order by payment.receipt_number;
