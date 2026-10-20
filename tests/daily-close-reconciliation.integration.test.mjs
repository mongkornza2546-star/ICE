import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const foundationMigration = readFileSync(
  new URL('../supabase/migrations/0160_cash_handover_dark_launch.sql', import.meta.url),
  'utf8',
);
const workflowMigration = readFileSync(
  new URL('../supabase/migrations/0161_cash_handover_workflow.sql', import.meta.url),
  'utf8',
);
const accountingQueueMigration = readFileSync(
  new URL('../supabase/migrations/0162_daily_close_accounting_review_queue.sql', import.meta.url),
  'utf8',
);

const migration = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const sqlFunction = (sql, name) => {
  const start = sql.indexOf(`create function public.${name}(`);
  assert.notEqual(start, -1);
  return sql.slice(start, sql.indexOf('\n$$;', start) + 4);
};

const courierId = '00000000-0000-0000-0000-000000000001';
const inactiveCourierId = '00000000-0000-0000-0000-000000000002';
const managerId = '00000000-0000-0000-0000-000000000003';
const newCourierId = '00000000-0000-0000-0000-000000000004';
const runId = '10000000-0000-0000-0000-000000000001';
const shopId = '50000000-0000-0000-0000-000000000001';
const serviceDate = '2026-01-02';

