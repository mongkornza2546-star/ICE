-- One-off historical cash receipt for B-ISO-04 / INV2610-00036.
-- The customer paid 120.00 THB on 30 September 2026, before the invoice date.
-- Recording the real receipt on that date makes the 1 October cash effect 0.00 THB.
--
-- The exact payment time was not supplied. 23:59 Asia/Bangkok is used as an
-- end-of-day placeholder and is called out in the audit log.
--
-- Run once in the ICE production Supabase SQL Editor. The transaction aborts
-- if the target changed, was already paid, or 30 September was already closed.

begin;

-- Existing admin actor used by the production data-repair scripts.
set local request.jwt.claim.sub = '5047b139-345c-4173-b3dd-b5fe5a13bd2e';
set local request.jwt.claim.role = 'authenticated';

do $record_historical_receipt$
declare
  v_actor_id constant uuid := '5047b139-345c-4173-b3dd-b5fe5a13bd2e';
  v_payment_id constant uuid :=
    md5('historical-cash|2026-09-30|B-ISO-04|INV2610-00036|120.00')::uuid;
  v_paid_at constant timestamptz :=
    timestamp '2026-09-30 23:59:00' at time zone 'Asia/Bangkok';
  v_charge public.delivery_charges%rowtype;
  v_shop_id uuid;
  v_shop_code text;
  v_already_paid numeric(12,2);
  v_effective_amount numeric(12,2);
  v_allocations jsonb;
begin
  if not exists (
    select 1
    from public.users app_user
    where app_user.id = v_actor_id
      and app_user.is_active
      and app_user.role in ('admin', 'round_lead')
  ) then
    raise exception 'Configured repair actor is not an active admin or round lead';
  end if;

  select charge, shop.id, shop.code
  into strict v_charge, v_shop_id, v_shop_code
  from public.delivery_charges charge
  join public.shops shop on shop.id = charge.shop_id
  where charge.charge_number = 'INV2610-00036'
    and upper(shop.code) = 'B-ISO-04'
  for update of charge;

  if v_charge.shop_id is distinct from v_shop_id
    or v_shop_code <> 'B-ISO-04'
    or v_charge.service_date <> date '2026-10-01'
    or v_charge.original_amount <> 120.00
    or v_charge.status <> 'active'
    or v_charge.payment_term = 'immediate'
    or v_charge.event_settlement_context_id is not null
  then
    raise exception 'Target invoice changed; review B-ISO-04 / INV2610-00036 before recording payment';
  end if;

  if exists (
    select 1
    from public.daily_aggregate_stock_closures closure
    where closure.service_date = date '2026-09-30'
  ) then
    raise exception '30 September 2026 is already closed; review the daily close before backdating this receipt';
  end if;

  select coalesce(sum(allocation.amount), 0)::numeric(12,2)
  into v_already_paid
  from public.payment_allocations allocation
  join public.payments payment on payment.id = allocation.payment_id
  where allocation.charge_id = v_charge.id
    and payment.status = 'active';

  v_effective_amount := public.effective_delivery_charge_amount(v_charge.id);

  if v_already_paid <> 0 then
    raise exception 'Invoice INV2610-00036 already has active payment allocations totaling %',
      v_already_paid;
  elsif v_effective_amount <> 120.00 then
    raise exception 'Effective invoice amount changed: expected 120.00, found %',
      v_effective_amount;
  end if;

  if exists (
    select 1
    from public.payments payment
    where payment.id = v_payment_id
       or payment.idempotency_key = v_payment_id
  ) then
    raise exception 'This historical receipt was already entered';
  end if;

  v_allocations := jsonb_build_array(jsonb_build_object(
    'charge_id', v_charge.id,
    'amount', 120.00::numeric(12,2)
  ));

  insert into public.payments (
    id,
    shop_id,
    collection_run_id,
    payment_method,
    received_amount,
    allocated_amount,
    change_amount,
    reference_number,
    evidence_path,
    idempotency_key,
    request_fingerprint,
    request_fingerprint_version,
    status,
    recorded_by,
    recorded_at
  ) values (
    v_payment_id,
    v_shop_id,
    null,
    'cash',
    120.00,
    120.00,
    0.00,
    'รับจริง 30 ก.ย. 2569 · บันทึกย้อนหลัง',
    null,
    v_payment_id,
    public.financial_payment_request_fingerprint_v2(
      'regular',
      jsonb_build_object(
        'shop_id', v_shop_id,
        'settlement_context_id', null,
        'allocations', v_allocations,
        'expected_outstanding_amount', 120.00::numeric(12,2),
        'payment_method', 'cash',
        'received_amount', 120.00::numeric(12,2),
        'reference_number', 'รับจริง 30 ก.ย. 2569 · บันทึกย้อนหลัง',
        'evidence_path', null,
        'collection_run_id', null,
        'approval_id', null
      )
    ),
    2,
    'active',
    v_actor_id,
    v_paid_at
  );

  insert into public.payment_allocations (payment_id, charge_id, amount)
  values (v_payment_id, v_charge.id, 120.00);

  insert into public.audit_logs (
    actor_id,
    entity_type,
    entity_id,
    action,
    after_value,
    reason
  ) values (
    v_actor_id,
    'payments',
    v_payment_id,
    'historical_cash_receipt_recorded',
    jsonb_build_object(
      'shop_code', v_shop_code,
      'charge_id', v_charge.id,
      'charge_number', v_charge.charge_number,
      'invoice_service_date', v_charge.service_date,
      'received_amount', 120.00,
      'payment_method', 'cash',
      'payment_date', '2026-09-30',
      'recorded_at', v_paid_at,
      'time_is_placeholder', true,
      'cash_effect_2026_10_01', 0.00
    ),
    'Customer paid on 30 September 2026; entered later against INV2610-00036'
  );
