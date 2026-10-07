-- Targeted repair: user confirmed actual receipts for BB1 on 2026-10-06 = 400.
-- Preserve REC2610-00300 (425) as voided evidence; reissue its valid 350 portion.
-- REC2610-00307 (50), delivery records, prices, and stock remain unchanged.
-- Default is a dry run. Change only the final ROLLBACK to COMMIT after review.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $repair$
declare
  v_actor uuid := '5047b139-345c-4173-b3dd-b5fe5a13bd2e';
  v_key uuid := md5('repair:BB1:2026-10-06:REC2610-00300:actual-total-400')::uuid;
  v_reason text := 'แก้ยอดรับเงินเกินจากบัคยกเลิกใบส่ง INV2610-00401: ผู้ใช้ยืนยันรับเงินจริงรวมวันที่ 6 ต.ค. 2569 จำนวน 400 บาท ยกเลิกใบเสร็จผิด 425 และออกทดแทน 350 โดยคงใบเสร็จ 50 บาท ไม่มีการคืนเงินจริง';
  v_old public.payments%rowtype;
  v_other public.payments%rowtype;
  v_refund public.refund_obligations%rowtype;
  v_new public.payments%rowtype;
  v_snapshot jsonb;
  v_before jsonb;
  v_allocations jsonb;
  v_shop uuid;
  v_sum numeric;
