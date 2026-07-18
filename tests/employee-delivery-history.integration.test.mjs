import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0012_employee_delivery_history.sql', import.meta.url),
  'utf8',
);

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const SELECTED_ROUND_ID = '20000000-0000-4000-8000-000000000001';
const OTHER_ROUND_ID = '20000000-0000-4000-8000-000000000002';
const SHOP_ID = '30000000-0000-4000-8000-000000000001';
const BUILDING_ID = '40000000-0000-4000-8000-000000000001';
const SELECTED_STOP_ID = '50000000-0000-4000-8000-000000000001';
const OTHER_STOP_ID = '50000000-0000-4000-8000-000000000002';
const PROBLEM_EVENT_ID = '60000000-0000-4000-8000-000000000001';
const DELIVERY_EVENT_ID = '60000000-0000-4000-8000-000000000002';
const ICE_TYPE_ID = '70000000-0000-4000-8000-000000000001';

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role authenticated;
    create schema auth;

    create type public.app_role as enum ('courier', 'round_lead', 'admin');
    create type public.shop_payment_status as enum ('unknown', 'paid', 'unpaid');
    create type public.shop_round_status as enum (
      'pending', 'delivered', 'full_bin', 'closed_shop', 'no_access', 'issue'
    );

    create function auth.uid() returns uuid
    language sql stable as $$ select '${USER_ID}'::uuid $$;

    create function public.is_active_user() returns boolean
    language sql stable as $$ select true $$;

    create function public.current_app_role() returns public.app_role
    language sql stable as $$ select 'courier'::public.app_role $$;

    create table public.users (
      id uuid primary key,
      display_name text not null
    );

    create table public.delivery_rounds (
      id uuid primary key,
      service_date date not null,
      name text not null
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

    create table public.shops (
      id uuid primary key,
      image_path text,
      payment_status public.shop_payment_status not null
    );

    create table public.round_stops (
      id uuid primary key,
      round_id uuid not null,
      shop_id uuid not null,
      shop_code_snapshot text not null,
      shop_name_snapshot text not null,
      building_id_snapshot uuid not null,
      building_name_snapshot text not null,
      floor_or_zone_snapshot text not null,
      sequence_no integer not null,
      status public.shop_round_status not null,
      note text
    );

    create table public.delivery_events (
      id uuid primary key,
      round_stop_id uuid not null,
      recorded_by uuid not null,
      recorded_at timestamptz not null,
      note text,
      status text not null
    );

    create table public.delivery_items (
      delivery_event_id uuid not null,
      ice_type_id uuid not null,
      quantity integer not null
    );

    create table public.audit_logs (
      id uuid primary key default gen_random_uuid(),
      entity_type text not null,
      entity_id uuid not null,
      after_value jsonb,
      occurred_at timestamptz not null default now()
    );
  `);

  await db.exec(migration);
  await db.exec(`
    insert into public.users (id, display_name) values
      ('${USER_ID}', 'พนักงานหนึ่ง'),
      ('${OTHER_USER_ID}', 'พนักงานสอง');

    insert into public.delivery_rounds (id, service_date, name) values
      ('${SELECTED_ROUND_ID}', date '2026-07-16', 'รอบเช้า'),
      ('${OTHER_ROUND_ID}', date '2026-07-16', 'รอบสาย');

    insert into public.delivery_round_members (round_id, user_id)
    values ('${SELECTED_ROUND_ID}', '${USER_ID}');

    insert into public.shops (id, payment_status)
    values ('${SHOP_ID}', 'unknown');

    insert into public.round_stops (
      id, round_id, shop_id, shop_code_snapshot, shop_name_snapshot,
      building_id_snapshot, building_name_snapshot, floor_or_zone_snapshot,
      sequence_no, status, note
    ) values
      (
        '${SELECTED_STOP_ID}', '${SELECTED_ROUND_ID}', '${SHOP_ID}', 'AA01',
        'ร้านทดสอบ', '${BUILDING_ID}', 'ตึก A', 'ชั้น 1', 1,
        'closed_shop', 'ร้านหยุดวันนี้'
      ),
      (
        '${OTHER_STOP_ID}', '${OTHER_ROUND_ID}', '${SHOP_ID}', 'AA01',
        'ร้านทดสอบ', '${BUILDING_ID}', 'ตึก A', 'ชั้น 1', 1,
        'delivered', null
      );

    insert into public.delivery_events (
      id, round_stop_id, recorded_by, recorded_at, note, status
    ) values
      (
        '${PROBLEM_EVENT_ID}', '${SELECTED_STOP_ID}', '${USER_ID}',
        timestamptz '2026-07-16 08:00:00+07', 'ร้านหยุดวันนี้', 'active'
      ),
      (
        '${DELIVERY_EVENT_ID}', '${OTHER_STOP_ID}', '${OTHER_USER_ID}',
        timestamptz '2026-07-16 10:00:00+07', null, 'active'
      );

    insert into public.delivery_items (delivery_event_id, ice_type_id, quantity)
    values ('${DELIVERY_EVENT_ID}', '${ICE_TYPE_ID}', 3);

    insert into public.audit_logs (entity_type, entity_id, after_value, occurred_at) values
      (
        'delivery_events', '${PROBLEM_EVENT_ID}',
        '{"stop_status":"closed_shop"}', timestamptz '2026-07-16 08:00:00+07'
      ),
      (
        'delivery_events', '${DELIVERY_EVENT_ID}',
        '{"stop_status":"delivered"}', timestamptz '2026-07-16 10:00:00+07'
      );
  `);

  return db;
}

test('courier cards include same-day totals from other rounds and complete problem history', async (t) => {
  const db = await createDatabase(t);
  const result = await db.query(`
    select * from public.get_round_shop_cards('${SELECTED_ROUND_ID}', null)
  `);

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].today_totals[ICE_TYPE_ID], 3);
  assert.equal(result.rows[0].today_history.length, 2);

  const problem = result.rows[0].today_history.find((entry) => entry.event_id === PROBLEM_EVENT_ID);
  assert.equal(problem.stop_status, 'closed_shop');
  assert.equal(problem.note, 'ร้านหยุดวันนี้');
});
