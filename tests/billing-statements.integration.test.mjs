import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

function migration(name) {
  return readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
}

const shopId = '20000000-0000-4000-8000-000000000001';
const runId = '30000000-0000-4000-8000-000000000001';
const oldBill = '10000000-0000-4000-8000-000000000001';
const newBill = '10000000-0000-4000-8000-000000000002';
const otherShopBill = '10000000-0000-4000-8000-000000000003';
const otherRunBill = '10000000-0000-4000-8000-000000000004';

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());
  // Minimal surrounding schema; payment/void writers, wrappers, effective
  // balances and deferred allocation constraints all use production SQL.
  await db.exec(`
    create role authenticated;
    create role anon;
    create schema auth;
    create schema storage;
    create type public.financial_record_status as enum ('active', 'voided');
    create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');
    create function auth.uid() returns uuid language sql as $$
      select '50000000-0000-4000-8000-000000000001'::uuid
    $$;
    create function public.is_active_user() returns boolean language sql as $$ select true $$;
    create function public.current_app_role() returns text language sql as $$ select coalesce(nullif(current_setting('test.role', true), ''), 'admin')::text $$;
    create function public.can_collect_shop_payments() returns boolean language sql as $$
      select coalesce(current_setting('test.can_collect', true), 'true') = 'true'
    $$;
    create function public.is_payment_visible(uuid) returns boolean language sql as $$ select coalesce(current_setting('test.visible', true), 'true') = 'true' $$;
    create function public.is_collection_run_member(uuid) returns boolean language sql as $$ select true $$;
    create function public.is_financial_charge_visible(uuid) returns boolean language sql as $$ select true $$;
    create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1, '/') $$;
    create table storage.objects (bucket_id text, name text);
    create table public.collection_runs (id uuid primary key, service_date date, status text);
    create table public.daily_aggregate_stock_closures (service_date date);
    create table public.shop_payment_profiles (
      id uuid default gen_random_uuid(), shop_id uuid,
      allowed_payment_methods public.payment_method[], allow_outstanding boolean,
      cash_reference_required boolean default false, bank_transfer_reference_required boolean default false,
      qr_reference_required boolean default false, cash_evidence_required boolean default false,
      bank_transfer_evidence_required boolean default false, qr_evidence_required boolean default false
    );
    create table public.financial_approval_requests (
      id uuid, status text, kind text, shop_id uuid, round_stop_id uuid,
      requested_by uuid, requested_amount numeric, request_fingerprint text,
      consumed_by_payment_id uuid, consumed_at timestamptz
    );
    create table public.delivery_events (id uuid, round_stop_id uuid);
    create table public.delivery_charges (
      id uuid primary key, shop_id uuid not null, payment_term text not null,
      due_date date not null, created_at timestamptz not null,
      outstanding_amount numeric(12,2) not null, status public.financial_record_status default 'active',
      collection_run_id uuid, delivery_event_id uuid, service_date date,
      event_settlement_context_id uuid
    );
    create table public.payments (
      id uuid primary key default gen_random_uuid(), status text not null default 'active',
      shop_id uuid, collection_run_id uuid, payment_method public.payment_method,
      received_amount numeric(12,2), allocated_amount numeric(12,2), change_amount numeric(12,2),
      reference_number text, evidence_path text, approval_request_id uuid,
      idempotency_key uuid unique, request_fingerprint text, recorded_by uuid,
      operation_kind text default 'regular', event_settlement_context_id uuid,
      request_fingerprint_version integer default 2
    );
    create table public.payment_allocations (
      payment_id uuid not null references public.payments(id),
      charge_id uuid not null references public.delivery_charges(id), amount numeric(12,2) not null
    );
    create table public.audit_logs (actor_id uuid, entity_type text, entity_id uuid, action text, after_value jsonb);
    create function public.is_charge_collectible_in_run(uuid, uuid)
    returns boolean language sql stable as $$
      select exists (select 1 from public.delivery_charges where id = $1 and collection_run_id = $2)
    $$;
    create function public.effective_delivery_charge_amount(uuid)
    returns numeric language sql stable as $$
      select outstanding_amount from public.delivery_charges where id = $1
    $$;
    create function public.financial_payment_response(uuid) returns jsonb language sql stable as $$
      select jsonb_build_object('payment_id', id, 'allocated_amount', allocated_amount)
      from public.payments where id = $1
    $$;
    insert into public.collection_runs values ('${runId}', (clock_timestamp() at time zone 'Asia/Bangkok')::date, 'open');
    insert into public.shop_payment_profiles (shop_id, allowed_payment_methods, allow_outstanding)
      values ('${shopId}', '{cash,bank_transfer,qr}', false);
    insert into public.delivery_charges (id, shop_id, payment_term, due_date, created_at, outstanding_amount, collection_run_id) values
      ('${oldBill}', '${shopId}', 'credit', '2026-09-29', '2026-09-29 08:00:00+07', 50, '${runId}'),
      ('${newBill}', '${shopId}', 'credit', '2026-09-30', '2026-09-30 08:00:00+07', 75, '${runId}'),
      ('${otherShopBill}', '20000000-0000-4000-8000-000000000002', 'credit', '2026-09-30', '2026-09-30 09:00:00+07', 20, '${runId}'),
      ('${otherRunBill}', '${shopId}', 'credit', '2026-09-30', '2026-09-30 10:00:00+07', 10, null);
  `);
  await db.exec(migration('0130_effective_charge_payments'));
  const automaticContext = migration('0159_automatic_collection_context_authorization');
  await db.exec(automaticContext.slice(
    automaticContext.indexOf('alter function public.record_payment('),
    automaticContext.indexOf('alter function public.void_payment('),
  ));
  const eventContext = migration('0171_event_ice_delivery_financial_closeout');
  await db.exec(eventContext.slice(
    eventContext.indexOf('create or replace function public.financial_payment_request_fingerprint_v2('),
    eventContext.indexOf('create or replace function public.record_event_payment('),
  ));

  await db.exec(`
    create table public.users (id uuid primary key, display_name text);
    insert into public.users values ('50000000-0000-4000-8000-000000000001', 'Admin');
    create table public.shops (id uuid primary key, code text, name text, building_id uuid, zone_id uuid, image_path text);
    insert into public.shops(id, code, name) values ('${shopId}', 'TEST', 'Test');
    create table public.buildings(id uuid primary key, name text);
    create table public.building_zones(id uuid primary key, name text);
    create table public.round_stops(id uuid primary key, round_id uuid, event_job_name_snapshot text,
      event_location_snapshot text, event_zone_snapshot text, event_booth_snapshot text);
    create table public.delivery_rounds(id uuid, status text, service_date date);
    create table public.daily_stock_closures(service_date date, status text);
    create table public.event_jobs(id uuid primary key, name text, location text);
    create table public.event_participations(id uuid primary key, event_job_id uuid, event_zone text, booth_number text,
      allowed_payment_methods_snapshot public.payment_method[], default_payment_method_snapshot public.payment_method,
      cash_reference_required_snapshot boolean, cash_evidence_required_snapshot boolean,
      bank_transfer_reference_required_snapshot boolean, bank_transfer_evidence_required_snapshot boolean,
      qr_reference_required_snapshot boolean, qr_evidence_required_snapshot boolean);
    create table public.event_settlement_contexts(id uuid primary key, event_participation_id uuid,
      service_date date, settlement_policy_fingerprint text);
    create table public.refund_obligations(payment_id uuid, source_charge_id uuid, amount numeric, status text);
    create table public.payment_allocation_changes(payment_id uuid);
    create table public.delivery_charge_adjustments(charge_id uuid, amount_delta numeric, status text);
    alter table public.daily_aggregate_stock_closures add status text default 'closed';
    alter table public.shop_payment_profiles add primary key(id), add default_payment_method public.payment_method;
    alter table public.payments add recorded_at timestamptz default now(), add voided_at timestamptz,
      add voided_by uuid, add void_reason text;
    alter table public.delivery_charges add original_amount numeric, add charge_number text;
    delete from public.delivery_charges where id in ('${otherShopBill}', '${otherRunBill}');
    update public.delivery_charges set original_amount = outstanding_amount,
      service_date = (clock_timestamp() at time zone 'Asia/Bangkok')::date,
      due_date = (clock_timestamp() at time zone 'Asia/Bangkok')::date;
    create function public.charge_line_items(uuid) returns jsonb language sql as $$ select '[]'::jsonb $$;
  `);
  const corrections = migration('0128_delivery_corrections_refunds_and_adjustments');
  await db.exec(corrections.slice(
    corrections.indexOf('create function public.effective_delivery_charge_amount('),
    corrections.indexOf('create or replace function public.assert_payment_allocation_integrity('),
  ).replace('create function', 'create or replace function'));
  await db.exec(corrections.slice(
    corrections.indexOf('create or replace function public.assert_charge_allocation_integrity('),
    corrections.indexOf('create function public.get_delivery_correction_context('),
  ));
  await db.exec(corrections.slice(
    corrections.indexOf('create or replace function public.void_payment('),
    corrections.indexOf('revoke all on function public.protect_append_only_financial_history('),
  ));
  await db.exec(automaticContext.slice(
    automaticContext.indexOf('alter function public.void_payment('),
    automaticContext.indexOf('alter function public.close_daily_aggregate_stock('),
  ));
  await db.exec(eventContext.slice(
    eventContext.indexOf('create or replace function public.assert_payment_allocation_integrity('),
    eventContext.indexOf('create or replace function public.enable_event_ice_delivery_pilot('),
  ));
  const foundation = migration('0029_pos_financial_foundation');
  await db.exec(foundation.slice(
    foundation.indexOf('create constraint trigger payments_allocation_integrity'),
    foundation.indexOf('create or replace function public.assert_financial_approval_integrity('),
  ));
  await db.exec(migration('0198_allow_selected_credit_bill_payments'));
  await db.exec(migration('0199_credit_billing_statements'));
  return db;
}