begin
  if not exists (select 1 from public.users where id = v_actor and role = 'admin' and is_active) then
    raise exception 'Expected active repair administrator is missing';
  end if;
  select id into strict v_shop from public.shops where code = 'BB1';
  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_shop::text, 0));
  select * into strict v_old from public.payments where receipt_number = 'REC2610-00300' and shop_id = v_shop for update;
  select * into strict v_other from public.payments where receipt_number = 'REC2610-00307' and shop_id = v_shop for update;
  select * into strict v_refund from public.refund_obligations where payment_id = v_old.id for update;
  select * into v_new from public.payments where idempotency_key = v_key;

  if v_new.id is not null then
    if v_old.status <> 'voided' or v_refund.status <> 'voided'
      or v_new.status <> 'active' or v_new.allocated_amount <> 350
      or v_new.shop_id <> v_shop or v_other.status <> 'active' or v_other.allocated_amount <> 50 then
      raise exception 'Previous repair no longer matches its expected result';
    end if;
    perform public.assert_payment_allocation_integrity(v_new.id);
    raise notice 'Repair already applied: %', v_new.receipt_number;
    return;
  end if;

  if v_old.status <> 'active' or v_old.received_amount <> 425 or v_old.allocated_amount <> 425 or v_old.change_amount <> 0
    or v_other.status <> 'active' or v_other.received_amount <> 50 or v_other.allocated_amount <> 50 or v_other.change_amount <> 0
    or v_old.payment_method <> 'cash' or v_other.payment_method <> 'cash'
    or (v_old.recorded_at at time zone 'Asia/Bangkok')::date <> date '2026-10-06'
    or (v_other.recorded_at at time zone 'Asia/Bangkok')::date <> date '2026-10-06'
    or v_old.operation_kind <> 'regular' or v_old.event_settlement_context_id is not null
    or v_old.approval_request_id is not null or v_old.billing_statement_id is not null then
    raise exception 'Receipt preflight changed; stop without modifying data';
  end if;
  if v_refund.id <> '1d422e76-a8c5-47cf-9dc9-0664c45dca1a'::uuid
    or v_refund.status <> 'pending' or v_refund.amount <> 75
    or exists (select 1 from public.refund_settlements where obligation_id = v_refund.id)
    or not exists (select 1 from public.delivery_charges where id = v_refund.source_charge_id
      and charge_number = 'INV2610-00401' and status = 'voided' and original_amount = 75) then
    raise exception 'Refund preflight changed or a real refund exists; stop';
  end if;
  if exists (select 1 from public.daily_close_payment_items where payment_id in (v_old.id, v_other.id)) then
    raise exception 'Receipt is included in a frozen cash reconciliation; review the close before repair';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('charge_id',a.charge_id,'amount',a.amount,'invoice',c.charge_number)
    order by c.charge_number), '[]'::jsonb), sum(a.amount)
  into v_allocations, v_sum
  from public.payment_allocations a join public.delivery_charges c on c.id = a.charge_id
  where a.payment_id = v_old.id;
  if v_sum is distinct from 350 or jsonb_array_length(v_allocations) <> 3
    or exists (select 1 from public.payment_allocations a join public.delivery_charges c on c.id = a.charge_id
      where a.payment_id = v_old.id and (c.status <> 'active' or
        (c.charge_number,a.amount) not in (('INV2610-00335',200),('INV2610-00386',100),('INV2610-00397',50))))
    or not exists (select 1 from public.payment_allocations a join public.delivery_charges c on c.id=a.charge_id
      where a.payment_id=v_other.id and c.charge_number='INV2610-00409' and c.status='active' and a.amount=50) then
    raise exception 'Allocation preflight changed; stop';
  end if;
  select sum(allocated_amount) into v_sum from public.payments
  where shop_id = v_shop and status = 'active' and (recorded_at at time zone 'Asia/Bangkok')::date = date '2026-10-06';
  if v_sum is distinct from 475 then raise exception 'Shop daily receipt total changed'; end if;
  select receipt_data into strict v_snapshot from public.payment_receipt_snapshots where payment_id = v_old.id;
  v_before := jsonb_build_object('payment', to_jsonb(v_old), 'refund', to_jsonb(v_refund), 'allocations', v_allocations);

  -- Keep the original 425 receipt and snapshot intact, but inactive. Restoring
  -- its original 75 allocation is historical only: the payment is now voided.
  -- This also preserves allocation + non-void refund = declared receipt amount.
  update public.payments set status='voided', voided_by=v_actor, voided_at=now(), void_reason=v_reason where id=v_old.id;
  update public.refund_obligations set status='voided', voided_by=v_actor, voided_at=now(), void_reason=v_reason where id=v_refund.id;
  insert into public.payment_allocations(payment_id,charge_id,amount) values(v_old.id,v_refund.source_charge_id,75);
  insert into public.payment_allocation_changes(source_kind,source_id,payment_id,from_charge_id,to_charge_id,before_amount,after_amount,reason,changed_by)
  values('open_revision',v_refund.source_id,v_old.id,null,v_refund.source_charge_id,0,75,v_reason,v_actor);

  -- Normal role/date/numbering/snapshot triggers remain enabled. Record only
  -- the confirmed business date; entered_at records when this repair occurred.
  perform set_config('request.jwt.claim.sub',v_actor::text,true);
  perform set_config('app.payment_received_date','2026-10-06',true);
  insert into public.payments(shop_id,collection_run_id,payment_method,received_amount,allocated_amount,change_amount,
    reference_number,idempotency_key,request_fingerprint,recorded_by,recorded_at,operation_kind,request_fingerprint_version)
  values(v_shop,v_old.collection_run_id,'cash',350,350,0,'ทดแทน REC2610-00300 / แก้ยอดรับจริง BB1',v_key,
    md5(v_key::text || ':350'),v_actor,'2026-10-06 00:00:00+07','regular',2)
  returning * into v_new;
  insert into public.payment_allocations(payment_id,charge_id,amount)
  select v_new.id, item.charge_id, item.amount from jsonb_to_recordset(v_allocations) item(charge_id uuid,amount numeric);
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,before_value,after_value,reason)
  values(v_actor,'payments',v_old.id,'receipt_reissued_after_cancellation_bug',v_before,
    jsonb_build_object('repair_key',v_key,'replacement_payment',to_jsonb(v_new),'unchanged_receipt',v_other.receipt_number,
      'confirmed_shop_receipts',400,'refund_voided',v_refund.id,'actual_refund',0),v_reason),
    (v_actor,'refund_obligations',v_refund.id,'voided_erroneous_refund',to_jsonb(v_refund),
      jsonb_build_object('status','voided','repair_key',v_key,'replacement_payment_id',v_new.id),v_reason);

  perform public.assert_payment_allocation_integrity(v_old.id);
  perform public.assert_payment_allocation_integrity(v_new.id);
  if (select receipt_data from public.payment_receipt_snapshots where payment_id=v_old.id) is distinct from v_snapshot then
    raise exception 'Original receipt snapshot was changed';
  end if;
  select sum(allocated_amount) into v_sum from public.payments
  where shop_id=v_shop and status='active' and (recorded_at at time zone 'Asia/Bangkok')::date=date '2026-10-06';
  if v_sum is distinct from 400 then raise exception 'Final receipt total is not 400'; end if;
end;
$repair$;
set constraints all immediate;

select p.receipt_number,p.status,p.allocated_amount,p.recorded_at,p.reference_number
from public.payments p join public.shops s on s.id=p.shop_id
where s.code='BB1' and (p.recorded_at at time zone 'Asia/Bangkok')::date=date '2026-10-06'
order by p.recorded_at,p.receipt_number;
rollback;
