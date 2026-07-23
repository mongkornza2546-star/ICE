import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migrations = [
  ...[33, 34, 35, 36].map((number) => readFileSync(
    new URL(`../supabase/migrations/00${number}_${[
      'stock_holder_foundation',
      'stock_transfer_and_revision_v2',
      'stock_count_and_close_v2',
      'cutover_tool',
    ][number - 33]}.sql`, import.meta.url),
    'utf8',
  )),
  readFileSync(new URL('../supabase/migrations/0056_fix_damage_stock_movements.sql', import.meta.url), 'utf8'),
];

const ADMIN_ID = '10000000-0000-4000-8000-000000000001';
const TRUCK_ID = '20000000-0000-4000-8000-000000000001';
const TEAM_ID = '20000000-0000-4000-8000-000000000002';
const WORK_SITE_ID = '20000000-0000-4000-8000-000000000003';
const BUILDING_ID = '30000000-0000-4000-8000-000000000001';
const ICE_ACTIVE_ID = '40000000-0000-4000-8000-000000000001';
const ICE_INACTIVE_ID = '40000000-0000-4000-8000-000000000002';
const SERVICE_DATE = '2026-07-22';

test('stock-holder v2 enforces holder boundaries and performs a guarded complete cutover', async (t) => {
  const db = await createDatabase(t);

  await seedLocations(db);
  for (const migration of migrations) await db.exec(migration);

  const summaryBefore = await db.query(
    `select public.get_stock_control_summary(null, $1::date) as summary`,
    [SERVICE_DATE],
  );
  const workSiteBefore = summaryBefore.rows[0].summary.locations.find((location) => location.id === WORK_SITE_ID);
  assert.equal(workSiteBefore.holds_inventory, true);
  assert.equal(workSiteBefore.requires_daily_count, false);

  const savedWorkSite = await db.query(
    `select public.save_stock_location(
      'SITE-NEW', 'New report zone', 'work_site', null, $1, null,
      false, false, true, true, false
    ) as id`,
    [BUILDING_ID],
  );
  const newWorkSiteId = savedWorkSite.rows[0].id;
  const newWorkSite = await db.query(
    `select holds_inventory from public.stock_locations where id = $1`,
    [newWorkSiteId],
  );
  assert.equal(newWorkSite.rows[0].holds_inventory, false);

  await assert.rejects(
    db.query(
      `select public.record_location_count_v2(
        $1::date, $2, '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","actual_quantity":0}]'::jsonb,
        null, gen_random_uuid()
      )`,
      [SERVICE_DATE, newWorkSiteId],
    ),
    /not an active stock holder/,
  );

  await insertOpeningMovement(db, WORK_SITE_ID, ICE_ACTIVE_ID, 4);
  await insertOpeningMovement(db, WORK_SITE_ID, ICE_INACTIVE_ID, 2);

  const cutover = await db.query(
    `select public.execute_stock_cutover($1::date) as result`,
    [SERVICE_DATE],
  );
  assert.equal(cutover.rows[0].result.status, 'executed');
  assert.equal(cutover.rows[0].result.moved_item_count, 2);
  assert.equal(Number(cutover.rows[0].result.moved_quantity), 6);

  const balances = await db.query(
    `select
      public.stock_balance_at($1::date, $2, $4) as site_active,
      public.stock_balance_at($1::date, $2, $5) as site_inactive,
      public.stock_balance_at($1::date, $3, $4) as truck_active,
      public.stock_balance_at($1::date, $3, $5) as truck_inactive`,
    [SERVICE_DATE, WORK_SITE_ID, TRUCK_ID, ICE_ACTIVE_ID, ICE_INACTIVE_ID],
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(balances.rows[0]).map(([key, value]) => [key, Number(value)])),
    { site_active: 0, site_inactive: 0, truck_active: 4, truck_inactive: 2 },
  );

  const holderFlags = await db.query(
    `select holds_inventory, requires_daily_count
     from public.stock_locations where id = $1`,
    [WORK_SITE_ID],
  );
  assert.deepEqual(holderFlags.rows[0], { holds_inventory: false, requires_daily_count: false });

  const requiredHolders = await db.query(
    `select code, requires_daily_count
     from public.stock_locations
     where id in ($1, $2)
     order by code`,
    [TRUCK_ID, TEAM_ID],
  );
  assert.deepEqual(requiredHolders.rows, [
    { code: 'TEAM', requires_daily_count: true },
    { code: 'TRUCK', requires_daily_count: true },
  ]);

  const retry = await db.query(
    `select public.execute_stock_cutover($1::date) as result`,
    [SERVICE_DATE],
  );
  assert.equal(retry.rows[0].result.status, 'already_executed');

  await db.query(
    `select public.record_stock_transfer_v2(
      $1::date, 'auto', $2, $3,
      '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
      null, gen_random_uuid()
    )`,
    [SERVICE_DATE, TRUCK_ID, TEAM_ID],
  );

  await assert.rejects(
    db.query(
      `select public.save_stock_location(
        'TRUCK', 'Main truck', 'truck', $1, null, null,
        true, false, true, false, false
      )`,
      [TRUCK_ID],
    ),
    /active inventory-holding truck/,
  );

  await insertOpeningMovement(db, TEAM_ID, ICE_INACTIVE_ID, 1);
  await assert.rejects(
    db.query(
      `select public.save_stock_location(
        'TEAM', 'Employee holder', 'team', $1, null, $2,
        false, false, false, true, true
      )`,
      [TEAM_ID, ADMIN_ID],
    ),
    /open balance/,
  );

  await assert.rejects(
    db.query(
      `select public.record_stock_transfer_v2(
        $1::date, 'auto', $2, $3,
        '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
        null, gen_random_uuid()
      )`,
      [SERVICE_DATE, TRUCK_ID, WORK_SITE_ID],
    ),
    /valid stock holder/,
  );

  await db.query(
    `insert into public.daily_stock_closures (
      service_date, status, idempotency_key, closed_by, closed_at
    ) values ('2026-07-21', 'closed', gen_random_uuid(), $1, now())`,
    [ADMIN_ID],
  );
  await assert.rejects(
    db.query(`select public.execute_stock_cutover('2026-07-21')`),
    /closed service date/,
  );
});

