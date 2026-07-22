import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration0042 = readFileSync(
  new URL('../supabase/migrations/0042_daily_work_session_architecture.sql', import.meta.url),
  'utf8',
);

const USER_ID = '10000000-0000-4000-8000-000000000001';
const ICE_TYPE_ID = '40000000-0000-4000-8000-000000000001';
const BUILDING_ID = '50000000-0000-4000-8000-000000000001';
const SHOP_ID = '60000000-0000-4000-8000-000000000001';
const TRUCK_ID = '70000000-0000-4000-8000-000000000001';

async function createDb({ legacyRounds = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create type public.delivery_round_status as enum ('open', 'closed');
    create type public.shop_round_status as enum ('pending', 'delivered', 'issue');
    create type public.stock_location_kind as enum ('truck', 'team', 'small_vehicle', 'work_site', 'reserve_bin', 'front_vehicle');

    create table public.users (
      id uuid primary key,
      role text not null default 'round_lead',
      is_active boolean not null default true
    );
    insert into public.users (id, role, is_active) values ('${USER_ID}', 'round_lead', true);

    create function auth.uid() returns uuid language sql stable as
      'select ''${USER_ID}''::uuid';
    create function public.is_active_user() returns boolean language sql stable as
      'select true';
    create function public.current_app_role() returns text language sql stable as
      'select ''round_lead''::text';

    create table public.delivery_round_name_options (
      id uuid primary key default gen_random_uuid(),
      name text not null unique,
      sort_order integer not null default 0,
      is_active boolean not null default true
    );
    insert into public.delivery_round_name_options (name) values ('เช้ามืด'), ('เช้า');

    create table public.delivery_rounds (
      id uuid primary key default gen_random_uuid(),
      service_date date not null,
      name text not null,
      status public.delivery_round_status not null default 'open',
      opened_by uuid not null references public.users(id),
      opened_at timestamptz not null default now(),
      closed_by uuid references public.users(id),
      closed_at timestamptz,
      created_at timestamptz not null default now(),
      cancelled_at timestamptz,
      check ((status = 'open' and closed_by is null and closed_at is null)
        or (status = 'closed' and closed_by is not null and closed_at is not null))
    );

    create function public.validate_delivery_round_name()
    returns trigger language plpgsql security definer set search_path = public as $$
    begin
      if not exists (select 1 from public.delivery_round_name_options option where option.name = new.name and option.is_active) then
        raise exception 'Delivery round name must be an active configured option';
      end if;
      return new;
    end;
    $$;

    create trigger delivery_rounds_validate_configured_name
    before insert or update of name on public.delivery_rounds
    for each row execute function public.validate_delivery_round_name();

    create table public.delivery_round_members (
      round_id uuid not null references public.delivery_rounds(id),
      user_id uuid not null references public.users(id),
      primary key (round_id, user_id)
    );

    create table public.buildings (
      id uuid primary key,
      name text not null,
      is_active boolean not null default true
    );
    insert into public.buildings values ('${BUILDING_ID}', 'อาคาร A', true);

    create table public.shops (
      id uuid primary key,
      code text not null,
      name text not null,
      building_id uuid not null references public.buildings(id),
      floor_or_zone text,
      status text not null default 'active'
    );
    insert into public.shops values ('${SHOP_ID}', 'S01', 'ร้านน้ำ 1', '${BUILDING_ID}', 'ชั้น 1', 'active');

    create table public.ice_types (
      id uuid primary key,
      code text not null,
      name text not null,
      unit text not null,
      is_active boolean not null default true
    );
    insert into public.ice_types values ('${ICE_TYPE_ID}', 'CUBE', 'น้ำแข็งยูนิต', 'ถุง', true);

    create table public.round_stops (
      id uuid primary key default gen_random_uuid(),
      round_id uuid not null references public.delivery_rounds(id),
      shop_id uuid not null references public.shops(id),
      shop_code_snapshot text not null,
      shop_name_snapshot text not null,
      building_id_snapshot uuid not null,
      building_name_snapshot text not null,
      floor_or_zone_snapshot text,
      sequence_no integer not null default 1,
      status public.shop_round_status not null default 'pending',
      updated_by uuid not null references public.users(id)
    );

    create table public.round_ice_counts (
      round_id uuid not null references public.delivery_rounds(id),
      ice_type_id uuid not null references public.ice_types(id),
      loaded_quantity integer not null default 0,
      replenished_quantity integer not null default 0,
      remaining_quantity integer not null default 0,
      damaged_quantity integer not null default 0,
      updated_by uuid not null references public.users(id),
      primary key (round_id, ice_type_id)
    );

    create table public.stock_locations (
      id uuid primary key,
      code text not null,
      name text not null,
      kind public.stock_location_kind not null,
      holds_inventory boolean not null default true,
      requires_daily_count boolean not null default true,
      is_courier_source boolean not null default true,
      is_active boolean not null default true
    );
    insert into public.stock_locations values ('${TRUCK_ID}', 'TR01', 'รถใหญ่ 1', 'truck', true, true, true, true);

    create table public.stock_movements (
      id uuid primary key default gen_random_uuid(),
      service_date date not null,
      round_id uuid references public.delivery_rounds(id),
      kind text not null,
      from_location_id uuid references public.stock_locations(id),
      to_location_id uuid references public.stock_locations(id),
      note text,
      idempotency_key uuid not null unique,
      recorded_by uuid not null references public.users(id),
      recorded_at timestamptz not null default now(),
      status text not null default 'active'
    );

    create table public.stock_movement_items (
      movement_id uuid not null references public.stock_movements(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity integer not null,
      primary key (movement_id, ice_type_id)
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
      location_kind_snapshot public.stock_location_kind not null,
      ice_type_id uuid not null references public.ice_types(id),
      ice_type_name_snapshot text not null,
      unit_snapshot text not null,
      quantity integer not null,
      primary key (round_id, location_id, ice_type_id)
    );

    create table public.stock_count_snapshots (
      id uuid primary key default gen_random_uuid(),
      service_date date not null,
      location_id uuid not null references public.stock_locations(id),
      counted_by uuid not null references public.users(id),
      counted_at timestamptz not null default now()
    );

    create table public.stock_count_snapshot_items (
      snapshot_id uuid not null references public.stock_count_snapshots(id),
      ice_type_id uuid not null references public.ice_types(id),
      system_quantity numeric not null,
      actual_quantity numeric not null,
      primary key (snapshot_id, ice_type_id)
    );

    create table public.stock_count_variance_reviews (
      snapshot_id uuid not null references public.stock_count_snapshots(id),
      ice_type_id uuid not null references public.ice_types(id),
      status text not null default 'approved',
      primary key (snapshot_id, ice_type_id)
    );

    create function public.is_stock_count_snapshot_current(p_snapshot_id uuid)
    returns boolean language sql stable as 'select true';

    create table public.daily_stock_closures (
      id uuid primary key default gen_random_uuid(),
      service_date date not null unique,
      status text not null,
      note text,
      idempotency_key uuid not null unique,
      request_fingerprint text,
      closed_by uuid not null references public.users(id),
      closed_at timestamptz
    );

    create table public.daily_stock_closure_items (
      service_date date not null,
      location_id uuid not null references public.stock_locations(id),
      ice_type_id uuid not null references public.ice_types(id),
      system_quantity numeric not null,
      actual_quantity numeric not null,
      variance_quantity numeric not null,
      note text,
      primary key (service_date, location_id, ice_type_id)
    );

    create table public.audit_logs (
      id uuid primary key default gen_random_uuid(),
      actor_id uuid not null,
      entity_type text not null,
      entity_id text not null,
      action text not null,
      after_value jsonb,
      created_at timestamptz not null default now()
    );

    create function public.stock_balance_at(p_date date, p_loc uuid, p_ice uuid)
    returns numeric language sql stable as $$
      select 10 + coalesce((
        select sum(item.variance_quantity)
        from public.daily_stock_closure_items item
        join public.daily_stock_closures closure on closure.service_date = item.service_date
        where item.service_date = p_date
          and item.location_id = p_loc
          and item.ice_type_id = p_ice
          and closure.status in ('closing', 'closed')
      ), 0)
    $$;

    create function public.get_factory_order_summary(p_date date, p_loc uuid, p_limit integer default 50)
    returns jsonb language sql stable as 'select jsonb_build_object(''status'', ''ok'')';

    create function public.get_daily_stock_close_state(p_round_id uuid, p_service_date date)
    returns jsonb language sql stable as 'select jsonb_build_object(''status'', ''closed'')';
  `);

  if (legacyRounds) {
    await db.exec(`
      insert into public.delivery_rounds (service_date, name, opened_by)
      values
        ('2026-07-21', 'เช้ามืด', '${USER_ID}'),
        ('2026-07-21', 'เช้า', '${USER_ID}');
    `);
  }

  await db.exec(migration0042);
  return db;
}

test('validate_delivery_round_name exempts system daily round name', async () => {
  const db = await createDb();
  const res = await db.query(`
    insert into public.delivery_rounds (service_date, name, round_type, opened_by)
    values ('2026-07-22', 'งานประจำวัน', 'daily', '${USER_ID}')
    returning id, name, round_type;
  `);
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].name, 'งานประจำวัน');
  assert.equal(res.rows[0].round_type, 'daily');
});

test('migration preserves multiple legacy rounds as special before adding daily uniqueness', async () => {
  const db = await createDb({ legacyRounds: true });
  const legacy = await db.query(`
    select round_type from public.delivery_rounds
    where service_date = '2026-07-21'
    order by name;
  `);
  assert.deepEqual(legacy.rows.map((row) => row.round_type), ['special', 'special']);

  await db.query(`select public.ensure_daily_delivery_round('2026-07-21');`);
  const counts = await db.query(`
    select count(*) filter (where round_type = 'daily') as daily_count,
           count(*) filter (where round_type = 'special') as special_count
    from public.delivery_rounds
    where service_date = '2026-07-21';
  `);
  assert.equal(counts.rows[0].daily_count, 1);
  assert.equal(counts.rows[0].special_count, 2);
});

test('daily helper is not executable by anonymous or authenticated clients', async () => {
  const db = await createDb();
  const privileges = await db.query(`
    select
      has_function_privilege('anon', 'public.ensure_daily_delivery_round(date)', 'execute') as anonymous_execute,
      has_function_privilege('authenticated', 'public.ensure_daily_delivery_round(date)', 'execute') as authenticated_execute;
  `);
  assert.equal(privileges.rows[0].anonymous_execute, false);
  assert.equal(privileges.rows[0].authenticated_execute, false);
});

test('daily type accepts only the system daily name', async () => {
  const db = await createDb();
  await assert.rejects(
    db.query(`
      insert into public.delivery_rounds (service_date, name, round_type, opened_by)
      values ('2026-07-22', 'เช้า', 'daily', '${USER_ID}');
    `),
    /Daily delivery rounds must use the system name/,
  );
});

test('ensure_daily_delivery_round is idempotent', async () => {
  const db = await createDb();
  const res1 = await db.query(`select public.ensure_daily_delivery_round('2026-07-22') as round_id;`);
  const roundId1 = res1.rows[0].round_id;

  const res2 = await db.query(`select public.ensure_daily_delivery_round('2026-07-22') as round_id;`);
  const roundId2 = res2.rows[0].round_id;

  assert.equal(roundId1, roundId2);

  const roundsCount = await db.query(`select count(*) as cnt from public.delivery_rounds where service_date = '2026-07-22';`);
  assert.equal(roundsCount.rows[0].cnt, 1);
});

test('record_factory_order automatically creates daily delivery round', async () => {
  const db = await createDb();
  const payload = JSON.stringify([{ ice_type_id: ICE_TYPE_ID, quantity: 50 }]);
  await db.query(`
    select public.record_factory_order('2026-07-22', '${TRUCK_ID}', '${payload}'::jsonb, 'Test order');
  `);

  const roundRes = await db.query(`select id, name, round_type from public.delivery_rounds where service_date = '2026-07-22';`);
  assert.equal(roundRes.rows.length, 1);
  assert.equal(roundRes.rows[0].name, 'งานประจำวัน');
});

test('factory-order validation still rejects an inactive truck before creating a session', async () => {
  const db = await createDb();
  await db.query(`update public.stock_locations set is_active = false where id = '${TRUCK_ID}';`);
  const payload = JSON.stringify([{ ice_type_id: ICE_TYPE_ID, quantity: 50 }]);

  await assert.rejects(
    db.query(`
      select public.record_factory_order('2026-07-22', '${TRUCK_ID}', '${payload}'::jsonb, 'Test order');
    `),
    /Factory orders require an active truck location/,
  );
  const sessions = await db.query(`select count(*) as count from public.delivery_rounds;`);
  assert.equal(sessions.rows[0].count, 0);
});

test('get_employee_active_session is read-only and returns the factory-created session', async () => {
  const db = await createDb();
  const before = await db.query(`select public.get_employee_active_session('2026-07-22') as session;`);
  assert.equal(before.rows[0].session.sessions.length, 0);

  const payload = JSON.stringify([{ ice_type_id: ICE_TYPE_ID, quantity: 50 }]);
  await db.query(`
    select public.record_factory_order('2026-07-22', '${TRUCK_ID}', '${payload}'::jsonb, 'Test order');
  `);
  const res = await db.query(`select public.get_employee_active_session('2026-07-22') as session;`);
  const session = res.rows[0].session;
  assert.equal(session.single_session, true);
  assert.equal(session.active_round.name, 'งานประจำวัน');
});

test('daily close snapshots the approved actual quantity', async () => {
  const db = await createDb();
  await db.query(`select public.ensure_daily_delivery_round('2026-07-22');`);
  await db.exec(`
    with snapshot as (
      insert into public.stock_count_snapshots (service_date, location_id, counted_by)
      values ('2026-07-22', '${TRUCK_ID}', '${USER_ID}')
      returning id
    )
    insert into public.stock_count_snapshot_items (snapshot_id, ice_type_id, system_quantity, actual_quantity)
    select id, '${ICE_TYPE_ID}', 10, 8 from snapshot;

    insert into public.stock_count_variance_reviews (snapshot_id, ice_type_id, status)
    select id, '${ICE_TYPE_ID}', 'approved'
    from public.stock_count_snapshots;
  `);

  const countsPayload = JSON.stringify([{
    location_id: TRUCK_ID,
    ice_type_id: ICE_TYPE_ID,
    actual_quantity: 8,
    note: 'approved variance'
  }]);
  await db.query(`
    select public.close_daily_stock_v2('${countsPayload}'::jsonb, null, gen_random_uuid(), '2026-07-22');
  `);

  const snapshot = await db.query(`select quantity from public.round_stock_snapshot_items;`);
  assert.equal(snapshot.rows[0].quantity, 8);
});

test('close_daily_stock_v2 atomically closes open daily delivery round', async () => {
  const db = await createDb();
  await db.query(`select public.ensure_daily_delivery_round('2026-07-22');`);

  const countsPayload = JSON.stringify([{
    location_id: TRUCK_ID,
    ice_type_id: ICE_TYPE_ID,
    actual_quantity: 10,
    note: ''
  }]);

  await db.query(`
    select public.close_daily_stock_v2('${countsPayload}'::jsonb, 'Daily close note', gen_random_uuid(), '2026-07-22');
  `);

  const roundRes = await db.query(`select status, closed_by from public.delivery_rounds where service_date = '2026-07-22';`);
  assert.equal(roundRes.rows[0].status, 'closed');
  assert.equal(roundRes.rows[0].closed_by, USER_ID);

  const closureRes = await db.query(`select status from public.daily_stock_closures where service_date = '2026-07-22';`);
  assert.equal(closureRes.rows[0].status, 'closed');
});
