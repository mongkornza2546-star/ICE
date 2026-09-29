-- รับชำระบิล INV2609-00477 ของร้าน BB35
-- วิธีชำระ: โอนเงิน 480 บาท
-- วันที่รับเงินจริง: 28 ก.ย. 2569 (กำหนดเวลา 12:00 น. เวลาไทย)
-- ยกเว้นหลักฐานการโอนเฉพาะ payment ของบิลนี้ โดยไม่แก้ payment profile ของร้าน

begin;

-- ผู้บันทึกที่ใช้กับงานนำเข้าข้อมูลของระบบนี้
set local request.jwt.claim.sub = '5047b139-345c-4173-b3dd-b5fe5a13bd2e';
set local request.jwt.claim.role = 'authenticated';

do $payment$
declare
  v_actor_id constant uuid := '5047b139-345c-4173-b3dd-b5fe5a13bd2e';
  v_payment_id constant uuid := md5(
    'manual-payment|BB35|INV2609-00477|2026-09-28|bank_transfer|480.00'
  )::uuid;
  v_recorded_at constant timestamptz := timestamptz '2026-09-28 12:00:00+07';
  v_reference constant text := 'รับโอนวันที่ 28/09/2569 (บันทึกย้อนหลัง)';
  v_charge public.delivery_charges%rowtype;
  v_shop_id uuid;
  v_profile public.shop_payment_profiles%rowtype;
  v_paid numeric(12,2);
  v_outstanding numeric(12,2);
  v_allocations jsonb;
  v_fingerprint text;
begin
  -- รันซ้ำได้โดยไม่สร้างรายการรับเงินซ้ำ
  if exists (
    select 1
    from public.payments payment
    where payment.id = v_payment_id
  ) then
    if not exists (
      select 1
      from public.payments payment
      join public.shops shop on shop.id = payment.shop_id
      join public.payment_allocations allocation on allocation.payment_id = payment.id
      join public.delivery_charges charge on charge.id = allocation.charge_id
      where payment.id = v_payment_id
        and shop.code = 'BB35'
        and charge.charge_number = 'INV2609-00477'
        and payment.status = 'active'
        and payment.payment_method = 'bank_transfer'
        and payment.received_amount = 480.00
        and payment.allocated_amount = 480.00
        and allocation.amount = 480.00
        and (payment.recorded_at at time zone 'Asia/Bangkok')::date = date '2026-09-28'
    ) then
      raise exception 'พบ payment id เดิม แต่ข้อมูลไม่ตรงกับรายการนี้ กรุณาหยุดตรวจสอบ';
    end if;
    return;
  end if;

  if not exists (
    select 1
    from public.users app_user
    where app_user.id = v_actor_id
      and app_user.is_active
      and app_user.role in ('admin', 'round_lead')
  ) then
    raise exception 'บัญชีผู้บันทึกไม่พร้อมใช้งานหรือไม่มีสิทธิ์รับชำระ';
  end if;

  select charge.*
  into strict v_charge
  from public.delivery_charges charge
  join public.shops shop on shop.id = charge.shop_id
  where shop.code = 'BB35'
    and charge.charge_number = 'INV2609-00477';

  v_shop_id := v_charge.shop_id;

  if v_charge.status <> 'active' then
    raise exception 'บิล INV2609-00477 ไม่ได้อยู่ในสถานะ active';
  elsif v_charge.event_settlement_context_id is not null then
    raise exception 'บิลนี้เป็นบิลกิจกรรม ต้องใช้ขั้นตอนรับชำระของกิจกรรม';
  end if;

  select profile.*
  into strict v_profile
  from public.shop_payment_profiles profile
  where profile.shop_id = v_shop_id;

  if not ('bank_transfer'::public.payment_method = any(v_profile.allowed_payment_methods)) then
    raise exception 'ร้าน BB35 ไม่ได้เปิดรับวิธีโอนเงิน';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_shop_id::text, 0));

  select coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0)::numeric(12,2)
  into v_paid
  from public.payment_allocations allocation
  join public.payments payment on payment.id = allocation.payment_id
  where allocation.charge_id = v_charge.id;

  v_outstanding := (
    public.effective_delivery_charge_amount(v_charge.id) - v_paid
  )::numeric(12,2);

  if v_outstanding <> 480.00 then
    raise exception
      'ยอดคงเหลือของบิล INV2609-00477 ต้องเป็น 480.00 แต่พบ % กรุณาหยุดตรวจสอบ',
      v_outstanding;
  end if;

  v_allocations := jsonb_build_array(jsonb_build_object(
    'charge_id', v_charge.id,
    'amount', 480.00::numeric(12,2)
  ));

  v_fingerprint := public.financial_payment_request_fingerprint_v2(
    'regular',
    jsonb_build_object(
      'shop_id', v_shop_id,
      'settlement_context_id', null,
      'allocations', v_allocations,
      'expected_outstanding_amount', 480.00::numeric(12,2),
      'payment_method', 'bank_transfer'::public.payment_method,
      'received_amount', 480.00::numeric(12,2),
      'reference_number', v_reference,
      'evidence_path', null,
      'collection_run_id', null,
      'approval_id', null
    )
  );

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
    operation_kind,
    status,
    recorded_by,
    recorded_at
  ) values (
    v_payment_id,
    v_shop_id,
    null,
    'bank_transfer',
    480.00,
    480.00,
    0.00,
    v_reference,
    null,
    v_payment_id,
    v_fingerprint,
    2,
    'regular',
    'active',
    v_actor_id,
    v_recorded_at
  );

  insert into public.payment_allocations (payment_id, charge_id, amount)
  values (v_payment_id, v_charge.id, 480.00);

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
    'manual_backdated_payment_created',
    jsonb_build_object(
      'shop_code', 'BB35',
      'charge_number', 'INV2609-00477',
      'payment_method', 'bank_transfer',
      'received_amount', 480.00,
      'recorded_at', v_recorded_at,
      'evidence_path', null,
      'evidence_exception', true,
      'evidence_exception_scope', 'INV2609-00477 only'
    ),
    'รับโอนวันที่ 28/09/2569 และยกเว้นหลักฐานการโอนเฉพาะบิล INV2609-00477 ตามคำสั่งผู้ใช้'
  );
end;
$payment$;

-- บังคับให้ตรวจ allocation และสร้าง immutable receipt snapshot ก่อน commit
set constraints all immediate;

commit;

-- ผลลัพธ์หลังรัน: ต้องได้ 1 แถว, status = active, ยอดคงเหลือ = 0.00
select
  payment.receipt_number,
  shop.code as shop_code,
  charge.charge_number,
  payment.payment_method,
  payment.received_amount,
  payment.allocated_amount,
  payment.status,
  payment.recorded_at at time zone 'Asia/Bangkok' as recorded_at_bangkok,
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
  )::numeric(12,2) as outstanding_after_payment
from public.payments payment
join public.shops shop on shop.id = payment.shop_id
join public.payment_allocations allocation on allocation.payment_id = payment.id
join public.delivery_charges charge on charge.id = allocation.charge_id
where payment.id = md5(
  'manual-payment|BB35|INV2609-00477|2026-09-28|bank_transfer|480.00'
)::uuid;