const requestKey = (key) => `40000000-0000-4000-8000-${String(key).padStart(12, '0')}`;

async function issue(db, bills = [newBill]) {
  return (await db.query('select public.create_billing_statement($1, $2::uuid[]) as result', [shopId, bills])).rows[0].result;
}

async function pay(db, { statement, bill = newBill, amount = 25, expected = 75, key = 1, legacy = false } = {}) {
  const args = [statement ?? shopId, JSON.stringify([{ charge_id: bill, amount }]), amount, runId, expected, requestKey(key)];
  const fn = statement ? 'record_billing_statement_payment' : legacy ? 'record_payment' : 'record_regular_collection_payment';
  return (await db.query(`select public.${fn}($1::uuid, $2::jsonb, 'cash', $3::numeric, null, null,
    $4::uuid, $5::numeric, ${statement ? '' : 'null, '}$6::uuid) as result`, args)).rows[0].result;
}

async function queue(db) {
  return (await db.query('select public.get_collection_run_queue($1) as queue', [runId])).rows[0].queue;
}

async function voidStatement(db, id) {
  await db.query('select public.void_billing_statement($1, $2)', [id, 'Reissue after correction']);
}

async function voidPayment(db, id) {
  await db.query('select public.void_payment($1, $2)', [id, 'Correct payment']);
}

