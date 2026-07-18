import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0015_employee_assigned_stock_flow.sql', import.meta.url),
  'utf8',
);

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const ICE_SMALL_ID = '20000000-0000-4000-8000-000000000001';
const ICE_BLOCK_ID = '20000000-0000-4000-8000-000000000002';
const ROUND_ID = '30000000-0000-4000-8000-000000000001';
const OTHER_ROUND_ID = '30000000-0000-4000-8000-000000000002';
const SHOP_ID = '40000000-0000-4000-8000-000000000001';
const STOP_ID = '50000000-0000-4000-8000-000000000001';
const TRUCK_ID = '60000000-0000-4000-8000-000000000001';
const HOLDING_ID = '60000000-0000-4000-8000-000000000002';
const SHOP_SOURCE_ID = '60000000-0000-4000-8000-000000000003';
const SERVICE_DATE = '2026-07-18';

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role authenticated;
    create schema auth;

    create type public.app_role as enum ('courier', 'round_lead', 'admin');
    create type public.delivery_round_status as enum ('open', 'closed');
    create type public.shop_round_status as enum (
      'pending', 'delivered', 'full_bin', 'closed_shop', 'no_access', 'issue'
    );
    create type public.delivery_event_status as enum ('active', 'cancelled');
    create type public.stock_location_kind as enum (
      'truck', 'team', 'small_vehicle', 'work_site', 'reserve_bin', 'front_vehicle'
    );
    create type public.stock_movement_kind as enum (
      'factory_order', 'transfer', 'damage', 'return_to_factory'
    );
    create type public.stock_movement_status as enum ('active', 'cancelled');

    create table public.auth_context (
      singleton boolean primary key default true,
      user_id uuid not null,
      app_role public.app_role not null,
      is_active boolean not null
    );

    insert into public.auth_context (user_id, app_role, is_active)
    values ('${USER_ID}', 'courier', true);

    create function auth.uid() returns uuid
    language sql stable as $$
      select user_id from public.auth_context where singleton
    $$;

    create function public.current_app_role() returns public.app_role
    language sql stable as $$
      select app_role from public.auth_context where singleton
    $$;

    create function public.is_active_user() returns boolean
    language sql stable as $$
      select is_active from public.auth_context where singleton
    $$;

    create table public.users (
      id uuid primary key,
      display_name text not null
    );

    create table public.delivery_rounds (
      id uuid primary key,
      service_date date not null,
      status public.delivery_round_status not null
    );

    create table public.delivery_round_members (
      round_id uuid not null references public.delivery_rounds(id),
      user_id uuid not null references public.users(id),
      primary key (round_id, user_id)
    );

    create function public.is_round_member(target_round_id uuid) returns boolean
    language sql stable as $$
      select exists (
        select 1
        from public.delivery_round_members member
        where member.round_id = target_round_id
          and member.user_id = auth.uid()
      )
    $$;

    create table public.stock_locations (
      id uuid primary key,
      code text not null unique,
      name text not null,
      kind public.stock_location_kind not null,
      assigned_user_id uuid references public.users(id),
      is_active boolean not null
    );

    create table public.ice_types (
      id uuid primary key,
      code text not null unique,
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
      status text not null
    );

    create table public.shops (
      id uuid primary key,
      stock_location_id uuid not null references public.stock_locations(id)
    );

    create table public.round_stops (
      id uuid primary key,
      round_id uuid not null references public.delivery_rounds(id),
      shop_id uuid not null references public.shops(id),
      status public.shop_round_status not null default 'pending',
      note text,
      updated_by uuid not null references public.users(id),
      updated_at timestamptz not null default now()
    );

    create table public.delivery_events (
      id uuid primary key default gen_random_uuid(),
      round_stop_id uuid not null references public.round_stops(id),
      recorded_by uuid not null references public.users(id),
      recorded_at timestamptz not null default now(),
      client_recorded_at timestamptz,
      idempotency_key uuid not null unique,
      note text,
      status public.delivery_event_status not null default 'active',
      source_stock_location_id uuid not null references public.stock_locations(id)
    );

    create table public.delivery_items (
      delivery_event_id uuid not null references public.delivery_events(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity integer not null check (quantity > 0),
      primary key (delivery_event_id, ice_type_id)
    );

    create table public.audit_logs (
      id uuid primary key default gen_random_uuid(),
      actor_id uuid not null references public.users(id),
      entity_type text not null,
      entity_id uuid not null,
      action text not null,
      after_value jsonb
    );

    create table public.test_opening_balances (
      service_date date not null,
      location_id uuid not null references public.stock_locations(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity integer not null,
      primary key (service_date, location_id, ice_type_id)
    );

    create function public.stock_balance_at(
      p_service_date date,
      p_location_id uuid,
      p_ice_type_id uuid
    ) returns integer
    language sql stable as $$
      with opening as (
        select coalesce(sum(balance.quantity), 0) as quantity
        from public.test_opening_balances balance
        where balance.service_date = p_service_date
          and balance.location_id = p_location_id
          and balance.ice_type_id = p_ice_type_id
      ), movements as (
        select
          coalesce(sum(item.quantity) filter (where movement.to_location_id = p_location_id), 0)
          - coalesce(sum(item.quantity) filter (where movement.from_location_id = p_location_id), 0)
          as quantity
        from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date
          and movement.status = 'active'
          and item.ice_type_id = p_ice_type_id
          and (movement.from_location_id = p_location_id or movement.to_location_id = p_location_id)
      ), deliveries as (
        select coalesce(sum(item.quantity), 0) as quantity
        from public.delivery_events event
        join public.delivery_items item on item.delivery_event_id = event.id
        join public.round_stops stop on stop.id = event.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        where round.service_date = p_service_date
          and event.status = 'active'
          and event.source_stock_location_id = p_location_id
          and item.ice_type_id = p_ice_type_id
      )
      select (opening.quantity + movements.quantity - deliveries.quantity)::integer
      from opening, movements, deliveries
    $$;

    create function public.is_delivery_event_visible(target_event_id uuid) returns boolean
    language sql stable as $$
      select exists (
        select 1
        from public.delivery_events event
        join public.round_stops stop on stop.id = event.round_stop_id
        where event.id = target_event_id
          and (
            public.current_app_role() in ('admin', 'round_lead')
            or public.is_round_member(stop.round_id)
          )
      )
    $$;

    create function public.delivery_event_response(p_event_id uuid) returns jsonb
    language sql stable as $$
      select jsonb_build_object(
        'event_id', event.id,
        'round_stop_id', event.round_stop_id,
        'source_stock_location_id', event.source_stock_location_id,
        'items', coalesce((
          select jsonb_agg(
            jsonb_build_object('ice_type_id', item.ice_type_id, 'quantity', item.quantity)
            order by item.ice_type_id
          )
          from public.delivery_items item
          where item.delivery_event_id = event.id
        ), '[]'::jsonb)
      )
      from public.delivery_events event
      where event.id = p_event_id
    $$;
  `);

  await db.exec(migration);

  await db.exec(`
    insert into public.users (id, display_name) values
      ('${USER_ID}', 'Courier Test'),
      ('${OTHER_USER_ID}', 'Other User');

    insert into public.delivery_rounds (id, service_date, status) values
      ('${ROUND_ID}', date '${SERVICE_DATE}', 'open'),
      ('${OTHER_ROUND_ID}', date '${SERVICE_DATE}', 'open');

    insert into public.delivery_round_members (round_id, user_id) values
      ('${ROUND_ID}', '${USER_ID}'),
      ('${OTHER_ROUND_ID}', '${USER_ID}');

    insert into public.stock_locations (
      id, code, name, kind, assigned_user_id, is_active
    ) values
      ('${TRUCK_ID}', 'TRUCK-MAIN', 'Main truck', 'truck', null, true),
      ('${HOLDING_ID}', 'TEAM-COURIER', 'Courier holding', 'team', '${USER_ID}', true),
      ('${SHOP_SOURCE_ID}', 'SITE-SHOP', 'Shop source', 'work_site', null, true);

    insert into public.ice_types (id, code, name, unit, is_active) values
      ('${ICE_SMALL_ID}', 'ICE-SMALL', 'Small ice', 'bag', true),
      ('${ICE_BLOCK_ID}', 'ICE-BLOCK', 'Block ice', 'bag', true);

    insert into public.test_opening_balances (
      service_date, location_id, ice_type_id, quantity
    ) values
      (date '${SERVICE_DATE}', '${TRUCK_ID}', '${ICE_SMALL_ID}', 10),
      (date '${SERVICE_DATE}', '${TRUCK_ID}', '${ICE_BLOCK_ID}', 2),
      (date '${SERVICE_DATE}', '${SHOP_SOURCE_ID}', '${ICE_SMALL_ID}', 5),
      (date '${SERVICE_DATE}', '${SHOP_SOURCE_ID}', '${ICE_BLOCK_ID}', 5);

    insert into public.shops (id, stock_location_id)
    values ('${SHOP_ID}', '${SHOP_SOURCE_ID}');

    insert into public.round_stops (
      id, round_id, shop_id, status, updated_by
    ) values (
      '${STOP_ID}', '${ROUND_ID}', '${SHOP_ID}', 'pending', '${USER_ID}'
    );
  `);

  return db;
}

function items(entries) {
  return JSON.stringify(entries.map(([ice_type_id, quantity]) => ({ ice_type_id, quantity })));
}

async function getState(db, roundId = ROUND_ID) {
  return db.query(`select public.get_employee_stock_state('${roundId}') as result`);
}

async function transfer(db, entries, key, roundId = ROUND_ID) {
  return db.query(`
    select public.record_employee_stock_transfer(
      '${roundId}',
      '${items(entries)}'::jsonb,
      '${key}'
    ) as result
  `);
}

async function deliver(db, quantity, key) {
  return db.query(`
    select public.record_delivery(
      '${STOP_ID}',
      '${items([[ICE_SMALL_ID, quantity]])}'::jsonb,
      'delivered',
      null,
      timestamptz '${SERVICE_DATE} 10:00:00+07',
      '${key}'
    ) as result
  `);
}

function balanceFor(location, iceTypeId) {
  return location.balances.find((balance) => balance.ice_type_id === iceTypeId)?.quantity;
}

test('state and multi-item transfer use the truck and assigned holding atomically', async (t) => {
  const db = await createDatabase(t);
  const requestKey = '70000000-0000-4000-8000-000000000001';

  const initial = (await getState(db)).rows[0].result;
  assert.equal(initial.round_id, ROUND_ID);
  assert.equal(initial.service_date, SERVICE_DATE);
  assert.equal(initial.truck_location.id, TRUCK_ID);
  assert.equal(initial.holding_location.id, HOLDING_ID);
  assert.equal(balanceFor(initial.truck_location, ICE_SMALL_ID), 10);
  assert.equal(balanceFor(initial.holding_location, ICE_SMALL_ID), 0);

  const response = await transfer(db, [
    [ICE_SMALL_ID, 4],
    [ICE_BLOCK_ID, 2],
  ], requestKey);
  const state = response.rows[0].result;
  assert.equal(balanceFor(state.truck_location, ICE_SMALL_ID), 6);
  assert.equal(balanceFor(state.truck_location, ICE_BLOCK_ID), 0);
  assert.equal(balanceFor(state.holding_location, ICE_SMALL_ID), 4);
  assert.equal(balanceFor(state.holding_location, ICE_BLOCK_ID), 2);

  const movement = await db.query(`
    select kind, from_location_id, to_location_id, recorded_by
    from public.stock_movements
    where idempotency_key = '${requestKey}'
  `);
  assert.deepEqual(movement.rows[0], {
    kind: 'transfer',
    from_location_id: TRUCK_ID,
    to_location_id: HOLDING_ID,
    recorded_by: USER_ID,
  });

  const counts = await db.query(`
    select
      (select count(*)::integer from public.stock_movements where idempotency_key = '${requestKey}') as movements,
      (select count(*)::integer
       from public.stock_movement_items item
       join public.stock_movements movement on movement.id = item.movement_id
       where movement.idempotency_key = '${requestKey}') as items,
      (select count(*)::integer
       from public.audit_logs log
       join public.stock_movements movement on movement.id = log.entity_id
       where movement.idempotency_key = '${requestKey}') as audits
  `);
  assert.deepEqual(counts.rows[0], { movements: 1, items: 2, audits: 1 });
});

test('transfer replay normalizes item order and rejects every payload mismatch', async (t) => {
  const db = await createDatabase(t);
  const requestKey = '70000000-0000-4000-8000-000000000002';

  await transfer(db, [
    [ICE_SMALL_ID, 3],
    [ICE_BLOCK_ID, 1],
  ], requestKey);

  const replay = await transfer(db, [
    [ICE_BLOCK_ID, 1],
    [ICE_SMALL_ID, 3],
  ], requestKey);
  assert.equal(balanceFor(replay.rows[0].result.holding_location, ICE_SMALL_ID), 3);

  await assert.rejects(
    transfer(db, [[ICE_SMALL_ID, 2]], requestKey),
    /different employee stock request/i,
  );
  await assert.rejects(
    transfer(db, [
      [ICE_SMALL_ID, 3],
      [ICE_BLOCK_ID, 1],
    ], requestKey, OTHER_ROUND_ID),
    /different employee stock request/i,
  );

  const count = await db.query(`
    select count(*)::integer as count
    from public.stock_movements
    where idempotency_key = '${requestKey}'
  `);
  assert.equal(count.rows[0].count, 1);
});

test('insufficient stock rolls back the full multi-item transfer', async (t) => {
  const db = await createDatabase(t);
  const requestKey = '70000000-0000-4000-8000-000000000003';

  await assert.rejects(
    transfer(db, [
      [ICE_SMALL_ID, 4],
      [ICE_BLOCK_ID, 3],
    ], requestKey),
    /truck does not have enough stock/i,
  );

  const rows = await db.query(`
    select
      (select count(*)::integer from public.stock_movements where idempotency_key = '${requestKey}') as movements,
      (select count(*)::integer from public.stock_movement_items) as items,
      (select count(*)::integer from public.audit_logs) as audits
  `);
  assert.deepEqual(rows.rows[0], { movements: 0, items: 0, audits: 0 });

  const state = (await getState(db)).rows[0].result;
  assert.equal(balanceFor(state.truck_location, ICE_SMALL_ID), 10);
  assert.equal(balanceFor(state.truck_location, ICE_BLOCK_ID), 2);
  assert.equal(balanceFor(state.holding_location, ICE_SMALL_ID), 0);
});

test('courier delivery consumes assigned holding and manager delivery keeps shop source', async (t) => {
  const db = await createDatabase(t);

  await transfer(
    db,
    [[ICE_SMALL_ID, 4]],
    '70000000-0000-4000-8000-000000000004',
  );
  const courierDelivery = await deliver(
    db,
    3,
    '80000000-0000-4000-8000-000000000001',
  );
  assert.equal(courierDelivery.rows[0].result.source_stock_location_id, HOLDING_ID);

  let balances = await db.query(`
    select
      public.stock_balance_at(date '${SERVICE_DATE}', '${TRUCK_ID}', '${ICE_SMALL_ID}') as truck,
      public.stock_balance_at(date '${SERVICE_DATE}', '${HOLDING_ID}', '${ICE_SMALL_ID}') as holding,
      public.stock_balance_at(date '${SERVICE_DATE}', '${SHOP_SOURCE_ID}', '${ICE_SMALL_ID}') as shop
  `);
  assert.deepEqual(balances.rows[0], { truck: 6, holding: 1, shop: 5 });

  await assert.rejects(
    deliver(db, 2, '80000000-0000-4000-8000-000000000002'),
    /source location does not have enough stock/i,
  );

  await db.exec(`update public.auth_context set app_role = 'round_lead' where singleton`);
  const managerDelivery = await deliver(
    db,
    2,
    '80000000-0000-4000-8000-000000000003',
  );
  assert.equal(managerDelivery.rows[0].result.source_stock_location_id, SHOP_SOURCE_ID);

  balances = await db.query(`
    select
      public.stock_balance_at(date '${SERVICE_DATE}', '${HOLDING_ID}', '${ICE_SMALL_ID}') as holding,
      public.stock_balance_at(date '${SERVICE_DATE}', '${SHOP_SOURCE_ID}', '${ICE_SMALL_ID}') as shop
  `);
  assert.deepEqual(balances.rows[0], { holding: 1, shop: 3 });
});

test('zero, inactive, and multiple employee holdings are rejected', async (t) => {
  const db = await createDatabase(t);

  await db.exec(`update public.stock_locations set is_active = false where id = '${HOLDING_ID}'`);
  await assert.rejects(getState(db), /none is configured/i);
  await assert.rejects(
    transfer(db, [[ICE_SMALL_ID, 1]], '90000000-0000-4000-8000-000000000001'),
    /none is configured/i,
  );
  await assert.rejects(
    deliver(db, 1, '90000000-0000-4000-8000-000000000002'),
    /none is configured/i,
  );

  await db.exec(`
    update public.stock_locations set is_active = true where id = '${HOLDING_ID}';
    insert into public.stock_locations (
      id, code, name, kind, assigned_user_id, is_active
    ) values (
      '60000000-0000-4000-8000-000000000004',
      'CART-SECOND',
      'Second cart',
      'small_vehicle',
      '${USER_ID}',
      true
    )
  `);

  await assert.rejects(getState(db), /multiple are configured/i);
  await assert.rejects(
    transfer(db, [[ICE_SMALL_ID, 1]], '90000000-0000-4000-8000-000000000003'),
    /multiple are configured/i,
  );
  await assert.rejects(
    deliver(db, 1, '90000000-0000-4000-8000-000000000004'),
    /multiple are configured/i,
  );
});

test('transfer rejects closed rounds, closed stock days, and unassigned couriers', async (t) => {
  const db = await createDatabase(t);

  await db.exec(`update public.delivery_rounds set status = 'closed' where id = '${ROUND_ID}'`);
  await assert.rejects(
    transfer(db, [[ICE_SMALL_ID, 1]], 'a0000000-0000-4000-8000-000000000001'),
    /round is already closed/i,
  );

  await db.exec(`
    update public.delivery_rounds set status = 'open' where id = '${ROUND_ID}';
    insert into public.daily_stock_closures (service_date, status)
    values (date '${SERVICE_DATE}', 'closed')
  `);
  await assert.rejects(
    transfer(db, [[ICE_SMALL_ID, 1]], 'a0000000-0000-4000-8000-000000000002'),
    /stock for this service date is already closed/i,
  );

  await db.exec(`
    delete from public.daily_stock_closures;
    delete from public.delivery_round_members
    where round_id = '${ROUND_ID}' and user_id = '${USER_ID}'
  `);
  await assert.rejects(getState(db), /not assigned to this delivery round/i);
  await assert.rejects(
    transfer(db, [[ICE_SMALL_ID, 1]], 'a0000000-0000-4000-8000-000000000003'),
    /not assigned to this delivery round/i,
  );
});
