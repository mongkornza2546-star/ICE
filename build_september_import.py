import argparse
import json
import uuid
from collections import defaultdict
from pathlib import Path


ACTOR_ID = "5047b139-345c-4173-b3dd-b5fe5a13bd2e"
TRUCK_ID = "46dca9b3-fe99-4f3e-be95-ce51d0d1aa98"
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


def quote(value):
    if value is None:
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


parser = argparse.ArgumentParser()
parser.add_argument("--commit", action="store_true")
args = parser.parse_args()

records = json.loads(Path("tmp/september_sales.json").read_text(encoding="utf-8"))["records"]

regular = defaultdict(lambda: {"items": defaultdict(float), "sources": []})
casual = []

for record in records:
    if record["kind"] == "casual" and record["items"]:
        casual.append(record)
        continue
    shop_code = record["code"] if record["kind"] == "regular" else ALIASES.get((record["kind"], record["name"]))
    if not shop_code or not record["items"]:
        continue
    sale = regular[(record["date"], shop_code)]
    for ice_code, quantity in record["items"].items():
        sale["items"][ice_code] += quantity
    sale["sources"].append(f"{record['sheet']} แถว {record['row']}")

dates = sorted({day for day, _ in regular} | {record["date"] for record in casual})
round_values = []
for day in dates:
    round_values.append(
        f"({quote(uid('round', day))}::uuid,{quote(day)}::date,'งานประจำวัน','daily',"
        f"'open',{quote(ACTOR_ID)}::uuid,({quote(day)}::date + time '06:00') at time zone 'Asia/Bangkok',"
        f"(({quote(day)}::date + time '06:00') at time zone 'Asia/Bangkok'))"
    )

regular_item_values = []
regular_sale_values = []
for (day, shop_code), sale in sorted(regular.items()):
    stop_id = uid("stop", day, shop_code)
    event_id = uid("event", day, shop_code)
    source_note = "นำเข้าจาก " + SOURCE_LABEL + ": " + "; ".join(sale["sources"])
    regular_sale_values.append(
        f"({quote(day)}::date,{quote(shop_code)},{quote(stop_id)}::uuid,{quote(event_id)}::uuid,{quote(source_note)})"
    )
    for ice_code, quantity in sorted(sale["items"].items()):
        regular_item_values.append(
            f"({quote(day)}::date,{quote(shop_code)},{quote(event_id)}::uuid,{quote(ice_code)},{quantity}::numeric)"
        )

casual_values = []
for index, record in enumerate(sorted(casual, key=lambda row: (row["date"], row["sheet"], row["row"])), start=1):
    if len(record["items"]) != 1 or not isinstance(record["money"], (int, float)) or record["money"] <= 0:
        raise SystemExit(f"Unsupported casual row: {record}")
    ice_code, quantity = next(iter(record["items"].items()))
    transaction_id = uid("casual", record["date"], record["sheet"], record["row"], ice_code)
    receipt = f"MIG-{record['date'].replace('-', '')}-{index:03d}"
    note = f"นำเข้าจาก {SOURCE_LABEL}: {record['sheet']} แถว {record['row']} (ระบุว่า สด)"
    casual_values.append(
        f"({quote(transaction_id)}::uuid,{quote(record['date'])}::date,{quote(ice_code)},{quantity}::numeric,"
        f"{float(record['money'])}::numeric,{quote(receipt)},{quote(note)})"
    )

expected_stops = len(regular_sale_values)
expected_items = len(regular_item_values)
expected_quantity = sum(sum(sale["items"].values()) for sale in regular.values())
expected_regular_total = 171635
expected_casual_count = len(casual_values)
expected_casual_quantity = sum(sum(record["items"].values()) for record in casual)
expected_casual_total = sum(float(record["money"]) for record in casual)

finish = "commit;" if args.commit else "rollback;"
postcheck = """
select jsonb_build_object(
  'rounds', (select count(*) from public.delivery_rounds where service_date between '2026-09-01' and '2026-09-18' and round_type='daily' and cancelled_at is null),
  'regular_stops', (select count(*) from public.round_stops stop join public.delivery_rounds round on round.id=stop.round_id where round.service_date between '2026-09-01' and '2026-09-18' and stop.destination_kind='regular' and stop.status='delivered'),
  'delivery_items', (select count(*) from public.delivery_items item join public.delivery_events event on event.id=item.delivery_event_id join public.round_stops stop on stop.id=event.round_stop_id join public.delivery_rounds round on round.id=stop.round_id where round.service_date between '2026-09-01' and '2026-09-18'),
  'regular_quantity', (select sum(item.quantity) from public.delivery_items item join public.delivery_events event on event.id=item.delivery_event_id join public.round_stops stop on stop.id=event.round_stop_id join public.delivery_rounds round on round.id=stop.round_id where round.service_date between '2026-09-01' and '2026-09-18'),
  'regular_sales', (select sum(charge.original_amount) from public.delivery_charges charge where charge.service_date between '2026-09-01' and '2026-09-18' and charge.status='active'),
  'casual_count', (select count(*) from public.casual_transactions where service_date between '2026-09-01' and '2026-09-18' and status='active'),
  'casual_quantity', (select sum(quantity) from public.casual_transactions where service_date between '2026-09-01' and '2026-09-18' and status='active'),
  'casual_sales', (select sum(sale_amount) from public.casual_transactions where service_date between '2026-09-01' and '2026-09-18' and status='active')
) as imported;
""" if args.commit else ""

