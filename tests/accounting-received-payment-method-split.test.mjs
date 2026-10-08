import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0212_accounting_received_cash_transfer_split.sql', import.meta.url),
  'utf8',
);
const accounting0143 = readFileSync(
  new URL('../supabase/migrations/0143_accounting_shop_summary.sql', import.meta.url),
  'utf8',
);
const activeShops0144 = readFileSync(
  new URL('../supabase/migrations/0144_accounting_all_active_shops.sql', import.meta.url),
  'utf8',
);
const areaGroups0145 = readFileSync(
  new URL('../supabase/migrations/0145_accounting_shop_summary_area_groups.sql', import.meta.url),
  'utf8',
);
const casual0154 = readFileSync(
  new URL('../supabase/migrations/0154_casual_measured_transactions.sql', import.meta.url),
  'utf8',
);

test('migration script includes required payment method filters and fields', () => {
  assert.match(migration, /payment\.payment_method = 'cash'/);
  assert.match(migration, /payment\.payment_method in \('bank_transfer', 'qr'\)/);
  assert.match(migration, /'cash_in_period'/);
  assert.match(migration, /'transfer_in_period'/);
  assert.match(migration, /'cash_received_in_period'/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
});

async function setupBaseDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role authenticated;
    create type public.payment_term as enum ('immediate', 'end_of_day', 'credit');
    create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');
    create type public.financial_record_status as enum ('active', 'voided');
    create type public.shop_status as enum ('active', 'inactive');
    create function public.is_active_user() returns boolean language sql stable as $$ select true $$;
    create function public.current_app_role() returns text language sql stable as $$ select 'admin'::text $$;
    create table public.users (id uuid primary key, display_name text not null);
    create table public.buildings (id uuid primary key, code text not null unique default gen_random_uuid()::text, name text not null, is_active boolean not null default true, created_at timestamptz not null default now(), sort_order integer not null default 1);
    create table public.building_zones (id uuid primary key, building_id uuid not null references public.buildings(id), name text not null, sort_order integer not null default 1, is_active boolean not null default true);
    create table public.shops (id uuid primary key, code text not null, name text not null, building_id uuid not null references public.buildings(id), zone_id uuid not null references public.building_zones(id), status public.shop_status not null default 'active', delivery_sequence integer, payment_term public.payment_term, event_job_id uuid);
    create table public.shop_payment_profiles (shop_id uuid primary key references public.shops(id), allowed_payment_terms public.payment_term[] not null, default_payment_term public.payment_term not null);
    create table public.delivery_rounds (id uuid primary key, service_date date not null, round_type text not null default 'daily', opened_at timestamptz not null default now(), cancelled_at timestamptz, created_at timestamptz not null default now());
    create table public.round_stops (id uuid primary key, shop_id uuid not null references public.shops(id), building_id_snapshot uuid not null, building_name_snapshot text not null, floor_or_zone_snapshot text not null, round_id uuid references public.delivery_rounds(id), sequence_no integer, status text not null default 'pending', updated_at timestamptz not null default now());
    create table public.delivery_events (id uuid primary key, round_stop_id uuid not null references public.round_stops(id), recorded_by uuid not null references public.users(id), status text not null, recorded_at timestamptz not null);
    create table public.delivery_charges (id uuid primary key, delivery_event_id uuid not null references public.delivery_events(id), shop_id uuid not null references public.shops(id), service_date date not null, payment_term public.payment_term not null, due_date date, original_amount numeric(12,2) not null, status public.financial_record_status not null, charge_number text not null default gen_random_uuid()::text);
    create table public.payments (id uuid primary key, shop_id uuid not null references public.shops(id), payment_method public.payment_method not null, allocated_amount numeric(12,2) not null, status public.financial_record_status not null, recorded_at timestamptz not null, evidence_path text);
    create table public.payment_allocations (payment_id uuid not null references public.payments(id), charge_id uuid not null references public.delivery_charges(id), amount numeric(12,2) not null, primary key (payment_id, charge_id));
    create table public.ice_types (id uuid primary key, code text not null, name text not null, unit text not null);
    create table public.delivery_items (delivery_event_id uuid not null references public.delivery_events(id), ice_type_id uuid not null references public.ice_types(id), quantity numeric(12,1) not null, unit_price numeric(12,2) not null, line_total numeric(12,2) not null, primary key (delivery_event_id, ice_type_id));
    create table public.delivery_charge_adjustments (idempotency_key uuid primary key, charge_id uuid not null references public.delivery_charges(id), amount_delta numeric(12,2) not null, status public.financial_record_status not null, scope text not null default 'round_closed', corrected_total numeric(12,2) not null default 0, reason text not null default 'Adjustment', created_at timestamptz not null default now());
    create table public.delivery_adjustment_items (adjustment_id uuid not null references public.delivery_charge_adjustments(idempotency_key), ice_type_id uuid not null references public.ice_types(id), original_quantity numeric(12,1) not null, corrected_quantity numeric(12,1) not null, quantity_delta numeric(12,1) not null, unit_price numeric(12,2) not null, primary key (adjustment_id, ice_type_id));
    create table public.payment_receipt_snapshots (payment_id uuid primary key references public.payments(id), receipt_data jsonb not null, created_at timestamptz not null default now());
    create table public.refund_obligations (id uuid primary key, payment_id uuid not null references public.payments(id), source_charge_id uuid not null references public.delivery_charges(id), amount numeric(12,2) not null, status text not null);
    create function public.effective_delivery_charge_amount(p_charge_id uuid) returns numeric language sql stable as $$ select coalesce((select original_amount from public.delivery_charges where id = p_charge_id), 0) $$;
    create function public.ensure_daily_delivery_round(p_service_date date) returns uuid language sql as $$ select gen_random_uuid() $$;
  `);
  await db.exec(accounting0143);
  await db.exec(activeShops0144);
  await db.exec(areaGroups0145);
  return db;
}

test('migration splits cash and transfer receipts correctly and is idempotent', async (t) => {
  const db = await setupBaseDatabase(t);

  const shopId = '20000000-0000-4000-8000-000000000001';
  const bldgId = '30000000-0000-4000-8000-000000000001';
  const zoneId = '40000000-0000-4000-8000-000000000001';

  await db.exec(`
    insert into public.users values ('10000000-0000-4000-8000-000000000001', 'Admin');
    insert into public.buildings (id, name) values ('${bldgId}', 'Bldg 1');
    insert into public.building_zones values ('${zoneId}', '${bldgId}', 'Zone 1');
    insert into public.shops values ('${shopId}', 'S01', 'Shop 1', '${bldgId}', '${zoneId}', 'active');
    insert into public.shop_payment_profiles values ('${shopId}', array['immediate']::public.payment_term[], 'immediate');

    -- Cash payment
    insert into public.payments (id, shop_id, payment_method, allocated_amount, status, recorded_at)
    values (gen_random_uuid(), '${shopId}', 'cash', 100, 'active', '2026-10-01 10:00:00+07');

    -- Transfer payment
    insert into public.payments (id, shop_id, payment_method, allocated_amount, status, recorded_at)
    values (gen_random_uuid(), '${shopId}', 'bank_transfer', 60, 'active', '2026-10-01 11:00:00+07');

    -- QR payment (grouped with transfer)
    insert into public.payments (id, shop_id, payment_method, allocated_amount, status, recorded_at)
    values (gen_random_uuid(), '${shopId}', 'qr', 40, 'active', '2026-10-01 12:00:00+07');
  `);

  // Apply migration 0212
  await db.exec(migration);

  const res1 = await db.query(`
    select public.get_accounting_shop_summary('2026-10-01'::date, '2026-10-01'::date) as summary
  `);
  const totals1 = res1.rows[0].summary.totals;
  assert.equal(totals1.cash_received_in_period, 200);
  assert.equal(totals1.cash_in_period, 100);
  assert.equal(totals1.transfer_in_period, 100);

  // Idempotent re-run
  await db.exec(migration);
  const res2 = await db.query(`
    select public.get_accounting_shop_summary('2026-10-01'::date, '2026-10-01'::date) as summary
  `);
  const totals2 = res2.rows[0].summary.totals;
  assert.equal(totals2.cash_received_in_period, 200);
  assert.equal(totals2.cash_in_period, 100);
  assert.equal(totals2.transfer_in_period, 100);
});

test('migration works when casual wrapper 0154 has renamed the function', async (t) => {
  const db = await setupBaseDatabase(t);
  await db.exec(`
    alter function public.get_accounting_shop_summary(date, date, jsonb, integer, integer)
      rename to get_accounting_shop_summary_without_casual;

    create function public.get_accounting_shop_summary(
      p_from_date date,
      p_to_date date,
      p_filters jsonb default '{}'::jsonb,
      p_limit integer default 100,
      p_offset integer default 0
    )
    returns jsonb language plpgsql as $$
    begin
      return public.get_accounting_shop_summary_without_casual(p_from_date, p_to_date, p_filters, p_limit, p_offset);
    end;
    $$;
  `);

  const shopId = '20000000-0000-4000-8000-000000000002';
  const bldgId = '30000000-0000-4000-8000-000000000002';
  const zoneId = '40000000-0000-4000-8000-000000000002';

  await db.exec(`
    insert into public.users values ('10000000-0000-4000-8000-000000000002', 'Admin 2');
    insert into public.buildings (id, name) values ('${bldgId}', 'Bldg 2');
    insert into public.building_zones values ('${zoneId}', '${bldgId}', 'Zone 2');
    insert into public.shops values ('${shopId}', 'S02', 'Shop 2', '${bldgId}', '${zoneId}', 'active');
    insert into public.shop_payment_profiles values ('${shopId}', array['immediate']::public.payment_term[], 'immediate');

    insert into public.payments (id, shop_id, payment_method, allocated_amount, status, recorded_at)
    values (gen_random_uuid(), '${shopId}', 'cash', 250, 'active', '2026-10-02 10:00:00+07');

    insert into public.payments (id, shop_id, payment_method, allocated_amount, status, recorded_at)
    values (gen_random_uuid(), '${shopId}', 'bank_transfer', 150, 'active', '2026-10-02 11:00:00+07');
  `);

  await db.exec(migration);

  const res = await db.query(`
    select public.get_accounting_shop_summary('2026-10-02'::date, '2026-10-02'::date) as summary
  `);
  const totals = res.rows[0].summary.totals;
  assert.equal(totals.cash_received_in_period, 400);
  assert.equal(totals.cash_in_period, 250);
  assert.equal(totals.transfer_in_period, 150);
});
