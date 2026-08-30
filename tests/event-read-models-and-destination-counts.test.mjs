import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0165_event_read_models_and_destination_counts.sql', import.meta.url),
  'utf8',
);
const presentationMigration = readFileSync(
  new URL('../supabase/migrations/0168_event_card_presentation_contract.sql', import.meta.url),
  'utf8',
);
const roundCancellationMigration = readFileSync(
  new URL('../supabase/migrations/0027_cancel_delivery_round.sql', import.meta.url),
  'utf8',
);
const dailyCancellationMigration = readFileSync(
  new URL('../supabase/migrations/0043_daily_work_dashboard_and_cancellation.sql', import.meta.url),
  'utf8',
);

test('event read slice leaves every event writer capability disabled', () => {
  assert.match(migration, /event_reads_enabled = true/);
  assert.match(migration, /create or replace function public\.get_event_delivery_cards/);
  assert.doesNotMatch(migration, /event_stops_enabled\s*=\s*true/);
  assert.doesNotMatch(migration, /event_ice_delivery_enabled\s*=\s*true/);
  assert.doesNotMatch(migration, /event_tank_rental_enabled\s*=\s*true/);
  assert.doesNotMatch(migration, /create or replace function public\.sync_daily_round_destinations/);
});

test('event card presentation exposes real stop state without enabling writers', () => {
  assert.match(presentationMigration, /'stop_status'/);
  assert.match(presentationMigration, /'stop_note'/);
  assert.match(presentationMigration, /greatest\(schema_version, 4\)/);
  assert.match(presentationMigration, /event_ice_delivery_enabled = false/);
  assert.match(presentationMigration, /event_tank_rental_enabled = false/);
});

test('round and daily cancellation contracts include event activity but not tank balances', () => {
  const roundBlockers = roundCancellationMigration.slice(
    roundCancellationMigration.indexOf('create or replace function public.delivery_round_cancellation_blockers'),
    roundCancellationMigration.indexOf('create or replace function public.get_delivery_round_cancellation_state'),
  );
  const dailyBlockers = dailyCancellationMigration.slice(
    dailyCancellationMigration.indexOf('create or replace function public.daily_work_session_cancellation_blockers'),
    dailyCancellationMigration.indexOf('-- 2. Admin RPC'),
  );

  for (const blockers of [roundBlockers, dailyBlockers]) {
    assert.match(blockers, /from public\.delivery_events event/);
    assert.match(blockers, /stop\.status <> 'pending'/);
    assert.doesNotMatch(blockers, /destination_kind/);
    assert.doesNotMatch(blockers, /event_tank|tank_movement|event_participations/);
  }
});

