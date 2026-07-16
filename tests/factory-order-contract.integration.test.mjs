import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0011_round_independent_factory_orders.sql', import.meta.url),
  'utf8',
);
const ledgerMigration = readFileSync(
  new URL('../supabase/migrations/0007_daily_mobile_stock.sql', import.meta.url),
  'utf8',
);
const historyMigration = readFileSync(
  new URL('../supabase/migrations/0009_phase_3_review_fixes.sql', import.meta.url),
  'utf8',
);

const AUTH_USER_ID = '00000000-0000-4000-8000-000000000001';
const ICE_TYPE_ID = '00000000-0000-4000-8000-000000000002';
const ROUND_ID = '00000000-0000-4000-8000-000000000003';
const TRUCK_ID = '00000000-0000-4000-8000-000000000004';
const INACTIVE_TRUCK_ID = '00000000-0000-4000-8000-000000000005';
const OLD_ORDER_ID = '00000000-0000-4000-8000-000000000006';
const OLD_ORDER_KEY = '00000000-0000-4000-8000-000000000007';

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role authenticated;
    create schema auth;

    create table public.auth_context (
      id boolean primary key default true,
      user_id uuid not null,
      app_role text not null,
      is_active boolean not null
    );

    insert into public.auth_context (user_id, app_role, is_active)
    values ('${AUTH_USER_ID}', 'admin', true);

    create function auth.uid() returns uuid
    language sql stable as $$
      select user_id from public.auth_context where id
    $$;

    create function public.is_active_user() returns boolean
    language sql stable as $$
      select is_active from public.auth_context where id
    $$;

    create function public.current_app_role() returns text
    language sql stable as $$
      select app_role from public.auth_context where id
    $$;

    create type public.stock_location_kind as enum (
      'truck', 'team', 'small_vehicle', 'work_site', 'reserve_bin', 'front_vehicle'
    );
    create type public.stock_movement_kind as enum (
      'factory_order', 'transfer', 'damage', 'return_to_factory'
    );
    create type public.stock_movement_status as enum ('active', 'cancelled');

    create table public.users (
      id uuid primary key,
      display_name text not null
    );

    create table public.ice_types (
      id uuid primary key default gen_random_uuid(),
      code text not null unique,
      name text not null,
      unit text not null,
      is_active boolean not null default true
    );

    create table public.delivery_rounds (
      id uuid primary key,
      service_date date not null,
      status text not null default 'open'
    );

    create table public.stock_locations (
      id uuid primary key,
      code text not null unique,
      name text not null,
      kind public.stock_location_kind not null,
      is_active boolean not null default true,
      created_at timestamptz not null default now()
    );

    create table public.stock_movements (
      id uuid primary key default gen_random_uuid(),
      service_date date not null,
      round_id uuid not null references public.delivery_rounds(id),
      kind public.stock_movement_kind not null,
      from_location_id uuid references public.stock_locations(id),
      to_location_id uuid references public.stock_locations(id),
      note text,
      idempotency_key uuid not null unique,
      status public.stock_movement_status not null default 'active',
      recorded_by uuid not null references public.users(id),
      recorded_at timestamptz not null default now()
    );

    create table public.stock_movement_items (
      movement_id uuid not null references public.stock_movements(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity integer not null check (quantity > 0),
      primary key (movement_id, ice_type_id)
    );

    create table public.daily_stock_closures (
      service_date date primary key,
      round_id uuid not null references public.delivery_rounds(id),
      status text not null check (status in ('closing', 'closed')),
      note text,
      idempotency_key uuid not null unique,
      closed_by uuid not null references public.users(id),
      closed_at timestamptz
    );

    create table public.daily_stock_closure_items (
      service_date date not null references public.daily_stock_closures(service_date),
      location_id uuid not null references public.stock_locations(id),
      ice_type_id uuid not null references public.ice_types(id),
      system_quantity integer not null,
      actual_quantity integer not null,
      variance_quantity integer not null,
      note text,
      primary key (service_date, location_id, ice_type_id)
    );

    create table public.stock_count_snapshots (
      id uuid primary key default gen_random_uuid(),
      service_date date not null,
      round_id uuid not null references public.delivery_rounds(id),
      location_id uuid not null references public.stock_locations(id),
      note text,
      counted_by uuid not null references public.users(id),
      counted_at timestamptz not null default now()
    );

    create table public.stock_count_snapshot_items (
      snapshot_id uuid not null references public.stock_count_snapshots(id),
      ice_type_id uuid not null references public.ice_types(id),
      system_quantity integer not null,
      actual_quantity integer not null,
      variance_quantity integer not null,
      primary key (snapshot_id, ice_type_id)
    );

    create table public.audit_logs (
      id uuid primary key default gen_random_uuid(),
      actor_id uuid not null references public.users(id),
      entity_type text not null,
      entity_id uuid not null,
      action text not null,
      after_value jsonb
    );

    create function public.stock_balance_at(
      p_service_date date,
      p_location_id uuid,
      p_ice_type_id uuid
    ) returns integer
    language sql stable as $$
      select coalesce(sum(
        case
          when movement.to_location_id = p_location_id then item.quantity
          when movement.from_location_id = p_location_id then -item.quantity
          else 0
        end
      ), 0)::integer
      from public.stock_movements movement
      join public.stock_movement_items item on item.movement_id = movement.id
      where movement.service_date = p_service_date
        and movement.status = 'active'
        and item.ice_type_id = p_ice_type_id
        and (movement.from_location_id = p_location_id or movement.to_location_id = p_location_id)
    $$;

    insert into public.users (id, display_name)
    values ('${AUTH_USER_ID}', 'Admin Test');

    insert into public.ice_types (id, code, name, unit)
    values ('${ICE_TYPE_ID}', 'ICE-01', 'น้ำแข็งทดสอบ', 'ถุง');

    insert into public.delivery_rounds (id, service_date)
    values ('${ROUND_ID}', date '2026-07-15');

    insert into public.stock_locations (id, code, name, kind, is_active)
    values
      ('${TRUCK_ID}', 'TRUCK-01', 'รถบรรทุกหลัก', 'truck', true),
      ('${INACTIVE_TRUCK_ID}', 'TRUCK-02', 'รถพักใช้งาน', 'truck', false);

    insert into public.stock_movements (
      id, service_date, round_id, kind, from_location_id, to_location_id,
      note, idempotency_key, recorded_by, recorded_at
    ) values (
      '${OLD_ORDER_ID}', date '2026-07-15', '${ROUND_ID}', 'factory_order', null,
      '${TRUCK_ID}', 'รายการก่อน migration', '${OLD_ORDER_KEY}', '${AUTH_USER_ID}',
      timestamptz '2026-07-15 08:00:00+07'
    );

    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    values ('${OLD_ORDER_ID}', '${ICE_TYPE_ID}', 25);
  `);

  await db.exec(migration);
  return db;
}

test('migration keeps old round-linked orders and exposes them by date and truck', async (t) => {
  const db = await createDatabase(t);

  const nullable = await db.query(`
    select is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'stock_movements'
      and column_name = 'round_id'
  `);
  assert.equal(nullable.rows[0].is_nullable, 'YES');

  const result = await db.query(`
    select public.get_factory_order_summary(
      date '2026-07-15', '${TRUCK_ID}', 50
    ) as summary
  `);
  const summary = result.rows[0].summary;

  assert.equal(summary.service_date, '2026-07-15');
  assert.equal(summary.locations[0].id, TRUCK_ID);
  assert.equal(summary.locations[0].balances[0].quantity, 25);
  assert.equal(summary.order_count, 1);
  assert.equal(summary.ordered_totals[0].quantity, 25);
  assert.equal(summary.recent_movements.length, 1);
  assert.equal(summary.recent_movements[0].id, OLD_ORDER_ID);

  const oldOrder = await db.query(`
    select round_id from public.stock_movements where id = '${OLD_ORDER_ID}'
  `);
  assert.equal(oldOrder.rows[0].round_id, ROUND_ID);
});

test('factory order can start a service date before any delivery round and retries once', async (t) => {
  const db = await createDatabase(t);
  const requestKey = '10000000-0000-4000-8000-000000000001';
  const input = JSON.stringify([{ ice_type_id: ICE_TYPE_ID, quantity: 100 }]);

  const first = await db.query(`
    select public.record_factory_order(
      date '2026-07-16', '${TRUCK_ID}', '${input}'::jsonb,
      'ยอดตั้งต้น', '${requestKey}'
    ) as summary
  `);
  const retry = await db.query(`
    select public.record_factory_order(
      date '2026-07-16', '${TRUCK_ID}', '${input}'::jsonb,
      'ยอดตั้งต้น', '${requestKey}'
    ) as summary
  `);

  assert.deepEqual(retry.rows[0].summary, first.rows[0].summary);
  assert.equal(first.rows[0].summary.locations[0].balances[0].quantity, 100);
  assert.equal(first.rows[0].summary.order_count, 1);
  assert.equal(first.rows[0].summary.ordered_totals[0].quantity, 100);
  assert.equal(first.rows[0].summary.recent_movements.length, 1);

  const rows = await db.query(`
    select round_id
    from public.stock_movements
    where idempotency_key = '${requestKey}'
  `);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].round_id, null);

  const audits = await db.query(`
    select count(*)::integer as count
    from public.audit_logs
    where entity_type = 'stock_movements'
      and action = 'created'
  `);
  assert.equal(audits.rows[0].count, 1);
});

test('summary totals all orders for the selected truck beyond the history limit', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.stock_locations
    set is_active = true
    where id = '${INACTIVE_TRUCK_ID}';

    with orders as (
      insert into public.stock_movements (
        service_date, round_id, kind, from_location_id, to_location_id,
        note, idempotency_key, recorded_by, recorded_at
      )
      select
        date '2026-07-19', null, 'factory_order', null, '${TRUCK_ID}',
        null, gen_random_uuid(), '${AUTH_USER_ID}',
        timestamptz '2026-07-19 08:00:00+07' + sequence * interval '1 minute'
      from generate_series(1, 60) sequence
      returning id
    )
    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    select id, '${ICE_TYPE_ID}', 1 from orders;

    with other_truck_orders as (
      insert into public.stock_movements (
        service_date, round_id, kind, from_location_id, to_location_id,
        note, idempotency_key, recorded_by, recorded_at
      )
      select
        date '2026-07-19', null, 'factory_order', null, '${INACTIVE_TRUCK_ID}',
        null, gen_random_uuid(), '${AUTH_USER_ID}',
        timestamptz '2026-07-19 09:30:00+07' + sequence * interval '1 minute'
      from generate_series(1, 3) sequence
      returning id
    )
    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    select id, '${ICE_TYPE_ID}', 100 from other_truck_orders;
  `);

  const result = await db.query(`
    select public.get_factory_order_summary(
      date '2026-07-19', '${TRUCK_ID}', 5
    ) as summary
  `);
  const summary = result.rows[0].summary;

  assert.equal(summary.recent_movements.length, 5);
  assert.equal(summary.order_count, 60);
  assert.equal(summary.ordered_totals[0].quantity, 60);
  assert.equal(summary.locations[0].balances[0].quantity, 60);
});

