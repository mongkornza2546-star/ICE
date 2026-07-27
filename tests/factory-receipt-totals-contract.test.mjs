import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0101_factory_receipt_totals.sql', import.meta.url),
  'utf8',
);

const USER_ID = '10000000-0000-4000-8000-000000000001';
const TRUCK_ID = '10000000-0000-4000-8000-000000000002';
const TEAM_ID = '10000000-0000-4000-8000-000000000003';
const ICE_ID = '10000000-0000-4000-8000-000000000004';

async function createDb() {
  const db = new PGlite();
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
    create table public.delivery_items (delivery_event_id uuid not null, ice_type_id uuid not null, quantity numeric(12, 1) not null);
    create table public.daily_stock_closures (service_date date primary key, status text not null);
    create table public.daily_stock_closure_items (
      service_date date not null, location_id uuid not null, ice_type_id uuid not null, variance_quantity numeric(12, 1) not null
    );
    create table public.audit_logs (
      actor_id uuid, entity_type text, entity_id uuid, action text, after_value jsonb
    );

    insert into public.users values ('${USER_ID}');
    insert into public.stock_locations values
      ('${TRUCK_ID}', 'TRUCK-01', 'รถบรรทุกหลัก', 'truck', true, true),
      ('${TEAM_ID}', 'TEAM-01', 'รถเข็น', 'team', true, false);
    insert into public.ice_types values ('${ICE_ID}', 'ICE-01', 'หลอดเล็ก', 'ถุง');
  `);
  await db.exec(migration);
  return db;
}

async function insertFactoryOrder(db, orderId) {
  await db.exec(`
    insert into public.stock_movements (id, service_date, kind, to_location_id, recorded_by)
    values ('${orderId}', date '2026-07-27', 'factory_order', '${TRUCK_ID}', '${USER_ID}');
    insert into public.stock_movement_items values ('${orderId}', '${ICE_ID}', 20);
  `);
}

test('a short factory receipt changes availability to the actual quantity and survives later transfers', async (t) => {
  const db = await createDb();
  t.after(() => db.close());
  const orderId = '10000000-0000-4000-8000-000000000010';
  await insertFactoryOrder(db, orderId);

  const pending = await db.query(`
    select public.stock_balance_at(date '2026-07-27', '${TRUCK_ID}', '${ICE_ID}') as quantity
  `);
  assert.equal(Number(pending.rows[0].quantity), 0);

  await db.query(`
    select public.record_factory_receipt(
      '${orderId}', '[{"ice_type_id":"${ICE_ID}","actual_quantity":18}]'::jsonb, null,
      '10000000-0000-4000-8000-000000000011'
    )
  `);

  const received = await db.query(`
    select public.stock_balance_at(date '2026-07-27', '${TRUCK_ID}', '${ICE_ID}') as quantity,
      public.get_factory_receipt_summary(date '2026-07-27', '${TRUCK_ID}') as summary
  `);
  assert.equal(Number(received.rows[0].quantity), 18);
  assert.deepEqual(received.rows[0].summary.receipts[0].items[0], {
    ice_type_id: ICE_ID,
    ice_type_name: 'หลอดเล็ก',
    unit: 'ถุง',
    expected_quantity: 20,
    actual_quantity: 18,
    variance_quantity: -2,
  });

  await db.exec(`
    insert into public.stock_movements (id, service_date, kind, from_location_id, to_location_id, recorded_by)
    values ('10000000-0000-4000-8000-000000000012', date '2026-07-27', 'transfer', '${TRUCK_ID}', '${TEAM_ID}', '${USER_ID}');
    insert into public.stock_movement_items values ('10000000-0000-4000-8000-000000000012', '${ICE_ID}', 5);
  `);

  const afterTransfer = await db.query(`
    select public.stock_balance_at(date '2026-07-27', '${TRUCK_ID}', '${ICE_ID}') as quantity,
      public.get_factory_receipt_summary(date '2026-07-27', '${TRUCK_ID}') as summary
  `);
  assert.equal(Number(afterTransfer.rows[0].quantity), 13);
  assert.equal(afterTransfer.rows[0].summary.receipts[0].items[0].variance_quantity, -2);
});

test('an overage factory receipt adds the actual quantity to availability', async (t) => {
  const db = await createDb();
  t.after(() => db.close());
  const orderId = '10000000-0000-4000-8000-000000000020';
  await insertFactoryOrder(db, orderId);

  await db.query(`
    select public.record_factory_receipt(
      '${orderId}', '[{"ice_type_id":"${ICE_ID}","actual_quantity":22}]'::jsonb, 'เกินจากใบสั่ง',
      '10000000-0000-4000-8000-000000000021'
    )
  `);

  const result = await db.query(`
    select public.stock_balance_at(date '2026-07-27', '${TRUCK_ID}', '${ICE_ID}') as quantity,
      public.get_factory_receipt_summary(date '2026-07-27', '${TRUCK_ID}') as summary
  `);
  assert.equal(Number(result.rows[0].quantity), 22);
  assert.equal(result.rows[0].summary.receipts[0].items[0].variance_quantity, 2);
});

test('daily stock cannot close while a factory order is pending', async (t) => {
  const db = await createDb();
  t.after(() => db.close());
  const orderId = '10000000-0000-4000-8000-000000000030';
  await insertFactoryOrder(db, orderId);

  await assert.rejects(
    db.exec(`
      insert into public.daily_stock_closures values (date '2026-07-27', 'closed')
    `),
    /Receive or cancel every factory order before closing daily stock/,
  );

  await db.query(`
    select public.record_factory_receipt(
      '${orderId}', '[{"ice_type_id":"${ICE_ID}","actual_quantity":20}]'::jsonb, null,
      '10000000-0000-4000-8000-000000000031'
    )
  `);
  await db.exec(`
    insert into public.daily_stock_closures values (date '2026-07-27', 'closed')
  `);
});

test('a legacy outgoing movement still requires enough actual receipt stock', async (t) => {
  const db = await createDb();
  t.after(() => db.close());
  const orderId = '10000000-0000-4000-8000-000000000040';
  await insertFactoryOrder(db, orderId);
  await db.exec(`
    insert into public.stock_movements (id, service_date, kind, from_location_id, to_location_id, recorded_by)
    values ('10000000-0000-4000-8000-000000000041', date '2026-07-27', 'transfer', '${TRUCK_ID}', '${TEAM_ID}', '${USER_ID}');
    insert into public.stock_movement_items values ('10000000-0000-4000-8000-000000000041', '${ICE_ID}', 5);
  `);

  await assert.rejects(
    db.query(`
      select public.record_factory_receipt(
        '${orderId}', '[{"ice_type_id":"${ICE_ID}","actual_quantity":4}]'::jsonb, null,
        '10000000-0000-4000-8000-000000000042'
      )
    `),
    /Cannot record this shortage after stock has left the truck/,
  );

  await db.query(`
    select public.record_factory_receipt(
      '${orderId}', '[{"ice_type_id":"${ICE_ID}","actual_quantity":5}]'::jsonb, null,
      '10000000-0000-4000-8000-000000000043'
    )
  `);
  const result = await db.query(`
    select public.stock_balance_at(date '2026-07-27', '${TRUCK_ID}', '${ICE_ID}') as quantity
  `);
  assert.equal(Number(result.rows[0].quantity), 0);
});
