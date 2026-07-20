import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0027_cancel_delivery_round.sql', import.meta.url),
  'utf8',
);
const deliveryMigration = readFileSync(
  new URL('../supabase/migrations/0015_employee_assigned_stock_flow.sql', import.meta.url),
  'utf8',
);
const stockMigration = readFileSync(
  new URL('../supabase/migrations/0007_daily_mobile_stock.sql', import.meta.url),
  'utf8',
);

const USER_ID = '10000000-0000-4000-8000-000000000001';
const ROUND_ID = '20000000-0000-4000-8000-000000000001';
const STOP_ID = '30000000-0000-4000-8000-000000000001';
const ICE_ID = '40000000-0000-4000-8000-000000000001';

async function createDb() {
  const db = new PGlite();
  await db.exec(`
    create role authenticated;
    create schema auth;
    create type public.delivery_round_status as enum ('open', 'closed');
    create type public.shop_round_status as enum ('pending', 'delivered', 'issue');
    create table public.users (id uuid primary key);
    insert into public.users values ('${USER_ID}');
    create function auth.uid() returns uuid language sql stable as
      'select ''${USER_ID}''::uuid';
    create function public.is_active_user() returns boolean language sql stable as
      'select true';
    create function public.current_app_role() returns text language sql stable as
      'select ''round_lead''::text';
    create table public.delivery_rounds (
      id uuid primary key,
      service_date date not null,
      name text not null,
      status public.delivery_round_status not null default 'open',
      opened_by uuid not null references public.users(id),
      opened_at timestamptz not null default now(),
      closed_by uuid references public.users(id),
      closed_at timestamptz,
      check ((status = 'open' and closed_by is null and closed_at is null)
        or (status = 'closed' and closed_by is not null and closed_at is not null))
    );
    create table public.round_stops (
      id uuid primary key,
      round_id uuid not null references public.delivery_rounds(id),
      status public.shop_round_status not null default 'pending'
    );
    create table public.delivery_events (
      id uuid primary key default gen_random_uuid(),
      round_stop_id uuid not null references public.round_stops(id)
    );
    create table public.stock_movements (
      id uuid primary key default gen_random_uuid(),
      round_id uuid not null references public.delivery_rounds(id)
    );
    create table public.stock_locations (
      id uuid primary key,
      code text not null,
      name text not null,
      kind text not null,
      is_active boolean not null default true
    );
    create table public.ice_types (
      id uuid primary key,
      name text not null,
      unit text not null,
      is_active boolean not null default true
    );
    create table public.round_stock_snapshots (
      round_id uuid primary key references public.delivery_rounds(id),
      service_date date not null,
      captured_by uuid not null references public.users(id),
      captured_at timestamptz not null
    );
    create table public.round_stock_snapshot_items (
      round_id uuid not null references public.round_stock_snapshots(round_id),
      location_id uuid not null references public.stock_locations(id),
      location_code_snapshot text not null,
      location_name_snapshot text not null,
      location_kind_snapshot text not null,
      ice_type_id uuid not null references public.ice_types(id),
      ice_type_name_snapshot text not null,
      unit_snapshot text not null,
      quantity integer not null,
      primary key (round_id, location_id, ice_type_id)
    );
    create function public.stock_balance_at(date, uuid, uuid) returns integer
    language sql stable as 'select 0';
    create table public.round_ice_counts (
      round_id uuid not null references public.delivery_rounds(id),
      ice_type_id uuid not null,
      loaded_quantity integer not null default 0,
      replenished_quantity integer not null default 0,
      remaining_quantity integer not null default 0,
      damaged_quantity integer not null default 0,
      primary key (round_id, ice_type_id)
    );
    create table public.audit_logs (
      id bigint generated always as identity primary key,
      actor_id uuid,
      entity_type text,
      entity_id uuid,
      action text,
      after_value jsonb
    );
    insert into public.delivery_rounds (id, service_date, name, opened_by)
    values ('${ROUND_ID}', date '2026-07-20', '04:00', '${USER_ID}');
    insert into public.stock_locations (id, code, name, kind)
    values ('50000000-0000-4000-8000-000000000001', 'TRUCK', 'รถบรรทุก', 'truck');
    insert into public.ice_types (id, name, unit)
    values ('${ICE_ID}', 'หลอดเล็ก', 'ถุง');
    insert into public.round_stops (id, round_id) values ('${STOP_ID}', '${ROUND_ID}');
    insert into public.round_ice_counts (round_id, ice_type_id) values ('${ROUND_ID}', '${ICE_ID}');
  `);
  await db.exec(migration);
  return db;
}

