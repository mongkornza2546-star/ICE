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

test('only admins see cancelled daily deliveries, preserving totals, scopes and read-only history', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select '${id(1)}'::uuid $$;
    create function public.current_app_role() returns text language sql as $$ select coalesce(nullif(current_setting('test.role', true), ''), 'admin') $$;
    create function public.is_active_user() returns boolean language sql as $$ select coalesce(nullif(current_setting('test.active', true), ''), 'true')::boolean $$;
    create function public.is_round_member(uuid) returns boolean language sql as $$ select false $$;
    create type public.shop_payment_status as enum ('unpaid');
    create type public.shop_round_status as enum ('pending', 'delivered');
    create table public.delivery_rounds (id uuid primary key, service_date date, name text, status text, round_type text, cancelled_at timestamptz);
    create table public.buildings (id uuid primary key, sort_order integer);
    create table public.building_zones (id uuid primary key, sort_order integer);
    create table public.shops (id uuid primary key, code text, zone_id uuid, delivery_sequence integer, image_path text, payment_status public.shop_payment_status);
    create table public.round_stops (id uuid primary key, shop_id uuid, round_id uuid, shop_code_snapshot text, shop_name_snapshot text,
      building_id_snapshot uuid, building_name_snapshot text, floor_or_zone_snapshot text, sequence_no integer,
      status public.shop_round_status, note text, destination_kind text);
    create table public.delivery_events (id uuid primary key, round_stop_id uuid, recorded_at timestamptz, recorded_by uuid, note text, status text, cancelled_at timestamptz, cancelled_by uuid, cancellation_reason text);
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

  await db.exec(`
    insert into public.users values ('${id(1)}', 'Recorder'), ('${id(2)}', 'Canceller');
    insert into public.shops values ('${id(10)}', 'BB1', '${id(3)}', 1, null, 'unpaid');
    insert into public.delivery_rounds values ('${id(5)}', '2026-09-07', 'Previous', 'open', 'daily', null);
    insert into public.round_stops values
      ('${id(11)}', '${id(10)}', '${id(1)}', 'BB1', 'Shop', '${id(2)}', 'B', '1', 1, 'delivered', null, 'regular'),
      ('${id(12)}', '${id(10)}', '${id(1)}', 'BB1', 'Booth', '${id(2)}', 'B', '1', 2, 'delivered', null, 'event'),
      ('${id(13)}', '${id(10)}', '${id(5)}', 'BB1', 'Shop', '${id(2)}', 'B', '1', 1, 'delivered', null, 'regular');
  `);
  for (const [n, stop, status, quantity] of [
    [20, 11, 'active', 2], [21, 11, 'cancelled', 4], [22, 11, 'replaced', 8],
    [23, 12, 'cancelled', 16], [24, 13, 'cancelled', 32],
  ]) {
    await db.query(`insert into public.delivery_events values ($1, $2, $3, $4, null, $5, $6, $7, $8)`,
      [id(n), id(stop), `2026-09-08T0${n - 20}:00:00Z`, id(1), status,
        status === 'cancelled' ? '2026-09-09T02:15:00Z' : null,
        status === 'cancelled' ? id(2) : null, status === 'cancelled' ? 'Duplicate delivery' : null]);
    await db.query(`insert into public.delivery_items values ($1, $2, $3)`, [id(n), id(30), quantity]);
    await db.query(`insert into public.delivery_charges values ($1, $1, $2)`, [id(n), status === 'active' ? 'active' : 'voided']);
  }
  await db.exec(cardFunction);
  await db.exec(cardFence);
  await db.exec(migration);
  await db.exec(readMigration('0181_live_shop_code_numeric_order.sql'));
  const cards = async (building = null) => (await db.query(`select * from public.get_round_shop_cards($1, $2)`, [id(1), building])).rows;
  assert.equal((await cards())[0].today_history.length, 1);
  await db.exec(readMigration('0221_admin_cancelled_delivery_history.sql'));
  const [card] = await cards();
  assert.equal((await cards()).length, 1, 'event cards remain excluded');
  assert.deepEqual(card.today_history.map((entry) => entry.event_id), [id(21), id(20)]);
  assert.deepEqual(card.today_totals, { [id(30)]: 2 }, 'cancelled quantities must not count as delivered');
  const cancelled = card.today_history[0];
  assert.equal(cancelled.delivery_status, 'cancelled');
  assert.equal(cancelled.cancelled_by, 'Canceller');
  assert.equal(new Date(cancelled.cancelled_at).toISOString(), '2026-09-09T02:15:00.000Z');
  assert.equal(cancelled.cancellation_reason, 'Duplicate delivery');
  assert.equal(cancelled.recorded_by, 'Recorder');
  assert.deepEqual(cancelled.items, { [id(30)]: 4 });
  assert.equal(cancelled.can_cancel, false);
  assert.equal(cancelled.can_correct, false);
  assert.equal(card.today_history[1].can_cancel, true);
  assert.deepEqual(await cards(id(999)), [], 'building filter is preserved');
  for (const role of ['round_lead', 'courier']) {
    await db.exec(`set test.role = '${role}'`);
    if (role === 'courier') {
      await assert.rejects(cards(), /not assigned/);
      await db.exec(`create or replace function public.is_round_member(uuid) returns boolean language sql as $$ select true $$;`);
    }
    assert.deepEqual((await cards())[0].today_history.map((entry) => entry.event_id), [id(20)]);
  }
  await db.exec(`set test.role = 'admin'; set test.active = 'false'`);
  await assert.rejects(cards(), /not assigned/);
  await db.exec(`set test.active = 'true'; update public.delivery_events set status = 'cancelled' where id = '${id(20)}'`);
  assert.equal((await cards())[0].today_history.length, 2, 'a shop with only cancelled deliveries retains history');
  assert.deepEqual((await cards())[0].today_totals, {});
});