test('destination counts and event cards preserve regular/event separation', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create type public.round_destination_kind as enum ('regular', 'event');
    create type public.shop_round_status as enum (
      'pending', 'delivered', 'full_bin', 'closed_shop', 'no_access', 'issue'
    );

    create function auth.uid() returns uuid language sql stable
    as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
    create function public.is_active_user() returns boolean language sql stable
    as $$ select true $$;
    create function public.current_app_role() returns text language sql stable
    as $$ select 'courier'::text $$;
    create function public.is_round_member(uuid) returns boolean language sql stable
    as $$ select true $$;

    create table public.users (id uuid primary key);
    create table public.shops (
      id uuid primary key, code text not null, name text not null,
      contact_name text, contact_phone text
    );
    create table public.delivery_rounds (
      id uuid primary key, service_date date not null, round_type text not null,
      cancelled_at timestamptz
    );
    create table public.round_stops (
      id uuid primary key, round_id uuid not null, shop_id uuid not null,
      destination_kind public.round_destination_kind not null,
      event_participation_id uuid, status public.shop_round_status not null,
      shop_code_snapshot text not null, shop_name_snapshot text not null,
      event_job_name_snapshot text, event_location_snapshot text,
      event_booth_snapshot text, event_zone_snapshot text,
      event_landmark_snapshot text, event_contact_name_snapshot text,
      event_contact_phone_snapshot text, is_operational boolean not null default true,
      note text
    );
    create table public.round_close_summaries (
      round_id uuid primary key,
      total_shop_count integer not null,
      delivered_shop_count integer not null,
      pending_shop_count integer not null,
      problem_shop_count integer not null,
      captured_by uuid not null,
      captured_at timestamptz not null,
      check (delivered_shop_count + pending_shop_count + problem_shop_count = total_shop_count)
    );
    create table public.ice_types (
      id uuid primary key, code text not null, name text not null, unit text not null
    );
    create table public.round_ice_counts (
      round_id uuid not null, ice_type_id uuid not null,
      loaded_quantity numeric not null, replenished_quantity numeric not null,
      remaining_quantity numeric not null, damaged_quantity numeric not null
    );
    create table public.delivery_events (
      id uuid primary key, round_stop_id uuid not null, status text not null,
      recorded_at timestamptz not null, note text
    );
    create table public.delivery_items (
      delivery_event_id uuid not null, ice_type_id uuid not null, quantity numeric not null
    );
    create table public.delivery_charges (
      id uuid primary key, delivery_event_id uuid not null, shop_id uuid not null,
      service_date date not null, status text not null
    );
    create table public.event_jobs (
      id uuid primary key, name text not null, organizer_name text not null,
      location text not null, start_date date not null, end_date date not null,
      status text not null
    );
    create table public.event_participations (
      id uuid primary key, event_job_id uuid not null, shop_id uuid not null,
      booth_number text, event_zone text, landmark text, contact_name text,
      contact_phone text, start_date date not null, end_date date not null,
      rents_tank_from_us boolean not null, status text not null
    );
    create table public.event_delivery_feature_settings (
      singleton boolean primary key, schema_version integer not null,
      lifecycle_enabled boolean not null, event_stops_enabled boolean not null,
      event_ice_delivery_enabled boolean not null,
      event_tank_rental_enabled boolean not null, updated_at timestamptz not null
    );
    insert into public.event_delivery_feature_settings values (
      true, 1, true, false, false, false, now()
    );

    create function public.get_daily_work_dashboard(p_service_date date default null)
    returns jsonb language plpgsql stable as $$
    declare
      v_service_date date := p_service_date;
      v_round record;
      v_delivery_summary jsonb;
    begin
      select * into v_round from public.delivery_rounds
      where service_date = v_service_date limit 1;
      select jsonb_build_object(
        'activeDeliveryCount', count(c.id),
        'actualShopCount', count(distinct c.shop_id),
        'problemCount', (
          select count(*)
          from public.round_stops s
          where (v_round.id is not null and s.round_id = v_round.id)
            and s.status = 'issue'
        )
      )
      into v_delivery_summary
      from public.delivery_charges c
      where c.service_date = v_service_date and c.status = 'active';
      return jsonb_build_object('deliverySummary', v_delivery_summary);
    end;
    $$;
  `.replace(/^ {4}/gm, ''));

  await db.exec(migration);
  await db.exec(`
    create function public.sync_daily_round_destinations(uuid)
    returns integer language sql as $$ select 0 $$;
    update public.event_delivery_feature_settings
    set schema_version = 3,
        event_stops_enabled = true;
  `);
  await db.exec(presentationMigration);

  const ids = {
    user: '10000000-0000-4000-8000-000000000001',
    round: '20000000-0000-4000-8000-000000000001',
    regularShop: '30000000-0000-4000-8000-000000000001',
    eventShop: '30000000-0000-4000-8000-000000000002',
    regularStop: '40000000-0000-4000-8000-000000000001',
    eventStop: '40000000-0000-4000-8000-000000000002',
    problemEventStop: '40000000-0000-4000-8000-000000000003',
    eventJob: '50000000-0000-4000-8000-000000000001',
    participation: '60000000-0000-4000-8000-000000000001',
    secondParticipation: '60000000-0000-4000-8000-000000000002',
    ice: '70000000-0000-4000-8000-000000000001',
    regularDelivery: '80000000-0000-4000-8000-000000000001',
    eventDelivery: '80000000-0000-4000-8000-000000000002',
  };

  await db.exec(`
    insert into public.users values ('${ids.user}');
    insert into public.delivery_rounds values (
      '${ids.round}', date '2026-08-28', 'daily', null
    );
    insert into public.shops values
      ('${ids.regularShop}', 'R001', 'Regular shop', 'Regular contact', '0811111111'),
      ('${ids.eventShop}', 'E001', 'Event shop', 'Shop contact', '082-222-2222');
    insert into public.event_jobs values (
      '${ids.eventJob}', 'Live Expo', 'Organizer', 'Live Hall',
      date '2026-08-28', date '2026-08-29', 'published'
    );
    insert into public.event_participations values
      (
        '${ids.participation}', '${ids.eventJob}', '${ids.eventShop}',
        'A01', 'North', 'Gate', 'Event contact', '089-123-4567',
        date '2026-08-28', date '2026-08-29', false, 'active'
      ),
      (
        '${ids.secondParticipation}', '${ids.eventJob}', '${ids.regularShop}',
        'B02', 'South', null, null, null,
        date '2026-08-28', date '2026-08-29', false, 'active'
      );
    insert into public.round_stops values
      (
        '${ids.regularStop}', '${ids.round}', '${ids.regularShop}', 'regular', null,
        'delivered', 'R001', 'Regular snapshot', null, null, null, null, null, null, null, true, null
      ),
      (
        '${ids.eventStop}', '${ids.round}', '${ids.eventShop}', 'event', '${ids.participation}',
        'pending', 'E001', 'Event snapshot', 'Frozen Expo', 'Frozen Hall',
        'Frozen booth', 'Frozen zone', 'Frozen landmark', 'Frozen contact',
        '0800000000', true, null
      ),
      (
        '${ids.problemEventStop}', '${ids.round}', '${ids.regularShop}', 'event', '${ids.secondParticipation}',
        'issue', 'R001', 'Second event snapshot', 'Frozen Expo', 'Frozen Hall',
        'B02', 'South', null, null, null, true, 'Cannot access booth'
      );
    insert into public.ice_types values ('${ids.ice}', 'ICE', 'Tube ice', 'bag');
    insert into public.delivery_events values
      ('${ids.regularDelivery}', '${ids.regularStop}', 'active', now(), null),
      ('${ids.eventDelivery}', '${ids.eventStop}', 'active', now(), 'extra ice');
    insert into public.delivery_items values
      ('${ids.regularDelivery}', '${ids.ice}', 2),
      ('${ids.eventDelivery}', '${ids.ice}', 3);
    insert into public.delivery_charges values
      (gen_random_uuid(), '${ids.regularDelivery}', '${ids.regularShop}', date '2026-08-28', 'active'),
      (gen_random_uuid(), '${ids.eventDelivery}', '${ids.eventShop}', date '2026-08-28', 'active');
  `);

  await db.exec(`
    insert into public.round_close_summaries (
      round_id, total_shop_count, delivered_shop_count, pending_shop_count,
      problem_shop_count, captured_by, captured_at
    ) values ('${ids.round}', 0, 0, 0, 0, '${ids.user}', now())
  `);
  const closeSummary = await db.query(`
    select * from public.round_close_summaries where round_id = '${ids.round}'
  `);
  assert.equal(closeSummary.rows[0].total_shop_count, 3);
  assert.equal(closeSummary.rows[0].regular_stop_count, 1);
  assert.equal(closeSummary.rows[0].regular_delivered_stop_count, 1);
  assert.equal(closeSummary.rows[0].event_stop_count, 2);
  assert.equal(closeSummary.rows[0].event_pending_stop_count, 1);
  assert.equal(closeSummary.rows[0].event_problem_stop_count, 1);

  await db.exec(`create or replace function public.current_app_role() returns text language sql stable as $$ select 'admin'::text $$`);
  const roundSummary = await db.query(
    `select public.get_round_control_summary('${ids.round}') as value`,
  );
  assert.deepEqual(roundSummary.rows[0].value.destination_counts.regular, {
    total: 1,
    delivered: 1,
    pending: 0,
    problem: 0,
  });
  assert.deepEqual(roundSummary.rows[0].value.destination_counts.event, {
    total: 2,
    delivered: 0,
    pending: 1,
    problem: 1,
  });

  const dashboard = await db.query(
    `select public.get_daily_work_dashboard(date '2026-08-28') as value`,
  );
  assert.equal(dashboard.rows[0].value.deliverySummary.regularShopCount, 1);
  assert.equal(dashboard.rows[0].value.deliverySummary.eventParticipationCount, 1);
  assert.equal(dashboard.rows[0].value.deliverySummary.regularProblemCount, 0);
  assert.equal(dashboard.rows[0].value.deliverySummary.eventProblemCount, 1);

  await db.exec(`create or replace function public.current_app_role() returns text language sql stable as $$ select 'courier'::text $$`);
  const cards = await db.query(`
    select public.get_event_delivery_cards(
      '${ids.round}', '${ids.eventJob}', 'A-01'
    ) as value
  `);
  assert.equal(cards.rows[0].value.events.length, 1);
  assert.equal(cards.rows[0].value.cards.length, 1);
  assert.equal(cards.rows[0].value.cards[0].event_name, 'Frozen Expo');
  assert.equal(cards.rows[0].value.cards[0].booth_number, 'Frozen booth');
  assert.equal(cards.rows[0].value.cards[0].stop_status, 'pending');
  assert.equal(cards.rows[0].value.cards[0].stop_note, null);
  assert.equal(cards.rows[0].value.cards[0].today_history.length, 1);
  assert.equal(cards.rows[0].value.cards[0].today_totals[0].quantity, 3);

  const problemCards = await db.query(`
    select public.get_event_delivery_cards(
      '${ids.round}', '${ids.eventJob}', 'B02'
    ) as value
  `);
  assert.equal(problemCards.rows[0].value.cards.length, 1);
  assert.equal(problemCards.rows[0].value.cards[0].stop_status, 'issue');
  assert.equal(problemCards.rows[0].value.cards[0].stop_note, 'Cannot access booth');

  await db.exec(`create or replace function public.is_round_member(uuid) returns boolean language sql stable as $$ select false $$`);
  await assert.rejects(
    db.query(`select public.get_event_delivery_cards('${ids.round}', null, null)`),
    /You are not assigned to this delivery round/,
  );

  const capability = await db.query(`select public.get_event_delivery_capability() as value`);
  assert.equal(capability.rows[0].value.schema_version, 4);
  assert.equal(capability.rows[0].value.event_reads_enabled, true);
  assert.equal(capability.rows[0].value.event_stops_enabled, true);
  assert.equal(capability.rows[0].value.event_ice_delivery_enabled, false);
  assert.equal(capability.rows[0].value.event_tank_rental_enabled, false);
});
