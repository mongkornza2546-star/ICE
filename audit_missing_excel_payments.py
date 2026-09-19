import json
import uuid
from collections import defaultdict
from pathlib import Path


NAMESPACE = uuid.UUID("32617cd5-b01e-4f1a-87af-f770af4c9700")
ALIASES = {
    ("event", "เซเว่น"): "BB85",
    ("event", "วิน"): "B-ISO-01",
    ("unmapped_named", "Common day"): "BB87",
    ("unmapped_named", "พระปกเกล้าชั้น5"): "BB35",
    ("unmapped_named", "พันธ์ไทย"): "BB53",
}


def q(value):
    return "'" + str(value).replace("'", "''") + "'"


records = json.loads(Path("tmp/september_sales.json").read_text(encoding="utf-8"))["records"]
markers = defaultdict(lambda: {"amount": 0, "refs": []})
for record in records:
    code = record["code"] if record["kind"] == "regular" else ALIASES.get((record["kind"], record["name"]))
    if not code or not record["items"] or not isinstance(record["money"], (int, float)) or record["money"] <= 0:
        continue
    markers[(record["date"], code)]["amount"] += record["money"]
    markers[(record["date"], code)]["refs"].append(f"{record['sheet']} แถว {record['row']}")

rows = []
for (day, code), data in sorted(markers.items()):
    payment_id = uuid.uuid5(NAMESPACE, f"payment|{day}|{code}")
    rows.append(f"({q(payment_id)}::uuid,{q(day)}::date,{q(code)},{data['amount']}::numeric,{q('; '.join(data['refs']))})")

marker_sql = ",\n".join(rows)
sql = f"""
with expected(payment_id,receipt_date,shop_code,excel_amount,source_ref) as (values
{marker_sql}
), compared as (
  select expected.*,payment.id actual_payment_id,payment.status,payment.payment_method,
    payment.allocated_amount,payment.recorded_at
  from expected
  left join public.payments payment on payment.id=expected.payment_id
), balances as (
  select shop.code,shop.name,profile.default_payment_method,profile.allowed_payment_methods,
    coalesce(sum(charge.original_amount-coalesce(paid.amount,0)),0) outstanding
  from public.shops shop
  join public.shop_payment_profiles profile on profile.shop_id=shop.id
  left join public.delivery_charges charge on charge.shop_id=shop.id and charge.status='active'
    and charge.service_date between '2026-09-01' and '2026-09-18'
  left join lateral (
    select sum(allocation.amount) amount
    from public.payment_allocations allocation
    join public.payments payment on payment.id=allocation.payment_id and payment.status='active'
    where allocation.charge_id=charge.id
  ) paid on true
  where shop.code in ('BB72','CC6')
  group by shop.code,shop.name,profile.default_payment_method,profile.allowed_payment_methods
)
select jsonb_build_object(
  'expected_count',(select count(*) from expected),
  'expected_total',(select sum(excel_amount) from expected),
  'missing_count',(select count(*) from compared where actual_payment_id is null),
  'missing_total',(select coalesce(sum(excel_amount),0) from compared where actual_payment_id is null),
  'missing',coalesce((select jsonb_agg(to_jsonb(x) order by receipt_date,shop_code) from compared x where actual_payment_id is null),'[]'::jsonb),
  'amount_mismatch_count',(select count(*) from compared where actual_payment_id is not null and allocated_amount<>excel_amount),
  'amount_mismatches',coalesce((select jsonb_agg(to_jsonb(x) order by receipt_date,shop_code) from compared x where actual_payment_id is not null and allocated_amount<>excel_amount),'[]'::jsonb),
  'target_balances',(select jsonb_agg(to_jsonb(b) order by code) from balances b)
) result;
"""
Path("tmp/audit_missing_excel_payments.sql").write_text(sql, encoding="utf-8")
print(json.dumps({"markers": len(markers), "total": sum(x["amount"] for x in markers.values())}, ensure_ascii=False))