test('factory-order key cannot be replayed for another date or truck', async (t) => {
  const db = await createDatabase(t);
  const requestKey = '20000000-0000-4000-8000-000000000001';
  const input = JSON.stringify([{ ice_type_id: ICE_TYPE_ID, quantity: 10 }]);

  await db.query(`
    select public.record_factory_order(
      date '2026-07-16', '${TRUCK_ID}', '${input}'::jsonb, null, '${requestKey}'
    )
  `);

  await assert.rejects(
    db.query(`
      select public.record_factory_order(
        date '2026-07-17', '${TRUCK_ID}', '${input}'::jsonb, null, '${requestKey}'
      )
    `),
    /idempotency key belongs to another factory order/i,
  );

  const changedInput = JSON.stringify([{ ice_type_id: ICE_TYPE_ID, quantity: 11 }]);
  await assert.rejects(
    db.query(`
      select public.record_factory_order(
        date '2026-07-16', '${TRUCK_ID}', '${changedInput}'::jsonb, null, '${requestKey}'
      )
    `),
    /idempotency key belongs to another factory order/i,
  );
});

test('factory orders reject inactive trucks, closed days, and unauthorized users', async (t) => {
  const db = await createDatabase(t);
  const input = JSON.stringify([{ ice_type_id: ICE_TYPE_ID, quantity: 10 }]);

  await assert.rejects(
    db.query(`
      select public.record_factory_order(
        date '2026-07-16', '${INACTIVE_TRUCK_ID}', '${input}'::jsonb, null,
        '30000000-0000-4000-8000-000000000001'
      )
    `),
    /active truck location/i,
  );

  await db.exec(`
    insert into public.daily_stock_closures (
      service_date, round_id, status, idempotency_key, closed_by, closed_at
    ) values (
      date '2026-07-17', null, 'closed',
      '30000000-0000-4000-8000-000000000099', '${AUTH_USER_ID}', now()
    )
  `);
  await assert.rejects(
    db.query(`
      select public.record_factory_order(
        date '2026-07-17', '${TRUCK_ID}', '${input}'::jsonb, null,
        '30000000-0000-4000-8000-000000000002'
      )
    `),
    /already closed/i,
  );

  await db.exec(`update public.auth_context set app_role = 'courier' where id`);
  await assert.rejects(
    db.query(`
      select public.get_factory_order_summary(date '2026-07-16', '${TRUCK_ID}', 50)
    `),
    /round lead or admin/i,
  );
});

