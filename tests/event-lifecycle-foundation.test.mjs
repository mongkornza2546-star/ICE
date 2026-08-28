import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0163_event_lifecycle_foundation.sql', import.meta.url),
  'utf8',
);

test('event lifecycle foundation keeps operational capabilities dark', () => {
  assert.match(migration, /create table public\.event_jobs/);
  assert.match(migration, /create table public\.event_job_config_versions/);
  assert.match(migration, /create table public\.event_participations/);
  assert.match(migration, /create or replace function public\.save_event_job_metadata/);
  assert.match(migration, /create or replace function public\.publish_event_job/);
  assert.match(migration, /get_event_delivery_capability/);
  assert.match(migration, /values \(true, 1, true, false, false, false\)/);
  assert.doesNotMatch(migration, /create or replace function public\.sync_daily_round_destinations/);

  const cancelParticipation = migration.slice(
    migration.indexOf('create or replace function public.cancel_event_participation'),
    migration.indexOf('create or replace function public.get_event_delivery_capability'),
  );
  assert.match(
    cancelParticipation,
    /from public\.event_jobs job[\s\S]+for update;[\s\S]+from public\.event_participations[\s\S]+for update;/,
  );
});

test('event lifecycle fails fast when the destination compatibility fence is missing', async (t) => {
  const guardStart = migration.indexOf('-- 0163 prerequisite guard: begin');
  const guardEnd = migration.indexOf('-- 0163 prerequisite guard: end');
  assert.notEqual(guardStart, -1);
  assert.notEqual(guardEnd, -1);

  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('create table public.round_stops (id uuid primary key)');

  await assert.rejects(
    db.exec(migration.slice(guardStart, guardEnd)),
    /Migration 0163 requires migration 0157_event_destination_compatibility_fence\.sql/,
  );
});

