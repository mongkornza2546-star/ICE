import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const receiptMigration = readFileSync(
  new URL('../supabase/migrations/0101_factory_receipt_totals.sql', import.meta.url),
  'utf8',
);
const reconciliationMigration = readFileSync(
  new URL('../supabase/migrations/0103_restore_order_based_truck_stock.sql', import.meta.url),
  'utf8',
);

const USER_ID = '10000000-0000-4000-8000-000000000001';
const TRUCK_ID = '10000000-0000-4000-8000-000000000002';
const TEAM_ID = '10000000-0000-4000-8000-000000000003';
const ICE_ID = '10000000-0000-4000-8000-000000000004';
const ORDER_ID = '10000000-0000-4000-8000-000000000010';
const TRANSFER_ID = '10000000-0000-4000-8000-000000000011';

async function createDb(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select '${USER_ID}'::uuid $$;
    create role authenticated;
    create function public.is_active_user() returns boolean language sql stable as $$ select true $$;
    create function public.current_app_role() returns text language sql stable as $$ select 'admin' $$;

    create table public.users (id uuid primary key);
    create table public.stock_locations (
      id uuid primary key, code text not null, name text not null, kind text not null,
      is_active boolean not null, is_courier_source boolean not null
    );
    create table public.ice_types (id uuid primary key, code text not null, name text not null, unit text not null);
    create table public.stock_movements (
      id uuid primary key default gen_random_uuid(), service_date date not null, kind text not null,
      from_location_id uuid, to_location_id uuid, status text not null default 'active',
      recorded_by uuid not null, recorded_at timestamptz not null default now()
    );
    create table public.stock_movement_items (
      movement_id uuid not null references public.stock_movements(id), ice_type_id uuid not null,
      quantity numeric(12, 1) not null, primary key (movement_id, ice_type_id)
    );
    create table public.delivery_rounds (id uuid primary key, service_date date not null);
    create table public.round_stops (id uuid primary key, round_id uuid not null references public.delivery_rounds(id));
    create table public.delivery_events (
      id uuid primary key, round_stop_id uuid not null references public.round_stops(id),
      source_stock_location_id uuid not null, status text not null
    );
    create table public.delivery_items (
      delivery_event_id uuid not null, ice_type_id uuid not null, quantity numeric(12, 1) not null
    );
    create table public.daily_stock_closures (service_date date primary key, status text not null);
    create table public.daily_stock_closure_items (
      service_date date not null, location_id uuid not null, ice_type_id uuid not null,
      variance_quantity numeric(12, 1) not null
    );
    create table public.audit_logs (
      actor_id uuid, entity_type text, entity_id uuid, action text, after_value jsonb
    );

    insert into public.users values ('${USER_ID}');
    insert into public.stock_locations values
      ('${TRUCK_ID}', 'TRUCK-01', 'รถบรรทุกหลัก', 'truck', true, true),
      ('${TEAM_ID}', 'TEAM-01', 'ผู้ดูแล', 'team', true, false);
    insert into public.ice_types values ('${ICE_ID}', 'ICE-01', 'หลอดเล็ก', 'ถุง');
  `);
  await db.exec(receiptMigration);
  await db.exec(reconciliationMigration);
  return db;
}

async function seedOrderAndTransfer(db) {
  await db.exec(`
    insert into public.stock_movements (
      id, service_date, kind, from_location_id, to_location_id, recorded_by
    ) values
      (
        '${ORDER_ID}', date '2026-07-27', 'factory_order', null,
        '${TRUCK_ID}', '${USER_ID}'
      ),
      (
        '${TRANSFER_ID}', date '2026-07-27', 'transfer', '${TRUCK_ID}',
        '${TEAM_ID}', '${USER_ID}'
      );
    insert into public.stock_movement_items values
      ('${ORDER_ID}', '${ICE_ID}', 20),
      ('${TRANSFER_ID}', '${ICE_ID}', 5);
  `);
}

test('factory orders immediately become truck stock without a receipt step', async (t) => {
  const db = await createDb(t);
  await db.exec(`
    insert into public.stock_movements (
      id, service_date, kind, to_location_id, recorded_by
    ) values (
      '${ORDER_ID}', date '2026-07-27', 'factory_order', '${TRUCK_ID}', '${USER_ID}'
    );
    insert into public.stock_movement_items values ('${ORDER_ID}', '${ICE_ID}', 20);
  `);

  const result = await db.query(`
    select public.stock_balance_at(
      date '2026-07-27', '${TRUCK_ID}', '${ICE_ID}'
    ) as quantity
  `);
  assert.equal(Number(result.rows[0].quantity), 20);
});

test('truck count plus employee transfers reconciles to the factory order', async (t) => {
  const db = await createDb(t);
  await seedOrderAndTransfer(db);

  const result = await db.query(`
    select public.stock_balance_at(
      date '2026-07-27', '${TRUCK_ID}', '${ICE_ID}'
    ) as expected_remaining
  `);
  const expectedRemaining = Number(result.rows[0].expected_remaining);
  const actualRemaining = 14;
  const transferredToEmployees = 5;
  const orderedFromFactory = 20;

  assert.equal(expectedRemaining, 15);
  assert.equal(actualRemaining - expectedRemaining, -1);
  assert.equal(actualRemaining + transferredToEmployees - orderedFromFactory, -1);
});

test('daily stock can close without factory receipt records or APIs', async (t) => {
  const db = await createDb(t);
  await seedOrderAndTransfer(db);

  await db.exec(`
    insert into public.daily_stock_closures values (date '2026-07-27', 'closed')
  `);

  const functions = await db.query(`
    select proname
    from pg_proc
    join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
    where pg_namespace.nspname = 'public'
      and proname in ('get_factory_receipt_summary', 'record_factory_receipt')
  `);
  assert.deepEqual(functions.rows, []);

  const legacyTables = await db.query(`
    select
      to_regclass('public.factory_receipts') is not null as receipts_preserved,
      to_regclass('public.factory_receipt_items') is not null as items_preserved
  `);
  assert.equal(legacyTables.rows[0].receipts_preserved, true);
  assert.equal(legacyTables.rows[0].items_preserved, true);
});
