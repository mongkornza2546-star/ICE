import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0159_automatic_collection_context_authorization.sql', import.meta.url),
  'utf8',
);
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create role authenticated;
    create type public.app_role as enum ('courier', 'round_lead', 'admin');
    create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');
    create type public.collection_run_status as enum ('open', 'closed');

    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.test_user_id', true), '')::uuid
    $$;
    create table public.users (
      id uuid primary key, role public.app_role not null, is_active boolean not null,
      can_collect_shop_payments boolean not null default false
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
    create unique index collection_runs_one_open_per_day_idx on public.collection_runs(service_date) where status = 'open';
    create table public.collection_run_members (collection_run_id uuid, user_id uuid);
    create table public.daily_aggregate_stock_closures (
      service_date date primary key, status text not null default 'closed'
    );
    create table public.audit_logs (
      actor_id uuid, entity_type text, entity_id uuid, action text, after_value jsonb
    );
    create table public.delivery_charges (
      id uuid primary key, status text not null, payment_term text not null, due_date date
    );
    create table public.payments (
      id uuid primary key, shop_id uuid not null, collection_run_id uuid,
      status text not null default 'active', recorded_by uuid not null
    );
    create table public.payment_allocations (
      payment_id uuid not null, charge_id uuid not null
    );

    create function public.is_collection_run_member(uuid) returns boolean language sql as $$ select false $$;
    create function public.is_payment_visible(uuid) returns boolean language sql as $$ select false $$;
    create function public.is_financial_charge_visible(uuid) returns boolean language sql as $$ select true $$;
    create function public.is_charge_collectible_in_run(uuid, uuid) returns boolean language sql as $$ select false $$;
    create function public.open_collection_run(date, jsonb) returns jsonb language sql as $$ select '{}'::jsonb $$;
    create function public.get_collection_run_queue(uuid) returns jsonb language sql as $$
      select jsonb_build_object('called', true)
    $$;
    create function public.get_today_collection_run_queue(uuid) returns jsonb language sql as $$
      select jsonb_build_object('called', true)
    $$;

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
      return jsonb_build_object('called', true);
    end;
    $$;
    create function public.void_payment(uuid, text) returns jsonb language sql as $$
      select jsonb_build_object('called', true)
    $$;
    create function public.close_daily_aggregate_stock(date, jsonb, text, uuid)
    returns jsonb language sql as $$ select jsonb_build_object('closed', true) $$;
    create function public.close_collection_run(uuid) returns jsonb language sql as $$ select '{}'::jsonb $$;
    create function public.set_credit_charge_collection_assignment(uuid, uuid, boolean)
    returns jsonb language sql as $$ select '{}'::jsonb $$;

    alter table public.payment_allocations enable row level security;
    create policy "assigned users read payment allocations"
      on public.payment_allocations for select
      using (public.is_payment_visible(payment_id) or public.is_financial_charge_visible(charge_id));

    insert into public.users values
      ('00000000-0000-0000-0000-000000000001', 'courier', true, false),
      ('00000000-0000-0000-0000-000000000002', 'courier', true, true),
      ('00000000-0000-0000-0000-000000000003', 'admin', true, false);
  `);
  await db.exec(migration);
  return db;
}

test('ensure is current-day, capability-gated, idempotent, and member-free', async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  await db.exec("set app.test_user_id = '00000000-0000-0000-0000-000000000001'");
  await assert.rejects(db.query(`select public.ensure_daily_collection_context('${today}')`), /cannot collect/i);

  await db.exec("update public.users set can_collect_shop_payments = true where id = '00000000-0000-0000-0000-000000000001'");
  const first = await db.query(`select public.ensure_daily_collection_context('${today}') as context`);
  const second = await db.query(`select public.ensure_daily_collection_context('${today}') as context`);
  assert.equal(first.rows[0].context.collection_run_id, second.rows[0].context.collection_run_id);
  assert.equal((await db.query('select count(*)::int as count from public.collection_runs')).rows[0].count, 1);
  assert.equal((await db.query("select count(*)::int as count from public.audit_logs where action = 'auto_opened'")).rows[0].count, 1);
  assert.equal((await db.query('select count(*)::int as count from public.collection_run_members')).rows[0].count, 0);
  await assert.rejects(db.query(`select public.ensure_daily_collection_context(date '${today}' - 1)`), /current Bangkok business date/i);
});

test('collection payment authorization is enforced again after the financial locks', async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  await db.exec("set app.test_user_id = '00000000-0000-0000-0000-000000000002'");
  const context = (await db.query(`select public.ensure_daily_collection_context('${today}') as context`)).rows[0].context;
  const args = `'10000000-0000-0000-0000-000000000001', '[]'::jsonb, 'cash', 1, null, null,
    '${context.collection_run_id}', 1, null, '20000000-0000-0000-0000-000000000001'`;
  const allowed = await db.query(`select public.record_payment(${args}) as result`);
  assert.equal(allowed.rows[0].result.called, true);

  await db.exec("update public.users set can_collect_shop_payments = false where id = '00000000-0000-0000-0000-000000000002'");
  await assert.rejects(db.query(`select public.record_payment(${args})`), /cannot collect/i);
});

test('manager queue access rejects legacy open contexts outside the current Bangkok date', async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  await db.exec("set app.test_user_id = '00000000-0000-0000-0000-000000000003'");
  const current = (await db.query(`select public.ensure_daily_collection_context('${today}') as context`)).rows[0].context;
  assert.equal(
    (await db.query(`select public.get_collection_run_queue('${current.collection_run_id}') as queue`)).rows[0].queue.called,
    true,
  );

  const future = (await db.query(`insert into public.collection_runs (service_date, opened_by)
    values (date '${today}' + 1, '00000000-0000-0000-0000-000000000003') returning id`)).rows[0].id;
  await assert.rejects(
    db.query(`select public.get_collection_run_queue('${future}')`),
    /stale or closed/i,
  );
  await assert.rejects(
    db.query(`select public.get_today_collection_run_queue('${future}')`),
    /stale or closed/i,
  );
});

test('legacy membership no longer exposes another courier payment', async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  await db.exec("set app.test_user_id = '00000000-0000-0000-0000-000000000001'");
  await db.exec(`insert into public.payments values (
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001', null, 'active',
    '00000000-0000-0000-0000-000000000002'
  )`);
  const visible = await db.query("select public.is_payment_visible('30000000-0000-0000-0000-000000000001') as visible");
  assert.equal(visible.rows[0].visible, false);
});

test('payment allocation RLS follows payment visibility only', async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  const policy = await db.query(`
    select pg_get_expr(policy.polqual, policy.polrelid) as qualification
    from pg_policy policy
    where policy.polrelid = 'public.payment_allocations'::regclass
      and policy.polname = 'assigned users read payment allocations'
  `);
  assert.equal(policy.rows.length, 1);
  assert.match(policy.rows[0].qualification, /is_payment_visible\(payment_id\)/);
  assert.doesNotMatch(policy.rows[0].qualification, /is_financial_charge_visible/);
});