test('damage can omit its note and decrements stock without a round', async (t) => {
  const db = await createDatabase(t);
  await seedLocations(db);
  for (const migration of migrations) await db.exec(migration);
  await insertOpeningMovement(db, TRUCK_ID, ICE_ACTIVE_ID, 4);

  await db.query(
    `select public.record_stock_transfer_v2(
      $1::date, 'damage', $2, null,
      '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
      null, gen_random_uuid()
    )`,
    [SERVICE_DATE, TRUCK_ID],
  );

  const movement = await db.query(
    `select kind, round_id, to_location_id, note
     from public.stock_movements
     where kind = 'damage'`,
  );
  assert.deepEqual(movement.rows, [{
    kind: 'damage',
    round_id: null,
    to_location_id: null,
    note: null,
  }]);

  const balance = await db.query(
    `select public.stock_balance_at($1::date, $2, $3) as quantity`,
    [SERVICE_DATE, TRUCK_ID, ICE_ACTIVE_ID],
  );
  assert.equal(Number(balance.rows[0].quantity), 3);
});

test('latest count variance must be approved before close and reviews are final', async (t) => {
  const db = await createDatabase(t);
  await seedLocations(db);
  for (const migration of migrations) await db.exec(migration);

  await db.query(`select public.execute_stock_cutover($1::date)`, [SERVICE_DATE]);
  await insertOpeningMovement(db, TEAM_ID, ICE_ACTIVE_ID, 4);

  const teamCountKey = '50000000-0000-4000-8000-000000000001';
  await db.query(
    `select public.record_location_count_v2(
      $1::date, $2,
      '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","actual_quantity":3.5}]'::jsonb,
      'counted', $3
    )`,
    [SERVICE_DATE, TEAM_ID, teamCountKey],
  );
  await db.query(
    `select public.record_location_count_v2(
      $1::date, $2,
      '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","actual_quantity":0}]'::jsonb,
      null, $3
    )`,
    [SERVICE_DATE, TRUCK_ID, '50000000-0000-4000-8000-000000000002'],
  );

  const response = await db.query(
    `select public.get_stock_count_variance_reviews($1::date) as reviews`,
    [SERVICE_DATE],
  );
  assert.deepEqual(
    {
      location_name: response.rows[0].reviews[0].location_name,
      ice_type_name: response.rows[0].reviews[0].ice_type_name,
      unit: response.rows[0].reviews[0].unit,
    },
    { location_name: 'Employee holder', ice_type_name: 'Tube ice', unit: 'bag' },
  );
  const reviewId = response.rows[0].reviews[0].id;

  await assert.rejects(
    db.query(
      `select public.close_daily_stock_from_latest_counts(
        null, null, $2, $1::date, false
      )`,
      [SERVICE_DATE, '50000000-0000-4000-8000-000000000003'],
    ),
    /Approve every variance/,
  );

  await db.query(
    `select public.approve_stock_count_variance($1, 'rejected', 'recount required')`,
    [reviewId],
  );
  await assert.rejects(
    db.query(
      `select public.close_daily_stock_from_latest_counts(
        null, null, $2, $1::date, false
      )`,
      [SERVICE_DATE, '50000000-0000-4000-8000-000000000003'],
    ),
    /Approve every variance/,
  );

  await db.query(
    `select public.record_location_count_v2(
      $1::date, $2,
      '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","actual_quantity":3.5}]'::jsonb,
      'recounted', $3
    )`,
    [SERVICE_DATE, TEAM_ID, '50000000-0000-4000-8000-000000000004'],
  );
  const refreshed = await db.query(
    `select public.get_stock_count_variance_reviews($1::date) as reviews`,
    [SERVICE_DATE],
  );
  const pendingReview = refreshed.rows[0].reviews.find((review) => review.status === 'pending');
  assert.ok(pendingReview);
  await db.query(
    `select public.approve_stock_count_variance($1, 'approved', 'checked')`,
    [pendingReview.id],
  );

  await db.query(
    `select public.record_location_count_v2(
      $1::date, $2,
      '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","actual_quantity":3.5}]'::jsonb,
      'final recount', $3
    )`,
    [SERVICE_DATE, TEAM_ID, '50000000-0000-4000-8000-000000000005'],
  );
  await assert.rejects(
    db.query(
      `select public.close_daily_stock_from_latest_counts(
        null, null, $2, $1::date, false
      )`,
      [SERVICE_DATE, '50000000-0000-4000-8000-000000000003'],
    ),
    /Approve every variance/,
  );
  const finalReviews = await db.query(
    `select public.get_stock_count_variance_reviews($1::date) as reviews`,
    [SERVICE_DATE],
  );
  const finalPendingReview = finalReviews.rows[0].reviews.find((review) => review.status === 'pending');
  assert.ok(finalPendingReview);
  await db.query(
    `select public.approve_stock_count_variance($1, 'approved', 'latest count checked')`,
    [finalPendingReview.id],
  );

  const closed = await db.query(
    `select public.close_daily_stock_from_latest_counts(
      null, null, $2, $1::date, false
    ) as result`,
    [SERVICE_DATE, '50000000-0000-4000-8000-000000000003'],
  );
  assert.equal(closed.rows[0].result.is_closed, true);

  await assert.rejects(
    db.query(`select public.approve_stock_count_variance($1, 'approved', null)`, [reviewId]),
    /already been reviewed/,
  );
});

