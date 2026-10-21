import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
   create role authenticated; create role anon;
   create function is_active_user() returns boolean language sql as $$select coalesce(current_setting('test.active_user',true),'true')::boolean$$;
   create function daily_aggregate_stock_balance_at(date,uuid) returns numeric language sql as $$select 0::numeric$$;
   create table ice_types(id uuid primary key,code text,name text,unit text,is_active boolean);
   create table daily_aggregate_stock_closures(service_date date,status text,closed_at timestamptz);
   create table daily_aggregate_stock_closure_items(service_date date,ice_type_id uuid,system_quantity numeric,actual_quantity numeric,variance_quantity numeric,note text);
   create table stock_movements(id uuid,service_date date,status text,kind text);
   create table stock_movement_items(movement_id uuid,ice_type_id uuid,quantity numeric);
   create table factory_receipts(id uuid,factory_order_id uuid,service_date date);
   create table factory_receipt_items(factory_receipt_id uuid,ice_type_id uuid,actual_quantity numeric);
   create table delivery_events(id uuid,round_stop_id uuid,status text,source_stock_location_id uuid);
   create table delivery_items(delivery_event_id uuid,ice_type_id uuid,quantity numeric);
   create table round_stops(id uuid,round_id uuid);
   create table delivery_rounds(id uuid,service_date date);
   create table daily_stock_uses(id uuid,service_date date,status text);
   create table daily_stock_use_items(use_id uuid,ice_type_id uuid,quantity numeric);
   create table casual_transactions(service_date date,status text,fulfillment_mode text,ice_type_id uuid,quantity numeric);
   create function casual_loose_stock_totals(date) returns table(ice_type_id uuid,quantity numeric) language sql as $$select null::uuid,0::numeric where false$$;
   insert into ice_types values('00000000-0000-0000-0000-000000000001','01','หลอดเล็ก','ถุง',true);
   insert into daily_aggregate_stock_closures values('2026-10-20','closed','2026-10-20T16:48:10Z');
   insert into daily_aggregate_stock_closure_items values('2026-10-20','00000000-0000-0000-0000-000000000001',17,23,6,'counted');
  `);
  const sql = readFileSync('supabase/migrations/0107_daily_aggregate_stock.sql','utf8');
  const start=sql.indexOf('create or replace function public.get_daily_aggregate_stock_summary(');
  await db.exec(sql.slice(start,sql.indexOf('\n$$;',start)+4));
  const wrapper=readFileSync('supabase/migrations/0179_casual_loose_stock_conversion.sql','utf8');
  const ws=wrapper.indexOf('alter function public.get_daily_aggregate_stock_summary(date)');
  await db.exec(wrapper.slice(ws,wrapper.indexOf('\n$$;',ws)+4));

  const fixPath = 'supabase/migrations/0246_daily_stock_closure_read_model.sql';
  await db.exec(readFileSync(fixPath, 'utf8'));
  return db;
}
const read = async (db, date = '2026-10-20') => (await db.query('select get_daily_aggregate_stock_summary($1::date) as result', [date])).rows[0].result;

test('closed stock preserves saved items after deactivation and excludes newly added products', async (t) => {
  const db = await createDatabase(t);
  const before = await read(db);
  await db.exec("update ice_types set is_active=false; insert into ice_types values('00000000-0000-0000-0000-000000000002','02','New product','ถุง',true)");
  const after = await read(db);
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].ice_type_id, '00000000-0000-0000-0000-000000000001');
  assert.deepEqual(after.items, before.items);
  assert.equal(after.items[0].system_quantity, 17);
  assert.equal(after.items[0].actual_quantity, 23);
  assert.equal(after.items[0].variance_quantity, 6);
  assert.equal(after.items[0].available_quantity, 0);
  assert.equal(after.items[0].note, 'counted');
  assert.equal(new Date(after.closed_at).toISOString(), '2026-10-20T16:48:10.000Z');
});

test('open days keep the active catalog and existing casual-sale calculation', async (t) => {
  const db = await createDatabase(t);
  await db.exec("insert into casual_transactions values('2026-10-21','active','measured','00000000-0000-0000-0000-000000000001',4)");
  const open = await read(db, '2026-10-21');
  assert.equal(open.status, 'open');
  assert.equal(open.items.length, 1);
  assert.equal(open.items[0].sold_quantity, 4);
  assert.equal(open.items[0].actual_quantity, null);
  await db.exec('update ice_types set is_active=false');
  assert.equal((await read(db, '2026-10-21')).items.length, 0);
});

test('the closed-day path still enforces active-user authorization', async (t) => {
  const db = await createDatabase(t);
  assert.equal((await db.query("select has_function_privilege('authenticated', 'get_daily_aggregate_stock_summary_without_casual(date)', 'execute') as allowed")).rows[0].allowed, false);
  await db.exec("set test.active_user = 'false'");
  await assert.rejects(read(db), /An active user is required/);
});

test('a day closed without any count items never falls back to the active catalog', async (t) => {
  const db = await createDatabase(t);
  await db.exec('delete from daily_aggregate_stock_closure_items');
  const summary = await read(db);
  assert.equal(summary.status, 'closed');
  assert.deepEqual(summary.items, []);
});