test('event lifecycle publishes only ready events and freezes settlement snapshots', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create type public.payment_term as enum ('immediate', 'end_of_day', 'credit');
    create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');
    create type public.round_destination_kind as enum ('regular', 'event');

    create function auth.uid() returns uuid language sql stable
    as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
    create function public.is_active_user() returns boolean language sql stable
    as $$ select current_setting('app.test_active', true) is distinct from 'off' $$;
    create function public.current_app_role() returns text language sql stable
    as $$ select coalesce(nullif(current_setting('app.test_role', true), ''), 'admin') $$;
    create function public.set_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at = now(); return new; end;
    $$;

    create table public.users (id uuid primary key);
    create table public.shops (
      id uuid primary key,
      code text not null,
      name text not null,
      contact_name text,
      contact_phone text,
      status text not null
    );
    create table public.ice_types (
      id uuid primary key,
      code text not null,
      name text not null,
      is_active boolean not null
    );
    create table public.ice_type_prices (
      id uuid primary key default gen_random_uuid(),
      ice_type_id uuid not null references public.ice_types(id),
      unit_price numeric(12,2) not null,
      valid_from date not null,
      valid_to date,
      is_active boolean not null
    );
    create table public.delivery_rounds (
      id uuid primary key default gen_random_uuid(),
      service_date date not null
    );
    create table public.round_stops (
      id uuid primary key default gen_random_uuid(),
      round_id uuid references public.delivery_rounds(id),
      destination_kind public.round_destination_kind not null default 'regular',
      event_participation_id uuid,
      is_operational boolean not null default true,
      event_job_name_snapshot text,
      event_location_snapshot text,
      event_booth_snapshot text,
      event_zone_snapshot text,
      event_landmark_snapshot text,
      event_contact_name_snapshot text,
      event_contact_phone_snapshot text,
      constraint round_stops_destination_context_check check (
        (destination_kind = 'regular' and event_participation_id is null)
        or (destination_kind = 'event' and event_participation_id is not null)
      )
    );
    create unique index round_stops_regular_destination_unique_idx
      on public.round_stops (round_id, id) where destination_kind = 'regular';
    create unique index round_stops_event_destination_unique_idx
      on public.round_stops (round_id, event_participation_id) where destination_kind = 'event';
    create table public.delivery_events (
      id uuid primary key default gen_random_uuid(),
      round_stop_id uuid not null references public.round_stops(id)
    );
    create table public.audit_logs (
      id uuid primary key default gen_random_uuid(),
      actor_id uuid not null references public.users(id),
      entity_type text not null,
      entity_id uuid not null,
      action text not null,
      before_value jsonb,
      after_value jsonb,
      reason text,
      occurred_at timestamptz not null default now()
    );

    insert into public.users values ('10000000-0000-4000-8000-000000000001');
    insert into public.shops values
      ('20000000-0000-4000-8000-000000000001', 'S001', 'Shop one', 'One', '0800000001', 'active'),
      ('20000000-0000-4000-8000-000000000002', 'S002', 'Shop two', 'Two', '0800000002', 'active'),
      ('20000000-0000-4000-8000-000000000003', 'S003', 'Shop three', 'Three', '0800000003', 'active'),
      ('20000000-0000-4000-8000-000000000004', 'S004', 'Shop four', null, null, 'active');
    insert into public.ice_types values
      ('30000000-0000-4000-8000-000000000001', 'ICE', 'Ice', true);
  `);

  await db.exec(migration);

  const capability = await db.query(`select public.get_event_delivery_capability() as value`);
  assert.deepEqual(capability.rows[0].value, {
    schema_version: 1,
    lifecycle_enabled: true,
    event_stops_enabled: false,
    event_ice_delivery_enabled: false,
    event_tank_rental_enabled: false,
    online_only: true,
  });

  await db.exec(`select set_config('app.test_role', 'courier', false)`);
  await assert.rejects(
    db.query(`
      select public.save_event_job(
        null, 'Expo', 'Organizer', 'Manager', '0811111111', 'Hall A',
        date '2026-08-30', date '2026-08-31', null, 100,
        array['cash']::public.payment_method[], 'cash',
        false, false, true, false, true, false
      )
    `),
    /Only an active admin can manage events/,
  );

  await db.exec(`select set_config('app.test_role', 'round_lead', false)`);
  const leadCreated = await db.query(`
    select id, status, current_config_version_id
    from public.save_event_job_metadata(
      null, 'Lead Expo', 'Organizer', 'Manager', '0811111111', 'Hall B',
      date '2026-09-01', date '2026-09-02', null
    )
  `);
  assert.equal(leadCreated.rows[0].status, 'draft');
  assert.equal(leadCreated.rows[0].current_config_version_id, null);
  await assert.rejects(
    db.query(`
      select public.create_event_job_config_version(
        '${leadCreated.rows[0].id}'::uuid, 100,
        array['cash']::public.payment_method[], 'cash',
        false, false, true, false, true, false
      )
    `),
    /Only an active admin can manage event configurations/,
  );

  await db.exec(`select set_config('app.test_role', 'admin', false)`);

  const created = await db.query(`
    select public.save_event_job(
      null, 'Expo', 'Organizer', 'Manager', '0811111111', 'Hall A',
      date '2026-08-30', date '2026-08-31', null, 100,
      array['qr', 'cash', 'cash']::public.payment_method[], 'cash',
      false, false, true, false, true, false
    ) as value
  `);
  const eventJobId = created.rows[0].value.event_job.id;
  const firstConfigId = created.rows[0].value.configuration.id;
  assert.deepEqual(created.rows[0].value.configuration.allowed_payment_methods, ['cash', 'qr']);

  const addParticipation = (shopId, booth) => db.query(`
    select public.save_event_participation(
      null, '${eventJobId}'::uuid, '${shopId}'::uuid,
      '${booth}', 'Zone A', null, null, null,
      date '2026-08-30', date '2026-08-31', true
    )
  `);

  await db.exec(`select set_config('app.test_role', 'round_lead', false)`);
  await addParticipation('20000000-0000-4000-8000-000000000001', 'A1');
  await db.exec(`select set_config('app.test_role', 'admin', false)`);
  await assert.rejects(
    db.query(`
      select public.save_event_job(
        '${eventJobId}'::uuid, 'Expo', 'Organizer', 'Manager', '0811111111', 'Hall A',
        date '2026-08-30', date '2026-08-30', null, 100,
        array['cash', 'qr']::public.payment_method[], 'cash',
        false, false, true, false, true, false
      )
    `),
    /cannot exclude an existing participation/,
  );
  await db.exec(`select set_config('app.test_role', 'round_lead', false)`);
  await assert.rejects(
    db.query(`select public.publish_event_job('${eventJobId}'::uuid)`),
    /require 2 to 50 active participations/,
  );

  await addParticipation('20000000-0000-4000-8000-000000000002', 'A2');
  await assert.rejects(
    db.query(`select public.publish_event_job('${eventJobId}'::uuid)`),
    /Standard prices must cover every active ice type and event service date/,
  );

  await db.exec(`
    insert into public.ice_type_prices (
      ice_type_id, unit_price, valid_from, valid_to, is_active
    ) values (
      '30000000-0000-4000-8000-000000000001', 50,
      date '2026-08-30', date '2026-08-31', true
    )
  `);
  const published = await db.query(
    `select (public.publish_event_job('${eventJobId}'::uuid)).status as status`,
  );
  assert.equal(published.rows[0].status, 'published');

  const initialSnapshots = await db.query(`
    select config_version_id, tank_rental_unit_price_snapshot,
      payment_term_snapshot, settlement_policy_fingerprint
    from public.event_participations
    where event_job_id = '${eventJobId}'::uuid
    order by shop_id
  `);
  assert.equal(initialSnapshots.rows.length, 2);
  for (const row of initialSnapshots.rows) {
    assert.equal(row.config_version_id, firstConfigId);
    assert.equal(row.tank_rental_unit_price_snapshot, '100.00');
    assert.equal(row.payment_term_snapshot, 'end_of_day');
    assert.ok(row.settlement_policy_fingerprint);
  }

  const firstParticipation = await db.query(`
    select id, shop_id from public.event_participations
    where event_job_id = '${eventJobId}'::uuid
    order by shop_id limit 1
  `);
  const editedParticipation = await db.query(`
    select booth_number, rents_tank_from_us, config_version_id
    from public.save_event_participation(
      '${firstParticipation.rows[0].id}'::uuid,
      '${eventJobId}'::uuid,
      '${firstParticipation.rows[0].shop_id}'::uuid,
      'A1-new', 'Zone B', 'North gate', 'Event contact', '0899999999',
      date '2026-08-30', date '2026-08-31', false
    )
  `);
  assert.equal(editedParticipation.rows[0].booth_number, 'A1-new');
  assert.equal(editedParticipation.rows[0].rents_tank_from_us, false);
  assert.equal(editedParticipation.rows[0].config_version_id, firstConfigId);
  await assert.rejects(
    db.query(`
      select public.save_event_participation(
        '${firstParticipation.rows[0].id}'::uuid,
        '${eventJobId}'::uuid,
        '20000000-0000-4000-8000-000000000002'::uuid,
        'A1-new', 'Zone B', 'North gate', 'Event contact', '0899999999',
        date '2026-08-30', date '2026-08-31', false
      )
    `),
    /cannot change customer identity/,
  );

  await db.exec(`
    insert into public.delivery_rounds (id, service_date)
    values ('40000000-0000-4000-8000-000000000001', date '2026-08-31');
    insert into public.round_stops (id, round_id, destination_kind, event_participation_id)
    values (
      '50000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      'event',
      '${firstParticipation.rows[0].id}'::uuid
    );
    insert into public.delivery_events (round_stop_id)
    values ('50000000-0000-4000-8000-000000000001');
  `);
  await assert.rejects(
    db.query(`
      select public.save_event_participation(
        '${firstParticipation.rows[0].id}'::uuid,
        '${eventJobId}'::uuid,
        '${firstParticipation.rows[0].shop_id}'::uuid,
        'A1-new', 'Zone B', 'North gate', 'Event contact', '0899999999',
        date '2026-08-30', date '2026-08-30', false
      )
    `),
    /cannot exclude an existing delivery/,
  );

  await assert.rejects(
    db.query(`
      update public.event_participations
      set tank_rental_unit_price_snapshot = 1
      where id = '${firstParticipation.rows[0].id}'::uuid
    `),
    /settlement snapshot/,
  );

  await db.exec(`select set_config('app.test_role', 'admin', false)`);
  const nextConfig = await db.query(`
    select (public.create_event_job_config_version(
      '${eventJobId}'::uuid, 120,
      array['bank_transfer']::public.payment_method[], 'bank_transfer',
      false, false, true, true, true, false
    )).id as id
  `);
  await assert.rejects(
    addParticipation('20000000-0000-4000-8000-000000000004', 'A4'),
    /require customer identity and contact details/,
  );
  await addParticipation('20000000-0000-4000-8000-000000000003', 'A3');
  const versionAssignments = await db.query(`
    select shop_id, config_version_id, tank_rental_unit_price_snapshot
    from public.event_participations
    where event_job_id = '${eventJobId}'::uuid
    order by shop_id
  `);
  assert.deepEqual(
    versionAssignments.rows.map((row) => [
      row.shop_id,
      row.config_version_id,
      row.tank_rental_unit_price_snapshot,
    ]),
    [
      ['20000000-0000-4000-8000-000000000001', firstConfigId, '100.00'],
      ['20000000-0000-4000-8000-000000000002', firstConfigId, '100.00'],
      ['20000000-0000-4000-8000-000000000003', nextConfig.rows[0].id, '120.00'],
    ],
  );

  await db.exec(`select set_config('app.test_role', 'round_lead', false)`);
  const cancelledParticipation = await db.query(`
    select (public.cancel_event_participation(
      '${firstParticipation.rows[0].id}'::uuid, 'Booth withdrew'
    )).status as status
  `);
  assert.equal(cancelledParticipation.rows[0].status, 'cancelled');

  const cancelled = await db.query(`
    select (public.cancel_event_job('${eventJobId}'::uuid, 'Venue closed')).status as status
  `);
  assert.equal(cancelled.rows[0].status, 'cancelled');
  await assert.rejects(
    addParticipation('20000000-0000-4000-8000-000000000003', 'A4'),
    /Cancelled events cannot accept participations/,
  );
});
