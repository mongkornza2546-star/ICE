import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0153_casual_transaction_foundation.sql', import.meta.url),
  'utf8',
);

const USER_ID = '10000000-0000-4000-8000-000000000001';
const ICE_ID = '20000000-0000-4000-8000-000000000001';
const ROUND_ID = '30000000-0000-4000-8000-000000000001';
const LOCATION_ID = '40000000-0000-4000-8000-000000000001';
const SERVICE_DATE = '2026-08-20';

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create type public.app_role as enum ('courier', 'round_lead', 'admin');
    create type public.delivery_round_status as enum ('open', 'closed');
    create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');
    create type public.financial_record_status as enum ('active', 'voided');

    create function auth.uid() returns uuid language sql stable as $$ select '${USER_ID}'::uuid $$;
    create function public.current_app_role() returns public.app_role
      language sql stable as $$ select 'courier'::public.app_role $$;
    create function public.is_active_user() returns boolean language sql stable as $$ select true $$;

    create table public.users (id uuid primary key);
    create table public.delivery_rounds (
      id uuid primary key,
      service_date date not null,
      status public.delivery_round_status not null
    );
    create table public.stock_locations (id uuid primary key);
    create table public.ice_types (id uuid primary key);
    create table public.daily_stock_uses (
      id uuid primary key default gen_random_uuid(),
      service_date date not null,
      kind text not null check (kind = 'refill'),
      status text not null default 'active',
      note text,
      idempotency_key uuid not null unique,
      request_fingerprint text not null,
      recorded_by uuid not null references public.users(id),
      recorded_at timestamptz not null default now(),
      cancelled_by uuid references public.users(id),
      cancelled_at timestamptz,
      cancellation_reason text
    );
    create table public.daily_stock_use_items (
      use_id uuid not null references public.daily_stock_uses(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity numeric(12,1) not null,
      primary key (use_id, ice_type_id)
    );

    insert into public.users values ('${USER_ID}');
    insert into public.delivery_rounds values ('${ROUND_ID}', date '${SERVICE_DATE}', 'open');
    insert into public.stock_locations values ('${LOCATION_ID}');
    insert into public.ice_types values ('${ICE_ID}');
  `);

  await db.exec(migration);
  return db;
}

function transactionSql({
  id,
  kind = 'paid',
  mode = 'measured',
  quantity = '0.5',
  sale = '75',
  method = "'cash'",
  received = '100',
  change = '25',
  evidence = 'null',
  receipt = "'REC2608-00001'",
  serviceDate = SERVICE_DATE,
}) {
  return `
    insert into public.casual_transactions (
      id, service_date, round_id, source_stock_location_id, ice_type_id,
      transaction_kind, fulfillment_mode, quantity, sale_amount, payment_method,
      received_amount, change_amount, evidence_path, receipt_number,
      idempotency_key, request_fingerprint, recorded_by
    ) values (
      '${id}', date '${serviceDate}', '${ROUND_ID}', '${LOCATION_ID}', '${ICE_ID}',
      '${kind}', '${mode}', ${quantity}, ${sale}, ${method},
      ${received}, ${change}, ${evidence}, ${receipt},
      gen_random_uuid(), 'fingerprint', '${USER_ID}'
    )
  `;
}

async function insertTransaction(db, options) {
  const kind = options.kind ?? 'paid';
  const receipt = options.receipt ?? "'REC2608-00001'";
  const snapshotReceipt = options.snapshotReceipt ?? receipt;

  await db.exec('begin');
  try {
    await db.exec(transactionSql(options));
    if (kind === 'paid') {
      await db.exec(`
        insert into public.casual_receipt_snapshots (transaction_id, receipt_data)
        values (
          '${options.id}',
          jsonb_build_object('receipt_number', ${snapshotReceipt})
        )
      `);
    }
    await db.exec('commit');
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

test('foundation accepts half-bag cash sales and loose free issues', async (t) => {
  const db = await createDatabase(t);
  await insertTransaction(db, { id: '50000000-0000-4000-8000-000000000001' });
  await insertTransaction(db, {
    id: '50000000-0000-4000-8000-000000000002',
    kind: 'free',
    mode: 'loose',
    quantity: 'null',
    sale: '0',
    method: 'null',
    received: 'null',
    change: 'null',
    receipt: 'null',
  });

  const result = await db.query(`
    select transaction_kind, fulfillment_mode, quantity, sale_amount
    from public.casual_transactions order by id
  `);
  assert.deepEqual(result.rows, [
    { transaction_kind: 'paid', fulfillment_mode: 'measured', quantity: '0.5', sale_amount: '75' },
    { transaction_kind: 'free', fulfillment_mode: 'loose', quantity: null, sale_amount: '0' },
  ]);
});

test('foundation rejects invalid quantity, payment, evidence, and round-date combinations', async (t) => {
  const db = await createDatabase(t);

  await assert.rejects(
    insertTransaction(db, { id: '50000000-0000-4000-8000-000000000003', quantity: '0.25' }),
    /casual_transactions_fulfillment_check/i,
  );
  await assert.rejects(
    insertTransaction(db, {
      id: '50000000-0000-4000-8000-000000000004',
      method: "'bank_transfer'",
      received: '75',
      change: '0',
    }),
    /casual_transactions_payment_check/i,
  );
  await assert.rejects(
    insertTransaction(db, {
      id: '50000000-0000-4000-8000-000000000005',
      received: '70',
      change: '-5',
    }),
    /casual_transactions_payment_check/i,
  );
  await assert.rejects(
    insertTransaction(db, {
      id: '50000000-0000-4000-8000-000000000006',
      serviceDate: '2026-08-21',
    }),
    /casual_transactions_round_service_date_fk/i,
  );
});

test('foundation rejects values that column coercion would otherwise round', async (t) => {
  const db = await createDatabase(t);

  await assert.rejects(
    insertTransaction(db, {
      id: '50000000-0000-4000-8000-000000000012',
      quantity: '0.49',
    }),
    /casual_transactions_fulfillment_check/i,
  );
  await assert.rejects(
    insertTransaction(db, {
      id: '50000000-0000-4000-8000-000000000013',
      sale: '74.5',
      received: '74.5',
      change: '0',
    }),
    /casual_transactions_money_check/i,
  );
});

test('receipt snapshots are required for paid transactions and forbidden for free transactions', async (t) => {
  const db = await createDatabase(t);
  const paidId = '50000000-0000-4000-8000-000000000014';
  const freeId = '50000000-0000-4000-8000-000000000015';

  await assert.rejects(
    db.exec(transactionSql({ id: paidId })),
    /require one matching receipt snapshot/i,
  );
  await assert.rejects(
    insertTransaction(db, {
      id: '50000000-0000-4000-8000-000000000016',
      snapshotReceipt: "'REC2608-99999'",
    }),
    /receipt snapshot number must match/i,
  );
  await insertTransaction(db, {
    id: freeId,
    kind: 'free',
    mode: 'loose',
    quantity: 'null',
    sale: '0',
    method: 'null',
    received: 'null',
    change: 'null',
    receipt: 'null',
  });
  await assert.rejects(db.exec(`
    insert into public.casual_receipt_snapshots (transaction_id, receipt_data)
    values ('${freeId}', '{"receipt_number":"REC2608-99999"}'::jsonb)
  `), /only paid casual transactions can have receipt snapshots/i);
});

test('refund confirmation is full-value and all evidence records are immutable', async (t) => {
  const db = await createDatabase(t);
  const transactionId = '50000000-0000-4000-8000-000000000007';
  await insertTransaction(db, { id: transactionId });

  await assert.rejects(db.exec(`
    insert into public.casual_refund_confirmations (
      transaction_id, refunded_amount, refund_method, confirmed_by,
      idempotency_key, request_fingerprint
    ) values (
      '${transactionId}', 74, 'cash', '${USER_ID}', gen_random_uuid(), 'refund-fingerprint'
    )
  `), /must equal the casual sale amount/i);

  await assert.rejects(db.exec(`
    insert into public.casual_refund_confirmations (
      transaction_id, refunded_amount, refund_method, confirmed_by,
      idempotency_key, request_fingerprint
    ) values (
      '${transactionId}', 75.5, 'cash', '${USER_ID}', gen_random_uuid(), 'refund-fingerprint'
    )
  `), /must equal the casual sale amount|casual_refund_confirmations_amount_check/i);

  await assert.rejects(db.exec(`
    update public.casual_transactions
    set status = 'voided', voided_by = '${USER_ID}', voided_at = now(), void_reason = 'customer return'
    where id = '${transactionId}'
  `), /require a full refund confirmation/i);

  await db.exec(`
    insert into public.casual_refund_confirmations (
      transaction_id, refunded_amount, refund_method, confirmed_by,
      idempotency_key, request_fingerprint
    ) values (
      '${transactionId}', 75, 'cash', '${USER_ID}', gen_random_uuid(), 'refund-fingerprint'
    );
  `);

  await assert.rejects(
    db.exec(`update public.casual_refund_confirmations set reference_number = 'changed'`),
    /are immutable/i,
  );
  await assert.rejects(
    db.exec(`delete from public.casual_receipt_snapshots`),
    /are immutable/i,
  );
  await assert.rejects(
    db.exec(`update public.casual_transactions set sale_amount = 80 where id = '${transactionId}'`),
    /details are immutable/i,
  );

  await db.exec(`
    update public.casual_transactions
    set status = 'voided', voided_by = '${USER_ID}', voided_at = now(), void_reason = 'customer return'
    where id = '${transactionId}'
  `);
  const status = await db.query(`
    select status, void_reason from public.casual_transactions where id = '${transactionId}'
  `);
  assert.deepEqual(status.rows[0], { status: 'voided', void_reason: 'customer return' });
});

test('shared daily stock uses remain refill-only until close v2 updates every consumer', async (t) => {
  const db = await createDatabase(t);

  await assert.rejects(db.exec(`
    insert into public.daily_stock_uses (
      service_date, kind, idempotency_key, request_fingerprint, recorded_by
    ) values (
      date '${SERVICE_DATE}', 'casual_loose', gen_random_uuid(), 'loose', '${USER_ID}'
    )
  `), /daily_stock_uses_kind_check/i);
});

test('authenticated clients have no direct casual write permission', async (t) => {
  const db = await createDatabase(t);
  await db.exec('set role authenticated');
  try {
    await assert.rejects(
      insertTransaction(db, { id: '50000000-0000-4000-8000-000000000009' }),
      /permission denied/i,
    );
  } finally {
    await db.exec('reset role');
  }
});
