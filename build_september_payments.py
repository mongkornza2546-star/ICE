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
markers = defaultdict(lambda: {"amount": 0, "refs": []})
for record in records:
    code = record["code"] if record["kind"] == "regular" else ALIASES.get((record["kind"], record["name"]))
    if not code or not record["items"]:
        continue
    if not isinstance(record["money"], (int, float)) or record["money"] <= 0:
        continue
    markers[(record["date"], code)]["amount"] += record["money"]
    markers[(record["date"], code)]["refs"].append(f"{record['sheet']} แถว {record['row']}")

values = []
for (day, code), data in sorted(markers.items()):
    payment_id = uid("payment", day, code)
    method = "bank_transfer" if code == "BB72" else "cash"
    note = f"รับชำระตามช่องเงินใน {SOURCE_LABEL}: {'; '.join(data['refs'])}"
    values.append(
        f"({q(payment_id)}::uuid,{q(day)}::date,{q(code)},{data['amount']}::numeric,{q(method)},{q(note)})"
    )

finish = "commit;" if args.commit else "rollback;"
postcheck = """
select jsonb_build_object(
  'payment_count',count(*),
  'allocated_total',sum(payment.allocated_amount),
  'cash_total',sum(payment.allocated_amount) filter(where payment.payment_method='cash'),
  'transfer_total',sum(payment.allocated_amount) filter(where payment.payment_method='bank_transfer'),
  'allocation_count',(select count(*) from public.payment_allocations allocation join public.payments p on p.id=allocation.payment_id where p.id in (select id from import_payment_markers)),
  'paid_charges',(select count(*) from public.delivery_charges charge where charge.service_date between '2026-09-01' and '2026-09-18' and charge.status='active' and charge.original_amount=(select coalesce(sum(allocation.amount),0) from public.payment_allocations allocation join public.payments p on p.id=allocation.payment_id and p.status='active' where allocation.charge_id=charge.id)),
  'partial_charges',(select count(*) from public.delivery_charges charge where charge.service_date between '2026-09-01' and '2026-09-18' and charge.status='active' and (select coalesce(sum(allocation.amount),0) from public.payment_allocations allocation join public.payments p on p.id=allocation.payment_id and p.status='active' where allocation.charge_id=charge.id) between 0.01 and charge.original_amount-0.01),
  'unpaid_balance',(select sum(charge.original_amount-coalesce((select sum(allocation.amount) from public.payment_allocations allocation join public.payments p on p.id=allocation.payment_id and p.status='active' where allocation.charge_id=charge.id),0)) from public.delivery_charges charge where charge.service_date between '2026-09-01' and '2026-09-18' and charge.status='active')
) imported
from public.payments payment
where payment.id in (select id from import_payment_markers);
""" if args.commit else ""

marker_sql = ",\n".join(values)
sql = f"""
create temporary table import_payment_markers(
 id uuid primary key,receipt_date date,shop_code text,excel_amount numeric,payment_method public.payment_method,note text
) on commit preserve rows;
insert into import_payment_markers values
{marker_sql};

begin;
set local request.jwt.claim.sub = {q(ACTOR_ID)};
set local request.jwt.claim.role = 'authenticated';

do $$
begin
 if exists(select 1 from public.payments payment where payment.id in(select id from import_payment_markers)) then
   raise exception 'One or more September import payments already exist';
 end if;
 if (select count(*) from public.delivery_rounds where service_date between '2026-09-01' and '2026-09-18' and round_type='daily' and cancelled_at is null) <> 14 then
   raise exception 'Expected 14 imported September rounds before recording payments';
 end if;
end $$;

do $$
declare
 marker record;
 charge_row record;
 v_shop_id uuid;
 v_available numeric;
 v_payment_amount numeric;
 v_remaining numeric;
 v_piece numeric;
begin
 for marker in select * from import_payment_markers order by receipt_date,shop_code loop
   select id into strict v_shop_id from public.shops where upper(code)=marker.shop_code;

   select coalesce(sum(charge.original_amount-coalesce(allocated.amount,0)),0)
   into v_available
   from public.delivery_charges charge
   left join lateral (
     select sum(allocation.amount) amount
     from public.payment_allocations allocation
     join public.payments payment on payment.id=allocation.payment_id and payment.status='active'
     where allocation.charge_id=charge.id
   ) allocated on true
   where charge.shop_id=v_shop_id and charge.status='active'
     and charge.service_date between '2026-09-01' and marker.receipt_date;

   v_payment_amount := least(marker.excel_amount,v_available);
   if v_payment_amount <= 0 then continue; end if;

   insert into public.payments(
     id,shop_id,collection_run_id,payment_method,received_amount,allocated_amount,change_amount,
     reference_number,evidence_path,idempotency_key,request_fingerprint,status,recorded_by,recorded_at
   ) values (
     marker.id,v_shop_id,null,marker.payment_method,v_payment_amount,v_payment_amount,0,
     case when marker.payment_method='bank_transfer' then 'โอนตาม Excel '||to_char(marker.receipt_date,'DD/MM/YYYY') else null end,
     null,marker.id,md5(marker.id::text||marker.note),'active',{q(ACTOR_ID)}::uuid,
     (marker.receipt_date+time '18:00') at time zone 'Asia/Bangkok'
   );

   v_remaining := v_payment_amount;
   for charge_row in
     select charge.id,charge.original_amount-coalesce(allocated.amount,0) balance
     from public.delivery_charges charge
     left join lateral (
       select sum(allocation.amount) amount
       from public.payment_allocations allocation
       join public.payments payment on payment.id=allocation.payment_id and payment.status='active'
       where allocation.charge_id=charge.id
     ) allocated on true
     where charge.shop_id=v_shop_id and charge.status='active'
       and charge.service_date between '2026-09-01' and marker.receipt_date
       and charge.original_amount-coalesce(allocated.amount,0)>0
     order by charge.service_date,charge.created_at,charge.id
   loop
     exit when v_remaining<=0;
     v_piece := least(v_remaining,charge_row.balance);
     insert into public.payment_allocations(payment_id,charge_id,amount)
     values(marker.id,charge_row.id,v_piece);
     v_remaining := v_remaining-v_piece;
   end loop;

   insert into public.audit_logs(actor_id,entity_type,entity_id,action,after_value)
   values({q(ACTOR_ID)}::uuid,'payments',marker.id,'imported',jsonb_build_object(
     'source',{q(SOURCE_LABEL)},'receipt_date',marker.receipt_date,'shop_code',marker.shop_code,
     'excel_amount',marker.excel_amount,'allocated_september_amount',v_payment_amount,
     'payment_method',marker.payment_method,'note',marker.note
   ));
 end loop;
end $$;

set constraints all immediate;
{finish}
{postcheck}
"""

output = Path("tmp/import_september_payments_commit.sql" if args.commit else "tmp/import_september_payments_dry_run.sql")
output.write_text(sql,encoding="utf-8")
print(json.dumps({
    "output":str(output),"mode":"commit" if args.commit else "rollback",
    "excel_payment_markers":len(markers),"excel_amount_total":sum(data["amount"] for data in markers.values()),
    "transfer_shop":"BB72",
},ensure_ascii=False,indent=2))