async function createDatabase({ applyCashFix = true, applyFingerprintFix = true } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create extension if not exists pgcrypto;
    create schema auth;
    create role authenticated;
    create role anon;
    create schema storage;
    create type public.financial_record_status as enum ('active', 'voided');
    create table storage.objects (bucket_id text, name text);
    create type public.app_role as enum ('courier', 'round_lead', 'admin');
    create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');

    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.test_user_id', true), '')::uuid
    $$;
    create table public.users (
      id uuid primary key,
      display_name text not null,
      role public.app_role not null,
      is_active boolean not null
    );
    create function public.current_app_role() returns public.app_role language sql stable
    security definer set search_path = public as $$
      select role from public.users where id = auth.uid() and is_active
    $$;
    create function public.is_active_user() returns boolean language sql stable
    security definer set search_path = public as $$
      select exists (select 1 from public.users where id = auth.uid() and is_active)
    $$;
    create table public.collection_runs (
      id uuid primary key,
      service_date date not null,
      status text not null default 'open',
      closed_by uuid,
      closed_at timestamptz
    );
    create table public.shops (
      id uuid primary key,
      name text not null
    );
    create table public.payments (
      id uuid primary key,
      shop_id uuid not null references public.shops(id),
      collection_run_id uuid references public.collection_runs(id),
      payment_method public.payment_method not null,
      received_amount numeric(12,2) not null,
      allocated_amount numeric(12,2) not null,
      change_amount numeric(12,2) not null default 0,
      status public.financial_record_status not null,
      recorded_by uuid not null references public.users(id),
      recorded_role public.app_role not null,
      recorded_at timestamptz not null,
      receipt_number text,
      voided_at timestamptz,
      void_reason text,
      evidence_path text
    );
    create table public.delivery_charges (
      id uuid primary key,
      shop_id uuid not null references public.shops(id),
      service_date date not null,
      status text not null,
      payment_term text not null,
      due_date date,
      charge_number text,
      delivery_event_id uuid,
      created_at timestamptz not null default now(),
      voided_at timestamptz,
      void_reason text
    );
    create table public.payment_allocations (
      payment_id uuid not null references public.payments(id),
      charge_id uuid not null references public.delivery_charges(id),
      amount numeric(12,2) not null
    );
    create table public.payment_allocation_changes (
      id uuid primary key,
      source_kind text not null,
      source_id uuid not null,
      from_charge_id uuid not null references public.delivery_charges(id),
      changed_at timestamptz not null,
      reason text not null,
      payment_id uuid references public.payments(id),
      before_amount numeric(12,2) not null
    );
    create table public.refund_obligations (
      id uuid primary key,
      source_charge_id uuid not null references public.delivery_charges(id),
      created_at timestamptz not null,
      amount numeric(12,2) not null,
      reason text not null,
      payment_id uuid references public.payments(id),
      status text not null
    );
    create table public.ice_types (
      id uuid primary key,
      code text not null,
      name text not null,
      unit text not null,
      is_active boolean not null default true
    );
    create table public.daily_aggregate_stock_closures (
      service_date date primary key,
      status text not null,
      note text,
      idempotency_key uuid unique,
      closed_by uuid,
      closed_at timestamptz not null default now()
    );
    create table public.daily_aggregate_stock_closure_items (
      service_date date not null,
      ice_type_id uuid not null,
      system_quantity numeric(12,1) not null,
      actual_quantity numeric(12,1) not null,
      variance_quantity numeric(12,1) not null,
      note text,
      primary key (service_date, ice_type_id)
    );
    create table public.audit_logs (
      id uuid primary key default gen_random_uuid(),
      actor_id uuid not null,
      entity_type text not null,
      entity_id uuid not null,
      action text not null,
      before_value jsonb,
      after_value jsonb,
      reason text,
      occurred_at timestamptz not null default now()
    );
    create function public.get_daily_aggregate_stock_summary(p_service_date date)
    returns jsonb language sql stable as $$
      select jsonb_build_object(
        'service_date', p_service_date,
        'status', case when exists (
          select 1 from public.daily_aggregate_stock_closures where service_date = p_service_date
        ) then 'closed' else 'open' end,
        'items', coalesce((select jsonb_agg(jsonb_build_object(
          'ice_type_id', ice.id, 'code', ice.code, 'name', ice.name, 'unit', ice.unit,
          'available_quantity', coalesce(item.system_quantity, 10),
          'actual_quantity', item.actual_quantity,
          'variance_quantity', item.variance_quantity
        )) from public.ice_types ice left join public.daily_aggregate_stock_closure_items item
          on item.service_date = p_service_date and item.ice_type_id = ice.id), '[]'::jsonb)
      )
    $$;
    create function public.effective_delivery_charge_amount(p_charge_id uuid)
    returns numeric language sql stable as $$ select 0::numeric $$;
    create function public.accounting_aggregate_reconciliation_rows(p_service_date date)
    returns table (
      id uuid,
      name text,
      variance numeric,
      unit text,
      count_status text
    ) language sql stable as $$
      select ice.id, ice.name, item.variance_quantity, ice.unit, 'complete'::text
      from public.daily_aggregate_stock_closure_items item
      join public.ice_types ice on ice.id = item.ice_type_id
      where item.service_date = p_service_date
    $$;
    create function public.get_accounting_review_queue(
      p_from_date date, p_to_date date, p_filters jsonb, p_limit integer, p_offset integer
    ) returns jsonb language sql stable as $$
      select jsonb_build_object('rows', '[]'::jsonb, 'total_count', 0)
    $$;

    insert into public.users values
      ('${courierId}', 'Courier One', 'courier', true),
      ('${inactiveCourierId}', 'Courier Old', 'courier', false),
      ('${managerId}', 'Manager', 'round_lead', true);
    insert into public.collection_runs (id, service_date) values ('${runId}', date '${serviceDate}');
    insert into public.shops (id, name) values ('${shopId}', 'Test Shop');
    insert into public.ice_types (id, code, name, unit)
      values ('40000000-0000-0000-0000-000000000001', 'ICE', 'Ice', 'bag');
  `);
  // Use the production casual schema/write RPCs and stock-close functions.
  // Stock balances and context are fixed fixtures; cash mutations are real SQL.
  await db.exec(`
    create table public.stock_locations (id uuid primary key);
    insert into public.stock_locations values ('60000000-0000-0000-0000-000000000001');
    create table public.delivery_rounds (
      id uuid primary key, service_date date not null, status text not null,
      cancelled_at timestamptz, closed_by uuid, closed_at timestamptz
    );
    insert into public.delivery_rounds (id, service_date, status)
      values ('${runId}', '${serviceDate}', 'open');
    create function public.daily_aggregate_stock_balance_at(date, uuid)
      returns numeric language sql as $$ select 10::numeric $$;
    create function public.stock_balance_at(date, uuid, uuid)
      returns numeric language sql as $$ select 100::numeric $$;
    create sequence receipt_seq;
    create function public.next_sales_document_number(text, date)
      returns text language sql as $$ select 'REC-' || nextval('receipt_seq') $$;
    create function public.get_casual_transaction_context(p_round_id uuid)
      returns jsonb language sql as $$ select jsonb_build_object(
        'stock_closed', exists (select 1 from public.daily_aggregate_stock_closures
          where service_date = (select service_date from public.delivery_rounds where id = p_round_id)),
        'stock_source', jsonb_build_object('id', '60000000-0000-0000-0000-000000000001', 'name', 'Truck')
      ) $$;
  `);
  await db.exec(migration('0153_casual_transaction_foundation.sql'));
  const casual = migration('0154_casual_measured_transactions.sql');
  await db.exec(casual.slice(casual.indexOf('create table public.casual_void_requests'), casual.indexOf('create function public.get_casual_transaction_capability')));
  await db.exec(`create function public.casual_transaction_response(p_id uuid)
    returns jsonb language sql as $$ select jsonb_build_object('transaction', to_jsonb(t))
    from public.casual_transactions t where id = p_id $$;`);
  await db.exec(sqlFunction(casual, 'record_casual_transaction'));
  await db.exec(sqlFunction(casual, 'void_casual_transaction'));
  await db.exec(sqlFunction(migration('0155_casual_loose_transactions.sql'), 'record_casual_loose_transaction'));
  const stock = migration('0107_daily_aggregate_stock.sql').replace('create or replace function public.close_daily_aggregate_stock(', 'create function public.close_daily_aggregate_stock(');
  await db.exec(sqlFunction(stock, 'close_daily_aggregate_stock'));
  const wrapper = migration('0159_automatic_collection_context_authorization.sql');
  await db.exec(wrapper.slice(wrapper.indexOf('alter function public.close_daily_aggregate_stock('), wrapper.indexOf('revoke all on function public.ensure_daily_collection_context(date)')));
  await db.exec('grant execute on function public.close_daily_aggregate_stock(date,jsonb,text,uuid) to authenticated');
  await db.exec(foundationMigration);
  await db.exec(workflowMigration);
  await db.exec(accountingQueueMigration);
  await db.exec(`update public.daily_close_reconciliation_configuration
    set enabled_from_service_date = date '${serviceDate}' where singleton`);
  if (applyCashFix) {
    await db.exec(migration('0235_daily_close_casual_cash_and_legacy_guard.sql'));
  }
  if (applyFingerprintFix) {
    await db.exec(migration('0238_daily_close_payment_fingerprint_enum.sql'));
  }
  return db;
}

async function addPayment(db, {
  id,
  amount,
  employeeId = courierId,
  method = 'cash',
  status = 'active',
  role = 'courier',
  receivedAmount = amount,
  changeAmount = 0,
  recordedAt = '2026-01-02 03:00:00+00',
  collectionRunId = runId,
}) {
  await db.exec(`insert into public.payments (
    id, shop_id, collection_run_id, payment_method, received_amount,
    allocated_amount, change_amount, status, recorded_by, recorded_role, recorded_at
  ) values (
    '${id}', '${shopId}', ${collectionRunId ? `'${collectionRunId}'` : 'null'}, '${method}',
    ${receivedAmount}, ${amount}, ${changeAmount}, '${status}', '${employeeId}', '${role}', '${recordedAt}'
  )`);
}

test('enum fingerprint migration repairs failed closes without changing hashes or granting client access', async (t) => {
  const db = await createDatabase({ applyFingerprintFix: false });
  t.after(() => db.close());
  await addPayment(db, { id: '20000000-0000-0000-0000-000000000001', amount: 100 });
  await db.exec(`set app.test_user_id = '${managerId}'`);
  const stockCounts = JSON.stringify([{ ice_type_id: '40000000-0000-0000-0000-000000000001', actual_quantity: 10 }]);
  const cashCounts = JSON.stringify([{ employee_id: courierId, actual_cash_amount: 100 }]);
  const closeSql = `select public.close_daily_reconciliation_v2(
    date '${serviceDate}', '${stockCounts}'::jsonb, '${cashCounts}'::jsonb,
    null, '30000000-0000-0000-0000-000000000099'
  ) result`;
  await assert.rejects(db.query(closeSql), {
    code: '42883',
    message: 'function public.daily_close_payment_fingerprint(uuid, financial_record_status, payment_method, numeric, uuid, app_role, date) does not exist',
  });
  for (const table of ['daily_aggregate_stock_closures', 'daily_close_reconciliation_requests', 'daily_close_employee_snapshots', 'daily_close_payment_items']) {
    assert.equal((await db.query(`select count(*)::integer count from public.${table}`)).rows[0].count, 0);
  }

  const fix = migration('0238_daily_close_payment_fingerprint_enum.sql');
  await db.exec(fix);
  await db.exec(fix);
  const hashes = (await db.query(`select status,
    public.daily_close_payment_fingerprint(p.id, status, p.payment_method,
      p.allocated_amount, p.recorded_by, p.recorded_role, date '${serviceDate}') enum_hash,
    public.daily_close_payment_fingerprint(p.id, status::text, p.payment_method,
      p.allocated_amount, p.recorded_by, p.recorded_role, date '${serviceDate}') text_hash
    from (select id, payment_method, allocated_amount, recorded_by, recorded_role from public.payments) p
    cross join unnest(enum_range(null::public.financial_record_status)) status
  `)).rows;
  assert.equal(hashes.length, 2);
  for (const row of hashes) assert.equal(row.enum_hash, row.text_hash);
  for (const role of ['anon', 'authenticated']) {
    const access = (await db.query(`select has_function_privilege('${role}',
      'public.daily_close_payment_fingerprint(uuid,public.financial_record_status,public.payment_method,numeric,uuid,public.app_role,date)',
      'EXECUTE') allowed`)).rows[0];
    assert.equal(access.allowed, false);
  }

  await db.exec('set role authenticated');
  assert.equal((await db.query(closeSql)).rows[0].result.status, 'closed');
  assert.equal((await db.query(closeSql)).rows[0].result.status, 'closed');
  await db.exec('reset role');
  const snapshots = (await db.query('select payment_fingerprint from public.daily_close_payment_items')).rows;
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].payment_fingerprint, hashes.find(row => row.status === 'active').text_hash);
});

test('summary counts only active allocated courier cash for the service date', async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  await addPayment(db, { id: '20000000-0000-0000-0000-000000000001', amount: 100, receivedAmount: 120, changeAmount: 20 });
  await addPayment(db, { id: '20000000-0000-0000-0000-000000000002', amount: 50, method: 'qr' });
  await addPayment(db, { id: '20000000-0000-0000-0000-000000000003', amount: 40, status: 'voided' });
  await addPayment(db, { id: '20000000-0000-0000-0000-000000000004', amount: 30, employeeId: managerId, role: 'round_lead' });
  await addPayment(db, { id: '20000000-0000-0000-0000-000000000005', amount: 25, employeeId: inactiveCourierId });
  await addPayment(db, { id: '20000000-0000-0000-0000-000000000006', amount: 70, recordedAt: '2026-01-03 03:00:00+00', collectionRunId: null });

  await db.exec(`set app.test_user_id = '${managerId}'`);
  const summary = (await db.query(
    `select public.get_daily_close_reconciliation(date '${serviceDate}') summary`,
  )).rows[0].summary;

  assert.equal(summary.feature_enabled, true);
  assert.deepEqual(summary.employees
    .map((employee) => [employee.employee_id, Number(employee.expected_cash_amount)])
    .sort(([left], [right]) => left.localeCompare(right)), [
    [courierId, 100],
    [inactiveCourierId, 25],
  ]);
});

test('variance requires a reason, closes atomically, and retry does not duplicate snapshots', async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  await addPayment(db, { id: '20000000-0000-0000-0000-000000000001', amount: 100 });
  await db.exec(`set app.test_user_id = '${managerId}'`);

  const stockCounts = JSON.stringify([{ ice_type_id: '40000000-0000-0000-0000-000000000001', actual_quantity: 9, note: 'melted' }]);
  const missingReasonCash = JSON.stringify([{ employee_id: courierId, actual_cash_amount: 90, reason: null }]);
  const requestId = '30000000-0000-0000-0000-000000000001';
  await assert.rejects(
    db.query(`select public.close_daily_reconciliation_v2(
      date '${serviceDate}', '${stockCounts}'::jsonb, '${missingReasonCash}'::jsonb,
      'stock reason', '${requestId}'
    )`),
    /reason is required/i,
  );
  assert.equal((await db.query('select count(*)::integer count from public.daily_aggregate_stock_closures')).rows[0].count, 0);

  const cashCounts = JSON.stringify([{ employee_id: courierId, actual_cash_amount: 90, reason: 'customer cash pending' }]);
  const first = (await db.query(`select public.close_daily_reconciliation_v2(
    date '${serviceDate}', '${stockCounts}'::jsonb, '${cashCounts}'::jsonb,
    'stock reason', '${requestId}'
  ) result`)).rows[0].result;
  const retry = (await db.query(`select public.close_daily_reconciliation_v2(
    date '${serviceDate}', '${stockCounts}'::jsonb, '${cashCounts}'::jsonb,
    'stock reason', '${requestId}'
  ) result`)).rows[0].result;

  assert.equal(first.status, 'closed');
  assert.equal(retry.status, 'closed');
  assert.equal((await db.query('select count(*)::integer count from public.daily_close_employee_snapshots')).rows[0].count, 1);
  assert.equal((await db.query('select count(*)::integer count from public.daily_close_payment_items')).rows[0].count, 1);
  const issues = (await db.query(`select issue_type::text, reason from public.daily_close_reconciliation_issues order by issue_type`)).rows;
  assert.deepEqual(issues, [
    { issue_type: 'CASH_VARIANCE', reason: 'customer cash pending' },
    { issue_type: 'STOCK_VARIANCE', reason: 'melted' },
  ]);

  const queue = (await db.query(`select public.get_accounting_review_queue(
    date '${serviceDate}', date '${serviceDate}', '{}'::jsonb, 100, 0
  ) result`)).rows[0].result;
  assert.equal(queue.total_count, 2);
  assert.deepEqual(queue.rows.map((row) => row.issue_type).sort(), [
    'CASH_VARIANCE',
    'STOCK_VARIANCE',
  ]);
  const firstPage = (await db.query(`select public.get_accounting_review_queue(
    date '${serviceDate}', date '${serviceDate}', '{}'::jsonb, 1, 0
  ) result`)).rows[0].result;
  const secondPage = (await db.query(`select public.get_accounting_review_queue(
    date '${serviceDate}', date '${serviceDate}', '{}'::jsonb, 1, 1
  ) result`)).rows[0].result;
  assert.equal(firstPage.total_count, 2);
  assert.equal(secondPage.total_count, 2);
  assert.notEqual(firstPage.rows[0].issue_id, secondPage.rows[0].issue_id);
  const cashQueueItem = queue.rows.find((row) => row.issue_type === 'CASH_VARIANCE');
  assert.equal(cashQueueItem.shop_name, 'Courier One');

  const cashIssueId = cashQueueItem.source_id;
  await db.query(`select public.resolve_daily_close_reconciliation_issue(
    '${cashIssueId}', 'handled outside payroll', 'EXT-001'
  )`);
  const resolved = (await db.query(`select status::text, resolution_note, external_reference
    from public.daily_close_reconciliation_issues where id = '${cashIssueId}'`)).rows[0];
  assert.deepEqual(resolved, {
    status: 'resolved', resolution_note: 'handled outside payroll', external_reference: 'EXT-001',
  });
  const emptyQueue = (await db.query(`select public.get_accounting_review_queue(
    date '${serviceDate}', date '${serviceDate}', '{}'::jsonb, 100, 0
  ) result`)).rows[0].result;
  assert.equal(emptyQueue.total_count, 1);
  assert.equal(emptyQueue.rows[0].issue_type, 'STOCK_VARIANCE');

  await db.query(`select public.resolve_daily_close_reconciliation_issue(
    '${emptyQueue.rows[0].source_id}', 'stock checked', null
  )`);
  const resolvedQueue = (await db.query(`select public.get_accounting_review_queue(
    date '${serviceDate}', date '${serviceDate}', '{}'::jsonb, 100, 0
  ) result`)).rows[0].result;
  assert.equal(resolvedQueue.total_count, 0);
});

test('closed summary stays on the immutable roster and payment snapshot', async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  const paymentId = '20000000-0000-0000-0000-000000000001';
  await addPayment(db, { id: paymentId, amount: 100 });
  await db.exec(`set app.test_user_id = '${managerId}'`);
  const stockCounts = JSON.stringify([{ ice_type_id: '40000000-0000-0000-0000-000000000001', actual_quantity: 10, note: null }]);
  const cashCounts = JSON.stringify([{ employee_id: courierId, actual_cash_amount: 100, reason: null }]);
  await db.query(`select public.close_daily_reconciliation_v2(
    date '${serviceDate}', '${stockCounts}'::jsonb, '${cashCounts}'::jsonb,
    null, '30000000-0000-0000-0000-000000000002'
  )`);

  await db.exec(`
    update public.payments set allocated_amount = 1, status = 'voided' where id = '${paymentId}';
    update public.users set is_active = false where id = '${courierId}';
    insert into public.users values ('${newCourierId}', 'Courier New', 'courier', true);
  `);
  const snapshot = (await db.query(`select expected_cash_amount from public.daily_close_employee_snapshots
    where service_date = date '${serviceDate}' and employee_id = '${courierId}'`)).rows[0];
  const item = (await db.query(`select allocated_amount from public.daily_close_payment_items
    where payment_id = '${paymentId}'`)).rows[0];
  assert.equal(Number(snapshot.expected_cash_amount), 100);
  assert.equal(Number(item.allocated_amount), 100);

  const summary = (await db.query(
    `select public.get_daily_close_reconciliation(date '${serviceDate}') summary`,
  )).rows[0].summary;
  assert.deepEqual(summary.employees.map((employee) => ({
    employee_id: employee.employee_id,
    expected_cash_amount: Number(employee.expected_cash_amount),
    actual_cash_amount: Number(employee.actual_cash_amount),
    payment_ids: employee.payment_ids,
  })), [{
    employee_id: courierId,
    expected_cash_amount: 100,
    actual_cash_amount: 100,
    payment_ids: [paymentId],
  }]);
});

const iceId = '40000000-0000-0000-0000-000000000001';
const stockCounts = [{ ice_type_id: iceId, actual_quantity: 10, note: null }];

async function recordCasual(db, { amount = 50, received = amount, method = 'cash', loose = false, free = false, actor = courierId, round = runId } = {}) {
  await db.exec(`set app.test_user_id = '${actor}'`);
  const evidence = method === 'cash' || free ? null : `${actor}/${randomUUID()}`;
  if (evidence) await db.query("insert into storage.objects values ('payment-evidence', $1)", [evidence]);
  const values = [round, iceId, ...(loose ? [] : [1]), free ? 'free' : 'paid', free ? 0 : amount,
    free ? null : method, free ? null : received, null, evidence, null, null, randomUUID()];
  const name = loose ? 'record_casual_loose_transaction' : 'record_casual_transaction';
  const result = await db.query(`select public.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) result`, values);
  return result.rows[0].result.transaction.id;
}

async function refundCasual(db, id, { method = 'cash', actor = courierId } = {}) {
  await db.exec(`set app.test_user_id = '${actor}'`);
  const evidence = method == null || method === 'cash' ? null : `${actor}/${randomUUID()}`;
  if (evidence) await db.query("insert into storage.objects values ('payment-evidence', $1)", [evidence]);
  await db.query('select public.void_casual_transaction($1,$2,$3,$4,$5,$6)',
    [id, 'Customer returned sale', method, null, evidence, randomUUID()]);
}

async function cashSummary(db, date = serviceDate) {
  await db.exec(`set app.test_user_id = '${managerId}'`);
  return (await db.query('select public.get_daily_close_reconciliation($1) result', [date])).rows[0].result;
}

async function closeCash(db, counts, key = randomUUID(), date = serviceDate) {
  await db.exec(`set app.test_user_id = '${managerId}'; set role authenticated;`);
  try {
    return (await db.query('select public.close_daily_reconciliation_v2($1,$2,$3,$4,$5) result',
      [date, JSON.stringify(stockCounts), JSON.stringify(counts), null, key])).rows[0].result;
  } finally {
    await db.exec('reset role');
  }
}

test('measured and loose casual cash join regular receipts, net of change, with immutable idempotent close', async (t) => {
  const db = await createDatabase(); t.after(() => db.close());
  await addPayment(db, { id: randomUUID(), amount: 100 });
  const measuredId = await recordCasual(db, { amount: 50, received: 100 });
  await recordCasual(db, { amount: 20, loose: true });
  await recordCasual(db, { amount: 70, method: 'bank_transfer' });
  await recordCasual(db, { amount: 80, method: 'qr', loose: true });
  await recordCasual(db, { free: true });
  await recordCasual(db, { free: true, loose: true });
  await recordCasual(db, { amount: 90, actor: managerId });
  await db.exec(`insert into public.delivery_rounds (id, service_date, status)
    values ('${newCourierId}', date '${serviceDate}' + 1, 'open')`);
  await recordCasual(db, { amount: 500, round: newCourierId });

  const open = await cashSummary(db);
  assert.equal(Number(open.employees[0].expected_cash_amount), 170);
  assert.equal(open.employees[0].cash_source_count, 3);
  const counts = [{ employee_id: courierId, actual_cash_amount: 170, reason: null }];
  await assert.rejects(db.query('select public.close_daily_reconciliation_v2($1,$2,$3,null,$4)',
    [serviceDate, JSON.stringify([{ ice_type_id: iceId, actual_quantity: 9, note: null }]), JSON.stringify(counts), randomUUID()]), /note is required/);
  for (const table of ['daily_close_reconciliation_requests', 'daily_close_employee_snapshots', 'daily_close_casual_cash_items']) {
    assert.equal((await db.query(`select count(*)::int n from public.${table}`)).rows[0].n, 0);
  }
  const key = randomUUID();
  const closed = await closeCash(db, counts, key);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.employees[0].cash_source_count, 3);
  assert.equal(Number(closed.employees[0].cash_variance_amount), 0);
  assert.deepEqual(await closeCash(db, counts, key), closed);
  assert.equal((await db.query('select count(*)::int n from public.daily_close_casual_cash_items')).rows[0].n, 2);
  assert.equal((await db.query('select count(*)::int n from public.daily_close_reconciliation_issues')).rows[0].n, 0);
  await assert.rejects(db.exec('update public.daily_close_casual_cash_items set cash_amount = 1'), /cannot be changed/);
  await assert.rejects(db.exec('delete from public.daily_close_casual_cash_items'), /cannot be changed/);
  await assert.rejects(refundCasual(db, measuredId), /after stock is closed/);
  await db.exec(`update public.users set is_active = false where id = '${courierId}';
    insert into public.users values ('${newCourierId}', 'New', 'courier', true)`);
  const frozen = await cashSummary(db);
  assert.deepEqual(frozen.employees.map(e => [e.employee_id, Number(e.expected_cash_amount), Number(e.actual_cash_amount)]), [[courierId, 170, 170]]);
});

test('casual refunds follow cash movement and the refund actor, including cross-method refunds', async (t) => {
  const db = await createDatabase(); t.after(() => db.close());
  await addPayment(db, { id: randomUUID(), amount: 100 });
  const cashCash = await recordCasual(db, { amount: 50 });
  await refundCasual(db, cashCash); // 50 received, 50 cash returned = 0
  const cashTransfer = await recordCasual(db, { amount: 30, loose: true });
  await refundCasual(db, cashTransfer, { method: 'bank_transfer' }); // cash remains with courier
  const transferCash = await recordCasual(db, { amount: 20, method: 'bank_transfer' });
  await refundCasual(db, transferCash); // 20 cash paid out
  const managerRefund = await recordCasual(db, { amount: 40 });
  await refundCasual(db, managerRefund, { actor: managerId }); // manager's refund is not courier cash
  const transferTransfer = await recordCasual(db, { amount: 60, method: 'qr' });
  await refundCasual(db, transferTransfer, { method: 'qr' });
  const free = await recordCasual(db, { free: true });
  await refundCasual(db, free, { method: null });

  assert.equal(Number((await cashSummary(db)).employees[0].expected_cash_amount), 150);
  const result = await closeCash(db, [{ employee_id: courierId, actual_cash_amount: 150, reason: null }]);
  assert.equal(Number(result.employees[0].cash_variance_amount), 0);
  const sources = (await db.query('select source_kind, cash_amount from public.daily_close_casual_cash_items')).rows;
  assert.equal(sources.length, 5);
  assert.equal(sources.reduce((sum, row) => sum + Number(row.cash_amount), 0), 50);
});

test('a casual-only inactive courier remains accountable and variance is atomic and auditable', async (t) => {
  const db = await createDatabase(); t.after(() => db.close());
  await recordCasual(db, { amount: 50 });
  await db.exec(`update public.users set is_active = false where id = '${courierId}'`);
  assert.equal(Number((await cashSummary(db)).employees[0].expected_cash_amount), 50);
  await assert.rejects(closeCash(db, [{ employee_id: courierId, actual_cash_amount: 40, reason: null }]), /reason is required/);
  assert.equal((await db.query('select count(*)::int n from public.daily_aggregate_stock_closures')).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int n from public.daily_close_casual_cash_items')).rows[0].n, 0);
  await closeCash(db, [{ employee_id: courierId, actual_cash_amount: 40, reason: 'Short 10' }]);
  const issue = (await db.query("select expected_value, actual_value, variance_value from public.daily_close_reconciliation_issues where issue_type = 'CASH_VARIANCE'")).rows[0];
  assert.deepEqual(Object.values(issue).map(Number), [50, 40, -10]);
  const queue = (await db.query("select public.get_accounting_review_queue($1,$1,'{}',100,0) result", [serviceDate])).rows[0].result;
  assert.equal(queue.rows[0].issue_type, 'CASH_VARIANCE');
});

test('refund-only courier cash can be negative without losing the refund or blocking a reasoned close', async (t) => {
  const db = await createDatabase(); t.after(() => db.close());
  const id = await recordCasual(db, { amount: 20, method: 'bank_transfer' });
  await refundCasual(db, id);
  assert.equal(Number((await cashSummary(db)).employees[0].expected_cash_amount), -20);
  const result = await closeCash(db, [{ employee_id: courierId, actual_cash_amount: 0, reason: 'Refund funded separately' }]);
  assert.equal(Number(result.employees[0].cash_variance_amount), 20);
});

test('legacy RPC rejects enabled dates and internal close is inaccessible, while historical stock-only close still works', async (t) => {
  const db = await createDatabase(); t.after(() => db.close());
  await db.exec(`set app.test_user_id = '${managerId}'; set role authenticated`);
  await assert.rejects(db.query('select public.close_daily_aggregate_stock($1,$2,null,$3)',
    [serviceDate, JSON.stringify(stockCounts), randomUUID()]), /cash reconciliation/i);
  await assert.rejects(db.query('select public.close_daily_aggregate_stock_internal($1,$2,null,$3)',
    [serviceDate, JSON.stringify(stockCounts), randomUUID()]), /permission denied/);
  await db.exec('reset role');
  assert.equal((await db.query('select count(*)::int n from public.daily_aggregate_stock_closures')).rows[0].n, 0);
  assert.equal((await db.query('select status from public.collection_runs')).rows[0].status, 'open');
  await closeCash(db, [{ employee_id: courierId, actual_cash_amount: 0, reason: null }]);
  await db.exec('set role authenticated');
  const key = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = (await db.query('select public.close_daily_aggregate_stock($1::date - 1,$2,null,$3) result',
      [serviceDate, JSON.stringify(stockCounts), key])).rows[0].result;
    assert.equal(result.status, 'closed');
  }
  await db.exec('reset role');
  assert.equal((await db.query('select count(*)::int n from public.daily_close_reconciliation_requests')).rows[0].n, 1);
});

test('installing the fix preserves old closed cash snapshots and idempotent retries', async (t) => {
  const db = await createDatabase({ applyCashFix: false }); t.after(() => db.close());
  await addPayment(db, { id: randomUUID(), amount: 100 });
  await recordCasual(db, { amount: 50 });
  const key = randomUUID();
  const counts = [{ employee_id: courierId, actual_cash_amount: 100, reason: null }];
  const before = await closeCash(db, counts, key);
  await db.exec(migration('0235_daily_close_casual_cash_and_legacy_guard.sql'));
  const expected = { ...before, employees: before.employees.map(employee => ({ ...employee, cash_source_count: 1 })) };
  assert.deepEqual(await cashSummary(db), expected);
  assert.deepEqual(await closeCash(db, counts, key), expected);
  assert.equal((await db.query('select count(*)::int n from public.daily_close_casual_cash_items')).rows[0].n, 0);
});

const allReceiversMigration = migration('0242_daily_close_all_cash_receivers.sql');
const adminId = '00000000-0000-0000-0000-000000000005';

async function allReceiversDatabase(t) {
  const db = await createDatabase();
  t.after(() => db.close());
  await db.exec(migration('0202_admin_backdated_collection_payments.sql'));
  const refunds = migration('0128_delivery_corrections_refunds_and_adjustments.sql');
  const start = refunds.indexOf('create table public.refund_settlements (');
  await db.exec(refunds.slice(start, refunds.indexOf('\n);', start) + 3));
  await db.exec(sqlFunction(refunds, 'settle_refund'));
  await db.exec(allReceiversMigration);
  await db.exec(`insert into public.users values ('${adminId}', 'Admin', 'admin', true)`);
  return db;
}

test('cash reconciliation includes trimmed nicknames without replacing full names', async (t) => {
  const db = await allReceiversDatabase(t);
  await db.exec(`
    alter table public.users add column nickname text;
    update public.users set nickname = '  ชาย  ' where id = '${courierId}';
    update public.users set nickname = '   ' where id = '${adminId}';
  `);
  await db.exec(migration('0243_daily_close_employee_nicknames.sql'));
  const summary = await cashSummary(db);
  const courier = summary.employees.find(employee => employee.employee_id === courierId);
  assert.equal(courier.employee_nickname, 'ชาย');
  assert.equal(courier.employee_name, 'Courier One');
  assert.equal(summary.employees.find(employee => employee.employee_id === adminId).employee_nickname, null);
  assert.equal(summary.employees.find(employee => employee.employee_id === managerId).employee_nickname, null);
});

test('all cash receivers: regular and casual cash belong to each recorder, refunds to the confirming actor', async (t) => {
  const db = await allReceiversDatabase(t);
  for (const [employeeId, role, amount] of [
    [courierId, 'courier', 100], [managerId, 'round_lead', 200], [adminId, 'admin', 300],
  ]) {
    await addPayment(db, { id: randomUUID(), employeeId, role, amount, receivedAmount: amount + 20, changeAmount: 20 });
    await addPayment(db, { id: randomUUID(), employeeId, role, amount: 500, method: 'qr' });
    await addPayment(db, { id: randomUUID(), employeeId, role, amount: 500, method: 'bank_transfer' });
    await addPayment(db, { id: randomUUID(), employeeId, role, amount: 500, status: 'voided' });
    await addPayment(db, { id: randomUUID(), employeeId, role, amount: 500,
      recordedAt: '2026-01-03 03:00:00+00', collectionRunId: null });
  }
  const courierSale = await recordCasual(db, { amount: 40 });
  await refundCasual(db, courierSale, { actor: managerId });
  await recordCasual(db, { amount: 60, received: 100, actor: managerId });
  await recordCasual(db, { amount: 70, loose: true, actor: adminId });
  const transferSale = await recordCasual(db, { amount: 20, method: 'bank_transfer', actor: managerId });
  await refundCasual(db, transferSale, { actor: adminId });
  const cashSale = await recordCasual(db, { amount: 30, actor: adminId });
  await refundCasual(db, cashSale, { method: 'bank_transfer', actor: adminId });

  const open = await cashSummary(db);
  assert.deepEqual(Object.fromEntries(open.employees.map(e => [e.employee_id, Number(e.expected_cash_amount)])), {
    [adminId]: 380, [courierId]: 140, [managerId]: 220,
  });
  const counts = open.employees.map(e => ({
    employee_id: e.employee_id, actual_cash_amount: Number(e.expected_cash_amount), reason: null,
  }));
  const key = randomUUID();
  const closed = await closeCash(db, counts, key);
  assert.equal(closed.status, 'closed');
  assert.ok(closed.employees.every(e => Number(e.cash_variance_amount) === 0));
  assert.equal((await db.query('select count(*)::int n from public.daily_close_payment_items')).rows[0].n, 3);
  assert.equal((await db.query('select count(*)::int n from public.daily_close_casual_cash_items')).rows[0].n, 6);
  assert.equal((await db.query('select status from public.collection_runs')).rows[0].status, 'closed');
  assert.deepEqual(await closeCash(db, counts, key), closed);
  await assert.rejects(db.exec('update public.payments set allocated_amount = 1'), /ปิดตรวจนับเงินสดแล้ว/);
  await db.exec(`update public.users set is_active = false where id = '${adminId}';
    insert into public.users values ('${newCourierId}', 'New admin', 'admin', true)`);
  const frozen = await cashSummary(db);
  assert.deepEqual(frozen.employees.map(e => [e.employee_id, e.expected_cash_amount, e.actual_cash_amount, e.payment_ids]),
    closed.employees.map(e => [e.employee_id, e.expected_cash_amount, e.actual_cash_amount, e.payment_ids]));
});

test('all cash receivers: zero counts are mandatory for every active role and stale courier-only requests fail atomically', async (t) => {
  const db = await allReceiversDatabase(t);
  const open = await cashSummary(db);
  assert.deepEqual(open.employees.map(e => e.employee_id).sort(), [courierId, managerId, adminId].sort());
  const counts = open.employees.map(e => ({ employee_id: e.employee_id, actual_cash_amount: 0, reason: null }));
  for (const id of [courierId, managerId, adminId]) {
    await assert.rejects(closeCash(db, counts.filter(e => e.employee_id !== id)), /every eligible employee/);
  }
  await assert.rejects(closeCash(db, [{ employee_id: courierId, actual_cash_amount: 0 }]), /every eligible employee/);
  await assert.rejects(closeCash(db, [...counts, counts[0]]), /one non-negative cash count/);
  await assert.rejects(closeCash(db, counts.map(e => e.employee_id === adminId ? { ...e, actual_cash_amount: null } : e)), /one non-negative cash count/);
  await assert.rejects(closeCash(db, counts.map(e => e.employee_id === adminId ? { ...e, actual_cash_amount: -1 } : e)), /one non-negative cash count/);
  for (const table of ['daily_close_reconciliation_requests', 'daily_close_employee_snapshots', 'daily_aggregate_stock_closures']) {
    assert.equal((await db.query(`select count(*)::int n from public.${table}`)).rows[0].n, 0);
  }
  assert.equal((await db.query('select status from public.collection_runs')).rows[0].status, 'open');
  assert.equal((await closeCash(db, counts)).employees.length, 3);
});

test('all cash receivers: inactive admins with cash remain eligible and manager variances require reasons', async (t) => {
  const db = await allReceiversDatabase(t);
  await recordCasual(db, { amount: 50, actor: adminId });
  await addPayment(db, { id: randomUUID(), employeeId: managerId, role: 'round_lead', amount: 100 });
  await db.exec(`update public.users set is_active = false where id = '${adminId}'`);
  const open = await cashSummary(db);
  assert.equal(open.employees.find(e => e.employee_id === adminId).is_active, false);
  const counts = [
    { employee_id: courierId, actual_cash_amount: 0, reason: null },
    { employee_id: managerId, actual_cash_amount: 90, reason: null },
    { employee_id: adminId, actual_cash_amount: 40, reason: null },
  ];
  await assert.rejects(closeCash(db, counts), /reason is required/);
  counts[1].reason = 'Lead short 10';
  await assert.rejects(closeCash(db, counts), /reason is required/);
  counts[2].reason = 'Admin short 10';
  await closeCash(db, counts);
  const issues = (await db.query(`select employee_id, variance_value, reason
    from public.daily_close_reconciliation_issues where issue_type = 'CASH_VARIANCE' order by employee_id`)).rows;
  assert.deepEqual(issues.map(e => [e.employee_id, Number(e.variance_value), e.reason]), [
    [managerId, -10, 'Lead short 10'], [adminId, -10, 'Admin short 10'],
  ]);
  const queue = (await db.query("select public.get_accounting_review_queue($1,$1,'{}',100,0) result", [serviceDate])).rows[0].result;
  assert.equal(queue.total_count, 2);
});

test('all cash receivers: migrating preserves historical courier-only snapshots and retries', async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  await addPayment(db, { id: randomUUID(), amount: 100 });
  await addPayment(db, { id: randomUUID(), employeeId: managerId, role: 'round_lead', amount: 200 });
  await recordCasual(db, { amount: 50, actor: managerId });
  const counts = [{ employee_id: courierId, actual_cash_amount: 100, reason: null }];
  const key = randomUUID();
  const before = await closeCash(db, counts, key);
  await db.exec(migration('0202_admin_backdated_collection_payments.sql'));
  const refunds = migration('0128_delivery_corrections_refunds_and_adjustments.sql');
  const start = refunds.indexOf('create table public.refund_settlements (');
  await db.exec(refunds.slice(start, refunds.indexOf('\n);', start) + 3));
  await db.exec(allReceiversMigration);
  assert.deepEqual(await cashSummary(db), before);
  assert.deepEqual(await closeCash(db, counts, key), before);
  assert.equal((await db.query('select count(*)::int n from public.daily_close_payment_items')).rows[0].n, 1);
  assert.equal((await db.query('select count(*)::int n from public.daily_close_casual_cash_items')).rows[0].n, 0);
});

async function settleRegularRefund(db, { amount = 20, actor = managerId, method = 'cash', key = randomUUID() } = {}) {
  const charge = randomUUID(), obligation = randomUUID();
  await db.query(`insert into delivery_charges(id,shop_id,service_date,status,payment_term)
    values ($1,$2,$3,'active','immediate')`, [charge, shopId, serviceDate]);
  await db.query(`insert into refund_obligations(id,source_charge_id,created_at,amount,reason,status)
    values ($1,$2,now(),$3,'Returned goods','pending')`, [obligation, charge, amount]);
  await db.exec(`set app.test_user_id = '${actor}'`);
  const result = (await db.query('select settle_refund($1,$2,null,$3) result', [obligation, method, key])).rows[0].result;
  return { key, obligation, result };
}

test('all cash receivers: regular refunds reduce the confirming person on the refund date and freeze their sources', async (t) => {
  const db = await allReceiversDatabase(t);
  const today = (await db.query("select (clock_timestamp() at time zone 'Asia/Bangkok')::date::text as date")).rows[0].date;
  await db.query('update collection_runs set service_date=$1', [today]);
  await addPayment(db, { id: randomUUID(), amount: 100, employeeId: managerId, role: 'round_lead' });
  await addPayment(db, { id: randomUUID(), amount: 50, employeeId: adminId, role: 'admin' });
  const refund = await settleRegularRefund(db);
  await settleRegularRefund(db, { actor: adminId, method: 'bank_transfer' });
  const open = await cashSummary(db, today);
  assert.equal(Number(open.employees.find(e => e.employee_id === managerId).expected_cash_amount), 80);
  assert.equal(Number(open.employees.find(e => e.employee_id === adminId).expected_cash_amount), 50);
  // The sale being refunded belongs to an old day; today's cash is what changed.
  assert.equal(Number((await cashSummary(db)).employees.find(e => e.employee_id === managerId).expected_cash_amount), 0);
  const counts = open.employees.map(e => ({ employee_id: e.employee_id, actual_cash_amount: Number(e.expected_cash_amount), reason: null }));
  const key = randomUUID();
  const closed = await closeCash(db, counts, key, today);
  const manager = closed.employees.find(e => e.employee_id === managerId);
  assert.equal(manager.cash_source_count, 2);
  assert.equal(Number(manager.cash_variance_amount), 0);
  const items = (await db.query('select * from daily_close_refund_cash_items')).rows;
  assert.equal(items.length, 1);
  assert.equal(items[0].refund_id, refund.key);
  assert.equal(Number(items[0].cash_amount), -20);
  assert.equal(items[0].source_snapshot.settled_by, managerId);
  await assert.rejects(db.exec('update daily_close_refund_cash_items set cash_amount=-1'), /cannot be changed/);
  await assert.rejects(db.exec('delete from daily_close_refund_cash_items'), /cannot be changed/);
  await db.exec(`set app.test_user_id='${managerId}'; set role authenticated`);
  assert.equal((await db.query('select count(*)::int n from daily_close_refund_cash_items')).rows[0].n, 1);
  await assert.rejects(db.exec('delete from daily_close_refund_cash_items'), /permission denied/);
  await db.exec(`set app.test_user_id='${courierId}'`);
  assert.equal((await db.query('select count(*)::int n from daily_close_refund_cash_items')).rows[0].n, 0);
  await db.exec('reset role');
  assert.deepEqual(await closeCash(db, counts, key, today), closed);
  // Replaying an existing refund is allowed; a new cash refund after close is not.
  await db.exec(`set app.test_user_id = '${managerId}'`);
  assert.equal((await db.query("select settle_refund($1,'cash',null,$2) result", [refund.obligation, refund.key])).rows[0].result.idempotent_replay, true);
  await assert.rejects(settleRegularRefund(db), /ปิดตรวจนับเงินสดแล้ว/);
  await settleRegularRefund(db, { method: 'qr' });
  assert.deepEqual(await cashSummary(db, today), closed);
});

test('all cash receivers: a refund-only inactive admin is counted even with no receipts', async (t) => {
  const db = await allReceiversDatabase(t);
  const today = (await db.query("select (clock_timestamp() at time zone 'Asia/Bangkok')::date::text as date")).rows[0].date;
  await settleRegularRefund(db, { actor: adminId, amount: 20 });
  await db.exec(`update users set is_active=false where id='${adminId}'`);
  const open = await cashSummary(db, today);
  const admin = open.employees.find(e => e.employee_id === adminId);
  assert.equal(Number(admin.expected_cash_amount), -20);
  assert.equal(admin.is_active, false);
  const counts = open.employees.map(e => ({ employee_id: e.employee_id, actual_cash_amount: 0, reason: e.employee_id === adminId ? 'Refund funded separately' : null }));
  const closed = await closeCash(db, counts, randomUUID(), today);
  assert.equal(closed.employees.find(e => e.employee_id === adminId).cash_source_count, 1);
});

test('all cash receivers: backdated receipts use the received day and cannot change a closed cash day', async (t) => {
  const db = await allReceiversDatabase(t);
  const receivedDay = '2026-01-01';
  const paymentId = randomUUID();
  await db.query('update daily_close_reconciliation_configuration set enabled_from_service_date=$1', [receivedDay]);
  await db.exec(`set app.test_user_id='${adminId}'; set app.payment_received_date='${receivedDay}'`);
  await addPayment(db, { id: paymentId, amount: 25, employeeId: adminId, role: 'admin' });
  await db.exec("set app.payment_received_date=''");
  assert.equal(Number((await cashSummary(db)).employees.find(e => e.employee_id === adminId).expected_cash_amount), 0);
  const open = await cashSummary(db, receivedDay);
  assert.equal(Number(open.employees.find(e => e.employee_id === adminId).expected_cash_amount), 25);
  const counts = open.employees.map(e => ({ employee_id: e.employee_id, actual_cash_amount: Number(e.expected_cash_amount), reason: null }));
  const key = randomUUID();
  const closed = await closeCash(db, counts, key, receivedDay);
  const snapshot = (await db.query('select * from daily_close_payment_items where payment_id=$1', [paymentId])).rows[0];
  assert.equal(Number(snapshot.allocated_amount), 25);
  assert.deepEqual(closed.employees.find(e => e.employee_id === adminId).payment_ids, [paymentId]);
  await db.exec(`set app.test_user_id='${adminId}'; set app.payment_received_date='${receivedDay}'`);
  await assert.rejects(addPayment(db, { id: randomUUID(), amount: 25, employeeId: adminId, role: 'admin' }), /ปิดตรวจนับเงินสดแล้ว/);
  await addPayment(db, { id: randomUUID(), amount: 25, employeeId: adminId, role: 'admin', method: 'bank_transfer' });
  await assert.rejects(db.query("update payments set status='voided' where id=$1", [paymentId]), /ปิดตรวจนับเงินสดแล้ว/);
  await assert.rejects(db.query('delete from payments where id=$1', [paymentId]), /ปิดตรวจนับเงินสดแล้ว/);
  await assert.rejects(db.query("update payments set received_date_override=null, recorded_at='2026-01-02T03:00:00Z' where id=$1", [paymentId]), /ปิดตรวจนับเงินสดแล้ว/);
  assert.deepEqual(await cashSummary(db, receivedDay), closed);
  assert.deepEqual(await closeCash(db, counts, key, receivedDay), closed);
});
