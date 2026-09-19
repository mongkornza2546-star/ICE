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

rows = set()
for record in records:
    code = record["code"] if record["kind"] == "regular" else aliases.get((record["kind"], record["name"]))
    if not code:
        continue
    for ice_code, quantity in record["items"].items():
        rows.add((record["date"], code, ice_code, quantity))

def q(value):
    return "'" + str(value).replace("'", "''") + "'"

values = ",\n".join(
    f"({q(day)}::date, {q(shop)}, {q(ice)}, {quantity}::numeric)"
    for day, shop, ice, quantity in sorted(rows)
)

sql = f"""
with source(service_date, shop_code, ice_code, quantity) as (
  values
{values}
), resolved as (
  select source.*, shop.id as shop_id, ice.id as ice_type_id,
    profile.default_payment_term, profile.default_payment_method,
    coalesce(override_price.unit_price, standard_price.unit_price) as unit_price,
    case when override_price.id is not null then 'shop_override' else 'standard' end as price_source
  from source
  left join public.shops shop on upper(shop.code) = source.shop_code
  left join public.ice_types ice on ice.code = source.ice_code
  left join public.shop_payment_profiles profile on profile.shop_id = shop.id
  left join lateral (
    select price.id, price.unit_price from public.shop_ice_type_prices price
    where price.shop_id = shop.id and price.ice_type_id = ice.id and price.is_active
      and price.valid_from <= source.service_date
      and (price.valid_to is null or price.valid_to >= source.service_date)
    order by price.valid_from desc limit 1
  ) override_price on true
  left join lateral (
    select price.id, price.unit_price from public.ice_type_prices price
    where price.ice_type_id = ice.id and price.is_active
      and price.valid_from <= source.service_date
      and (price.valid_to is null or price.valid_to >= source.service_date)
    order by price.valid_from desc limit 1
  ) standard_price on true
), regular_result as (
select jsonb_build_object(
  'source_rows', (select count(*) from source),
  'source_quantity', (select sum(quantity) from source),
  'missing_shops', coalesce((select jsonb_agg(distinct shop_code) from resolved where shop_id is null), '[]'::jsonb),
  'missing_ice_types', coalesce((select jsonb_agg(distinct ice_code) from resolved where ice_type_id is null), '[]'::jsonb),
  'missing_profiles', coalesce((select jsonb_agg(distinct shop_code) from resolved where shop_id is not null and default_payment_term is null), '[]'::jsonb),
  'missing_prices', coalesce((select jsonb_agg(jsonb_build_object('date', service_date, 'shop', shop_code, 'ice', ice_code)) from resolved where unit_price is null), '[]'::jsonb),
  'terms', coalesce((select jsonb_object_agg(default_payment_term, row_count) from (select default_payment_term, count(*) row_count from resolved group by default_payment_term) t), '{{}}'::jsonb),
  'priced_total', (select sum(quantity * unit_price) from resolved)
) as value
)
select jsonb_build_object(
  'regular', (select value from regular_result),
  'event', jsonb_build_object(
    'settings', (select to_jsonb(setting) from public.event_delivery_feature_settings setting where singleton),
    'jobs', coalesce((select jsonb_agg(to_jsonb(job) order by start_date, name) from public.event_jobs job where daterange(job.start_date, job.end_date, '[]') && daterange('2026-09-01'::date, '2026-09-18'::date, '[]')), '[]'::jsonb)
  ),
  'existing', jsonb_build_object(
    'rounds', (select count(*) from public.delivery_rounds where service_date between '2026-09-01' and '2026-09-18'),
    'events', (select count(*) from public.delivery_events event join public.round_stops stop on stop.id=event.round_stop_id join public.delivery_rounds round on round.id=stop.round_id where round.service_date between '2026-09-01' and '2026-09-18'),
    'casual', (select count(*) from public.casual_transactions where service_date between '2026-09-01' and '2026-09-18')
  )
) as preflight;
"""

Path("tmp/preflight_generated.sql").write_text(sql, encoding="utf-8")
print(f"wrote tmp/preflight_generated.sql with {len(rows)} rows")
