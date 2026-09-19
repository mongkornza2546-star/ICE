import json
from collections import defaultdict
from pathlib import Path


records = json.loads(Path("tmp/september_sales.json").read_text(encoding="utf-8"))["records"]
aliases = {
    ("event", "เซเว่น"): "BB85",
    ("event", "วิน"): "B-ISO-01",
    ("unmapped_named", "Common day"): "BB87",
    ("unmapped_named", "พระปกเกล้าชั้น5"): "BB35",
    ("unmapped_named", "พันธ์ไทย"): "BB53",
}


def q(value):
    return "'" + str(value).replace("'", "''") + "'"


payments = defaultdict(lambda: {"amount": 0, "refs": []})
for record in records:
    code = record["code"] if record["kind"] == "regular" else aliases.get((record["kind"], record["name"]))
    if not code or not record["items"] or not isinstance(record["money"], (int, float)) or record["money"] <= 0:
        continue
    payments[(record["date"], code)]["amount"] += record["money"]
    payments[(record["date"], code)]["refs"].append(f"{record['sheet']} แถว {record['row']}")

values = ",\n".join(
    f"({q(day)}::date,{q(code)},{data['amount']}::numeric,{q('bank_transfer' if code == 'BB72' else 'cash')},{q('; '.join(data['refs']))})"
    for (day, code), data in sorted(payments.items())
)

sql = f"""
with target(receipt_date,shop_code,amount,payment_method,source_ref) as (values
{values}
), charge_balances as (
 select charge.id,charge.shop_id,charge.service_date,
   charge.original_amount-coalesce(sum(allocation.amount) filter(where payment.status='active'),0) balance
 from public.delivery_charges charge
 left join public.payment_allocations allocation on allocation.charge_id=charge.id
 left join public.payments payment on payment.id=allocation.payment_id
 where charge.status='active'
 group by charge.id
), checked as (
 select target.*,
   sum(target.amount) over(partition by target.shop_code order by target.receipt_date) cumulative_receipts,
   (select coalesce(sum(balance),0) from charge_balances balance join public.shops s2 on s2.id=balance.shop_id
    where upper(s2.code)=target.shop_code and balance.service_date<=target.receipt_date) available_balance
 from target
)
select jsonb_build_object(
 'receipt_count',(select count(*) from target),
 'receipt_total',(select sum(amount) from target),
 'cash_total',(select sum(amount) from target where payment_method='cash'),
 'transfer_total',(select sum(amount) from target where payment_method='bank_transfer'),
 'shortfalls',coalesce((select jsonb_agg(to_jsonb(x) order by receipt_date,shop_code) from checked x where cumulative_receipts>available_balance),'[]'::jsonb),
 'existing_september_payments',(select count(*) from public.payments where recorded_at>='2026-09-01 00:00+07' and recorded_at<'2026-09-19 00:00+07')
) result;
"""
Path("tmp/receipt_preflight.sql").write_text(sql, encoding="utf-8")
print(json.dumps({"receipt_count": len(payments), "receipt_total": sum(x["amount"] for x in payments.values())}, ensure_ascii=False))
