import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const darkLaunchMigration = readFileSync(
  new URL('../supabase/migrations/0166_event_destination_sync_dark_launch.sql', import.meta.url),
  'utf8',
);
const activationMigration = readFileSync(
  new URL('../supabase/migrations/0167_enable_event_destination_stops.sql', import.meta.url),
  'utf8',
);

test('event destination sync keeps activation separate and locks in global order', () => {
  assert.match(darkLaunchMigration, /schema_version = greatest\(schema_version, 3\)/);
  assert.doesNotMatch(darkLaunchMigration, /event_stops_enabled\s*=\s*true/);
  assert.match(activationMigration, /event_stops_enabled = true/);
  assert.match(activationMigration, /event_ice_delivery_enabled = false/);
  assert.match(activationMigration, /event_tank_rental_enabled = false/);

  const sessionDefinition = darkLaunchMigration.match(
    /create or replace function public\.get_employee_active_session[\s\S]*?\n\$\$;/,
  )?.[0];
  assert.ok(sessionDefinition);
  assert.ok(sessionDefinition.indexOf('pg_advisory_xact_lock') >= 0);
  assert.ok(sessionDefinition.indexOf('for update;') > sessionDefinition.indexOf('pg_advisory_xact_lock'));
  assert.ok(sessionDefinition.indexOf('insert into public.delivery_round_members') > sessionDefinition.indexOf('for update;'));

  const syncDefinition = darkLaunchMigration.match(
    /create or replace function public\.sync_daily_round_destinations[\s\S]*?\n\$\$;/,
  )?.[0];
  assert.ok(syncDefinition);
  const serviceDateLockAt = syncDefinition.indexOf('pg_advisory_xact_lock');
  const roundLockAt = syncDefinition.indexOf('for update;');
  const jobLockAt = syncDefinition.indexOf('for update of job');
  const participationLockAt = syncDefinition.indexOf('for update of participation');
  assert.ok(serviceDateLockAt >= 0);
  assert.ok(roundLockAt > serviceDateLockAt);
  assert.ok(jobLockAt > roundLockAt);
  assert.ok(participationLockAt > jobLockAt);
  assert.match(syncDefinition, /stop\.destination_kind = 'event'/);
  assert.match(syncDefinition, /where v_round\.service_date between job\.start_date and job\.end_date/);
});