test('statement retries return the original payment after balance changes, voiding and run closure', async (t) => {
  const db = await createDatabase(t);
  const statement = await issue(db);
  const args = { statement: statement.id };
  const recorded = await pay(db, args);
  assert.deepEqual(await pay(db, args), recorded);
  await assert.rejects(pay(db, { ...args, amount: 20 }), /idempotency key.*different payment/i);
  await assert.rejects(pay(db, { ...args, expected: 50 }), /idempotency key.*different payment/i);
  await db.exec("set test.visible = 'false'");
  await assert.rejects(pay(db, args), /cannot be viewed/i);
  await db.exec("set test.visible = 'true'");
  await voidStatement(db, statement.id);
  const replacement = await issue(db);
  await assert.rejects(pay(db, { statement: replacement.id, expected: 50 }), /idempotency key.*different payment/i);
  await db.exec(`update collection_runs set status = 'closed'`);
  assert.deepEqual(await pay(db, args), recorded);
  assert.equal((await db.query('select count(*)::int as count from payments')).rows[0].count, 1);
});

test('regular retries survive new statements and reject cross-route key reuse', async (t) => {
  const db = await createDatabase(t);
  const args = { bill: oldBill, expected: 125 };
  const recorded = await pay(db, args);
  assert.deepEqual(await pay(db, args), recorded);
  await issue(db, [oldBill]);
  assert.deepEqual(await pay(db, args), recorded);
  await assert.rejects(pay(db, { ...args, legacy: true }), /idempotency key.*different payment/i);
  await assert.rejects(pay(db, { ...args, expected: 100 }), /idempotency key.*different payment/i);
});

