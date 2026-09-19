import argparse
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument("--commit", action="store_true")
args = parser.parse_args()

finish = "commit;" if args.commit else "rollback;"
postcheck = """
with imported as (
  select distinct payment.id,payment.payment_method,shop.code,profile.default_payment_method
  from public.payments payment
  join public.shops shop on shop.id=payment.shop_id
  join public.shop_payment_profiles profile on profile.shop_id=shop.id
  join public.audit_logs audit on audit.entity_type='payments' and audit.entity_id=payment.id
  where payment.status='active'
    and audit.action in ('imported','import_price_reconciliation','import_payment_correction')
    and audit.after_value->>'source'='สรุปยอดขาย ศูนย์ราชการ ปี 69-2.xls'
)
select jsonb_build_object(
  'sw27_default_method',(select profile.default_payment_method from public.shop_payment_profiles profile join public.shops shop on shop.id=profile.shop_id where shop.code='SW-27'),
  'method_mismatches',(select count(*) from imported where payment_method<>default_payment_method),
  'sw27_outstanding_through_18',(
    select sum(charge.original_amount-coalesce((select sum(allocation.amount) from public.payment_allocations allocation join public.payments p on p.id=allocation.payment_id and p.status='active' where allocation.charge_id=charge.id),0))
    from public.delivery_charges charge join public.shops shop on shop.id=charge.shop_id
    where shop.code='SW-27' and charge.service_date between '2026-09-01' and '2026-09-18' and charge.status='active'
  ),
  'bb96_sep1_outstanding',(
    select sum(charge.original_amount-coalesce((select sum(allocation.amount) from public.payment_allocations allocation join public.payments p on p.id=allocation.payment_id and p.status='active' where allocation.charge_id=charge.id),0))
    from public.delivery_charges charge join public.shops shop on shop.id=charge.shop_id
    where shop.code='BB96' and charge.service_date='2026-09-01' and charge.status='active'
  ),
  'new_payment_count',(select count(*) from public.payments where id in(select id from import_missing_receipts)),
  'new_payment_total',(select sum(allocated_amount) from public.payments where id in(select id from import_missing_receipts))
) result;
""" if args.commit else ""

