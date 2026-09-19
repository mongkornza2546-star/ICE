import argparse
from pathlib import Path


ACTOR_ID = "5047b139-345c-4173-b3dd-b5fe5a13bd2e"

parser = argparse.ArgumentParser()
parser.add_argument("--commit", action="store_true")
args = parser.parse_args()

verify = """
select jsonb_build_object(
  'payment_count',(select count(*) from target_receipts),
  'payment_total',(select sum(expected_amount) from target_receipts),
  'bb72_outstanding',(select coalesce(sum(charge.original_amount-coalesce(paid.amount,0)),0)
    from public.delivery_charges charge
    join public.shops shop on shop.id=charge.shop_id
    left join lateral (
      select sum(allocation.amount) amount
      from public.payment_allocations allocation
      join public.payments payment on payment.id=allocation.payment_id and payment.status='active'
      where allocation.charge_id=charge.id
    ) paid on true
    where shop.code='BB72' and charge.status='active' and charge.service_date between '2026-09-01' and '2026-09-18'),
  'cc6_outstanding',(select coalesce(sum(charge.original_amount-coalesce(paid.amount,0)),0)
    from public.delivery_charges charge
    join public.shops shop on shop.id=charge.shop_id
    left join lateral (
      select sum(allocation.amount) amount
      from public.payment_allocations allocation
      join public.payments payment on payment.id=allocation.payment_id and payment.status='active'
      where allocation.charge_id=charge.id
    ) paid on true
    where shop.code='CC6' and charge.status='active' and charge.service_date between '2026-09-01' and '2026-09-18'),
  'methods',(select jsonb_object_agg(shop.code,payment.payment_method)
    from target_receipts target
    join public.payments payment on payment.id=target.payment_id
    join public.shops shop on shop.id=payment.shop_id)
) result;
"""

finish = f"commit;\n{verify}" if args.commit else f"{verify}\nrollback;"

sql = f"""
create temporary table target_receipts(
  payment_id uuid primary key,
  shop_code text not null,
  expected_amount numeric not null
) on commit preserve rows;

insert into target_receipts values
  (md5('2026-09-19-full-transfer|BB72')::uuid,'BB72',3480),
  (md5('2026-09-19-full-transfer|CC6')::uuid,'CC6',780);

begin;
set local request.jwt.claim.sub = '{ACTOR_ID}';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  target record;
  charge_row record;
  v_shop_id uuid;
  v_outstanding numeric;
  v_remaining numeric;
  v_piece numeric;
begin
  for target in select * from target_receipts order by shop_code loop
    if exists(select 1 from public.payments where id=target.payment_id) then
      raise exception 'Payment % already exists',target.payment_id;
    end if;

    select id into strict v_shop_id from public.shops where upper(code)=target.shop_code;

    select coalesce(sum(charge.original_amount-coalesce(paid.amount,0)),0)
    into v_outstanding
    from public.delivery_charges charge
    left join lateral (
      select sum(allocation.amount) amount
      from public.payment_allocations allocation
      join public.payments payment on payment.id=allocation.payment_id and payment.status='active'
      where allocation.charge_id=charge.id
    ) paid on true
    where charge.shop_id=v_shop_id and charge.status='active'
      and charge.service_date between '2026-09-01' and '2026-09-18';

    if v_outstanding<>target.expected_amount then
      raise exception 'Unexpected outstanding for %: expected %, got %',target.shop_code,target.expected_amount,v_outstanding;
    end if;

    insert into public.payments(
      id,shop_id,collection_run_id,payment_method,received_amount,allocated_amount,change_amount,
      reference_number,evidence_path,idempotency_key,request_fingerprint,status,recorded_by,recorded_at
    ) values (
      target.payment_id,v_shop_id,null,'bank_transfer',v_outstanding,v_outstanding,0,
      'รับโอนปิดยอดเดือนกันยายนถึง 18/09/2569',null,target.payment_id,
      md5(target.payment_id::text||'สรุปยอดขาย ศูนย์ราชการ ปี 69-2.xls'),
      'active','{ACTOR_ID}'::uuid,now()
    );

    v_remaining:=v_outstanding;
    for charge_row in
      select charge.id,charge.original_amount-coalesce(paid.amount,0) balance
      from public.delivery_charges charge
      left join lateral (
        select sum(allocation.amount) amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id=allocation.payment_id and payment.status='active'
        where allocation.charge_id=charge.id
      ) paid on true
      where charge.shop_id=v_shop_id and charge.status='active'
        and charge.service_date between '2026-09-01' and '2026-09-18'
        and charge.original_amount-coalesce(paid.amount,0)>0
      order by charge.service_date,charge.created_at,charge.id
    loop
      exit when v_remaining<=0;
      v_piece:=least(v_remaining,charge_row.balance);
      insert into public.payment_allocations(payment_id,charge_id,amount)
      values(target.payment_id,charge_row.id,v_piece);
      v_remaining:=v_remaining-v_piece;
    end loop;

    if v_remaining<>0 then
      raise exception 'Allocation remainder for %: %',target.shop_code,v_remaining;
    end if;

    insert into public.audit_logs(actor_id,entity_type,entity_id,action,after_value)
    values('{ACTOR_ID}'::uuid,'payments',target.payment_id,'imported_excel_followup',jsonb_build_object(
      'source','สรุปยอดขาย ศูนย์ราชการ ปี 69-2.xls',
      'receipt_date','2026-09-19',
      'shop_code',target.shop_code,
      'allocated_amount',v_outstanding,
      'payment_method','bank_transfer',
      'reason','รับโอนปิดยอดค้างเดือนกันยายนตามคำสั่งผู้ใช้'
    ));
  end loop;
end $$;

set constraints all immediate;
{finish}
"""

output = Path("tmp/settle_bb72_cc6_transfer_commit.sql" if args.commit else "tmp/settle_bb72_cc6_transfer_dry_run.sql")
output.write_text(sql, encoding="utf-8")
print(output)
