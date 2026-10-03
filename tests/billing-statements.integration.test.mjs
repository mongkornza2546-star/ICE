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

async function createDatabase(t, { applyDateFix = true } = {}) {
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
  await db.exec(migration('0202_admin_backdated_collection_payments'));
  await db.exec(migration('0110_payment_receipt_numbers'));
  const numbering = migration('0134_monthly_sales_documents_and_atomic_immediate_sales');
  await db.exec(numbering.slice(0, numbering.indexOf('alter table public.delivery_charges')));
  await db.exec(numbering.slice(numbering.indexOf('create or replace function public.assign_payment_receipt_number()'), numbering.indexOf('-- Receipt snapshots')));
  await db.exec(`
    create table public.ice_types(id uuid, code text, name text, unit text);
    create table public.delivery_items(delivery_event_id uuid, ice_type_id uuid, quantity numeric, line_total numeric);
    alter table public.event_settlement_contexts add shop_id uuid;
  `);
  await db.exec(migration('0124_payment_receipt_snapshots'));
  await db.exec(numbering.slice(numbering.indexOf('create or replace function public.get_payment_receipt_snapshot('), numbering.indexOf('create table public.delivery_charge_document_snapshots')));
  await db.exec(migration('0182_payment_history_shop_image_and_location'));
  const projections = migration('0129_effective_charge_projections');
  await db.exec(projections.slice(projections.indexOf('create or replace function public.get_credit_receivable_detail('),
    projections.indexOf('revoke all on function public.stock_balance_at(')));
  const accounting = migration('0144_accounting_all_active_shops');
  await db.exec(accounting.slice(accounting.indexOf('create or replace function public.get_accounting_shop_invoice_detail(')));
  const eventWriter = migration('0191_allow_event_carry_forward_collections');
  await db.exec(eventWriter.slice(eventWriter.indexOf('create or replace function public.record_event_payment(')));
  if (applyDateFix) await db.exec(migration('0204_payment_date_presentation_and_replay'));
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


async function backdate(db, { date, statement, key = 1, method = 'cash', evidence = null, amount = 25 } = {}) {
  return (await db.query(`select public.record_backdated_collection_payment($1, $2::date, $3::jsonb) as result`, [
    statement ? 'record_billing_statement_payment' : 'record_regular_collection_payment', date,
    JSON.stringify({
      p_shop_id: shopId, p_billing_statement_id: statement,
      p_allocations: [{ charge_id: newBill, amount }], p_payment_method: method,
      p_received_amount: amount, p_evidence_path: evidence, p_collection_run_id: runId,
      p_expected_outstanding_amount: statement ? 75 : 125, p_idempotency_key: requestKey(key),
    }),
  ])).rows[0].result;
}

for (const withStatement of [false, true]) {
  test(`admin backdating preserves entry time, receipt date, and retry identity (statement: ${withStatement})`, async (t) => {
    const db = await createDatabase(t);
    const statement = withStatement ? (await issue(db)).id : undefined;
    const date = (await db.query("select ((clock_timestamp() at time zone 'Asia/Bangkok')::date - 1)::text as date")).rows[0].date;
    const args = { date, statement };
    const result = await backdate(db, args);
    const row = (await db.query(`select entered_at, recorded_at, received_date_override::text,
      (recorded_at at time zone 'Asia/Bangkok')::date::text as received_day,
      (entered_at at time zone 'Asia/Bangkok')::date = (clock_timestamp() at time zone 'Asia/Bangkok')::date as entered_today,
      receipt_number from payments where id=$1`, [result.payment_id])).rows[0];
    assert.equal(row.received_day, date);
    assert.equal(row.received_date_override, date);
    assert.equal(row.entered_today, true);
    assert.ok(new Date(row.entered_at) > new Date(row.recorded_at));
    assert.ok(row.receipt_number.startsWith(`REC${date.slice(2, 7).replaceAll('-', '')}-`));
    const snapshot = (await db.query('select receipt_data from payment_receipt_snapshots where payment_id=$1', [result.payment_id])).rows[0].receipt_data;
    assert.equal(new Date(snapshot.recorded_at).getTime(), new Date(row.recorded_at).getTime());
    assert.equal(snapshot.received_date_override, date);
    assert.equal(new Date(snapshot.entered_at).getTime(), new Date(row.entered_at).getTime());
    const history = (await db.query('select public.get_payment_history($1::date, $1::date) as result', [date])).rows[0].result;
    assert.equal(history.items[0].received_date_override, date);
    assert.equal(new Date(history.items[0].entered_at).getTime(), new Date(row.entered_at).getTime());
    assert.deepEqual(await backdate(db, args), result);
    await assert.rejects(pay(db, { statement, expected: withStatement ? 75 : 125 }), /different received date/i);
    await assert.rejects(backdate(db, { ...args, date: '2020-01-01' }), /different received date/i);
    await assert.rejects(backdate(db, { ...args, amount: 20 }), /different payment/i);
    assert.equal((await db.query('select count(*)::int as count from payments')).rows[0].count, 1);
    // The transaction-local override must not leak into later ordinary entries.
    await pay(db, { bill: oldBill, expected: withStatement ? 50 : 100, key: 2 });
    const ordinary = (await db.query('select received_date_override, recorded_at, entered_at from payments where idempotency_key=$1', [requestKey(2)])).rows[0];
    assert.equal(ordinary.received_date_override, null);
    assert.ok(Math.abs(new Date(ordinary.entered_at) - new Date(ordinary.recorded_at)) < 5000);
  });
}

test('backdating rejects non-admin API calls, future dates and missing required slips', async (t) => {
  const db = await createDatabase(t);
  const date = '2020-01-01';
  await db.exec('set role authenticated');
  for (const role of ['round_lead', 'courier']) {
    await db.query("select set_config('test.role', $1, false)", [role]);
    await assert.rejects(backdate(db, { date }), /เฉพาะแอดมิน/);
  }
  await db.exec("set test.role = 'admin'");
  for (const invalid of [null, 'infinity', '-infinity', '9999-12-31']) {
    await assert.rejects(backdate(db, { date: invalid }), /ก่อนวันนี้/);
  }
  await db.exec('reset role');
  await db.exec('update shop_payment_profiles set bank_transfer_evidence_required=true');
  await assert.rejects(backdate(db, { date, method: 'bank_transfer' }), /evidence is required/i);
  await assert.rejects(backdate(db, { date, method: 'bank_transfer', evidence: 'missing/slip.jpg' }), /evidence does not exist/i);
  await db.exec("set test.can_collect = 'false'");
  await assert.rejects(backdate(db, { date }), /cannot collect/i);
  await db.exec("set test.can_collect = 'true'");
  const evidence = '50000000-0000-4000-8000-000000000001/slip.jpg';
  await db.query("insert into storage.objects values ('payment-evidence', $1)", [evidence]);
  await backdate(db, { date, method: 'bank_transfer', evidence });
  assert.equal((await db.query('select count(*)::int as count from payments')).rows[0].count, 1);
});


test('backdated event collection retains settlement context and enforces its policy', async (t) => {
  const db = await createDatabase(t);
  const contextId = '70000000-0000-4000-8000-000000000001';
  const participationId = '80000000-0000-4000-8000-000000000001';
  const date = (await db.query("select ((clock_timestamp() at time zone 'Asia/Bangkok')::date - 1)::text as date")).rows[0].date;
  await db.query("insert into event_participations(id, allowed_payment_methods_snapshot) values ($1, '{cash}')", [participationId]);
  await db.query(`insert into event_settlement_contexts(id, event_participation_id, service_date, settlement_policy_fingerprint, shop_id)
    values ($1, $2, $3, 'policy-1', $4)`, [contextId, participationId, date, shopId]);
  await db.query('update delivery_charges set event_settlement_context_id=$1 where id=$2', [contextId, newBill]);
  const args = {
    p_expected_settlement_context_id: contextId, p_expected_participation_id: participationId,
    p_expected_service_date: date, p_expected_policy_fingerprint: 'policy-1',
    p_allocations: [{ charge_id: newBill, amount: 75 }], p_payment_method: 'cash',
    p_received_amount: 75, p_collection_run_id: runId, p_expected_outstanding_amount: 75,
    p_idempotency_key: requestKey(1),
  };
  const call = (payload = args, receivedDate = date) => db.query(`select public.record_backdated_collection_payment(
    'record_event_payment', $1::date, $2::jsonb) as result`, [receivedDate, JSON.stringify(payload)]);
  await assert.rejects(call({ ...args, p_expected_policy_fingerprint: 'stale' }), /context changed/i);
  await assert.rejects(call({ ...args, p_payment_method: 'bank_transfer' }), /not allowed/i);
  const result = await call();
  assert.deepEqual((await call()).rows, result.rows);
  await assert.rejects(db.query(`select public.record_event_payment($1, $2, $3::date, $4, $5::jsonb, 'cash', 75, null, null, $6, 75, $7)`, [contextId, participationId, date, 'policy-1', JSON.stringify(args.p_allocations), runId, requestKey(1)]), /different received date/i);
  await assert.rejects(call(args, '2020-01-01'), /different received date/i);
  const row = (await db.query('select operation_kind, event_settlement_context_id, received_date_override::text from payments')).rows[0];
  assert.deepEqual(row, { operation_kind: 'event', event_settlement_context_id: contextId, received_date_override: date });
});


test('ordinary and historical retries remain valid, but cannot switch to an explicit received date', async (t) => {
  const db = await createDatabase(t);
  const args = { amount: 25, expected: 125 };
  const ordinary = await pay(db, args);
  await assert.rejects(backdate(db, { date: '2020-01-01' }), /different received date/i);
  // Simulate a replay after the original receipt day. A missing override means
  // ordinary mode, not a comparison against the server's new calendar day.
  await db.query("update payments set recorded_at='2020-01-01 10:00:00+07' where id=$1", [ordinary.payment_id]);
  assert.equal((await pay(db, args)).payment_id, ordinary.payment_id);
  const grants = await db.query("select has_function_privilege('authenticated', 'public.financial_payment_write_response(uuid)', 'EXECUTE') as allowed");
  assert.equal(grants.rows[0].allowed, false);
});

test('pre-fix backdated receipts retain their snapshot, replay identity, read privacy and void behavior', async (t) => {
  const db = await createDatabase(t, { applyDateFix: false });
  const args = { date: '2020-01-01' };
  const original = await backdate(db, args);
  const stored = (await db.query('select receipt_data from payment_receipt_snapshots where payment_id=$1', [original.payment_id])).rows[0].receipt_data;
  assert.equal(stored.entered_at, undefined);
  await db.exec(migration('0204_payment_date_presentation_and_replay'));
  assert.equal((await backdate(db, args)).payment_id, original.payment_id);
  await assert.rejects(pay(db, { expected: 125 }), /different received date/i);
  const receipt = (await db.query('select public.get_payment_receipt_snapshot($1) as receipt', [original.payment_id])).rows[0].receipt;
  assert.equal(receipt.received_date_override, '2020-01-01');
  assert.ok(receipt.entered_at);
  assert.deepEqual((await db.query('select receipt_data from payment_receipt_snapshots where payment_id=$1', [original.payment_id])).rows[0].receipt_data, stored);
  await db.exec("set test.visible = 'false'");
  await assert.rejects(db.query('select public.get_payment_receipt_snapshot($1)', [original.payment_id]), /cannot be viewed/i);
  await db.exec("set test.visible = 'true'");
  await voidPayment(db, original.payment_id);
  const voided = (await db.query('select public.get_payment_receipt_snapshot($1) as receipt', [original.payment_id])).rows[0].receipt;
  assert.equal(voided.status, 'voided');
  assert.equal(voided.void_info.reason, 'Correct payment');
  assert.equal(voided.entered_at, receipt.entered_at);
});
