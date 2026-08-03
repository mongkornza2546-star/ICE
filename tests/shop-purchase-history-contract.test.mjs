import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0119_shop_purchase_history.sql', import.meta.url),
  'utf8',
);

const SHOP_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '20000000-0000-4000-8000-000000000001';
const ROUND_ID = '30000000-0000-4000-8000-000000000001';
const STOP_ID = '40000000-0000-4000-8000-000000000001';
const ICE_ID = '50000000-0000-4000-8000-000000000001';
const EVENT_ID = '60000000-0000-4000-8000-000000000001';
const LEGACY_EVENT_ID = '60000000-0000-4000-8000-000000000002';
const CANCELLED_EVENT_ID = '60000000-0000-4000-8000-000000000003';
const CHARGE_ID = '70000000-0000-4000-8000-000000000001';
const PAYMENT_ID = '80000000-0000-4000-8000-000000000001';
const VOIDED_PAYMENT_ID = '80000000-0000-4000-8000-000000000002';

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role authenticated;
    create function public.is_active_user() returns boolean language sql stable as $$ select true $$;
    create function public.current_app_role() returns text language sql stable as $$ select 'admin'::text $$;

    create table public.shops (id uuid primary key);
    create table public.users (id uuid primary key, display_name text not null);
    create table public.delivery_rounds (id uuid primary key, service_date date not null);
    create table public.round_stops (id uuid primary key, round_id uuid not null, shop_id uuid not null);
    create table public.delivery_events (
      id uuid primary key,
      round_stop_id uuid not null,
      recorded_by uuid not null,
      recorded_at timestamptz not null,
      status text not null
    );
    create table public.ice_types (id uuid primary key, code text not null, name text not null, unit text not null);
    create table public.delivery_items (
      delivery_event_id uuid not null,
      ice_type_id uuid not null,
      quantity numeric(12,1) not null,
      unit_price numeric(12,2),
      line_total numeric(12,2)
    );
    create table public.delivery_charges (
      id uuid primary key,
      delivery_event_id uuid not null,
      charge_number text not null,
      original_amount numeric(12,2) not null,
      payment_term text not null,
      status text not null
    );
    create table public.payments (
      id uuid primary key,
      payment_method text not null,
      status text not null,
      recorded_at timestamptz not null
    );
    create table public.payment_allocations (
      payment_id uuid not null,
      charge_id uuid not null,
      amount numeric(12,2) not null
    );
  `);

  await db.exec(migration);
  await db.exec(`
    insert into public.shops (id) values ('${SHOP_ID}');
    insert into public.users (id, display_name) values ('${USER_ID}', 'พนักงานหนึ่ง');
    insert into public.delivery_rounds (id, service_date) values ('${ROUND_ID}', date '2026-08-03');
    insert into public.round_stops (id, round_id, shop_id) values ('${STOP_ID}', '${ROUND_ID}', '${SHOP_ID}');
    insert into public.ice_types (id, code, name, unit) values ('${ICE_ID}', 'CUBE', 'น้ำแข็งก้อน', 'ถุง');
    insert into public.delivery_events (id, round_stop_id, recorded_by, recorded_at, status) values
      ('${EVENT_ID}', '${STOP_ID}', '${USER_ID}', timestamptz '2026-08-03 09:00:00+07', 'active'),
      ('${LEGACY_EVENT_ID}', '${STOP_ID}', '${USER_ID}', timestamptz '2026-08-03 08:00:00+07', 'active'),
      ('${CANCELLED_EVENT_ID}', '${STOP_ID}', '${USER_ID}', timestamptz '2026-08-03 07:00:00+07', 'cancelled');
    insert into public.delivery_items (delivery_event_id, ice_type_id, quantity, unit_price, line_total) values
      ('${EVENT_ID}', '${ICE_ID}', 3, 30, 90),
      ('${LEGACY_EVENT_ID}', '${ICE_ID}', 2, null, null),
      ('${CANCELLED_EVENT_ID}', '${ICE_ID}', 4, 30, 120);
    insert into public.delivery_charges (id, delivery_event_id, charge_number, original_amount, payment_term, status)
    values ('${CHARGE_ID}', '${EVENT_ID}', 'C690803-000001', 90, 'end_of_day', 'active');
    insert into public.payments (id, payment_method, status, recorded_at) values
      ('${PAYMENT_ID}', 'cash', 'active', timestamptz '2026-08-03 10:00:00+07'),
      ('${VOIDED_PAYMENT_ID}', 'qr', 'voided', timestamptz '2026-08-03 10:05:00+07');
    insert into public.payment_allocations (payment_id, charge_id, amount) values
      ('${PAYMENT_ID}', '${CHARGE_ID}', 60),
      ('${VOIDED_PAYMENT_ID}', '${CHARGE_ID}', 30);
  `);

  return db;
}

test('combines delivery items and active payments into one shop purchase history', async (t) => {
  const db = await createDatabase(t);
  const result = await db.query(`select public.get_shop_purchase_history('${SHOP_ID}', 100, 0) as history`);
  const history = result.rows[0].history;

  assert.equal(history.length, 2);
  assert.equal(history[0].delivery_event_id, EVENT_ID);
  assert.equal(history[0].charge_number, 'C690803-000001');
  assert.equal(Number(history[0].allocated_amount), 60);
  assert.equal(Number(history[0].outstanding_amount), 30);
  assert.equal(history[0].payment_status, 'partial');
  assert.deepEqual(history[0].payments.map((payment) => payment.payment_method), ['cash']);
  assert.equal(Number(history[0].items[0].quantity), 3);

  assert.equal(history[1].delivery_event_id, LEGACY_EVENT_ID);
  assert.equal(history[1].charge_id, null);
  assert.equal(history[1].payment_status, null);
  assert.equal(history.some((entry) => entry.delivery_event_id === CANCELLED_EVENT_ID), false);
});

test('caps the result size and restricts the RPC to managers', () => {
  assert.match(migration, /least\(coalesce\(p_limit, 50\), 100\)/);
  assert.match(migration, /current_app_role\(\) not in \('admin', 'round_lead'\)/);
  assert.match(migration, /grant execute on function public\.get_shop_purchase_history/);
});