test('ice type with stock on a date that has no round cannot be retired', async (t) => {
  const db = await createDatabase(t);
  const input = JSON.stringify([{ ice_type_id: ICE_TYPE_ID, quantity: 10 }]);

  await db.query(`
    select public.record_factory_order(
      date '2026-07-18', '${TRUCK_ID}', '${input}'::jsonb, null,
      '40000000-0000-4000-8000-000000000001'
    )
  `);

  await assert.rejects(
    db.query(`
      select public.save_ice_type(
        '${ICE_TYPE_ID}', 'ICE-01', 'น้ำแข็งทดสอบ', 'ถุง', false
      )
    `),
    /stock on an open service day cannot be deactivated/i,
  );
});

test('a stock date created without a round can be counted and closed', async (t) => {
  const db = await createDatabase(t);
  const serviceDate = '2026-07-20';
  const input = JSON.stringify([{ ice_type_id: ICE_TYPE_ID, quantity: 40 }]);

  await db.query(`
    select public.record_factory_order(
      date '${serviceDate}', '${TRUCK_ID}', '${input}'::jsonb, null,
      '50000000-0000-4000-8000-000000000001'
    )
  `);

  await db.query(`
    select public.record_location_count(
      p_service_date => date '${serviceDate}',
      p_location_id => '${TRUCK_ID}',
      p_counts => '${JSON.stringify([{
        ice_type_id: ICE_TYPE_ID,
        actual_quantity: 40,
      }])}'::jsonb,
      p_note => 'นับก่อนปิดวัน'
    )
  `);

  const closed = await db.query(`
    select public.close_daily_stock(
      p_service_date => date '${serviceDate}',
      p_counts => '${JSON.stringify([{
        location_id: TRUCK_ID,
        ice_type_id: ICE_TYPE_ID,
        actual_quantity: 40,
        note: null,
      }])}'::jsonb,
      p_idempotency_key => '50000000-0000-4000-8000-000000000002'
    ) as state
  `);
  const retry = await db.query(`
    select public.close_daily_stock(
      p_service_date => date '${serviceDate}',
      p_counts => '${JSON.stringify([{
        location_id: TRUCK_ID,
        ice_type_id: ICE_TYPE_ID,
        actual_quantity: 40,
        note: null,
      }])}'::jsonb,
      p_idempotency_key => '50000000-0000-4000-8000-000000000002'
    ) as state
  `);

  assert.equal(closed.rows[0].state.is_closed, true);
  assert.equal(closed.rows[0].state.open_round_count, 0);
  assert.deepEqual(retry.rows[0].state, closed.rows[0].state);

  const summary = await db.query(`
    select public.get_stock_control_summary(
      p_service_date => date '${serviceDate}'
    ) as summary
  `);
  assert.equal(summary.rows[0].summary.locations[0].balances[0].quantity, 0);

  const snapshot = await db.query(`
    select round_id from public.stock_count_snapshots
    where service_date = date '${serviceDate}'
  `);
  assert.equal(snapshot.rows[0].round_id, null);

  const closures = await db.query(`
    select count(*)::integer as count from public.daily_stock_closures
    where service_date = date '${serviceDate}'
  `);
  assert.equal(closures.rows[0].count, 1);
});