test('public legacy and regular RPCs cannot pay active statement bills; private writer is inaccessible', async (t) => {
  const db = await createDatabase(t);
  const statement = await issue(db);
  await assert.rejects(pay(db, { legacy: true, expected: 125 }), /billing.statement.*queue/i);
  await assert.rejects(pay(db, { expected: 50 }), /billing.statement.*queue/i);
  const grants = await db.query(`select has_function_privilege('authenticated',
    'public.record_payment_before_billing_statements(uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid)',
    'EXECUTE') as allowed`);
  assert.equal(grants.rows[0].allowed, false);
  const recorded = await pay(db, { statement: statement.id });
  assert.equal((await db.query('select billing_statement_id from payments where id=$1', [recorded.payment_id])).rows[0].billing_statement_id, statement.id);
  await voidStatement(db, statement.id);
  await pay(db, { legacy: true, expected: 100, key: 2 });
});

test('pre-statement payment void requires void/reissue and never leaves an unpayable queue', async (t) => {
  const db = await createDatabase(t);
  const earlier = await pay(db, { legacy: true, expected: 125 });
  const statement = await issue(db);
  assert.equal(Number(statement.total_amount), 50);
  await assert.rejects(voidPayment(db, earlier.payment_id), /void.*billing statement.*first/i);
  assert.equal(Number((await queue(db)).find(row => row.billing_statement_id === statement.id).outstanding_amount), 50);
  await voidStatement(db, statement.id);
  await voidPayment(db, earlier.payment_id);
  const replacement = await issue(db);
  assert.equal(Number(replacement.total_amount), 75);
  await pay(db, { statement: replacement.id, amount: 75, expected: 75, key: 2 });
  assert.equal((await queue(db)).some(row => row.billing_statement_id === replacement.id), false);
});

test('statement payments can be voided; bill changes require void/reissue', async (t) => {
  const db = await createDatabase(t);
  const statement = await issue(db);
  const recorded = await pay(db, { statement: statement.id });
  await voidPayment(db, recorded.payment_id);
  assert.equal(Number((await queue(db)).find(row => row.billing_statement_id === statement.id).outstanding_amount), 75);
  await assert.rejects(db.query('update delivery_charges set original_amount=100 where id=$1', [newBill]), /void.*billing statement.*first/i);
  await assert.rejects(db.query("insert into delivery_charge_adjustments values ($1, 25, 'active')", [newBill]), /void.*billing statement.*first/i);
  await assert.rejects(db.query("update delivery_charges set status='voided' where id=$1", [newBill]), /void.*billing statement.*first/i);
  await voidStatement(db, statement.id);
  await db.query('update delivery_charges set original_amount=100 where id=$1', [newBill]);
  const replacement = await issue(db);
  assert.equal(Number(replacement.total_amount), 100);
});

