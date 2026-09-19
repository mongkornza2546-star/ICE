import argparse
import json
import uuid
from collections import defaultdict
from pathlib import Path


ACTOR_ID = "5047b139-345c-4173-b3dd-b5fe5a13bd2e"
NAMESPACE = uuid.UUID("32617cd5-b01e-4f1a-87af-f770af4c9700")
SOURCE_LABEL = "สรุปยอดขาย ศูนย์ราชการ ปี 69-2.xls"
ALIASES = {
    ("event", "เซเว่น"): "BB85",
    ("event", "วิน"): "B-ISO-01",
    ("unmapped_named", "Common day"): "BB87",
    ("unmapped_named", "พระปกเกล้าชั้น5"): "BB35",
    ("unmapped_named", "พันธ์ไทย"): "BB53",
}


def uid(*parts):
    return str(uuid.uuid5(NAMESPACE, "|".join(str(part) for part in parts)))


def q(value):
    return "'" + str(value).replace("'", "''") + "'"


parser = argparse.ArgumentParser()
parser.add_argument("--commit", action="store_true")
args = parser.parse_args()

records = json.loads(Path("tmp/september_sales.json").read_text(encoding="utf-8"))["records"]
markers = set()
for record in records:
    code = record["code"] if record["kind"] == "regular" else ALIASES.get((record["kind"], record["name"]))
    if code and record["items"] and isinstance(record["money"], (int, float)) and record["money"] > 0:
        markers.add((record["date"], code))

values = ",\n".join(
    f"({q(uid('configured-price-payment', day, code))}::uuid,{q(day)}::date,{q(code)},"
    f"{q('bank_transfer' if code == 'BB72' else 'cash')})"
    for day, code in sorted(markers)
)
finish = "commit;" if args.commit else "rollback;"
postcheck = """
select jsonb_build_object(
  'supplemental_payment_count',count(*),
  'supplemental_total',coalesce(sum(payment.allocated_amount),0),
  'remaining_partial_charges',(
    select count(*) from public.delivery_charges charge
    where charge.service_date between '2026-09-01' and '2026-09-18' and charge.status='active'
      and (select coalesce(sum(allocation.amount),0) from public.payment_allocations allocation join public.payments p on p.id=allocation.payment_id and p.status='active' where allocation.charge_id=charge.id) between 0.01 and charge.original_amount-0.01
  ),
  'remaining_balance',(
    select sum(charge.original_amount-coalesce((select sum(allocation.amount) from public.payment_allocations allocation join public.payments p on p.id=allocation.payment_id and p.status='active' where allocation.charge_id=charge.id),0))
    from public.delivery_charges charge where charge.service_date between '2026-09-01' and '2026-09-18' and charge.status='active'
  )
) result
from public.payments payment
where payment.id in(select id from import_price_markers);
""" if args.commit else ""

sql = f"""
create temporary table import_price_markers(id uuid primary key,receipt_date date,shop_code text,payment_method public.payment_method) on commit preserve rows;
insert into import_price_markers values
{values};

begin;
set local request.jwt.claim.sub = {q(ACTOR_ID)};
set local request.jwt.claim.role = 'authenticated';

do $$
declare marker record; charge_row record; v_shop_id uuid; v_amount numeric; v_remaining numeric; v_piece numeric;
begin
 for marker in select * from import_price_markers order by receipt_date,shop_code loop
   if exists(select 1 from public.payments where id=marker.id) then
     raise exception 'Configured-price supplemental payment already exists: %',marker.id;
   end if;
   select id into strict v_shop_id from public.shops where upper(code)=marker.shop_code;
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
     marker.id,v_shop_id,marker.payment_method,v_amount,v_amount,0,
     case when marker.payment_method='bank_transfer' then 'ปรับตามราคาประจำร้านจาก Excel' else null end,
     marker.id,md5(marker.id::text||':configured-shop-price'),'active',{q(ACTOR_ID)}::uuid,
     (marker.receipt_date+time '18:01') at time zone 'Asia/Bangkok'
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
   values({q(ACTOR_ID)}::uuid,'payments',marker.id,'import_price_reconciliation',jsonb_build_object(
     'source',{q(SOURCE_LABEL)},'shop_code',marker.shop_code,'receipt_date',marker.receipt_date,
     'amount',v_amount,'reason','ชำระตามราคาประจำร้านที่ตั้งไว้ในระบบ'
   ));
 end loop;
end $$;

set constraints all immediate;
{finish}
{postcheck}
"""

output=Path("tmp/fix_september_payment_prices_commit.sql" if args.commit else "tmp/fix_september_payment_prices_dry_run.sql")
output.write_text(sql,encoding="utf-8")
print(json.dumps({"output":str(output),"mode":"commit" if args.commit else "rollback","markers":len(markers)},ensure_ascii=False))