test('factory-order writes lock the retry key and service date before closed-day check', () => {
  const recordFunction = migration.slice(
    migration.indexOf('create or replace function public.record_factory_order('),
    migration.indexOf('-- Stock reads now resolve by service date.'),
  );

  assert.match(
    recordFunction,
    /pg_advisory_xact_lock\(hashtextextended\(p_idempotency_key::text, 0\)\)/,
  );
  assert.match(
    recordFunction,
    /pg_advisory_xact_lock\(hashtextextended\(p_service_date::text, 0\)\)[\s\S]*daily_stock_closures/,
  );
  assert.doesNotMatch(recordFunction, /delivery_rounds[\s\S]*status = 'open'/);
});

test('existing stock summary and history include movements by service date, not round id', () => {
  const balanceFunction = ledgerMigration.slice(
    ledgerMigration.indexOf('create or replace function public.stock_balance_at('),
    ledgerMigration.indexOf('create or replace function public.get_stock_control_summary('),
  );
  const stockSummary = ledgerMigration.slice(
    ledgerMigration.indexOf('create or replace function public.get_stock_control_summary('),
    ledgerMigration.indexOf('create or replace function public.record_stock_movement('),
  );
  const factoryHistory = historyMigration.slice(
    historyMigration.indexOf('create or replace function public.get_factory_order_history('),
  );

  assert.match(balanceFunction, /movement\.service_date = p_service_date/);
  assert.doesNotMatch(balanceFunction, /movement\.round_id/);
  assert.match(stockSummary, /movement\.service_date = v_service_date/);
  assert.doesNotMatch(stockSummary, /movement\.round_id/);
  assert.match(factoryHistory, /movement\.service_date = v_service_date/);
  assert.doesNotMatch(factoryHistory, /movement\.round_id/);
});