sql = f"""
create temporary table import_missing_receipts(
  id uuid primary key,shop_code text,receipt_date date,payment_method public.payment_method,note text
) on commit preserve rows;
insert into import_missing_receipts values
  (md5('2026-09-payment-correction|SW-27|2026-09-11')::uuid,'SW-27','2026-09-11','bank_transfer','Excel ระบุโอน และร้านเครดิตเก็บทุกวันศุกร์'),
  (md5('2026-09-payment-correction|SW-27|2026-09-18')::uuid,'SW-27','2026-09-18','bank_transfer','รับโอนรอบเครดิตวันศุกร์ตามค่าร้าน'),
  (md5('2026-09-payment-correction|BB96|2026-09-07')::uuid,'BB96','2026-09-07','cash','Excel ระบุ จ่าย7/9');

begin;
set local request.jwt.claim.sub='5047b139-345c-4173-b3dd-b5fe5a13bd2e';
set local request.jwt.claim.role='authenticated';

do $$
begin
  if exists(select 1 from public.payments where id in(select id from import_missing_receipts)) then
    raise exception 'One or more correction payments already exist';
  end if;
end $$;

with target as (
  select profile.id,profile.default_payment_method,profile.updated_at
  from public.shop_payment_profiles profile
  join public.shops shop on shop.id=profile.shop_id
  where shop.code='SW-27'
)
update public.shop_payment_profiles profile
set default_payment_method='bank_transfer'
from target
where profile.id=target.id and profile.default_payment_method<>'bank_transfer';

with imported_sw27 as (
  select distinct payment.id,payment.payment_method,payment.recorded_at,payment.reference_number
  from public.payments payment
  join public.shops shop on shop.id=payment.shop_id and shop.code='SW-27'
  join public.audit_logs audit on audit.entity_type='payments' and audit.entity_id=payment.id
  where payment.status='active'
    and audit.action in ('imported','import_price_reconciliation')
    and audit.after_value->>'source'='สรุปยอดขาย ศูนย์ราชการ ปี 69-2.xls'
)
insert into public.audit_logs(actor_id,entity_type,entity_id,action,before_value,after_value,reason)
select '5047b139-345c-4173-b3dd-b5fe5a13bd2e'::uuid,'payments',id,'import_payment_method_correction',
  jsonb_build_object('payment_method',payment_method,'recorded_at',recorded_at,'reference_number',reference_number),
  jsonb_build_object('source','สรุปยอดขาย ศูนย์ราชการ ปี 69-2.xls','payment_method','bank_transfer',
    'recorded_at',case when (recorded_at at time zone 'Asia/Bangkok')::date='2026-09-10' then recorded_at+interval '1 day' else recorded_at end,
    'reason','SW-27 ออแกไนซ์รับโอนและเก็บทุกวันศุกร์'),
  'แก้วิธีชำระและวันรับชำระตามค่าร้านและ Excel'
from imported_sw27;

update public.payments payment
set payment_method='bank_transfer',
    recorded_at=case when (payment.recorded_at at time zone 'Asia/Bangkok')::date='2026-09-10' then payment.recorded_at+interval '1 day' else payment.recorded_at end,
    reference_number='โอนตาม Excel / รอบเครดิตวันศุกร์'
where payment.id in (
  select distinct p.id from public.payments p
  join public.shops shop on shop.id=p.shop_id and shop.code='SW-27'
  join public.audit_logs audit on audit.entity_type='payments' and audit.entity_id=p.id
  where p.status='active' and audit.action in ('imported','import_price_reconciliation')
    and audit.after_value->>'source'='สรุปยอดขาย ศูนย์ราชการ ปี 69-2.xls'
);

do $$
declare marker record; charge_row record; v_shop_id uuid; v_amount numeric; v_remaining numeric; v_piece numeric; v_method public.payment_method;
begin
  for marker in select * from import_missing_receipts order by receipt_date,shop_code loop
    select shop.id,case when marker.shop_code='SW-27' then 'bank_transfer'::public.payment_method else profile.default_payment_method end
    into strict v_shop_id,v_method
    from public.shops shop join public.shop_payment_profiles profile on profile.shop_id=shop.id
    where shop.code=marker.shop_code;

    select coalesce(sum(charge.original_amount-coalesce(allocated.amount,0)),0) into v_amount
    from public.delivery_charges charge
    left join lateral (
      select sum(allocation.amount) amount from public.payment_allocations allocation
      join public.payments payment on payment.id=allocation.payment_id and payment.status='active'
      where allocation.charge_id=charge.id
    ) allocated on true
    where charge.shop_id=v_shop_id and charge.status='active'
      and charge.service_date between '2026-09-01' and marker.receipt_date;
    if v_amount<=0 then continue; end if;

    insert into public.payments(
      id,shop_id,payment_method,received_amount,allocated_amount,change_amount,reference_number,
      idempotency_key,request_fingerprint,status,recorded_by,recorded_at
    ) values (
      marker.id,v_shop_id,v_method,v_amount,v_amount,0,
      case when v_method='cash' then null else marker.note end,
      marker.id,md5(marker.id::text||':settings-and-excel-date'),'active',
      '5047b139-345c-4173-b3dd-b5fe5a13bd2e'::uuid,
      (marker.receipt_date+time '18:02') at time zone 'Asia/Bangkok'
    );

    v_remaining:=v_amount;
    for charge_row in
      select charge.id,charge.original_amount-coalesce(allocated.amount,0) balance
      from public.delivery_charges charge
      left join lateral (
        select sum(allocation.amount) amount from public.payment_allocations allocation
        join public.payments payment on payment.id=allocation.payment_id and payment.status='active'
        where allocation.charge_id=charge.id
      ) allocated on true
      where charge.shop_id=v_shop_id and charge.status='active'
        and charge.service_date between '2026-09-01' and marker.receipt_date
        and charge.original_amount-coalesce(allocated.amount,0)>0
      order by charge.service_date,charge.created_at,charge.id
    loop
      exit when v_remaining<=0;
      v_piece:=least(v_remaining,charge_row.balance);
      insert into public.payment_allocations(payment_id,charge_id,amount) values(marker.id,charge_row.id,v_piece);
      v_remaining:=v_remaining-v_piece;
    end loop;

    insert into public.audit_logs(actor_id,entity_type,entity_id,action,after_value)
    values('5047b139-345c-4173-b3dd-b5fe5a13bd2e'::uuid,'payments',marker.id,'import_payment_correction',
      jsonb_build_object('source','สรุปยอดขาย ศูนย์ราชการ ปี 69-2.xls','shop_code',marker.shop_code,
        'receipt_date',marker.receipt_date,'payment_method',v_method,'amount',v_amount,'note',marker.note));
  end loop;
end $$;

set constraints all immediate;
{finish}
{postcheck}
"""

output=Path("tmp/fix_payment_settings_commit.sql" if args.commit else "tmp/fix_payment_settings_dry_run.sql")
output.write_text(sql,encoding="utf-8")
print(output)
