import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const container = `ice-event-tank-billing-${process.pid}`;
function docker(args, options = {}) { return spawnSync('docker', args, { encoding: 'utf8', ...options }); }
function psql(sql) {
  const result = docker(['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: sql });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

const admin = '10000000-0000-4000-8000-000000000001';
const today = `(clock_timestamp() at time zone 'Asia/Bangkok')::date`;
function run(sql) { return psql(`set request.jwt.claim.sub = '${admin}'; ${sql}`).replace(/^SET\n/, ''); }

try {
  const started = docker(['run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=test', 'postgres:16-alpine']);
  assert.equal(started.status, 0, started.stderr);
  for (let i = 0; i < 60; i++) {
    if (docker(['exec', container, 'pg_isready', '-U', 'postgres']).status === 0) break;
    await new Promise(r => setTimeout(r, 500));
  }
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
  for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name <= '0189_event_tank_rental_billing.sql').sort()) {
    try {
      psql(`begin; ${readFileSync(new URL(name, directory), 'utf8')} commit;`);
    } catch (error) {
      throw new Error(`${name}: ${error.message}`);
    }
  }
  console.log('All migrations through 0189 applied successfully');

  // Seed base entities
  psql(`
    set request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';
    insert into auth.users (id, email, raw_user_meta_data) values (
      '10000000-0000-4000-8000-000000000001', 'admin@example.test',
      '{"display_name":"Admin user"}'::jsonb
    );
    update public.users set is_active = true, role = 'admin'
    where id = '10000000-0000-4000-8000-000000000001';
  `);

  // Activate event ice delivery
  run(`select public.activate_event_ice_delivery();`);

  psql(`
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
    ), (
      '30000000-0000-4000-8000-000000000002', 'EV02', 'Second shop',
      '20000000-0000-4000-8000-000000000001', 'Event hall',
      '21000000-0000-4000-8000-000000000001', 'Contact 2', '0800000002',
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
  `);

  // Create published event job with participations
  const saved = JSON.parse(run(`
    select public.save_event_job(null, 'Expo 2026', 'Organizer', 'Manager', '0812345678', 'Impact Arena', ${today}, ${today} + 3, 'Test event', 100, array['cash']::public.payment_method[], 'cash', false, false, false, false, false, false);
  `));
  const jobId = saved.event_job.id;

  // Add 2 participations
  const part1 = JSON.parse(run(`
    select to_jsonb(public.save_event_participation(
      null, '${jobId}'::uuid, '30000000-0000-4000-8000-000000000001'::uuid,
      'A01', 'Food Zone', 'Near Entrance', 'Seller A', '0811111111',
      ${today}, ${today} + 3, true
    ));
  `));
  const part2 = JSON.parse(run(`
    select to_jsonb(public.save_event_participation(
      null, '${jobId}'::uuid, '30000000-0000-4000-8000-000000000002'::uuid,
      'A02', 'Food Zone', 'Near Entrance', 'Seller B', '0822222222',
      ${today}, ${today} + 3, true
    ));
  `));
  const part1Id = part1.id;
  const part2Id = part2.id;

  // Ensure price is valid for all days of the event
  run(`update public.ice_type_prices set valid_to = ${today} + 10;`);

  // Publish event job
  run(`select public.publish_event_job('${jobId}');`);

  // 1. Record event tank handoff
  const handoffReq = randomUUID();
  const handoff = JSON.parse(run(`
    select to_jsonb(public.record_event_tank_movement(
      '${part1Id}', 'handoff', 3, ${today}, 'Booth tanks', '${handoffReq}'
    ));
  `));

  assert.equal(handoff.movement_kind, 'handoff');
  assert.equal(handoff.quantity, 3);
  assert.equal(Number(handoff.rental_unit_price), 100);

  // Verify delivery_charges was automatically created
  const chargeRow = JSON.parse(run(`
    select to_jsonb(c) from public.delivery_charges c where c.event_tank_rental_id = '${handoff.id}';
  `));

  assert.ok(chargeRow.id, 'Delivery charge was created');
  assert.equal(Number(chargeRow.original_amount), 300);
  assert.equal(chargeRow.payment_term, 'end_of_day');
  assert.ok(chargeRow.charge_number, 'Charge number was assigned');
  assert.ok(chargeRow.event_settlement_context_id, 'Settlement context is linked');

  // Check charge_line_items
  const lineItems = JSON.parse(run(`select public.charge_line_items('${chargeRow.id}');`));
  assert.equal(lineItems.length, 1);
  assert.equal(lineItems[0].ice_type_name, 'ค่าเช่าถังอีเวนต์');
  assert.equal(lineItems[0].quantity, 3);
  assert.equal(Number(lineItems[0].unit_price), 100);
  assert.equal(Number(lineItems[0].line_total), 300);

  // Check build_charge_print_document (INV)
  const invoiceDoc = JSON.parse(run(`select public.build_charge_print_document('${chargeRow.id}');`));
  assert.equal(invoiceDoc.document_type, 'INV');
  assert.equal(invoiceDoc.document_number, chargeRow.charge_number);
  assert.equal(invoiceDoc.destination_kind, 'event');
  assert.equal(invoiceDoc.event_name, 'Expo 2026');
  assert.equal(invoiceDoc.event_booth, 'A01');
  assert.equal(Number(invoiceDoc.total_amount), 300);

  // 2. Test idempotency of handoff
  const handoffRetry = JSON.parse(run(`
    select to_jsonb(public.record_event_tank_movement(
      '${part1Id}', 'handoff', 3, ${today}, 'Booth tanks', '${handoffReq}'
    ));
  `));
  assert.equal(handoffRetry.id, handoff.id, 'Same request_id returns existing movement');
  const chargeCount = run(`select count(*) from public.delivery_charges where event_tank_rental_id = '${handoff.id}';`);
  assert.equal(chargeCount, '1', 'No duplicate charges created');

  // 3. Test collection queue
  const runId = randomUUID();
  run(`insert into public.collection_runs(id, service_date, opened_by) values ('${runId}', ${today}, '${admin}');`);

  let queue = JSON.parse(run(`select public.get_collection_run_queue('${runId}');`));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].destination_kind, 'event');
  assert.equal(queue[0].event_name, 'Expo 2026');
  assert.equal(queue[0].event_booth, 'A01');
  assert.equal(Number(queue[0].outstanding_amount), 300);
  assert.equal(queue[0].charges.length, 1);
  assert.equal(queue[0].charges[0].charge_id, chargeRow.id);
  assert.equal(queue[0].charges[0].items[0].ice_type_name, 'ค่าเช่าถังอีเวนต์');

  // 4. Test payment collection (record_event_payment)
  const settlementContextId = queue[0].event_settlement_context_id;
  const policyFingerprint = queue[0].settlement_policy_fingerprint;
  const paymentAllocations = JSON.stringify([{ charge_id: chargeRow.id, amount: 300 }]);

  const paymentResult = JSON.parse(run(`
    select public.record_event_payment(
      '${settlementContextId}',
      '${part1Id}',
      ${today},
      '${policyFingerprint}',
      '${paymentAllocations}',
      'cash',
      300,
      null,
      null,
      '${runId}',
      300,
      '${randomUUID()}'
    );
  `));

  assert.ok(paymentResult.payment_id, 'Payment recorded successfully');

  // Receipt snapshot test
  const receiptSnapshot = JSON.parse(run(`select public.build_payment_receipt_snapshot('${paymentResult.payment_id}');`));
  assert.equal(receiptSnapshot.document_type, 'REC');
  assert.equal(Number(receiptSnapshot.received_amount), 300);
  assert.equal(Number(receiptSnapshot.allocated_amount), 300);
  assert.equal(receiptSnapshot.charges.length, 1);
  assert.equal(receiptSnapshot.charges[0].items[0].ice_type_name, 'ค่าเช่าถังอีเวนต์');
  assert.equal(receiptSnapshot.event_name, 'Expo 2026');
  assert.equal(receiptSnapshot.event_booth, 'A01');

  // Verify queue is now cleared
  queue = JSON.parse(run(`select public.get_collection_run_queue('${runId}');`));
  assert.equal(queue.length, 0, 'Queue is cleared after payment');

  // 5. Test accounting ledger
  const ledger = JSON.parse(run(`select jsonb_agg(row) from public.accounting_transaction_rows(${today}, ${today}) row;`));
  const rentalInvoices = ledger.filter(r => r.type === 'INV' && r.details?.charge_kind === 'event_tank_rental');
  assert.equal(rentalInvoices.length, 1);
  assert.equal(Number(rentalInvoices[0].sales_amount), 300);
  assert.equal(rentalInvoices[0].ice_type_name, 'ค่าเช่าถังอีเวนต์');
  assert.equal(Number(rentalInvoices[0].quantity_out), 0, 'Ice stock is unaffected');

  // 6. Test return of tanks
  const returnHandoff = JSON.parse(run(`
    select to_jsonb(public.record_event_tank_movement(
      '${part1Id}', 'return', 1, ${today}, 'Return 1 tank', '${randomUUID()}'
    ));
  `));
  assert.equal(returnHandoff.movement_kind, 'return');
  assert.equal(returnHandoff.quantity, 1);

  // Ensure returning does not create a charge
  const returnCharges = run(`select count(*) from public.delivery_charges where event_tank_rental_id = '${returnHandoff.id}';`);
  assert.equal(returnCharges, '0', 'Return does not create a charge');

  // Over-return throws error
  assert.throws(() => run(`
    select public.record_event_tank_movement(
      '${part1Id}', 'return', 5, ${today}, 'Over return', '${randomUUID()}'
    );
  `), /เกิน/);

  // 7. Test get_event_management_detail includes charge fields
  const eventDetail = JSON.parse(run(`select public.get_event_management_detail('${jobId}');`));
  assert.equal(eventDetail.tank_movements.length, 2);
  const handoffMovement = eventDetail.tank_movements.find(m => m.movement_kind === 'handoff');
  assert.ok(handoffMovement.charge_id);
  assert.ok(handoffMovement.charge_number);
  assert.equal(Number(handoffMovement.outstanding_amount), 0, 'Fully paid');

  console.log('All event tank rental billing postgres tests PASSED!');
} finally {
  docker(['rm', '-f', container]);
}