end;
$record_historical_receipt$;

-- Fire deferred integrity and immutable receipt-snapshot triggers now so any
-- problem rolls back before COMMIT.
set constraints all immediate;

do $verify_historical_receipt$
declare
  v_payment_id constant uuid :=
    md5('historical-cash|2026-09-30|B-ISO-04|INV2610-00036|120.00')::uuid;
begin
  if (
    select count(*)
    from public.payments payment
    join public.payment_receipt_snapshots snapshot
      on snapshot.payment_id = payment.id
    join public.payment_allocations allocation
      on allocation.payment_id = payment.id
    join public.delivery_charges charge
      on charge.id = allocation.charge_id
    join public.shops shop on shop.id = payment.shop_id
    where payment.id = v_payment_id
      and shop.code = 'B-ISO-04'
      and charge.charge_number = 'INV2610-00036'
      and payment.status = 'active'
      and payment.payment_method = 'cash'
      and payment.received_amount = 120.00
      and payment.allocated_amount = 120.00
      and payment.change_amount = 0.00
      and allocation.amount = 120.00
      and (payment.recorded_at at time zone 'Asia/Bangkok')::date = date '2026-09-30'
      and (snapshot.receipt_data ->> 'recorded_at')::timestamptz = payment.recorded_at
      and payment.receipt_number like 'REC2609-%'
  ) <> 1 then
    raise exception 'Post-insert verification failed';
  end if;
end;
$verify_historical_receipt$;

commit;

-- Expected result: outstanding_amount = 0.00 and cash_effect_2026_10_01 = 0.00.
select
  shop.code as shop_code,
  charge.charge_number,
  payment.receipt_number,
  payment.received_amount,
  payment.recorded_at at time zone 'Asia/Bangkok' as recorded_bangkok,
  greatest(
    public.effective_delivery_charge_amount(charge.id)
      - coalesce((
          select sum(active_allocation.amount)
          from public.payment_allocations active_allocation
          join public.payments active_payment
            on active_payment.id = active_allocation.payment_id
          where active_allocation.charge_id = charge.id
            and active_payment.status = 'active'
        ), 0),
    0
  )::numeric(12,2) as outstanding_amount,
  case
    when (payment.recorded_at at time zone 'Asia/Bangkok')::date = date '2026-10-01'
      then payment.received_amount
    else 0.00
  end::numeric(12,2) as cash_effect_2026_10_01
from public.payments payment
join public.payment_allocations allocation on allocation.payment_id = payment.id
join public.delivery_charges charge on charge.id = allocation.charge_id
join public.shops shop on shop.id = payment.shop_id
where payment.id =
  md5('historical-cash|2026-09-30|B-ISO-04|INV2610-00036|120.00')::uuid;