test('transfer and count idempotency keys reject a different payload', async (t) => {
  const db = await createDatabase(t);
  await seedLocations(db);
  for (const migration of migrations) await db.exec(migration);
  await db.query(`select public.execute_stock_cutover($1::date)`, [SERVICE_DATE]);
  await insertOpeningMovement(db, TRUCK_ID, ICE_ACTIVE_ID, 4);

  const transferKey = '60000000-0000-4000-8000-000000000001';
  await db.query(
    `select public.record_stock_transfer_v2(
      $1::date, 'auto', $2, $3,
      '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
      null, $4
    )`,
    [SERVICE_DATE, TRUCK_ID, TEAM_ID, transferKey],
  );
  await db.query(
    `select public.record_stock_transfer_v2(
      $1::date, 'auto', $2, $3,
      '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
      null, $4
    )`,
    [SERVICE_DATE, TRUCK_ID, TEAM_ID, transferKey],
  );
  await assert.rejects(
    db.query(
      `select public.record_stock_transfer_v2(
        $1::date, 'auto', $2, $3,
        '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","quantity":2}]'::jsonb,
        null, $4
      )`,
      [SERVICE_DATE, TRUCK_ID, TEAM_ID, transferKey],
    ),
    /another stock transfer request/,
  );

  const countKey = '60000000-0000-4000-8000-000000000002';
  await db.query(
    `select public.record_location_count_v2(
      $1::date, $2,
      '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","actual_quantity":1}]'::jsonb,
      null, $3
    )`,
    [SERVICE_DATE, TEAM_ID, countKey],
  );
  await db.query(
    `select public.record_location_count_v2(
      $1::date, $2,
      '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","actual_quantity":1}]'::jsonb,
      null, $3
    )`,
    [SERVICE_DATE, TEAM_ID, countKey],
  );
  await assert.rejects(
    db.query(
      `select public.record_location_count_v2(
        $1::date, $2,
        '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","actual_quantity":0.5}]'::jsonb,
        null, $3
      )`,
      [SERVICE_DATE, TEAM_ID, countKey],
    ),
    /another stock count request/,
  );
});

