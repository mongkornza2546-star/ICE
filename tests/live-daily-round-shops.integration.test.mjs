import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0147_live_daily_round_shops.sql', import.meta.url),
  'utf8',
);

const USER_ID = '10000000-0000-4000-8000-000000000001';
const BUILDING_ID = '20000000-0000-4000-8000-000000000001';
const ZONE_ID = '30000000-0000-4000-8000-000000000001';
const ROUND_ID = '40000000-0000-4000-8000-000000000001';
const ORIGINAL_SHOP_ID = '50000000-0000-4000-8000-000000000001';
const NEW_SHOP_ID = '50000000-0000-4000-8000-000000000002';

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create schema auth;
    create role authenticated;
    create type public.shop_status as enum ('active', 'inactive');
    create type public.delivery_round_status as enum ('open', 'closed');
    create type public.shop_round_status as enum (
      'pending', 'delivered', 'closed', 'temporarily_closed', 'not_found', 'rejected'
    );

    create function auth.uid() returns uuid language sql stable
    as $$ select '${USER_ID}'::uuid $$;
    create function public.is_active_user() returns boolean language sql stable
    as $$ select true $$;
    create function public.current_app_role() returns text language sql stable
    as $$ select 'courier'::text $$;
    create function public.is_round_member(p_round_id uuid) returns boolean language sql stable
    as $$ select p_round_id = '${ROUND_ID}'::uuid $$;

    create table public.users (id uuid primary key);
    create table public.buildings (
      id uuid primary key,
      name text not null,
      sort_order integer not null,
      is_active boolean not null default true
    );
    create table public.building_zones (
      id uuid primary key,
      building_id uuid not null references public.buildings(id),
      name text not null,
      sort_order integer not null,
      is_active boolean not null default true
    );
    create table public.shops (
      id uuid primary key,
      code text not null,
      name text not null,
      building_id uuid not null references public.buildings(id),
      zone_id uuid not null references public.building_zones(id),
      floor_or_zone text not null,
      delivery_sequence integer,
      status public.shop_status not null
    );
    create table public.delivery_rounds (
      id uuid primary key,
      service_date date not null,
      round_type text not null,
      status public.delivery_round_status not null,
      cancelled_at timestamptz
    );
    create table public.round_stops (
      id uuid primary key default gen_random_uuid(),
      round_id uuid not null references public.delivery_rounds(id),
      shop_id uuid not null references public.shops(id),
      shop_code_snapshot text not null,
      shop_name_snapshot text not null,
      building_id_snapshot uuid not null,
      building_name_snapshot text not null,
      floor_or_zone_snapshot text not null,
      sequence_no integer not null check (sequence_no > 0),
      status public.shop_round_status not null default 'pending',
      updated_by uuid not null references public.users(id),
      unique (round_id, shop_id),
      unique (round_id, sequence_no)
    );
    create publication supabase_realtime;

    insert into public.users values ('${USER_ID}');
    insert into public.buildings values ('${BUILDING_ID}', 'Building A', 1, true);
    insert into public.building_zones values ('${ZONE_ID}', '${BUILDING_ID}', 'Zone A', 1, true);
    insert into public.shops values (
      '${ORIGINAL_SHOP_ID}', 'S001', 'Original shop', '${BUILDING_ID}', '${ZONE_ID}',
      'Zone A', 1, 'active'
    );
    insert into public.delivery_rounds values (
      '${ROUND_ID}', date '2026-08-11', 'daily', 'open', null
    );
    insert into public.round_stops (
      round_id, shop_id, shop_code_snapshot, shop_name_snapshot,
      building_id_snapshot, building_name_snapshot, floor_or_zone_snapshot,
      sequence_no, updated_by
    ) values (
      '${ROUND_ID}', '${ORIGINAL_SHOP_ID}', 'S001', 'Original shop',
      '${BUILDING_ID}', 'Building A', 'Zone A', 1, '${USER_ID}'
    );

    insert into public.shops values (
      '${NEW_SHOP_ID}', 'S002', 'New shop', '${BUILDING_ID}', '${ZONE_ID}',
      'Zone A', 2, 'active'
    );
  `);

  await db.exec(migration);
  return db;
}

test('an open daily round picks up active shops created after the round started', async (t) => {
  const db = await createDatabase(t);

  const firstSync = await db.query(
    `select public.sync_daily_round_active_shops('${ROUND_ID}') as added_count`,
  );
  const secondSync = await db.query(
    `select public.sync_daily_round_active_shops('${ROUND_ID}') as added_count`,
  );
  const stops = await db.query(`
    select shop_code_snapshot, sequence_no
    from public.round_stops
    where round_id = '${ROUND_ID}'
    order by sequence_no
  `);

  assert.equal(firstSync.rows[0].added_count, 1);
  assert.equal(secondSync.rows[0].added_count, 0);
  assert.deepEqual(stops.rows, [
    { shop_code_snapshot: 'S001', sequence_no: 1 },
    { shop_code_snapshot: 'S002', sequence_no: 2 },
  ]);
});

for (const scenario of [
  { name: 'special', update: "round_type = 'special'" },
  { name: 'closed', update: "status = 'closed'" },
  {
    name: 'cancelled',
    update: "status = 'closed', cancelled_at = timestamptz '2026-08-11 08:00:00+07'",
  },
]) {
  test(`${scenario.name} rounds do not pick up newly active shops`, async (t) => {
    const db = await createDatabase(t);
    await db.exec(`update public.delivery_rounds set ${scenario.update} where id = '${ROUND_ID}'`);

    const sync = await db.query(
      `select public.sync_daily_round_active_shops('${ROUND_ID}') as added_count`,
    );
    const stops = await db.query(
      `select count(*)::integer as stop_count from public.round_stops where round_id = '${ROUND_ID}'`,
    );

    assert.equal(sync.rows[0].added_count, 0);
    assert.equal(stops.rows[0].stop_count, 1);
  });
}

test('the migration locks the round row before taking the service-date lock', () => {
  const rowLockAt = migration.indexOf('for update;');
  const advisoryLockAt = migration.indexOf('pg_advisory_xact_lock');

  assert.ok(rowLockAt >= 0);
  assert.ok(advisoryLockAt > rowLockAt);
});

test('the shops table is added to the Supabase Realtime publication', async (t) => {
  const db = await createDatabase(t);
  await db.exec(migration);
  const publication = await db.query(`
    select count(*)::integer as membership_count
    from pg_catalog.pg_publication publication
    join pg_catalog.pg_publication_rel publication_rel
      on publication_rel.prpubid = publication.oid
    join pg_catalog.pg_class relation on relation.oid = publication_rel.prrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where publication.pubname = 'supabase_realtime'
      and namespace.nspname = 'public'
      and relation.relname = 'shops'
  `);

  assert.equal(publication.rows[0].membership_count, 1);
});
