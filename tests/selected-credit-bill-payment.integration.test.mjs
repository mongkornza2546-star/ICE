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
  // Minimal surrounding schema; the payment writer and both wrappers below
  // come directly from the production migrations, including their guards.
  await db.exec(`
    create role authenticated;
    create role anon;
    create schema auth;
    create schema storage;
    create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');
    create function auth.uid() returns uuid language sql as $$
      select '50000000-0000-4000-8000-000000000001'::uuid
    $$;
    create function public.is_active_user() returns boolean language sql as $$ select true $$;
    create function public.current_app_role() returns text language sql as $$ select 'round_lead'::text $$;
    create function public.can_collect_shop_payments() returns boolean language sql as $$
      select coalesce(current_setting('test.can_collect', true), 'true') = 'true'
    $$;
    create function public.is_payment_visible(uuid) returns boolean language sql as $$ select true $$;
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
      outstanding_amount numeric(12,2) not null, status text default 'active',
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
  return db;
}

function pay(db, { bill = newBill, amount = 75, expected = 125, key = 1 } = {}) {
  return db.query(`select public.record_payment(
    $1::uuid, $2::jsonb, 'cash', $3::numeric, null, null,
    $4::uuid, $5::numeric, null, $6::uuid
  ) as result`, [shopId, JSON.stringify([{ charge_id: bill, amount }]), amount, runId, expected,
    `40000000-0000-4000-8000-${String(key).padStart(12, '0')}`]);
}

test('0198 patches the real writer through both wrappers and preserves payment safety', async (t) => {
  const db = await createDatabase(t);
  await assert.rejects(pay(db), /oldest due balance first/i);
  await db.exec(migration('0198_allow_selected_credit_bill_payments'));

  await assert.rejects(pay(db, { bill: otherShopBill, amount: 20 }), /outside the caller's assigned collection scope/i);
  await assert.rejects(pay(db, { bill: otherRunBill, amount: 10 }), /outside the caller's assigned collection scope/i);
  await assert.rejects(pay(db, { expected: 120 }), /outstanding amount changed/i);
  await assert.rejects(pay(db, { amount: 76 }), /exceed the latest charge balance/i);
  await db.exec("set test.can_collect = 'false'");
  await assert.rejects(pay(db), /cannot collect shop payments/i);
  await db.exec("set test.can_collect = 'true'");

  const recorded = await pay(db);
  assert.ok(recorded.rows[0].result.payment_id);
  assert.equal(Number(recorded.rows[0].result.allocated_amount), 75);
  const allocations = await db.query('select charge_id, amount::float as amount from public.payment_allocations');
  assert.deepEqual(allocations.rows, [{ charge_id: newBill, amount: 75 }]);
  const replayed = await pay(db);
  assert.deepEqual(replayed.rows, recorded.rows);
  await assert.rejects(pay(db, { amount: 70 }), /idempotency key was already used for a different payment/i);
  assert.equal((await db.query('select count(*)::int as count from public.payments')).rows[0].count, 1);
  await assert.rejects(pay(db, { key: 2, expected: 50, amount: 1 }), /exceed the latest charge balance/i);
});