async function createDatabase(t) {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());

  await db.exec(`
    create extension if not exists pgcrypto;
    create role authenticated;
    create schema auth;

    create type public.app_role as enum ('courier', 'round_lead', 'admin');
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
      role public.app_role not null,
      is_active boolean not null
    );
    insert into public.auth_context (user_id, role, is_active)
    values ('${ADMIN_ID}', 'admin', true);

    create function auth.uid() returns uuid language sql stable as $$
      select user_id from public.auth_context where singleton
    $$;
    create function public.current_app_role() returns public.app_role language sql stable as $$
      select role from public.auth_context where singleton
    $$;
    create function public.is_active_user() returns boolean language sql stable as $$
      select is_active from public.auth_context where singleton
    $$;

    create table public.users (
      id uuid primary key,
      code text not null unique,
      display_name text not null,
      role public.app_role not null,
      is_active boolean not null default true
    );
    create table public.buildings (
      id uuid primary key,
      code text not null unique,
      name text not null,
      is_active boolean not null default true
    );
    create table public.building_zones (
      id uuid primary key,
      building_id uuid not null references public.buildings(id),
      code text not null,
      name text not null
    );
    create table public.stock_locations (
      id uuid primary key default gen_random_uuid(),
      code text not null unique,
      name text not null,
      kind public.stock_location_kind not null,
      building_id uuid references public.buildings(id),
      assigned_user_id uuid references public.users(id),
      is_courier_source boolean not null default false,
      is_default_for_building boolean not null default false,
      is_active boolean not null default true
    );
    create table public.ice_types (
      id uuid primary key,
      code text not null unique,
      name text not null,
      unit text not null,
      is_active boolean not null default true
    );
    create table public.delivery_rounds (
      id uuid primary key default gen_random_uuid(),
      service_date date not null,
      status text not null default 'open'
    );
    create table public.daily_stock_closures (
      service_date date primary key,
      status text not null check (status in ('closing', 'closed')),
      note text,
      idempotency_key uuid not null unique,
      closed_by uuid not null references public.users(id),
      closed_at timestamptz
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
      recorded_at timestamptz not null default now(),
      cancelled_by uuid references public.users(id),
      cancelled_at timestamptz,
      cancellation_reason text,
      constraint stock_movements_round_or_factory_order_check
        check (round_id is not null or kind in ('factory_order', 'transfer', 'return_to_factory'))
    );
    create table public.stock_movement_items (
      movement_id uuid not null references public.stock_movements(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity numeric(12, 1) not null,
      primary key (movement_id, ice_type_id)
    );
    create table public.delivery_events (
      id uuid primary key default gen_random_uuid(),
      source_stock_location_id uuid references public.stock_locations(id),
      status text not null default 'active',
      recorded_at timestamptz not null default now(),
      cancelled_at timestamptz
    );
    create table public.stock_count_snapshots (
      id uuid primary key default gen_random_uuid(),
      service_date date not null,
      location_id uuid not null references public.stock_locations(id),
      note text,
      counted_by uuid not null references public.users(id),
      counted_at timestamptz not null default now()
    );
    create table public.stock_count_snapshot_items (
      snapshot_id uuid not null references public.stock_count_snapshots(id),
      ice_type_id uuid not null references public.ice_types(id),
      system_quantity numeric(12, 1) not null,
      actual_quantity numeric(12, 1) not null,
      variance_quantity numeric(12, 1) not null,
      primary key (snapshot_id, ice_type_id)
    );
    create table public.daily_stock_closure_items (
      service_date date not null references public.daily_stock_closures(service_date),
      location_id uuid not null references public.stock_locations(id),
      ice_type_id uuid not null references public.ice_types(id),
      system_quantity numeric(12, 1) not null,
      actual_quantity numeric(12, 1) not null,
      variance_quantity numeric(12, 1) not null,
      note text,
      primary key (service_date, location_id, ice_type_id)
    );
    create table public.shops (
      id uuid primary key default gen_random_uuid(),
      stock_location_id uuid references public.stock_locations(id)
    );
    create table public.audit_logs (
      id uuid primary key default gen_random_uuid(),
      actor_id uuid not null references public.users(id),
      entity_type text not null,
      entity_id uuid not null,
      action text not null,
      before_value jsonb,
      after_value jsonb,
      occurred_at timestamptz not null default now()
    );

    create function public.stock_balance_at(
      p_service_date date, p_location_id uuid, p_ice_type_id uuid
    ) returns numeric(12, 1) language sql stable as $$
      with movements as (
        select
          coalesce(sum(item.quantity) filter (where movement.to_location_id = p_location_id), 0)
          - coalesce(sum(item.quantity) filter (where movement.from_location_id = p_location_id), 0)
          as quantity
        from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date
          and movement.status = 'active'
          and item.ice_type_id = p_ice_type_id
      ), adjustments as (
        select coalesce(sum(item.variance_quantity), 0) as quantity
        from public.daily_stock_closure_items item
        join public.daily_stock_closures closure on closure.service_date = item.service_date
        where item.service_date = p_service_date
          and item.location_id = p_location_id
          and item.ice_type_id = p_ice_type_id
          and closure.status in ('closing', 'closed')
      )
      select (movements.quantity + adjustments.quantity)::numeric(12, 1)
      from movements, adjustments
    $$;
    create function public.get_stock_control_summary(
      p_round_id uuid default null, p_service_date date default null
    ) returns jsonb language sql stable security definer as $$
      select jsonb_build_object(
        'service_date', p_service_date,
        'locations', coalesce((select jsonb_agg(jsonb_build_object(
          'id', location.id,
          'code', location.code,
          'name', location.name,
          'kind', location.kind,
          'balances', '[]'::jsonb
        ) order by location.code) from public.stock_locations location), '[]'::jsonb),
        'recent_movements', '[]'::jsonb
      )
    $$;
    create function public.get_daily_stock_close_state(
      p_round_id uuid default null, p_service_date date default null
    ) returns jsonb language sql stable security definer as $$
      select jsonb_build_object(
        'service_date', p_service_date,
        'open_round_count', 0,
        'is_closed', exists (
          select 1 from public.daily_stock_closures
          where service_date = p_service_date and status = 'closed'
        ),
        'closed_at', null,
        'closed_by', null,
        'note', null,
        'counts', '[]'::jsonb
      )
    $$;
    create function public.is_stock_count_snapshot_current(target_snapshot_id uuid)
    returns boolean language sql stable as $$
      select exists (select 1 from public.stock_count_snapshots where id = target_snapshot_id)
    $$;
  `);

  return db;
}

