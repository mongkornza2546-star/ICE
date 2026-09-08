import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const readMigration = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const original = readMigration('0129_effective_charge_projections.sql');
const cardFunction = original.slice(original.indexOf('create or replace function public.get_round_shop_cards('), original.indexOf('revoke all on function public.daily_aggregate_stock_balance_at'));
const fence = readMigration('0157_event_destination_compatibility_fence.sql');
const cardFence = fence.slice(fence.lastIndexOf('do $fence$'), fence.indexOf('$fence$;', fence.lastIndexOf('do $fence$')) + '$fence$;'.length);
const migration = readMigration('0178_live_shop_delivery_order.sql');
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('open daily cards use current zone delivery order while preserving snapshots and event fencing', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select '${id(1)}'::uuid $$;
    create function public.current_app_role() returns text language sql as $$ select 'admin'::text $$;
    create function public.is_active_user() returns boolean language sql as $$ select true $$;
    create function public.is_round_member(uuid) returns boolean language sql as $$ select true $$;
    create type public.shop_payment_status as enum ('unpaid');
    create type public.shop_round_status as enum ('pending', 'delivered');
    create table public.delivery_rounds (id uuid primary key, service_date date, name text, status text, round_type text, cancelled_at timestamptz);
    create table public.buildings (id uuid primary key, sort_order integer);
    create table public.building_zones (id uuid primary key, sort_order integer);
    create table public.shops (id uuid primary key, code text, zone_id uuid, delivery_sequence integer, image_path text, payment_status public.shop_payment_status);
    create table public.round_stops (id uuid primary key, shop_id uuid, round_id uuid, shop_code_snapshot text, shop_name_snapshot text,
      building_id_snapshot uuid, building_name_snapshot text, floor_or_zone_snapshot text, sequence_no integer,
      status public.shop_round_status, note text, destination_kind text);
    create table public.delivery_events (id uuid primary key, round_stop_id uuid, recorded_at timestamptz, recorded_by uuid, note text, status text);
    create table public.users (id uuid primary key, display_name text);
    create table public.delivery_items (delivery_event_id uuid, ice_type_id uuid, quantity numeric);
    create table public.delivery_charges (id uuid, delivery_event_id uuid, status text);
    create table public.payment_allocations (charge_id uuid, payment_id uuid, amount numeric);
    create table public.payments (id uuid, status text);
    create table public.audit_logs (entity_type text, entity_id uuid, after_value jsonb, occurred_at timestamptz);
    insert into public.delivery_rounds values ('${id(1)}', '2026-09-08', 'Daily', 'open', 'daily', null);
    insert into public.buildings values ('${id(2)}', 1);
    insert into public.building_zones values ('${id(3)}', 1), ('${id(4)}', 2);
  `);
  for (const [n, code, zone, sequence, kind] of [
    [10, 'BB43', 3, 2, 'regular'], [11, 'BB75', 3, 1, 'regular'],
    [12, 'BB76', 3, null, 'regular'], [13, 'BB01', 4, 1, 'regular'],
    [14, 'EVENT', 3, 1, 'event'],
  ]) {
    await db.query('insert into public.shops values ($1, $2, $3, $4, null, $5)', [id(n), code, id(zone), sequence, 'unpaid']);
    await db.query(`insert into public.round_stops values ($1, $2, $3, $4, $4, $5, 'B', $6, $7, 'pending', null, $8)`,
      [id(n + 100), id(n), id(1), code, id(2), `Zone ${zone}`, n - 9, kind]);
  }
  await db.exec(cardFunction);
  await db.exec(cardFence);
  const cards = async () => (await db.query(`select shop_code, sequence_no from public.get_round_shop_cards('${id(1)}')`)).rows;
  assert.deepEqual((await cards()).map((card) => card.shop_code), ['BB43', 'BB75', 'BB76', 'BB01']);
  await db.exec(migration);
  assert.deepEqual((await cards()).map((card) => card.shop_code), ['BB75', 'BB43', 'BB76', 'BB01']);
  await db.exec(`update public.shops set delivery_sequence = 3 where code = 'BB75'`);
  assert.deepEqual((await cards()).map((card) => card.shop_code), ['BB43', 'BB75', 'BB76', 'BB01']);
  await db.exec(`update public.shops set delivery_sequence = 1 where code = 'BB75'`);
  for (const update of ["status = 'closed'", "status = 'open', round_type = 'special'", "round_type = 'daily', cancelled_at = now()"]) {
    await db.exec(`update public.delivery_rounds set ${update}`);
    assert.deepEqual((await cards()).map((card) => card.shop_code), ['BB43', 'BB75', 'BB76', 'BB01']);
  }
  assert.deepEqual((await db.query('select sequence_no from public.round_stops order by sequence_no')).rows.map((row) => row.sequence_no), [1, 2, 3, 4, 5]);
  const definition = (await db.query("select pg_get_functiondef('public.get_round_shop_cards(uuid,uuid)'::regprocedure) as definition")).rows[0].definition;
  assert.equal((definition.match(/and day_stop.destination_kind = 'regular'/g) ?? []).length, 2);
});
