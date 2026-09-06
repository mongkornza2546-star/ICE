import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const readMigration = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const dashboardSource = readMigration('0043_daily_work_dashboard_and_cancellation.sql');
const correctionSource = readMigration('0128_delivery_corrections_refunds_and_adjustments.sql');
const admin = '10000000-0000-4000-8000-000000000001';
const shop = '20000000-0000-4000-8000-000000000001';
const charge = '30000000-0000-4000-8000-000000000001';

async function database(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create schema auth;
    create role authenticated;
    create function auth.uid() returns uuid language sql stable as $$ select '${admin}'::uuid $$;
    create function public.is_active_user() returns boolean language sql stable as $$ select true $$;
    create function public.current_app_role() returns text language sql stable as $$ select coalesce(nullif(current_setting('test.role', true), ''), 'admin') $$;
    create table public.users(id uuid primary key, display_name text, role text);
    create table public.shops(id uuid primary key, name text, status text default 'active');
    create table public.delivery_rounds(id uuid primary key, service_date date, round_type text, status text,
      opened_at timestamptz, closed_at timestamptz, cancelled_at timestamptz, opened_by uuid, closed_by uuid,
      cancelled_by uuid, cancellation_reason text, created_at timestamptz default now());
    create table public.delivery_round_members(round_id uuid, user_id uuid);
    create table public.delivery_events(id uuid primary key, round_stop_id uuid, recorded_by uuid);
    create table public.delivery_charges(id uuid primary key, shop_id uuid, delivery_event_id uuid,
      service_date date, status text, original_amount numeric, created_at timestamptz default now(), payment_term text);
    create table public.delivery_items(delivery_event_id uuid, ice_type_id uuid, quantity numeric);
    create table public.ice_types(id uuid primary key, name text, code text, unit text, is_active boolean);
    create table public.delivery_charge_adjustments(charge_id uuid, amount_delta numeric, status text);
    create table public.stock_movements(recorded_by uuid, recorded_at timestamptz, kind text, service_date date);
    create table public.stock_count_snapshots(counted_by uuid, counted_at timestamptz, service_date date);
    create table public.round_stops(id uuid, round_id uuid, status text, shop_code_snapshot text,
      shop_name_snapshot text, note text, updated_at timestamptz, updated_by uuid);
    create function public.get_daily_stock_count_readiness(uuid,date) returns jsonb language sql as $$ select '[]'::jsonb $$;
    create function public.daily_work_session_cancellation_blockers(uuid,date) returns text[] language sql as $$ select '{}'::text[] $$;
    insert into public.users values ('${admin}', 'Admin', 'admin');
    insert into public.shops values ('${shop}', 'ร้านทดสอบ', 'active');
    insert into public.delivery_events values ('${charge}', null, '${admin}');
    insert into public.delivery_charges values ('${charge}', '${shop}', '${charge}', '2026-09-06', 'active', 1000, now(), 'immediate');
  `);
  await db.exec(correctionSource.slice(correctionSource.indexOf('create function public.effective_delivery_charge_amount('), correctionSource.indexOf('create or replace function public.assert_payment_allocation_integrity')));
  await db.exec(dashboardSource.slice(dashboardSource.indexOf('create or replace function public.get_daily_work_dashboard('), dashboardSource.indexOf('-- 4.')));
  return db;
}

test('dashboard uses adjusted sales and recent amounts without changing original bills', async (t) => {
  const db = await database(t);
  await db.exec(readMigration('0049_fix_daily_dashboard_app_role_label.sql'));
  await db.exec(`create function public.daily_work_delivery_destination_summary(uuid, date)
    returns jsonb language sql as $$ select '{"regularShopCount":1,"eventParticipationCount":2}'::jsonb $$;`);
  const destinationSource = readMigration('0165_event_read_models_and_destination_counts.sql');
  const patchStart = destinationSource.indexOf('do $dashboard_patch$');
  await db.exec(destinationSource.slice(patchStart, destinationSource.indexOf('$dashboard_patch$;', patchStart) + '$dashboard_patch$;'.length));
  await db.exec(readMigration('0174_manager_dashboard_effective_sales.sql'));
  await db.exec(`insert into public.delivery_charge_adjustments values ('${charge}', -200, 'active'), ('${charge}', 90, 'voided');`);
  const result = await db.query(`select public.get_daily_work_dashboard('2026-09-06') as dashboard`);
  assert.equal(result.rows[0].dashboard.salesSummary.netSalesValue, 800);
  assert.equal(result.rows[0].dashboard.recentDeliveries[0].net_amount, 800);
  assert.equal(result.rows[0].dashboard.deliverySummary.eventParticipationCount, 2);
  assert.equal((await db.query(`select original_amount from public.delivery_charges`)).rows[0].original_amount, '1000');
  await db.exec(`set test.role = 'courier'`);
  await assert.rejects(db.query(`select public.get_daily_work_dashboard('2026-09-06')`), /Only a round lead or admin/);
});

const terms = {
  allowed_payment_terms: ['end_of_day'], default_payment_term: 'end_of_day', allow_outstanding: true,
  credit_due_rule: null, credit_days: null, credit_collection_weekday: null, credit_limit: null,
};
const methods = { allowed_payment_methods: ['cash', 'bank_transfer'], default_payment_method: 'bank_transfer' };

test('bulk updates are atomic, preserve unselected settings, and enforce admin access', async (t) => {
  const db = await database(t);
  const profileSource = readMigration('0029_pos_financial_foundation.sql');
  await db.exec(`
    create type public.payment_term as enum ('immediate', 'end_of_day', 'credit');
    create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');
    create type public.credit_due_rule as enum ('net_days', 'end_of_month');
  `);
  await db.exec(profileSource.slice(profileSource.indexOf('create table public.shop_payment_profiles ('), profileSource.indexOf('-- Nullable snapshots')));
  await db.exec(`
    alter table public.shop_payment_profiles add column credit_collection_weekday integer;
    alter table public.shop_payment_profiles alter column bank_transfer_reference_required set default false,
      alter column bank_transfer_evidence_required set default true;
    insert into public.users values ('10000000-0000-4000-8000-000000000002', 'Original creator', 'admin');
    insert into public.shop_payment_profiles (shop_id, allowed_payment_terms, default_payment_term,
      allowed_payment_methods, default_payment_method, created_by,
      cash_reference_required, cash_evidence_required, qr_reference_required, qr_evidence_required)
    values ('${shop}', '{immediate}', 'immediate', '{cash}', 'cash', '10000000-0000-4000-8000-000000000002', true, true, false, true);
  `);
  await db.exec(readMigration('0175_bulk_payment_profile_patch.sql'));
  const original = (await db.query('select * from public.shop_payment_profiles')).rows[0];
  const apply = (ids, termPatch, methodPatch) => db.query(
    'select public.bulk_update_shop_payment_profiles($1::uuid[], $2::jsonb, $3::jsonb) as count',
    [ids, termPatch, methodPatch],
  );
  await apply([shop], terms, null);
  let updated = (await db.query('select * from public.shop_payment_profiles')).rows[0];
  assert.equal(updated.default_payment_term, 'end_of_day');
  assert.equal(updated.default_payment_method, 'cash');
  for (const key of ['created_by', 'cash_reference_required', 'cash_evidence_required', 'bank_transfer_reference_required',
    'bank_transfer_evidence_required', 'qr_reference_required', 'qr_evidence_required']) assert.deepEqual(updated[key], original[key], key);
  await apply([shop], null, methods);
  updated = (await db.query('select * from public.shop_payment_profiles')).rows[0];
  assert.equal(updated.default_payment_term, 'end_of_day');
  assert.equal(updated.default_payment_method, 'bank_transfer');
  await assert.rejects(apply([shop], { ...terms, cash_evidence_required: false }, null), /เฉพาะรูปแบบ/);
  await assert.rejects(apply([shop], null, { ...methods, default_payment_method: 'qr' }), /check constraint/);
  await assert.rejects(apply([shop, 'ffffffff-ffff-4fff-8fff-ffffffffffff'], {
    ...terms, allowed_payment_terms: ['immediate'], default_payment_term: 'immediate',
  }, null), /ไม่มีอยู่/);
  assert.deepEqual((await db.query('select * from public.shop_payment_profiles')).rows[0], updated);
  await db.exec(`set test.role = 'round_lead'`);
  await assert.rejects(apply([shop], terms, null), /เฉพาะแอดมิน/);
  await db.exec(`set test.role = 'admin'; insert into public.shops values ('20000000-0000-4000-8000-000000000002', 'ใหม่', 'active');`);
  const newShop = '20000000-0000-4000-8000-000000000002';
  await assert.rejects(apply([newShop], terms, null), /ยังไม่เคยตั้งค่า/);
  await apply([newShop], terms, methods);
  const created = (await db.query('select * from public.shop_payment_profiles where shop_id = $1', [newShop])).rows[0];
  assert.equal(created.bank_transfer_evidence_required, true);
  assert.equal(created.created_by, admin);
});