test('future bills keep due dates, queues stay separate, and roles and allocation guards remain enforced', async (t) => {
  const db = await createDatabase(t);
  await db.query("update delivery_charges set due_date=due_date+3 where id=$1", [newBill]);
  const dueDate = (await db.query('select due_date::text as due_date from delivery_charges where id=$1', [newBill])).rows[0].due_date;
  assert.equal((await queue(db)).length, 1);
  await db.exec("set test.role = 'courier'");
  await assert.rejects(issue(db), /only an admin/i);
  await db.exec("set test.role = 'admin'");
  const statement = await issue(db);
  assert.equal((await queue(db)).length, 2);
  await assert.rejects(issue(db), /already on an active/i);
  await assert.rejects(pay(db, { statement: statement.id, bill: oldBill }), /outside the billing statement/i);
  await assert.rejects(pay(db, { statement: statement.id, amount: 76 }), /exceed the latest charge balance/i);
  await assert.rejects(pay(db, { statement: statement.id, expected: 70 }), /outstanding changed/i);
  await db.exec("set test.can_collect = 'false'");
  await assert.rejects(pay(db, { statement: statement.id }), /cannot collect/i);
  await db.exec("set test.can_collect = 'true'; set test.role = 'courier'");
  await assert.rejects(voidStatement(db, statement.id), /only an admin/i);
  await pay(db, { statement: statement.id });
  await pay(db, { bill: oldBill, amount: 50, expected: 50, key: 2 });
  const remaining = await queue(db);
  assert.equal(remaining.length, 1);
  assert.equal(Number(remaining[0].outstanding_amount), 50);
  assert.equal((await db.query('select due_date::text as due_date from delivery_charges where id=$1', [newBill])).rows[0].due_date, dueDate);
  await db.exec("set test.role = 'admin'");
  await voidStatement(db, statement.id);
  assert.equal((await queue(db)).length, 0);
});


test('legacy replay and immediate delivery payments keep their existing behavior', async (t) => {
  const db = await createDatabase(t);
  const args = { legacy: true, expected: 125 };
  const original = await pay(db, args);
  await issue(db);
  assert.deepEqual(await pay(db, args), original);
  await db.query("update delivery_charges set payment_term='immediate' where id=$1", [oldBill]);
  const immediate = await db.query(`select public.record_payment($1, $2::jsonb, 'cash', 50,
    null, null, null, 50, null, $3) as result`,
  [shopId, JSON.stringify([{ charge_id: oldBill, amount: 50 }]), requestKey(2)]);
  assert.equal(Number(immediate.rows[0].result.allocated_amount), 50);
});

test('authenticated callers can collect but cannot invoke the private collection boundary', async (t) => {
  const db = await createDatabase(t);
  const statement = await issue(db);
  await db.exec("set role authenticated; set test.role = 'courier'");
  await assert.rejects(pay(db, { legacy: true, expected: 125 }), /billing.statement.*queue/i);
  await assert.rejects(db.query(`select public.record_collection_payment_for_billing(
    $1, $2, $3::jsonb, 'cash', 25, null, null, $4, 75, $5)`,
  [shopId, statement.id, JSON.stringify([{ charge_id: newBill, amount: 25 }]), runId, requestKey(1)]), /permission denied/i);
  const recorded = await pay(db, { statement: statement.id });
  assert.deepEqual(await pay(db, { statement: statement.id }), recorded);
});

test('statement payment reversals cannot invalidate a later replacement statement', async (t) => {
  const db = await createDatabase(t);
  const first = await issue(db);
  const recorded = await pay(db, { statement: first.id });
  await voidStatement(db, first.id);
  const replacement = await issue(db);
  await assert.rejects(voidPayment(db, recorded.payment_id), /void.*billing statement.*first/i);
  assert.equal(Number((await queue(db)).find(row => row.billing_statement_id === replacement.id).outstanding_amount), 50);
  await pay(db, { statement: replacement.id, amount: 50, expected: 50, key: 2 });
});

test('regular and statement balances exclude separate event collections for the same shop', async (t) => {
  const db = await createDatabase(t);
  const statement = await issue(db);
  await db.exec(`
    insert into event_settlement_contexts(id, service_date)
      values ('70000000-0000-4000-8000-000000000001', (clock_timestamp() at time zone 'Asia/Bangkok')::date);
    insert into delivery_charges(id, shop_id, payment_term, due_date, created_at, service_date,
      outstanding_amount, original_amount, event_settlement_context_id)
    values ('${otherRunBill}', '${shopId}', 'end_of_day',
      (clock_timestamp() at time zone 'Asia/Bangkok')::date, now(),
      (clock_timestamp() at time zone 'Asia/Bangkok')::date, 10, 10,
      '70000000-0000-4000-8000-000000000001');
  `);
  await pay(db, { bill: oldBill, amount: 50, expected: 50 });
  await pay(db, { statement: statement.id, amount: 75, expected: 75, key: 2 });
  const remaining = await queue(db);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].destination_kind, 'event');
  assert.equal(Number(remaining[0].outstanding_amount), 10);
});