async function seedLocations(db) {
  await db.query(
    `insert into public.users (id, code, display_name, role)
     values ($1, 'ADMIN', 'Administrator', 'admin')`,
    [ADMIN_ID],
  );
  await db.query(
    `insert into public.buildings (id, code, name)
     values ($1, 'BLDG', 'Building')`,
    [BUILDING_ID],
  );
  await db.query(
    `insert into public.stock_locations (
      id, code, name, kind, building_id, assigned_user_id,
      is_courier_source, is_active
    ) values
      ($1, 'TRUCK', 'Main truck', 'truck', null, null, true, true),
      ($2, 'TEAM', 'Employee holder', 'team', null, $4, false, true),
      ($3, 'SITE', 'Legacy work site', 'work_site', $5, null, false, false)`,
    [TRUCK_ID, TEAM_ID, WORK_SITE_ID, ADMIN_ID, BUILDING_ID],
  );
  await db.query(
    `insert into public.ice_types (id, code, name, unit, is_active) values
      ($1, 'TUBE', 'Tube ice', 'bag', true),
      ($2, 'OLD', 'Inactive ice', 'bag', false)`,
    [ICE_ACTIVE_ID, ICE_INACTIVE_ID],
  );
}

async function insertOpeningMovement(db, locationId, iceTypeId, quantity) {
  const movement = await db.query(
    `insert into public.stock_movements (
      service_date, kind, to_location_id, idempotency_key, recorded_by
    ) values ($1::date, 'factory_order', $2, gen_random_uuid(), $3)
    returning id`,
    [SERVICE_DATE, locationId, ADMIN_ID],
  );
  await db.query(
    `insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
     values ($1, $2, $3)`,
    [movement.rows[0].id, iceTypeId, quantity],
  );
}
