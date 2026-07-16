import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0009_phase_3_review_fixes.sql', import.meta.url),
  'utf8',
);

const AUTH_USER_ID = '00000000-0000-4000-8000-000000000001';
const ICE_TYPE_ID = '00000000-0000-4000-8000-000000000002';
const ROUND_ID = '00000000-0000-4000-8000-000000000003';
const TRUCK_ID = '00000000-0000-4000-8000-000000000004';

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role authenticated;
    create schema auth;

    create function auth.uid() returns uuid
    language sql stable as $$ select '${AUTH_USER_ID}'::uuid $$;

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
      service_date date not null
    );

    create table public.daily_stock_closures (
      service_date date primary key,
      status text not null
    );

    create table public.stock_locations (
      id uuid primary key,
      name text not null
    );

    create table public.test_stock_balances (
      service_date date not null,
      location_id uuid not null,
      ice_type_id uuid not null,
      quantity integer not null,
      primary key (service_date, location_id, ice_type_id)
    );

    create function public.stock_balance_at(date, uuid, uuid)
    returns integer language sql stable as $$
      select coalesce((
        select quantity
        from public.test_stock_balances
        where service_date = $1 and location_id = $2 and ice_type_id = $3
      ), 0)
    $$;

    create function public.is_active_user() returns boolean
    language sql stable as $$ select true $$;

    create function public.current_app_role() returns text
    language sql stable as $$ select 'admin'::text $$;

    create table public.stock_movements (
      id uuid primary key default gen_random_uuid(),
      service_date date not null,
      kind text not null,
      from_location_id uuid,
      to_location_id uuid,
      note text,
      status text not null default 'active',
      recorded_by uuid not null,
      recorded_at timestamptz not null
    );

    create table public.stock_movement_items (
      movement_id uuid not null,
      ice_type_id uuid not null,
      quantity integer not null
    );
  `);

  await db.exec(migration);
  await db.exec(`
    insert into public.users (id, display_name)
    values ('${AUTH_USER_ID}', 'Admin Test');
    insert into public.ice_types (id, code, name, unit)
    values ('${ICE_TYPE_ID}', 'ICE-01', 'น้ำแข็งทดสอบ', 'ถุง');
    insert into public.delivery_rounds (id, service_date)
    values ('${ROUND_ID}', date '2026-07-15');
    insert into public.stock_locations (id, name)
    values ('${TRUCK_ID}', 'รถบรรทุกหลัก');
  `);

  return db;
}

test('save_ice_type rejects retirement while an open day still has stock', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    insert into public.test_stock_balances (
      service_date, location_id, ice_type_id, quantity
    ) values (
      date '2026-07-15', '${TRUCK_ID}', '${ICE_TYPE_ID}', 5
    );
  `);

  await assert.rejects(
    db.query(`
      select public.save_ice_type(
        '${ICE_TYPE_ID}', 'ICE-01', 'น้ำแข็งทดสอบ', 'ถุง', false
      )
    `),
    /An ice type with stock on an open service day cannot be deactivated/,
  );

  const activeResult = await db.query(
    `select is_active from public.ice_types where id = '${ICE_TYPE_ID}'`,
  );
  assert.equal(activeResult.rows[0].is_active, true);

  await db.exec(`
    update public.test_stock_balances
    set quantity = 0
    where service_date = date '2026-07-15'
      and location_id = '${TRUCK_ID}'
      and ice_type_id = '${ICE_TYPE_ID}';
  `);
  await db.query(`
    select public.save_ice_type(
      '${ICE_TYPE_ID}', 'ICE-01', 'น้ำแข็งทดสอบ', 'ถุง', false
    )
  `);

  const inactiveResult = await db.query(
    `select is_active from public.ice_types where id = '${ICE_TYPE_ID}'`,
  );
  assert.equal(inactiveResult.rows[0].is_active, false);
});

test('factory-order history filters by kind before applying its limit', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    with factory_order as (
      insert into public.stock_movements (
        service_date, kind, to_location_id, recorded_by, recorded_at
      ) values (
        date '2026-07-15', 'factory_order', '${TRUCK_ID}',
        '${AUTH_USER_ID}', timestamptz '2026-07-15 08:00:00+07'
      )
      returning id
    )
    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    select id, '${ICE_TYPE_ID}', 100 from factory_order;

    insert into public.stock_movements (
      service_date, kind, recorded_by, recorded_at
    )
    select
      date '2026-07-15',
      'transfer',
      '${AUTH_USER_ID}',
      timestamptz '2026-07-15 09:00:00+07' + sequence * interval '1 minute'
    from generate_series(1, 12) sequence;
  `);

  const result = await db.query(`
    select public.get_factory_order_history('${ROUND_ID}', 12) as history
  `);
  const history = result.rows[0].history;

  assert.equal(history.length, 1);
  assert.equal(history[0].kind, 'factory_order');
  assert.equal(history[0].items[0].quantity, 100);
});
