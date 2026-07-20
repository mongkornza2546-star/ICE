import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const snapshotMigration = readFileSync(
  new URL('../supabase/migrations/0026_round_stock_snapshots.sql', import.meta.url),
  'utf8',
);
const cancellationMigration = readFileSync(
  new URL('../supabase/migrations/0027_cancel_delivery_round.sql', import.meta.url),
  'utf8',
);

const USER_ID = '10000000-0000-4000-8000-000000000001';
const ROUND_ID = '10000000-0000-4000-8000-000000000002';
const LOCATION_ID = '10000000-0000-4000-8000-000000000003';
const ICE_TYPE_ID = '10000000-0000-4000-8000-000000000004';
const CANCELLED_ROUND_ID = '10000000-0000-4000-8000-000000000005';

test('closed-round stock remains frozen while the service-date stock continues', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role authenticated;
    create schema auth;

    create function auth.uid() returns uuid
    language sql stable as $$ select '${USER_ID}'::uuid $$;

    create function public.is_active_user() returns boolean
    language sql stable as $$ select true $$;

    create function public.current_app_role() returns text
    language sql stable as $$ select 'admin'::text $$;

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

    create table public.users (
      id uuid primary key,
      display_name text not null
    );

    create table public.ice_types (
      id uuid primary key,
      code text not null,
      name text not null,
      unit text not null,
      is_active boolean not null default true
    );

    create table public.delivery_rounds (
      id uuid primary key,
      service_date date not null,
      status public.delivery_round_status not null default 'open',
      closed_by uuid references public.users(id),
      closed_at timestamptz
    );

    create table public.stock_locations (
      id uuid primary key,
      code text not null,
      name text not null,
      kind public.stock_location_kind not null,
      is_active boolean not null default true
    );

    create table public.stock_movements (
      id uuid primary key default gen_random_uuid(),
      service_date date not null,
      round_id uuid references public.delivery_rounds(id),
      kind public.stock_movement_kind not null,
      from_location_id uuid references public.stock_locations(id),
      to_location_id uuid references public.stock_locations(id),
      note text,
      status public.stock_movement_status not null default 'active',
      recorded_by uuid not null references public.users(id),
      recorded_at timestamptz not null default now(),
      cancelled_at timestamptz
    );

    create table public.stock_movement_items (
      movement_id uuid not null references public.stock_movements(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity integer not null,
      primary key (movement_id, ice_type_id)
    );

    create table public.round_stops (
      id uuid primary key default gen_random_uuid(),
      round_id uuid not null references public.delivery_rounds(id),
      status public.shop_round_status not null default 'pending'
    );

    create table public.delivery_events (
      id uuid primary key default gen_random_uuid(),
      round_stop_id uuid not null references public.round_stops(id),
      source_stock_location_id uuid references public.stock_locations(id),
      status public.delivery_event_status not null default 'active',
      recorded_by uuid not null references public.users(id),
      recorded_at timestamptz not null default now(),
      cancelled_at timestamptz
    );

    create table public.delivery_items (
      delivery_event_id uuid not null references public.delivery_events(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity integer not null,
      primary key (delivery_event_id, ice_type_id)
    );

    create table public.round_close_summaries (
      round_id uuid primary key references public.delivery_rounds(id),
      total_shop_count integer not null,
      delivered_shop_count integer not null,
      pending_shop_count integer not null,
      problem_shop_count integer not null,
      captured_by uuid not null references public.users(id),
      captured_at timestamptz not null
    );

    create table public.round_ice_counts (
      round_id uuid not null references public.delivery_rounds(id),
      ice_type_id uuid not null references public.ice_types(id),
      loaded_quantity integer not null default 0,
      replenished_quantity integer not null default 0,
      remaining_quantity integer not null default 0,
      damaged_quantity integer not null default 0,
      primary key (round_id, ice_type_id)
    );

    create table public.audit_logs (
      id uuid primary key default gen_random_uuid(),
      actor_id uuid not null references public.users(id),
      entity_type text not null,
      entity_id uuid not null,
      action text not null,
      after_value jsonb
    );

    create function public.get_round_control_summary(p_round_id uuid)
    returns jsonb language sql stable as $$ select '{}'::jsonb $$;

    create function public.stock_balance_at(
      p_service_date date,
      p_location_id uuid,
      p_ice_type_id uuid
    ) returns integer
    language sql stable as $$
      with movement_totals as (
        select
          coalesce(sum(item.quantity) filter (where movement.to_location_id = p_location_id), 0)
            - coalesce(sum(item.quantity) filter (where movement.from_location_id = p_location_id), 0)
            as quantity
        from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date
          and movement.status = 'active'
          and item.ice_type_id = p_ice_type_id
      ), delivery_totals as (
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
      select (movement_totals.quantity - delivery_totals.quantity)::integer
      from movement_totals, delivery_totals
    $$;

    insert into public.users (id, display_name) values ('${USER_ID}', 'ผู้ทดสอบ');
    insert into public.ice_types (id, code, name, unit)
    values ('${ICE_TYPE_ID}', 'SMALL', 'หลอดเล็ก', 'ถุง');
    insert into public.stock_locations (id, code, name, kind)
    values ('${LOCATION_ID}', 'TRUCK', 'รถบรรทุก', 'truck');
    insert into public.delivery_rounds (id, service_date)
    values ('${ROUND_ID}', date '2026-07-20');
    insert into public.delivery_rounds (id, service_date)
    values ('${CANCELLED_ROUND_ID}', date '2026-07-20');
  `);

  await db.exec(snapshotMigration);
  await db.exec(cancellationMigration);

  const order = await db.query(`
    insert into public.stock_movements (
      service_date, round_id, kind, to_location_id, recorded_by
    ) values (
      date '2026-07-20', '${ROUND_ID}', 'factory_order', '${LOCATION_ID}', '${USER_ID}'
    ) returning id
  `);
  await db.query(`
    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    values ('${order.rows[0].id}', '${ICE_TYPE_ID}', 100)
  `);

  await db.query(`
    select public.close_delivery_round('${ROUND_ID}', '[]'::jsonb)
  `);
  const closedSnapshot = await db.query(`
    select captured_at from public.round_stock_snapshots where round_id = '${ROUND_ID}'
  `);

  await new Promise((resolve) => setTimeout(resolve, 5));

  const damage = await db.query(`
    insert into public.stock_movements (
      service_date, round_id, kind, from_location_id, recorded_by, recorded_at
    ) values (
      date '2026-07-20', '${ROUND_ID}', 'damage', '${LOCATION_ID}', '${USER_ID}',
      timestamptz '2000-01-01 00:00:00+00'
    ) returning id, recorded_at
  `);
  await db.query(`
    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    values ('${damage.rows[0].id}', '${ICE_TYPE_ID}', 20)
  `);

  const historical = await db.query(`
    select public.get_stock_control_summary(
      p_round_id => '${ROUND_ID}', p_service_date => date '2026-07-20'
    ) as summary
  `);
  const live = await db.query(`
    select public.get_stock_control_summary(
      p_service_date => date '2026-07-20'
    ) as summary
  `);

  assert.equal(historical.rows[0].summary.is_snapshot, true);
  assert.equal(historical.rows[0].summary.locations[0].balances[0].quantity, 100);
  assert.equal(historical.rows[0].summary.recent_movements.length, 1);
  assert.equal(live.rows[0].summary.is_snapshot, false);
  assert.equal(live.rows[0].summary.locations[0].balances[0].quantity, 80);
  assert.equal(live.rows[0].summary.recent_movements.length, 2);
  assert.ok(
    new Date(damage.rows[0].recorded_at) > new Date(closedSnapshot.rows[0].captured_at),
    'ledger trigger must replace a stale client timestamp with the post-snapshot statement time',
  );

  await db.query(`
    select public.cancel_delivery_round('${CANCELLED_ROUND_ID}', 'เปิดรอบผิด')
  `);
  const cancelled = await db.query(`
    select public.get_stock_control_summary(
      p_round_id => '${CANCELLED_ROUND_ID}', p_service_date => date '2026-07-20'
    ) as summary
  `);

  assert.equal(cancelled.rows[0].summary.is_snapshot, true);
  assert.equal(cancelled.rows[0].summary.locations[0].balances[0].quantity, 80);
});
