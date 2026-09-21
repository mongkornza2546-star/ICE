import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const container = `ice-shop-rentals-${process.pid}`;
function docker(args, options = {}) { return spawnSync('docker', args, { encoding: 'utf8', ...options }); }
function psql(sql) {
  const result = docker(['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: sql });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
const admin = '10000000-0000-4000-8000-000000000001';
const shop = '30000000-0000-4000-8000-000000000001';
const today = `(clock_timestamp() at time zone 'Asia/Bangkok')::date`;
function run(sql) { return psql(`set request.jwt.claim.sub = '${admin}'; ${sql}`).replace(/^SET\n/, ''); }
try {
  const started = docker(['run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=test', 'postgres:16-alpine']);
  assert.equal(started.status, 0, started.stderr);
  for (let i = 0; i < 60; i++) { if (docker(['exec', container, 'pg_isready', '-U', 'postgres']).status === 0) break; await new Promise(r => setTimeout(r, 500)); }
  await new Promise(r => setTimeout(r, 1000));
  psql(`
    drop schema public cascade;
    drop schema if exists auth cascade;
    drop schema if exists storage cascade;
    create schema public;
    create schema auth;
    create schema storage;
    do $$ begin create role anon; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role; exception when duplicate_object then null; end $$;
    create table auth.users (
      id uuid primary key,
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null references storage.buckets(id),
      name text not null,
      metadata jsonb,
      unique (bucket_id, name)
    );
    create function storage.foldername(text) returns text[] language sql immutable as $$
      select string_to_array($1, '/')
    $$;
    alter table storage.objects enable row level security;
    create publication supabase_realtime;
  `);
  const directory = new URL('../supabase/migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name <= '0188_shop_one_time_tank_rentals.sql').sort()) {
    try { psql(`begin; ${readFileSync(new URL(name, directory), 'utf8')} commit;`); }
    catch (error) { throw new Error(`${name}: ${error.message}`); }
  }
  console.log('All migrations through 0188 applied');
  psql(`
    set request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';
    insert into auth.users (id, email, raw_user_meta_data) values (
      '10000000-0000-4000-8000-000000000001', 'admin@example.test',
      '{"display_name":"Event admin"}'::jsonb
    );
    update public.users set is_active = true, role = 'admin'
    where id = '10000000-0000-4000-8000-000000000001';

    set session_replication_role = replica;
    insert into public.buildings (id, code, name) values (
      '20000000-0000-4000-8000-000000000001', 'EVT', 'Event building'
    );
    set session_replication_role = origin;
    insert into public.building_zones (id, building_id, code, name) values (
      '21000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001', 'HALL', 'Event hall'
    );
    insert into public.stock_locations (
      id, code, name, kind, assigned_user_id, is_active,
      holds_inventory, requires_daily_count
    ) values (
      '22000000-0000-4000-8000-000000000001', 'EVENT-HOLD',
      'Event holding', 'team', '10000000-0000-4000-8000-000000000001',
      true, true, false
    );
    set session_replication_role = replica;
    insert into public.shops (
      id, code, name, building_id, floor_or_zone, zone_id,
      contact_name, contact_phone, stock_location_id
    ) values (
      '30000000-0000-4000-8000-000000000001', 'EV01', 'Event shop',
      '20000000-0000-4000-8000-000000000001', 'Event hall',
      '21000000-0000-4000-8000-000000000001', 'Contact', '0800000000',
      '22000000-0000-4000-8000-000000000001'
    );
    set session_replication_role = origin;
    insert into public.ice_types (id, code, name, unit) values (
      '40000000-0000-4000-8000-000000000001', 'ICE-E', 'Event ice', 'bag'
    );
    insert into public.ice_type_prices (
      id, ice_type_id, unit_price, valid_from, created_by
    ) values (
      '41000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001', 25,
      (clock_timestamp() at time zone 'Asia/Bangkok')::date,
      '10000000-0000-4000-8000-000000000001'
    );
    insert into public.delivery_rounds (
      id, service_date, name, round_type, status, opened_by
    ) values (
      '50000000-0000-4000-8000-000000000001',
      (clock_timestamp() at time zone 'Asia/Bangkok')::date,
      'งานประจำวัน', 'daily', 'open',
      '10000000-0000-4000-8000-000000000001'
    );
  `);
  run(`insert into public.shop_payment_profiles(shop_id, allowed_payment_terms, default_payment_term, allowed_payment_methods, default_payment_method, created_by)
    values('${shop}', array['end_of_day']::public.payment_term[], 'end_of_day', array['cash']::public.payment_method[], 'cash', '${admin}');`);
  const request = randomUUID();
  const create = (key = request, count = 3) => run(`select public.create_shop_tank_rental('${shop}', ${count}, 100, ${today}, ${today} + 2, 'Rental test', '${key}');`);
  const rental = create();
  assert.equal(create(), rental, 'creation retry is idempotent');
  assert.throws(() => create(request, 2), /different input/);
  const rows = JSON.parse(run(`select public.get_shop_tank_rentals('${shop}');`));
  assert.equal(rows.length, 1); assert.equal(rows[0].outstanding_quantity, 3); assert.equal(rows[0].total_amount, 300);
  const charge = run(`select id from public.delivery_charges where tank_rental_id = '${rental}';`);
  const invoice = JSON.parse(run(`select public.get_charge_print_document('${charge}');`));
  assert.equal(invoice.items[0].ice_type_name, 'ค่าเช่าถังรายครั้ง'); assert.equal(invoice.total_amount, 300);
  assert.equal(invoice.shop_name, 'Event shop');
  const runId = randomUUID();
  run(`insert into public.collection_runs(id, service_date, opened_by) values('${runId}', ${today}, '${admin}');`);
  let queue = JSON.parse(run(`select public.get_collection_run_queue('${runId}');`));
  assert.equal(queue[0].outstanding_amount, 300); assert.equal(queue[0].charges[0].items[0].quantity, 3);
  const retRequest = randomUUID();
  const returnSql = `select public.return_shop_tank_rental('${rental}', 1, ${today}, '${retRequest}');`;
  assert.equal(run(returnSql), run(returnSql));
  assert.throws(() => run(`select public.return_shop_tank_rental('${rental}', 3, ${today}, '${randomUUID()}');`), /จำนวนคืนเกิน/);
  assert.throws(() => run(`select public.return_shop_tank_rental('${rental}', 1, ${today} - 1, '${randomUUID()}');`), /วันรับคืน/);
  const payment = JSON.parse(run(`select public.record_payment('${shop}', '[{"charge_id":"${charge}","amount":300}]', 'cash', 300, null, null, '${runId}', 300, null, '${randomUUID()}');`));
  const receipt = JSON.parse(run(`select public.get_payment_receipt_snapshot('${payment.payment_id}');`));
  assert.equal(receipt.charges.length, 1); assert.equal(receipt.charges[0].items[0].ice_type_name, 'ค่าเช่าถังรายครั้ง');
  assert.equal(receipt.allocated_amount, 300);
  queue = JSON.parse(run(`select public.get_collection_run_queue('${runId}');`)); assert.equal(queue.length, 0);
  const ledger = JSON.parse(run(`select jsonb_agg(row) from public.accounting_transaction_rows(${today}, ${today}) row;`));
  assert.equal(ledger.filter(row => row.type === 'INV').reduce((n,row)=>n+row.sales_amount,0),300);
  assert.equal(ledger.reduce((n,row)=>n+row.receivable_delta,0),0);
  run(`select public.return_shop_tank_rental('${rental}', 2, ${today}, '${randomUUID()}');`);
  const finished = JSON.parse(run(`select public.get_shop_tank_rentals('${shop}');`))[0];
  assert.equal(finished.outstanding_quantity,0); assert.equal(finished.outstanding_amount,0); assert.equal(finished.returns.length,2);
  assert.equal(run(`select count(*) from public.delivery_events;`), '0');
  // Mix a real ice invoice with a new rental in the same shop payment.
  const mixedRental = create(randomUUID(), 2);
  const mixedCharge = run(`select id from public.delivery_charges where tank_rental_id = '${mixedRental}';`);
  const stop = randomUUID(), event = randomUUID(), iceCharge = randomUUID();
  run(`begin;
    insert into public.round_stops(id, round_id, shop_id, shop_code_snapshot, shop_name_snapshot,
      building_id_snapshot, building_name_snapshot, floor_or_zone_snapshot, sequence_no, updated_by)
    values('${stop}', '50000000-0000-4000-8000-000000000001', '${shop}', 'EV01', 'Event shop',
      '20000000-0000-4000-8000-000000000001', 'Event building', 'Event hall', 1, '${admin}');
    insert into public.delivery_events(id, round_stop_id, recorded_by, idempotency_key)
      values('${event}', '${stop}', '${admin}', '${randomUUID()}');
    insert into public.delivery_items(delivery_event_id, ice_type_id, quantity, unit_price, price_source, price_source_id)
      values('${event}', '40000000-0000-4000-8000-000000000001', 2, 25, 'standard', '41000000-0000-4000-8000-000000000001');
    insert into public.delivery_charges(id, delivery_event_id, shop_id, service_date, payment_term, original_amount)
      values('${iceCharge}', '${event}', '${shop}', ${today}, 'end_of_day', 50);
    commit;`);
  const mixedQueue = JSON.parse(run(`select public.get_collection_run_queue('${runId}');`));
  assert.equal(mixedQueue.length, 1); assert.equal(mixedQueue[0].outstanding_amount, 250);
  assert.equal(mixedQueue[0].charges.length, 2);
  const mixedPayment = JSON.parse(run(`select public.record_payment('${shop}',
    '[{"charge_id":"${mixedCharge}","amount":200},{"charge_id":"${iceCharge}","amount":50}]',
    'cash', 250, null, null, '${runId}', 250, null, '${randomUUID()}');`));
  const mixedReceipt = JSON.parse(run(`select public.get_payment_receipt_snapshot('${mixedPayment.payment_id}');`));
  assert.equal(mixedReceipt.charges.length, 2);
  assert.deepEqual(mixedReceipt.charges.flatMap(row => row.items.map(item => item.ice_type_name)).sort(), ['Event ice', 'ค่าเช่าถังรายครั้ง'].sort());
  assert.equal(mixedReceipt.allocated_amount, 250);
  assert.equal(run(`select count(*) from public.get_payment_receipt_items('${mixedPayment.payment_id}');`), '2');
  const mixedLedger = JSON.parse(run(`select jsonb_agg(row) from public.accounting_transaction_rows(${today}, ${today}) row;`));
  assert.equal(mixedLedger.reduce((n,row) => n + row.receivable_delta, 0), 0);
  assert.equal(mixedLedger.filter(row=>row.type==='INV').reduce((n,row)=>n+row.sales_amount,0),550);
  assert.equal(mixedLedger.filter(row=>row.type==='INV').reduce((n,row)=>n+row.quantity_out,0),2);
  // Payment void restores the receivable, while returning tanks never changes it.
  run(`select public.void_payment('${mixedPayment.payment_id}', 'Test void');`);
  assert.equal(JSON.parse(run(`select public.get_collection_run_queue('${runId}');`))[0].outstanding_amount,250);
  assert.throws(() => run(`select public.create_shop_tank_rental('${shop}', 1, 100, ${today}+1, ${today}+2, '', '${randomUUID()}');`), /ตรวจสอบ/);
  assert.throws(() => run(`select public.create_shop_tank_rental('${shop}', 1, -1, ${today}, ${today}+2, '', '${randomUUID()}');`), /ตรวจสอบ/);
  assert.equal(run(`select has_table_privilege('authenticated','public.shop_tank_rentals','INSERT');`),'f');
  assert.equal(run(`select has_function_privilege('anon','public.create_shop_tank_rental(uuid,integer,numeric,date,date,text,uuid)','EXECUTE');`),'f');
  run(`update public.users set role = 'courier' where id = '${admin}';`);
  assert.throws(() => create(randomUUID()), /เฉพาะแอดมิน/);
  assert.throws(() => run(`select public.return_shop_tank_rental('${rental}', 1, ${today}, '${randomUUID()}');`), /เฉพาะแอดมิน/);
  console.log('Rental creation, retries, permissions, partial returns, invoice, collection, receipt and ledger passed');
} finally { docker(['rm', '-f', container]); }
