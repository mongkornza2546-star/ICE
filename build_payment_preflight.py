import json
from pathlib import Path

records = json.loads(Path("tmp/september_sales.json").read_text(encoding="utf-8"))["records"]
aliases = {
    ("event", "เซเว่น"): "BB85",
    ("event", "วิน"): "B-ISO-01",
    ("unmapped_named", "Common day"): "BB87",
    ("unmapped_named", "พระปกเกล้าชั้น5"): "BB35",
    ("unmapped_named", "พันธ์ไทย"): "BB53",
}

def q(value): return "'" + str(value).replace("'", "''") + "'"

rows = []
for record in records:
    code = record["code"] if record["kind"] == "regular" else aliases.get((record["kind"], record["name"]))
    if not code or not record["items"]:
        continue
    money = record["money"]
    money_numeric = str(float(money)) if isinstance(money, (int, float)) else "null"
    money_text = "null" if money is None else q(money)
    for ice_code, quantity in record["items"].items():
        rows.append((record["date"], code, ice_code, quantity, money_numeric, money_text, record["sheet"], record["row"]))

values = ",\n".join(
    f"({q(day)}::date,{q(shop)},{q(ice)},{qty}::numeric,{money_num}::numeric,{money_text}::text,{q(sheet)},{row}::int)"
    for day, shop, ice, qty, money_num, money_text, sheet, row in rows
)

sql = f"""
with source(service_date,shop_code,ice_code,quantity,money_numeric,money_text,sheet_name,row_no) as (values
{values}
), priced as (
 select source.*, shop.id shop_id, profile.default_payment_term, profile.default_payment_method,
   coalesce(op.unit_price,sp.unit_price) unit_price
 from source join public.shops shop on upper(shop.code)=source.shop_code
 join public.ice_types ice on ice.code=source.ice_code
 join public.shop_payment_profiles profile on profile.shop_id=shop.id
 left join lateral (select unit_price from public.shop_ice_type_prices p where p.shop_id=shop.id and p.ice_type_id=ice.id and p.is_active and p.valid_from<=source.service_date and (p.valid_to is null or p.valid_to>=source.service_date) order by p.valid_from desc limit 1) op on true
 left join lateral (select unit_price from public.ice_type_prices p where p.ice_type_id=ice.id and p.is_active and p.valid_from<=source.service_date and (p.valid_to is null or p.valid_to>=source.service_date) order by p.valid_from desc limit 1) sp on true
), per_sale as (
 select service_date,shop_code,max(money_numeric) money_numeric,max(money_text) money_text,
   max(default_payment_term)::text payment_term,max(default_payment_method)::text payment_method,
   sum(quantity*unit_price) charge_amount,max(sheet_name) sheet_name,max(row_no) row_no
 from priced group by service_date,shop_code
)
select jsonb_build_object(
 'groups',(select jsonb_agg(to_jsonb(g) order by payment_term,money_state) from (
   select payment_term,case when money_text='ค้าง' then 'ค้าง' when money_numeric>0 then 'numeric' else 'blank' end money_state,count(*) sale_count,sum(charge_amount) charge_total
   from per_sale group by payment_term,2
 ) g),
 'mismatches',(select coalesce(jsonb_agg(to_jsonb(m) order by service_date,shop_code),'[]'::jsonb) from (
   select * from per_sale where money_numeric is not null and money_numeric>0 and money_numeric<>charge_amount
 ) m),
 'noncredit_blank',(select coalesce(jsonb_agg(to_jsonb(b) order by service_date,shop_code),'[]'::jsonb) from (
   select * from per_sale where payment_term<>'credit' and money_numeric is null
 ) b)
) result;
"""
Path("tmp/payment_preflight.sql").write_text(sql,encoding="utf-8")
print(len(rows))