test('cancel_delivery_round closes an unused round and preserves an audit reason', async (t) => {
  const db = await createDb();
  t.after(() => db.close());

  await db.query(`select public.cancel_delivery_round('${ROUND_ID}', 'เปิดรอบซ้ำ')`);

  const round = await db.query(`
    select status, cancellation_reason, cancelled_by, cancelled_at
    from public.delivery_rounds where id = '${ROUND_ID}'
  `);
  assert.equal(round.rows[0].status, 'closed');
  assert.equal(round.rows[0].cancellation_reason, 'เปิดรอบซ้ำ');
  assert.equal(round.rows[0].cancelled_by, USER_ID);
  assert.ok(round.rows[0].cancelled_at);

  const snapshot = await db.query(`
    select service_date, captured_at from public.round_stock_snapshots where round_id = '${ROUND_ID}'
  `);
  assert.equal(new Date(snapshot.rows[0].service_date).toISOString().slice(0, 10), '2026-07-20');
  assert.ok(snapshot.rows[0].captured_at);

  const audit = await db.query(`select action, after_value from public.audit_logs`);
  assert.equal(audit.rows[0].action, 'cancelled');
  assert.equal(audit.rows[0].after_value.cancellation_reason, 'เปิดรอบซ้ำ');

  await assert.rejects(
    db.query(`insert into public.stock_movements (round_id) values ('${ROUND_ID}')`),
    /ยกเลิกแล้ว/,
  );
});

test('cancel_delivery_round rejects a round with delivery activity', async (t) => {
  const db = await createDb();
  t.after(() => db.close());
  await db.query(`insert into public.delivery_events (round_stop_id) values ('${STOP_ID}')`);

  await assert.rejects(
    db.query(`select public.cancel_delivery_round('${ROUND_ID}', 'เปิดผิดเวลา')`),
    /มีการทำรายการแล้ว/,
  );
});

test('cancel_delivery_round rejects a round with stock activity', async (t) => {
  const db = await createDb();
  t.after(() => db.close());
  await db.query(`insert into public.stock_movements (round_id) values ('${ROUND_ID}')`);

  await assert.rejects(
    db.query(`select public.cancel_delivery_round('${ROUND_ID}', 'เปิดผิดเวลา')`),
    /มีการทำรายการแล้ว/,
  );
});

test('cancellation state reports non-pending stops and non-zero round counts', async (t) => {
  const db = await createDb();
  t.after(() => db.close());
  await db.exec(`
    update public.round_stops set status = 'issue' where id = '${STOP_ID}';
    update public.round_ice_counts set loaded_quantity = 1 where round_id = '${ROUND_ID}';
  `);

  const state = await db.query(`
    select public.get_delivery_round_cancellation_state('${ROUND_ID}') as state
  `);
  assert.equal(state.rows[0].state.can_cancel, false);
  assert.deepEqual(
    [...state.rows[0].state.blockers].sort(),
    ['non_pending_stops', 'round_ice_counts'],
  );

  await assert.rejects(
    db.query(`select public.cancel_delivery_round('${ROUND_ID}', 'เปิดผิดเวลา')`),
    /มีการทำรายการแล้ว/,
  );
});

test('activity writers lock the round before inserting, matching cancellation lock order', () => {
  const deliveryFunction = deliveryMigration.slice(
    deliveryMigration.indexOf('create or replace function public.record_delivery('),
  );
  const stockFunction = stockMigration.slice(
    stockMigration.indexOf('create or replace function public.record_stock_movement('),
    stockMigration.indexOf('create or replace function public.record_delivery('),
  );
  const cancelFunction = migration.slice(
    migration.indexOf('create or replace function public.cancel_delivery_round('),
  );

  assert.match(deliveryFunction, /for update of r;[\s\S]*insert into public\.delivery_events/);
  assert.match(stockFunction, /for update;[\s\S]*insert into public\.stock_movements/);
  assert.match(cancelFunction, /for update;[\s\S]*v_blockers := public\.delivery_round_cancellation_blockers/);
  assert.match(migration, /for key share/);
  assert.match(migration, /before insert on public\.stock_movements/);
});
