import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0142_employee_stock_damage.sql', import.meta.url),
  'utf8',
);

const USER_ID = '10000000-0000-4000-8000-000000000001';
const ICE_ID = '20000000-0000-4000-8000-000000000001';
const ROUND_ID = '30000000-0000-4000-8000-000000000001';
const TRUCK_ID = '40000000-0000-4000-8000-000000000001';
const HOLDING_ID = '40000000-0000-4000-8000-000000000002';
const SERVICE_DATE = '2026-08-09';

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role authenticated;
    create schema auth;
    create type public.app_role as enum ('courier', 'round_lead', 'admin');
    create type public.delivery_round_status as enum ('open', 'closed');
    create type public.stock_movement_kind as enum ('factory_order', 'transfer', 'damage', 'return_to_factory');
    create type public.stock_movement_status as enum ('active', 'cancelled');

    create table public.auth_context (
      singleton boolean primary key default true,
      user_id uuid not null,
      app_role public.app_role not null,
      is_active boolean not null
    );
    insert into public.auth_context values (true, '${USER_ID}', 'courier', true);

    create function auth.uid() returns uuid language sql stable as $$
      select user_id from public.auth_context where singleton
    $$;
    create function public.current_app_role() returns public.app_role language sql stable as $$
      select app_role from public.auth_context where singleton
    $$;
    create function public.is_active_user() returns boolean language sql stable as $$
      select is_active from public.auth_context where singleton
    $$;

    create table public.users (id uuid primary key, display_name text not null);
    create table public.delivery_rounds (
      id uuid primary key,
      service_date date not null,
      status public.delivery_round_status not null
    );
    create table public.stock_locations (id uuid primary key, name text not null);
    create table public.ice_types (
      id uuid primary key,
      code text not null,
      name text not null,
      unit text not null,
      is_active boolean not null
    );
    create table public.stock_movements (
      id uuid primary key default gen_random_uuid(),
      service_date date not null,
      round_id uuid references public.delivery_rounds(id),
      kind public.stock_movement_kind not null,
      from_location_id uuid references public.stock_locations(id),
      to_location_id uuid references public.stock_locations(id),
      idempotency_key uuid not null unique,
      request_fingerprint text,
      status public.stock_movement_status not null default 'active',
      recorded_by uuid not null references public.users(id)
    );
    create table public.stock_movement_items (
      movement_id uuid not null references public.stock_movements(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity numeric(12,1) not null,
      primary key (movement_id, ice_type_id)
    );
    create table public.daily_stock_closures (service_date date primary key, status text not null);
    create table public.audit_logs (
      id uuid primary key default gen_random_uuid(),
      actor_id uuid not null,
      entity_type text not null,
      entity_id uuid not null,
      action text not null,
      after_value jsonb
    );
    create table public.test_location_balances (
      service_date date not null,
      location_id uuid not null,
      ice_type_id uuid not null,
      quantity numeric(12,1) not null,
      primary key (service_date, location_id, ice_type_id)
    );
    create table public.test_aggregate_balances (
      service_date date not null,
      ice_type_id uuid not null,
      quantity numeric(12,1) not null,
      primary key (service_date, ice_type_id)
    );

    create function public.stock_balance_at(p_service_date date, p_location_id uuid, p_ice_type_id uuid)
    returns numeric language sql stable as $$
      select coalesce((select quantity from public.test_location_balances
        where service_date = p_service_date and location_id = p_location_id and ice_type_id = p_ice_type_id), 0)
        + coalesce((select sum(item.quantity) from public.stock_movements movement
          join public.stock_movement_items item on item.movement_id = movement.id
          where movement.service_date = p_service_date and movement.status = 'active'
            and movement.to_location_id = p_location_id and item.ice_type_id = p_ice_type_id), 0)
        - coalesce((select sum(item.quantity) from public.stock_movements movement
          join public.stock_movement_items item on item.movement_id = movement.id
          where movement.service_date = p_service_date and movement.status = 'active'
            and movement.from_location_id = p_location_id and item.ice_type_id = p_ice_type_id), 0)
    $$;

    create function public.daily_aggregate_stock_balance_at(p_service_date date, p_ice_type_id uuid)
    returns numeric language sql stable as $$
      select coalesce((select quantity from public.test_aggregate_balances
        where service_date = p_service_date and ice_type_id = p_ice_type_id), 0)
        - coalesce((select sum(item.quantity) from public.stock_movements movement
          join public.stock_movement_items item on item.movement_id = movement.id
          where movement.service_date = p_service_date and movement.status = 'active'
            and movement.kind = 'damage' and item.ice_type_id = p_ice_type_id), 0)
    $$;

    create function public.get_employee_stock_state(p_round_id uuid) returns jsonb
    language sql stable as $$
      select jsonb_build_object(
        'round_id', round.id,
        'service_date', round.service_date,
        'withdrawn_balances', '[]'::jsonb,
        'truck_location', jsonb_build_object('id', '${TRUCK_ID}', 'name', 'Truck', 'balances', '[]'::jsonb),
        'holding_location', jsonb_build_object(
          'id', '${HOLDING_ID}', 'name', 'Courier holding',
          'balances', jsonb_build_array(jsonb_build_object(
            'ice_type_id', '${ICE_ID}',
            'quantity', public.stock_balance_at(round.service_date, '${HOLDING_ID}', '${ICE_ID}')
          ))
        )
      )
      from public.delivery_rounds round where round.id = p_round_id
    $$;

    insert into public.users values ('${USER_ID}', 'Courier');
    insert into public.delivery_rounds values ('${ROUND_ID}', date '${SERVICE_DATE}', 'open');
    insert into public.stock_locations values
      ('${TRUCK_ID}', 'Truck'), ('${HOLDING_ID}', 'Courier holding');
    insert into public.ice_types values ('${ICE_ID}', 'ICE', 'Ice', 'bag', true);
    insert into public.test_location_balances values
      (date '${SERVICE_DATE}', '${HOLDING_ID}', '${ICE_ID}', 10);
    insert into public.test_aggregate_balances values
      (date '${SERVICE_DATE}', '${ICE_ID}', 3);
  `);

  await db.exec(migration);
  return db;
}

function recordDamage(db, quantity, key) {
  return db.query(`
    select public.record_employee_stock_damage(
      '${ROUND_ID}',
      '[{"ice_type_id":"${ICE_ID}","quantity":${quantity}}]'::jsonb,
      '${key}'
    ) as result
  `);
}

test('employee damage cannot overdraw aggregate stock even when holding stock is sufficient', async (t) => {
  const db = await createDatabase(t);
  await assert.rejects(
    recordDamage(db, 4, '50000000-0000-4000-8000-000000000001'),
    /aggregate stock does not have enough stock/i,
  );
  const count = await db.query('select count(*)::integer as count from public.stock_movements');
  assert.equal(count.rows[0].count, 0);
});

test('employee damage records against only the assigned holding and is idempotent', async (t) => {
  const db = await createDatabase(t);
  const key = '50000000-0000-4000-8000-000000000002';
  const first = await recordDamage(db, 2, key);
  const replay = await recordDamage(db, 2, key);

  assert.equal(first.rows[0].result.holding_location.balances[0].quantity, 8);
  assert.equal(replay.rows[0].result.holding_location.balances[0].quantity, 8);
  const movement = await db.query(`
    select movement.kind, movement.from_location_id, movement.to_location_id,
      item.quantity, count(*) over ()::integer as total
    from public.stock_movements movement
    join public.stock_movement_items item on item.movement_id = movement.id
  `);
  assert.deepEqual(movement.rows[0], {
    kind: 'damage',
    from_location_id: HOLDING_ID,
    to_location_id: null,
    quantity: '2.0',
    total: 1,
  });
});