regular_sale_sql = ",\n".join(regular_sale_values)
regular_item_sql = ",\n".join(regular_item_values)
casual_sql = ",\n".join(casual_values)
round_sql = ",\n".join(round_values)

sql = f"""
begin;
set local request.jwt.claim.sub = {quote(ACTOR_ID)};
set local request.jwt.claim.role = 'authenticated';

do $$
begin
  if exists (select 1 from public.delivery_rounds where service_date between '2026-09-01' and '2026-09-18' and cancelled_at is null)
     or exists (select 1 from public.casual_transactions where service_date between '2026-09-01' and '2026-09-18') then
    raise exception 'Target date range already contains operational data; import stopped';
  end if;
end $$;

create temporary table import_regular_sales(service_date date,shop_code text,stop_id uuid,event_id uuid,source_note text) on commit drop;
insert into import_regular_sales values
{regular_sale_sql};

create temporary table import_regular_items(service_date date,shop_code text,event_id uuid,ice_code text,quantity numeric) on commit drop;
insert into import_regular_items values
{regular_item_sql};

create temporary table import_casual(id uuid,service_date date,ice_code text,quantity numeric,sale_amount numeric,receipt_number text,note text) on commit drop;
insert into import_casual values
{casual_sql};

insert into public.delivery_rounds(id,service_date,name,round_type,status,opened_by,opened_at,created_at) values
{round_sql};

insert into public.round_stops(
 id,round_id,shop_id,shop_code_snapshot,shop_name_snapshot,building_id_snapshot,building_name_snapshot,
 floor_or_zone_snapshot,sequence_no,status,note,updated_by,updated_at,destination_kind,is_operational
)
select source.stop_id,round.id,shop.id,shop.code,shop.name,shop.building_id,building.name,shop.floor_or_zone,
 row_number() over(partition by source.service_date order by building.sort_order,shop.delivery_sequence nulls last,shop.code),
 'delivered',source.source_note,{quote(ACTOR_ID)}::uuid,
 (source.service_date + time '12:00') at time zone 'Asia/Bangkok','regular',true
from import_regular_sales source
join public.delivery_rounds round on round.service_date=source.service_date and round.round_type='daily' and round.cancelled_at is null
join public.shops shop on upper(shop.code)=source.shop_code
join public.buildings building on building.id=shop.building_id;

insert into public.delivery_events(
 id,round_stop_id,recorded_by,recorded_at,client_recorded_at,idempotency_key,note,status,source_stock_location_id,request_fingerprint
)
select source.event_id,source.stop_id,{quote(ACTOR_ID)}::uuid,
 (source.service_date + time '12:00') at time zone 'Asia/Bangkok',
 (source.service_date + time '12:00') at time zone 'Asia/Bangkok',source.event_id,source.source_note,'active',
 {quote(TRUCK_ID)}::uuid,md5(source.event_id::text || source.source_note)
from import_regular_sales source;

insert into public.delivery_items(delivery_event_id,ice_type_id,quantity,unit_price,price_source,price_source_id)
select source.event_id,ice.id,source.quantity,
 coalesce(override_price.unit_price,standard_price.unit_price),
 (case when override_price.id is not null then 'shop_override' else 'standard' end)::public.price_source,
 coalesce(override_price.id,standard_price.id)
from import_regular_items source
join public.shops shop on upper(shop.code)=source.shop_code
join public.ice_types ice on ice.code=source.ice_code
left join lateral (
 select price.id,price.unit_price from public.shop_ice_type_prices price
 where price.shop_id=shop.id and price.ice_type_id=ice.id and price.is_active
   and price.valid_from<=source.service_date and (price.valid_to is null or price.valid_to>=source.service_date)
 order by price.valid_from desc limit 1
) override_price on true
left join lateral (
 select price.id,price.unit_price from public.ice_type_prices price
 where price.ice_type_id=ice.id and price.is_active
   and price.valid_from<=source.service_date and (price.valid_to is null or price.valid_to>=source.service_date)
 order by price.valid_from desc limit 1
) standard_price on true;

insert into public.delivery_charges(id,delivery_event_id,shop_id,service_date,payment_term,original_amount,due_date,status,created_at)
select md5(source.event_id::text || ':charge')::uuid,source.event_id,shop.id,source.service_date,profile.default_payment_term,
 sum(item.line_total),
 case when profile.default_payment_term='credit'
   then public.resolve_credit_due_date(shop.id,source.service_date)
 end,
 'active',(source.service_date + time '12:00') at time zone 'Asia/Bangkok'
from import_regular_sales source
join public.shops shop on upper(shop.code)=source.shop_code
join public.shop_payment_profiles profile on profile.shop_id=shop.id
join public.delivery_items item on item.delivery_event_id=source.event_id
group by source.event_id,shop.id,source.service_date,profile.default_payment_term,profile.credit_due_rule,profile.credit_days;

insert into public.casual_transactions(
 id,service_date,round_id,source_stock_location_id,ice_type_id,transaction_kind,fulfillment_mode,quantity,
 sale_amount,payment_method,received_amount,change_amount,note,receipt_number,idempotency_key,request_fingerprint,
 client_recorded_at,recorded_by,recorded_at,status
)
select source.id,source.service_date,round.id,{quote(TRUCK_ID)}::uuid,ice.id,'paid','measured',source.quantity,
 source.sale_amount,'cash',source.sale_amount,0,source.note,source.receipt_number,source.id,
 md5(source.id::text || source.receipt_number),(source.service_date+time '12:30') at time zone 'Asia/Bangkok',
 {quote(ACTOR_ID)}::uuid,(source.service_date+time '12:30') at time zone 'Asia/Bangkok','active'
from import_casual source
join public.delivery_rounds round on round.service_date=source.service_date and round.round_type='daily' and round.cancelled_at is null
join public.ice_types ice on ice.code=source.ice_code;

insert into public.casual_receipt_snapshots(transaction_id,receipt_data,created_at)
select source.id,jsonb_build_object(
 'receipt_number',source.receipt_number,'service_date',source.service_date,'quantity',source.quantity,
 'sale_amount',source.sale_amount,'payment_method','cash','note',source.note
),(source.service_date+time '12:30') at time zone 'Asia/Bangkok'
from import_casual source;

update public.delivery_rounds
set status='closed',closed_by={quote(ACTOR_ID)}::uuid,
 closed_at=(service_date+time '23:00') at time zone 'Asia/Bangkok'
where service_date between '2026-09-01' and '2026-09-18' and round_type='daily' and cancelled_at is null;

do $$
declare
 v_stops bigint; v_items bigint; v_quantity numeric; v_regular_total numeric;
 v_casual_count bigint; v_casual_quantity numeric; v_casual_total numeric;
begin
 select count(*) into v_stops from import_regular_sales;
 select count(*),sum(quantity) into v_items,v_quantity from import_regular_items;
 select sum(charge.original_amount) into v_regular_total from public.delivery_charges charge where charge.service_date between '2026-09-01' and '2026-09-18';
 select count(*),sum(quantity),sum(sale_amount) into v_casual_count,v_casual_quantity,v_casual_total from public.casual_transactions where service_date between '2026-09-01' and '2026-09-18';
 if v_stops<>{expected_stops} or v_items<>{expected_items} or v_quantity<>{expected_quantity}
   or v_regular_total<>{expected_regular_total} or v_casual_count<>{expected_casual_count}
   or v_casual_quantity<>{expected_casual_quantity} or v_casual_total<>{expected_casual_total} then
   raise exception 'Import reconciliation failed: stops %, items %, qty %, regular %, casual count %, qty %, sales %',
     v_stops,v_items,v_quantity,v_regular_total,v_casual_count,v_casual_quantity,v_casual_total;
 end if;
end $$;

set constraints all immediate;
{finish}
{postcheck}
"""

output = Path("tmp/import_september_commit.sql" if args.commit else "tmp/import_september_dry_run.sql")
output.write_text(sql, encoding="utf-8")
print(json.dumps({
    "output": str(output), "mode": "commit" if args.commit else "rollback", "dates": len(dates),
    "regular_stops": expected_stops, "regular_items": expected_items,
    "regular_quantity": expected_quantity, "regular_sales": expected_regular_total,
    "casual_count": expected_casual_count, "casual_quantity": expected_casual_quantity,
    "casual_sales": expected_casual_total,
}, ensure_ascii=False, indent=2))