test('dark launch syncs membership and regular stops before event activation', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create type public.app_role as enum ('courier', 'round_lead', 'admin');
    create type public.shop_status as enum ('active', 'inactive');
    create type public.delivery_round_status as enum ('open', 'closed');
    create type public.shop_round_status as enum (
      'pending', 'delivered', 'full_bin', 'closed_shop', 'no_access', 'issue'
    );
    create type public.round_destination_kind as enum ('regular', 'event');
    create type public.event_job_status as enum ('draft', 'published', 'cancelled');
    create type public.event_participation_status as enum ('active', 'cancelled');

    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.test_user_id', true), '')::uuid
    $$;

    create table public.users (
      id uuid primary key, role public.app_role not null, is_active boolean not null
    );
    create function public.is_active_user() returns boolean language sql stable as $$
      select exists (
        select 1 from public.users where id = auth.uid() and is_active
      )
    $$;
    create function public.current_app_role() returns public.app_role language sql stable as $$
      select role from public.users where id = auth.uid() and is_active
    $$;

    create table public.buildings (
      id uuid primary key, name text not null, sort_order integer not null,
      is_active boolean not null
    );
    create table public.building_zones (
      id uuid primary key, sort_order integer not null
    );
    create table public.shops (
      id uuid primary key, code text not null, name text not null,
      building_id uuid not null, zone_id uuid not null, floor_or_zone text not null,
      delivery_sequence integer, status public.shop_status not null,
      contact_name text, contact_phone text
    );
    create table public.delivery_rounds (
      id uuid primary key, service_date date not null, name text not null,
      round_type text not null, status public.delivery_round_status not null,
      opened_at timestamptz not null default now(), created_at timestamptz not null default now(),
      cancelled_at timestamptz
    );
    create table public.delivery_round_members (
      round_id uuid not null, user_id uuid not null,
      primary key (round_id, user_id)
    );
    create function public.is_round_member(p_round_id uuid) returns boolean language sql stable as $$
      select exists (
        select 1 from public.delivery_round_members
        where round_id = p_round_id and user_id = auth.uid()
      )
    $$;

    create table public.event_jobs (
      id uuid primary key, name text not null, location text not null,
      start_date date not null, end_date date not null,
      status public.event_job_status not null
    );
    create table public.event_participations (
      id uuid primary key, event_job_id uuid not null, shop_id uuid not null,
      booth_number text, event_zone text, landmark text, contact_name text,
      contact_phone text, start_date date not null, end_date date not null,
      status public.event_participation_status not null
    );
    create table public.event_delivery_feature_settings (
      singleton boolean primary key, schema_version integer not null,
      lifecycle_enabled boolean not null, event_reads_enabled boolean not null,
      event_stops_enabled boolean not null, event_ice_delivery_enabled boolean not null,
      event_tank_rental_enabled boolean not null, updated_at timestamptz not null
    );
    create table public.round_stops (
      id uuid primary key default gen_random_uuid(), round_id uuid not null,
      shop_id uuid not null, shop_code_snapshot text not null,
      shop_name_snapshot text not null, building_id_snapshot uuid not null,
      building_name_snapshot text not null, floor_or_zone_snapshot text not null,
      sequence_no integer not null, status public.shop_round_status not null default 'pending',
      note text, updated_by uuid not null, updated_at timestamptz not null default now(),
      destination_kind public.round_destination_kind not null default 'regular',
      event_participation_id uuid, is_operational boolean not null default true,
      event_job_name_snapshot text, event_location_snapshot text,
      event_booth_snapshot text, event_zone_snapshot text, event_landmark_snapshot text,
      event_contact_name_snapshot text, event_contact_phone_snapshot text,
      unique (round_id, sequence_no)
    );
    create unique index round_stops_regular_destination_unique_idx
      on public.round_stops (round_id, shop_id) where destination_kind = 'regular';
    create unique index round_stops_event_destination_unique_idx
      on public.round_stops (round_id, event_participation_id) where destination_kind = 'event';

    create function public.get_employee_active_session(date default null)
    returns jsonb language sql as $$ select '{}'::jsonb $$;

    insert into public.users values
      ('10000000-0000-4000-8000-000000000001', 'courier', true),
      ('10000000-0000-4000-8000-000000000002', 'courier', true),
      ('10000000-0000-4000-8000-000000000003', 'admin', true);
    select set_config(
      'app.test_user_id', '10000000-0000-4000-8000-000000000001', false
    );
    insert into public.buildings values
      ('20000000-0000-4000-8000-000000000001', 'Building A', 1, true);
    insert into public.building_zones values
      ('20000000-0000-4000-8000-000000000002', 1);
    insert into public.shops values
      (
        '30000000-0000-4000-8000-000000000001', 'R001', 'Regular shop',
        '20000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002', 'A1', 1, 'active',
        'Regular contact', '0811111111'
      ),
      (
        '30000000-0000-4000-8000-000000000002', 'E001', 'Event shop',
        '20000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002', 'A2', 2, 'inactive',
        'Shop contact', '0822222222'
      );
    insert into public.delivery_rounds values (
      '40000000-0000-4000-8000-000000000001', date '2026-08-29',
      'Daily', 'daily', 'open', now(), now(), null
    );
    insert into public.event_jobs values (
      '50000000-0000-4000-8000-000000000001', 'Expo', 'Hall A',
      date '2026-08-29', date '2026-08-30', 'published'
    );
    insert into public.event_participations values (
      '60000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      'B01', 'North', 'Gate 1', 'Event contact', '0899999999',
      date '2026-08-29', date '2026-08-30', 'active'
    );
    insert into public.event_delivery_feature_settings values (
      true, 2, true, true, false, false, false, now()
    );
  `.replace(/^ {4}/gm, ''));

  await db.exec(darkLaunchMigration);

  const capability = await db.query(`
    select schema_version, event_stops_enabled
    from public.event_delivery_feature_settings where singleton
  `);
  assert.deepEqual(capability.rows[0], {
    schema_version: 3,
    event_stops_enabled: false,
  });

  await assert.rejects(
    db.query(`
      select public.sync_daily_round_destinations(
        '40000000-0000-4000-8000-000000000001'
      )
    `),
    /You are not assigned to this delivery round/,
  );

  const session = await db.query(`
    select public.get_employee_active_session(date '2026-08-29') as value
  `);
  assert.equal(session.rows[0].value.single_session, true);
  assert.equal(session.rows[0].value.active_round.id, '40000000-0000-4000-8000-000000000001');

  const darkAdded = await db.query(`
    select public.sync_daily_round_destinations(
      '40000000-0000-4000-8000-000000000001'
    ) as added
  `);
  assert.equal(darkAdded.rows[0].added, 1);
  assert.equal(
    (await db.query(`select count(*)::integer as count from public.delivery_round_members`)).rows[0].count,
    3,
  );
  assert.deepEqual(
    (await db.query(`
      select destination_kind::text as kind, count(*)::integer as count
      from public.round_stops group by destination_kind order by destination_kind
    `)).rows,
    [{ kind: 'regular', count: 1 }],
  );

  await db.exec(activationMigration);
  const activeAdded = await db.query(`
    select public.sync_daily_round_destinations(
      '40000000-0000-4000-8000-000000000001'
    ) as added
  `);
  assert.equal(activeAdded.rows[0].added, 1);

  const eventStop = await db.query(`
    select is_operational, event_job_name_snapshot, event_booth_snapshot
    from public.round_stops where destination_kind = 'event'
  `);
  assert.deepEqual(eventStop.rows[0], {
    is_operational: true,
    event_job_name_snapshot: 'Expo',
    event_booth_snapshot: 'B01',
  });

  await assert.rejects(
    db.query(`
      update public.round_stops set event_booth_snapshot = 'Changed'
      where destination_kind = 'event'
    `),
    /destination identity and snapshots are immutable/,
  );
  await db.exec(`
    update public.round_stops set note = 'Allowed'
    where destination_kind = 'event'
  `);

  await db.exec(`
    update public.event_delivery_feature_settings
    set event_stops_enabled = false where singleton;
    update public.event_participations
    set start_date = date '2026-08-30'
    where id = '60000000-0000-4000-8000-000000000001'
  `);
  await db.exec(`
    select public.sync_daily_round_destinations(
      '40000000-0000-4000-8000-000000000001'
    )
  `);
  assert.equal(
    (await db.query(`
      select is_operational from public.round_stops where destination_kind = 'event'
    `)).rows[0].is_operational,
    true,
  );

  await db.exec(`
    update public.event_delivery_feature_settings
    set event_stops_enabled = true where singleton;
    select public.sync_daily_round_destinations(
      '40000000-0000-4000-8000-000000000001'
    )
  `);
  assert.equal(
    (await db.query(`
      select is_operational from public.round_stops where destination_kind = 'event'
    `)).rows[0].is_operational,
    false,
  );

  await db.exec(`
    update public.event_participations
    set start_date = date '2026-08-29'
    where id = '60000000-0000-4000-8000-000000000001'
  `);
  await db.exec(`
    select public.sync_daily_round_destinations(
      '40000000-0000-4000-8000-000000000001'
    )
  `);
  const reactivated = await db.query(`
    select is_operational, event_booth_snapshot, note
    from public.round_stops where destination_kind = 'event'
  `);
  assert.deepEqual(reactivated.rows[0], {
    is_operational: true,
    event_booth_snapshot: 'B01',
    note: 'Allowed',
  });
});
