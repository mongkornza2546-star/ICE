import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const container = `ice-financial-concurrency-${process.pid}`;
const courierId = '00000000-0000-0000-0000-000000000001';
const secondCourierId = '00000000-0000-0000-0000-000000000002';
const adminId = '00000000-0000-0000-0000-000000000003';
const shopId = '10000000-0000-0000-0000-000000000001';

function docker(args, options = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...options });
}

function psql(sql) {
  const result = docker([
    'exec', '-i', container, 'psql', '-U', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-At',
  ], { input: sql });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function psqlConcurrent(sql) {
  return new Promise((resolve) => {
    const child = spawn('docker', [
      'exec', '-i', container, 'psql', '-U', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-At',
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(sql);
  });
}

function session(userId, sql) {
  return `begin; set local app.test_user_id = '${userId}'; ${sql}; commit;`;
}

const foundation = `
  create extension if not exists pgcrypto;
  create schema auth;
  create role authenticated;
  create type public.app_role as enum ('courier', 'round_lead', 'admin');
  create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');
  create type public.collection_run_status as enum ('open', 'closed');

  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('app.test_user_id', true), '')::uuid
  $$;
  create table public.users (
    id uuid primary key, display_name text not null, role public.app_role not null,
    is_active boolean not null, can_collect_shop_payments boolean not null default false
  );
  create function public.current_app_role() returns public.app_role language sql stable as $$
    select role from public.users where id = auth.uid() and is_active
  $$;
  create function public.is_active_user() returns boolean language sql stable as $$
    select exists (select 1 from public.users where id = auth.uid() and is_active)
  $$;
  create function public.can_collect_shop_payments() returns boolean language sql stable as $$
    select coalesce((select is_active and (role in ('admin', 'round_lead')
      or (role = 'courier' and can_collect_shop_payments))
      from public.users where id = auth.uid()), false)
  $$;

  create table public.collection_runs (
    id uuid primary key default gen_random_uuid(), service_date date not null,
    status public.collection_run_status not null default 'open', opened_by uuid not null,
    opened_at timestamptz not null default now(), closed_by uuid, closed_at timestamptz
  );
  create unique index collection_runs_one_open_per_day_idx
    on public.collection_runs(service_date) where status = 'open';
  create table public.collection_run_members (collection_run_id uuid, user_id uuid);
  create table public.daily_aggregate_stock_closures (
    service_date date primary key, status text not null default 'closed',
    note text, idempotency_key uuid unique, closed_by uuid, closed_at timestamptz not null default now()
  );
  create table public.daily_aggregate_stock_closure_items (
    service_date date not null, ice_type_id uuid not null,
    system_quantity numeric(12,1) not null, actual_quantity numeric(12,1) not null,
    variance_quantity numeric(12,1) not null, note text,
    primary key (service_date, ice_type_id)
  );
  create table public.audit_logs (
    id uuid primary key default gen_random_uuid(), actor_id uuid, entity_type text,
    entity_id uuid, action text, before_value jsonb, after_value jsonb, reason text,
    occurred_at timestamptz not null default now()
  );
  create table public.delivery_charges (
    id uuid primary key, status text not null, payment_term text not null, due_date date
  );
  create table public.payments (
    id uuid primary key default gen_random_uuid(), shop_id uuid, collection_run_id uuid,
    payment_method public.payment_method not null default 'cash',
    allocated_amount numeric(12,2) not null default 1,
    status text not null default 'active', recorded_by uuid not null,
    recorded_role public.app_role not null default 'courier',
    recorded_at timestamptz not null default now(), idempotency_key uuid unique
  );
  create table public.payment_allocations (payment_id uuid not null, charge_id uuid not null);

  create function public.is_collection_run_member(uuid) returns boolean language sql as $$ select false $$;
  create function public.is_payment_visible(uuid) returns boolean language sql as $$ select true $$;
  create function public.is_financial_charge_visible(uuid) returns boolean language sql as $$ select true $$;
  create function public.is_charge_collectible_in_run(uuid, uuid) returns boolean language sql as $$ select false $$;
  create function public.open_collection_run(date, jsonb) returns jsonb language sql as $$ select '{}'::jsonb $$;
  create function public.get_collection_run_queue(uuid) returns jsonb language sql as $$ select '[]'::jsonb $$;
  create function public.get_today_collection_run_queue(uuid) returns jsonb language sql as $$ select '[]'::jsonb $$;

  create function public.record_payment(
    p_shop_id uuid, p_allocations jsonb, p_payment_method public.payment_method,
    p_received_amount numeric, p_reference_number text, p_evidence_path text,
    p_collection_run_id uuid, p_expected_outstanding_amount numeric,
    p_approval_id uuid, p_idempotency_key uuid
  ) returns jsonb language plpgsql as $$
  declare v_profile record; v_remaining_outstanding numeric := 0;
  begin
    select true as allow_outstanding into v_profile;
    if not v_profile.allow_outstanding and v_remaining_outstanding > 0 and exists (
      select 1
    ) then null; end if;
    insert into public.payments (
      shop_id, collection_run_id, payment_method, allocated_amount,
      recorded_by, recorded_role, idempotency_key
    ) values (
      p_shop_id, p_collection_run_id, p_payment_method, p_received_amount,
      auth.uid(), public.current_app_role(), p_idempotency_key
    );
    return jsonb_build_object('recorded', true);
  end;
  $$;
  create function public.void_payment(p_payment_id uuid, p_reason text)
  returns jsonb language plpgsql as $$
  declare v_payment public.payments%rowtype;
  begin
    select * into v_payment from public.payments where id = p_payment_id for update;
    if v_payment.recorded_by <> auth.uid() then raise exception 'not owner'; end if;
    if v_payment.status <> 'active' then raise exception 'already voided'; end if;
    update public.payments set status = 'voided' where id = p_payment_id;
    return jsonb_build_object('status', 'voided');
  end;
  $$;
  create function public.close_daily_aggregate_stock(
    p_service_date date, p_counts jsonb, p_note text, p_idempotency_key uuid
  ) returns jsonb language plpgsql as $$
  begin
    insert into public.daily_aggregate_stock_closures(service_date, idempotency_key)
    values (p_service_date, p_idempotency_key);
    return jsonb_build_object('closed', true);
  end;
  $$;
  create function public.get_daily_aggregate_stock_summary(p_service_date date)
  returns jsonb language sql stable as $$
    select jsonb_build_object(
      'service_date', p_service_date,
      'status', case when exists (select 1 from public.daily_aggregate_stock_closures
        where service_date = p_service_date) then 'closed' else 'open' end,
      'items', '[]'::jsonb
    )
  $$;
  create function public.close_collection_run(uuid) returns jsonb language sql as $$ select '{}'::jsonb $$;
  create function public.set_credit_charge_collection_assignment(uuid, uuid, boolean)
  returns jsonb language sql as $$ select '{}'::jsonb $$;
  create function public.get_accounting_shop_summary(date, date, jsonb, integer, integer)
  returns jsonb language sql stable as $$
    select jsonb_build_object('totals', jsonb_build_object('cash_received_in_period', 0))
  $$;

  alter table public.payment_allocations enable row level security;
  create policy "assigned users read payment allocations"
    on public.payment_allocations for select
    using (public.is_payment_visible(payment_id) or public.is_financial_charge_visible(charge_id));

  insert into public.users values
    ('${courierId}', 'Courier One', 'courier', true, true),
    ('${secondCourierId}', 'Courier Two', 'courier', true, true),
    ('${adminId}', 'Admin', 'admin', true, false);
`;

try {
  const started = docker([
    'run', '--rm', '-d', '--name', container,
    '-e', 'POSTGRES_PASSWORD=test', 'postgres:16',
  ]);
  if (started.status !== 0) throw new Error(started.stderr);

  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (docker(['exec', container, 'pg_isready', '-U', 'postgres']).status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, 'PostgreSQL container did not become ready');

  psql(foundation);
  psql(readFileSync(new URL('../supabase/migrations/0159_automatic_collection_context_authorization.sql', import.meta.url), 'utf8'));

  const ensureResults = await Promise.all([
    psqlConcurrent(session(courierId, "select public.ensure_daily_collection_context((clock_timestamp() at time zone 'Asia/Bangkok')::date)")),
    psqlConcurrent(session(secondCourierId, "select public.ensure_daily_collection_context((clock_timestamp() at time zone 'Asia/Bangkok')::date)")),
  ]);
  assert.deepEqual(ensureResults.map((result) => result.code), [0, 0]);
  assert.equal(psql("select count(*) from public.collection_runs"), '1');
  assert.equal(psql("select count(*) from public.audit_logs where action = 'auto_opened'"), '1');

  const runId = psql('select id from public.collection_runs');
  const paymentKey = randomUUID();
  const closeKey = randomUUID();
  const paymentAndClose = await Promise.all([
    psqlConcurrent(session(courierId, `select public.record_payment(
      '${shopId}', '[]'::jsonb, 'cash', 10, null, null,
      '${runId}', 10, null, '${paymentKey}'
    )`)),
    psqlConcurrent(session(adminId, `select public.close_daily_aggregate_stock(
      (clock_timestamp() at time zone 'Asia/Bangkok')::date,
      '[]'::jsonb, null, '${closeKey}'
    )`)),
  ]);
  assert.equal(paymentAndClose[1].code, 0);
  assert.equal(psql(`select status from public.collection_runs where id = '${runId}'`), 'closed');
  assert.ok(
    paymentAndClose[0].code === 0 || /stale or closed/i.test(paymentAndClose[0].stderr),
    paymentAndClose[0].stderr,
  );

  psql(readFileSync(new URL('../supabase/migrations/0160_cash_handover_dark_launch.sql', import.meta.url), 'utf8'));
  psql(readFileSync(new URL('../supabase/migrations/0161_cash_handover_workflow.sql', import.meta.url), 'utf8'));
  const reconciliationDate = psql("select ((clock_timestamp() at time zone 'Asia/Bangkok')::date + 1)::text");
  const reconciliationRunId = randomUUID();
  psql(`
    update public.daily_close_reconciliation_configuration
    set enabled_from_service_date = date '${reconciliationDate}';
    insert into public.collection_runs (id, service_date, opened_by)
    values ('${reconciliationRunId}', date '${reconciliationDate}', '${adminId}');
    insert into public.payments (
      id, shop_id, collection_run_id, payment_method, allocated_amount, status,
      recorded_by, recorded_role, recorded_at, idempotency_key
    ) values (
      '20000000-0000-0000-0000-000000000099', '${shopId}', '${reconciliationRunId}', 'cash', 100,
      'active', '${secondCourierId}', 'courier', now(), '${randomUUID()}'
    );
  `);

  const cashCounts = JSON.stringify([
    { employee_id: courierId, actual_cash_amount: 0, reason: null },
    { employee_id: secondCourierId, actual_cash_amount: 100, reason: null },
  ]);
  const closeResults = await Promise.all([
    psqlConcurrent(session(adminId, `select public.close_daily_reconciliation_v2(
      date '${reconciliationDate}', '[]'::jsonb, '${cashCounts}'::jsonb,
      null, '${randomUUID()}'
    )`)),
    psqlConcurrent(session(adminId, `select public.close_daily_reconciliation_v2(
      date '${reconciliationDate}', '[]'::jsonb, '${cashCounts}'::jsonb,
      null, '${randomUUID()}'
    )`)),
  ]);
  assert.deepEqual(closeResults.map((result) => result.code).sort(), [0, 3]);
  assert.equal(psql(`select count(*) from public.daily_close_reconciliation_requests
    where service_date = date '${reconciliationDate}'`), '1');
  assert.equal(psql(`select count(*) from public.daily_close_employee_snapshots
    where service_date = date '${reconciliationDate}'`), '2');
  assert.equal(psql(`select count(*) from public.daily_close_payment_items
    where service_date = date '${reconciliationDate}'`), '1');

  console.log('Real PostgreSQL concurrency checks passed');
} finally {
  docker(['rm', '-f', container]);
}
