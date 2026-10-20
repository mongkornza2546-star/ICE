import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Reuse the existing minimal executive fixture, then load real accounting readers.
const fixtureUrl = new URL('../../tests/executive-reports.integration.test.mjs', import.meta.url);
const fixture = readFileSync(fixtureUrl, 'utf8').split("test('executive report separates")[0]
  .replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(fixtureUrl.href));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const { db, productionFunction } = await new AsyncFunction('PGlite', 'readFileSync', 'assert',
  fixture + '\nreturn { db: await database({after() {}}), productionFunction };')(PGlite, readFileSync, assert);
const migration = (name) => readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
try {
  await db.exec(`
    create type payment_term as enum ('immediate', 'end_of_day', 'credit');
    alter table buildings add column sort_order integer default 1;
    alter table shops add column code text default 'S1', add column zone_id uuid, add column delivery_sequence integer;
    create table building_zones(id uuid, name text, sort_order integer);
    create table shop_payment_profiles(shop_id uuid, allowed_payment_terms payment_term[], default_payment_term payment_term);
    create table delivery_rounds(id uuid, service_date date, cancelled_at timestamptz);
    alter table round_stops add column round_id uuid, add column shop_id uuid, add column status text, add column floor_or_zone_snapshot text;
    alter table delivery_events add column recorded_by uuid;
    create table users(id uuid, display_name text);
    alter table event_jobs add column status text, add column start_date date, add column end_date date;
    alter table event_participations add column shop_id uuid, add column status text, add column start_date date, add column end_date date;
  `);
  await db.exec(productionFunction('0145_accounting_shop_summary_area_groups', 'get_accounting_shop_summary'));
  await db.exec('alter function get_accounting_shop_summary(date,date,jsonb,integer,integer) rename to get_accounting_shop_summary_without_casual');
  await db.exec(productionFunction('0154_casual_measured_transactions', 'get_accounting_shop_summary'));
  for (const name of ['0199_accounting_event_date_scope', '0206_accounting_shop_code_numeric_order', '0212_accounting_received_cash_transfer_split']) await db.exec(migration(name));
  // Apply the actual 0223 summary patches only; unrelated daily/detail endpoints are not loaded.
  await db.exec(migration('0223_accounting_sales_exclude_vat').replace(
    ') as patches(function_id, old_text, new_text)',
    ") as patches(function_id, old_text, new_text) where function_id::text like '%get_accounting_shop_summary%'"));
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  await db.exec(`
    insert into buildings(id,name) values ('${id(1)}','Building');
    insert into building_zones values ('${id(2)}','Zone',1);
    insert into shops(id,name,building_id,zone_id) values ('${id(3)}','Shop','${id(1)}','${id(2)}');
    insert into users values ('${id(4)}','Driver');
    insert into round_stops(id,shop_id) values ('${id(5)}','${id(3)}');
    insert into delivery_events(id,round_stop_id,status,recorded_at,recorded_by) values ('${id(6)}','${id(5)}','active','2026-09-01T04:00:00Z','${id(4)}');
    insert into delivery_charges(id,delivery_event_id,shop_id,service_date,status,original_amount,vat_amount) values ('${id(7)}','${id(6)}','${id(3)}','2026-09-01','active',107,7);
    insert into shop_tank_rentals(id,quantity,unit_price,recorded_at) values ('${id(8)}',1,50,'2026-09-01T04:00:00Z');
    insert into delivery_charges(id,tank_rental_id,shop_id,service_date,status,original_amount,vat_amount) values ('${id(9)}','${id(8)}','${id(3)}','2026-09-01','active',53.5,3.5);
  `);
  const compare = async () => (await db.query(`select
    (get_executive_report('2026-09-01','2026-09-01')->>'sales')::numeric as executive_sales,
    (get_accounting_shop_summary('2026-09-01','2026-09-01')->'totals'->>'sales_amount')::numeric as accounting_shop_sales,
    (get_accounting_shop_summary('2026-09-01','2026-09-01')->'totals'->>'casual_sales_amount')::numeric as accounting_casual_sales`)).rows[0];
  const active = await compare();
  assert.equal(Number(active.executive_sales),150);
  assert.equal(Number(active.accounting_shop_sales),100);
  console.log('Active shop with net ice sale 100 + net tank rental 50:', active);
  await db.exec(`update shops set status='inactive' where id='${id(3)}'`);
  const inactive = await compare();
  assert.equal(Number(inactive.executive_sales),150);
  assert.equal(Number(inactive.accounting_shop_sales),0);
  console.log('Same shop after deactivation:', inactive);
} finally { await db.close(); }
