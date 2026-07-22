import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0014_employee_truck_delivery_source.sql', import.meta.url),
  'utf8',
);

const USER_ID = '10000000-0000-4000-8000-000000000001';
const ICE_TYPE_ID = '20000000-0000-4000-8000-000000000001';
const ROUND_ID = '30000000-0000-4000-8000-000000000001';
const SHOP_ID = '40000000-0000-4000-8000-000000000001';
const STOP_ID = '50000000-0000-4000-8000-000000000001';
const TRUCK_MAIN_ID = '60000000-0000-4000-8000-000000000001';
const TRUCK_ALT_ID = '60000000-0000-4000-8000-000000000002';
const SHOP_SOURCE_ID = '60000000-0000-4000-8000-000000000003';
const SERVICE_DATE = '2026-07-18';

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
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

    create table public.auth_context (
      id boolean primary key default true,
      user_id uuid not null,
      app_role public.app_role not null,
      is_active boolean not null
    );

    insert into public.auth_context (user_id, app_role, is_active)
    values ('${USER_ID}', 'courier', true);

    create function auth.uid() returns uuid
    language sql stable as $$
      select user_id from public.auth_context where id
    $$;

    create function public.current_app_role() returns public.app_role
    language sql stable as $$
      select app_role from public.auth_context where id
    $$;

    create function public.is_active_user() returns boolean
    language sql stable as $$
      select is_active from public.auth_context where id
    $$;

    create table public.delivery_rounds (
      id uuid primary key,
      service_date date not null,
      status public.delivery_round_status not null
    );

    create table public.delivery_round_members (
      round_id uuid not null,
      user_id uuid not null,
      primary key (round_id, user_id)
    );

    create function public.is_round_member(target_round_id uuid) returns boolean
    language sql stable as $$
      select exists(
        select 1 from public.delivery_round_members
        where round_id = target_round_id and user_id = auth.uid()
      )
    $$;

    create table public.stock_locations (
      id uuid primary key,
      code text not null unique,
      kind public.stock_location_kind not null,
      is_active boolean not null
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
      updated_by uuid not null,
      updated_at timestamptz not null default now()
    );

    create table public.ice_types (
      id uuid primary key,
      is_active boolean not null
    );

    create table public.delivery_events (
      id uuid primary key default gen_random_uuid(),
      round_stop_id uuid not null references public.round_stops(id),
      recorded_by uuid not null,
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
      actor_id uuid not null,
      entity_type text not null,
      entity_id uuid not null,
      action text not null,
      after_value jsonb
    );

    create table public.test_opening_balances (
      location_id uuid not null references public.stock_locations(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity integer not null,
      primary key (location_id, ice_type_id)
    );

    create function public.is_delivery_event_visible(target_event_id uuid) returns boolean
    language sql stable as $$
      select exists(
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
        'id', event.id,
        'round_stop_id', event.round_stop_id,
        'source_stock_location_id', event.source_stock_location_id
      )
      from public.delivery_events event
      where event.id = p_event_id
    $$;

    create function public.stock_balance_at(
      p_service_date date,
      p_location_id uuid,
      p_ice_type_id uuid
    ) returns integer
    language sql stable as $$
      select (
        coalesce((
          select opening.quantity
          from public.test_opening_balances opening
          where opening.location_id = p_location_id
            and opening.ice_type_id = p_ice_type_id
        ), 0)
        - coalesce((
          select sum(item.quantity)
          from public.delivery_events event
          join public.delivery_items item on item.delivery_event_id = event.id
          join public.round_stops stop on stop.id = event.round_stop_id
          join public.delivery_rounds round on round.id = stop.round_id
          where round.service_date = p_service_date
            and event.status = 'active'
            and event.source_stock_location_id = p_location_id
            and item.ice_type_id = p_ice_type_id
        ), 0)
      )::integer
    $$;

    insert into public.delivery_rounds (id, service_date, status)
    values ('${ROUND_ID}', date '${SERVICE_DATE}', 'open');

    insert into public.delivery_round_members (round_id, user_id)
    values ('${ROUND_ID}', '${USER_ID}');

    insert into public.stock_locations (id, code, kind, is_active) values
      ('${TRUCK_MAIN_ID}', 'TRUCK-MAIN', 'truck', true),
      ('${TRUCK_ALT_ID}', 'TRUCK-ALT', 'truck', true),
      ('${SHOP_SOURCE_ID}', 'SITE-A', 'work_site', true);

    insert into public.shops (id, stock_location_id)
    values ('${SHOP_ID}', '${SHOP_SOURCE_ID}');

    insert into public.round_stops (
      id, round_id, shop_id, status, updated_by
    ) values (
      '${STOP_ID}', '${ROUND_ID}', '${SHOP_ID}', 'pending', '${USER_ID}'
    );

    insert into public.ice_types (id, is_active)
    values ('${ICE_TYPE_ID}', true);

    insert into public.test_opening_balances (location_id, ice_type_id, quantity) values
      ('${TRUCK_MAIN_ID}', '${ICE_TYPE_ID}', 5),
      ('${TRUCK_ALT_ID}', '${ICE_TYPE_ID}', 100),
      ('${SHOP_SOURCE_ID}', '${ICE_TYPE_ID}', 7);
  `);

  await db.exec(migration);
  return db;
}

function deliveryItems(quantity) {
  return JSON.stringify([{ ice_type_id: ICE_TYPE_ID, quantity }]);
}

async function recordDelivery(db, quantity, idempotencyKey) {
  return db.query(`
    select public.record_delivery(
      '${STOP_ID}',
      '${deliveryItems(quantity)}'::jsonb,
      'delivered',
      null,
      timestamptz '${SERVICE_DATE} 10:00:00+07',
      '${idempotencyKey}'
    ) as result
  `);
}

test('courier snapshots TRUCK-MAIN and stock validation follows that source', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.stock_locations
    set is_active = false
    where id = '${TRUCK_ALT_ID}';
  `);
  const requestKey = '70000000-0000-4000-8000-000000000001';

  const response = await recordDelivery(db, 4, requestKey);
  assert.equal(response.rows[0].result.source_stock_location_id, TRUCK_MAIN_ID);

  const event = await db.query(`
    select source_stock_location_id
    from public.delivery_events
    where idempotency_key = '${requestKey}'
  `);
  assert.equal(event.rows[0].source_stock_location_id, TRUCK_MAIN_ID);

  const balances = await db.query(`
    select
      public.stock_balance_at(date '${SERVICE_DATE}', '${TRUCK_MAIN_ID}', '${ICE_TYPE_ID}') as truck,
      public.stock_balance_at(date '${SERVICE_DATE}', '${TRUCK_ALT_ID}', '${ICE_TYPE_ID}') as alternate,
      public.stock_balance_at(date '${SERVICE_DATE}', '${SHOP_SOURCE_ID}', '${ICE_TYPE_ID}') as shop
  `);
  assert.deepEqual(balances.rows[0], { truck: 1, alternate: 100, shop: 7 });

  await assert.rejects(
    recordDelivery(db, 2, '70000000-0000-4000-8000-000000000002'),
    /source location does not have enough stock/i,
  );
});

test('round lead snapshots and deducts the shop configured source', async (t) => {
  const db = await createDatabase(t);
  const requestKey = '80000000-0000-4000-8000-000000000001';
  await db.exec(`update public.auth_context set app_role = 'round_lead' where id`);

  const response = await recordDelivery(db, 3, requestKey);
  assert.equal(response.rows[0].result.source_stock_location_id, SHOP_SOURCE_ID);

  const balances = await db.query(`
    select
      public.stock_balance_at(date '${SERVICE_DATE}', '${TRUCK_MAIN_ID}', '${ICE_TYPE_ID}') as truck,
      public.stock_balance_at(date '${SERVICE_DATE}', '${SHOP_SOURCE_ID}', '${ICE_TYPE_ID}') as shop
  `);
  assert.deepEqual(balances.rows[0], { truck: 5, shop: 4 });
});

test('courier rejects ambiguous active trucks when multiple exist', async (t) => {
  const db = await createDatabase(t);

  await assert.rejects(
    recordDelivery(db, 1, '90000000-0000-4000-8000-000000000001'),
    /exactly one active truck/i,
  );

  const events = await db.query(`select count(*)::integer as count from public.delivery_events`);
  assert.equal(events.rows[0].count, 0);
});
