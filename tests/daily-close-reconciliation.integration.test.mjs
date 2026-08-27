import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
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

const courierId = '00000000-0000-0000-0000-000000000001';
const inactiveCourierId = '00000000-0000-0000-0000-000000000002';
const managerId = '00000000-0000-0000-0000-000000000003';
const newCourierId = '00000000-0000-0000-0000-000000000004';
const runId = '10000000-0000-0000-0000-000000000001';
const shopId = '50000000-0000-0000-0000-000000000001';
const serviceDate = '2026-01-02';

async function createDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create extension if not exists pgcrypto;
    create schema auth;
    create role authenticated;
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
    create function public.current_app_role() returns public.app_role language sql stable as $$
      select role from public.users where id = auth.uid() and is_active
    $$;
    create function public.is_active_user() returns boolean language sql stable as $$
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
      status text not null,
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
    create function public.close_daily_aggregate_stock(
      p_service_date date, p_counts jsonb, p_note text, p_idempotency_key uuid
    ) returns jsonb language plpgsql as $$
    begin
      if exists (select 1 from public.daily_aggregate_stock_closures where service_date = p_service_date) then
        raise exception 'Stock for this service date is already closed';
      end if;
      insert into public.daily_aggregate_stock_closures
        (service_date, status, note, idempotency_key, closed_by)
      values (p_service_date, 'closed', p_note, p_idempotency_key, auth.uid());
      insert into public.daily_aggregate_stock_closure_items
        (service_date, ice_type_id, system_quantity, actual_quantity, variance_quantity, note)
      select p_service_date, input.ice_type_id, 10, input.actual_quantity,
        input.actual_quantity - 10, input.note
      from jsonb_to_recordset(p_counts) input(ice_type_id uuid, actual_quantity numeric, note text);
      update public.collection_runs set status = 'closed', closed_by = auth.uid(), closed_at = now()
      where service_date = p_service_date and status = 'open';
      return public.get_daily_aggregate_stock_summary(p_service_date);
    end;
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
  await db.exec(foundationMigration);
  await db.exec(workflowMigration);
  await db.exec(accountingQueueMigration);
  await db.exec(`update public.daily_close_reconciliation_configuration
    set enabled_from_service_date = date '${serviceDate}' where singleton`);
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
