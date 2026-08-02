import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const foundation = readFileSync(
  new URL('../supabase/migrations/0029_pos_financial_foundation.sql', import.meta.url),
  'utf8',
);
const transactions = readFileSync(
  new URL('../supabase/migrations/0030_pos_delivery_transactions.sql', import.meta.url),
  'utf8',
);
const operations = readFileSync(
  new URL('../supabase/migrations/0059_pos_financial_operations.sql', import.meta.url),
  'utf8',
);
const legacyRecordPayment = operations.slice(
  operations.indexOf('create or replace function public.record_payment('),
  operations.indexOf('revoke all on function public.record_payment('),
);
const recovery = readFileSync(
  new URL('../supabase/migrations/0060_recoverable_collection_balances.sql', import.meta.url),
  'utf8',
);
const collectorAccess = readFileSync(
  new URL('../supabase/migrations/0102_collection_collector_access.sql', import.meta.url),
  'utf8',
);
const adminBackdatedBilling = readFileSync(
  new URL('../supabase/migrations/0106_admin_backdated_billing.sql', import.meta.url),
  'utf8',
);
const dailyAggregateStock = readFileSync(
  new URL('../supabase/migrations/0107_daily_aggregate_stock.sql', import.meta.url),
  'utf8',
);
const dailyAggregateCompletion = readFileSync(
  new URL('../supabase/migrations/0108_finish_daily_aggregate_workflow.sql', import.meta.url),
  'utf8',
);
const collectionShopCardsAndChargeNumbers = readFileSync(
  new URL('../supabase/migrations/0109_collection_shop_cards_and_charge_numbers.sql', import.meta.url),
  'utf8',
);
const collectionCarryForwardBalances = readFileSync(
  new URL('../supabase/migrations/0115_collection_carry_forward_balances.sql', import.meta.url),
  'utf8',
);

const COURIER_ID = '10000000-0000-4000-8000-000000000001';
const ADMIN_ID = '10000000-0000-4000-8000-000000000002';
const OTHER_COURIER_ID = '10000000-0000-4000-8000-000000000003';
const ROUND_LEAD_ID = '10000000-0000-4000-8000-000000000004';
const INACTIVE_COURIER_ID = '10000000-0000-4000-8000-000000000005';
const ROUND_ID = '20000000-0000-4000-8000-000000000001';
const SHOP_ID = '30000000-0000-4000-8000-000000000001';
const STOP_ID = '40000000-0000-4000-8000-000000000001';
const ICE_ID = '50000000-0000-4000-8000-000000000001';
const HOLDING_ID = '60000000-0000-4000-8000-000000000001';
const SHOP_SOURCE_ID = '60000000-0000-4000-8000-000000000002';
const TRUCK_ID = '60000000-0000-4000-8000-000000000003';
const SERVICE_DATE = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
const NEXT_SERVICE_DATE = new Date(`${SERVICE_DATE}T12:00:00+07:00`);
NEXT_SERVICE_DATE.setDate(NEXT_SERVICE_DATE.getDate() + 1);
const NEXT_SERVICE_DATE_TEXT = NEXT_SERVICE_DATE.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
const PREVIOUS_SERVICE_DATE = new Date(`${SERVICE_DATE}T12:00:00+07:00`);
PREVIOUS_SERVICE_DATE.setDate(PREVIOUS_SERVICE_DATE.getDate() - 1);
const PREVIOUS_SERVICE_DATE_TEXT = PREVIOUS_SERVICE_DATE.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });

async function createDatabase(t, { applyCollectionShopCards = true } = {}) {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto } });
  t.after(() => db.close());

  await db.exec(`
    create extension if not exists pgcrypto;
    create role authenticated;
    create schema auth;
    create schema storage;

    create type public.app_role as enum ('courier', 'round_lead', 'admin');
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

    create table public.auth_context (
      singleton boolean primary key default true,
      user_id uuid not null,
      app_role public.app_role not null,
      is_active boolean not null
    );
    insert into public.auth_context (user_id, app_role, is_active)
    values ('${COURIER_ID}', 'courier', true);

    create function auth.uid() returns uuid language sql stable as $$
      select user_id from public.auth_context where singleton
    $$;
    create function public.current_app_role() returns public.app_role language sql stable as $$
      select app_role from public.auth_context where singleton
    $$;
    create function public.is_active_user() returns boolean language sql stable as $$
      select is_active from public.auth_context where singleton
    $$;

    create table public.users (
      id uuid primary key,
      code text not null unique,
      role public.app_role not null,
      is_active boolean not null default true,
      display_name text not null,
      nickname text,
      avatar_path text
    );
    create table public.delivery_rounds (
      id uuid primary key,
      service_date date not null,
      status public.delivery_round_status not null,
      cancelled_at timestamptz,
      closed_by uuid references public.users(id),
      closed_at timestamptz
    );
    create table public.delivery_round_members (
      round_id uuid not null references public.delivery_rounds(id),
      user_id uuid not null references public.users(id),
      primary key (round_id, user_id)
    );
    create function public.is_round_member(target_round_id uuid) returns boolean
    language sql stable as $$
      select exists (
        select 1 from public.delivery_round_members
        where round_id = target_round_id and user_id = auth.uid()
      )
    $$;

    create table public.stock_locations (
      id uuid primary key,
      code text not null unique,
      name text not null,
      kind public.stock_location_kind not null,
      assigned_user_id uuid references public.users(id),
      is_courier_source boolean not null default false,
      holds_inventory boolean not null default true,
      is_active boolean not null default true
    );
    create table public.shops (
      id uuid primary key,
      code text not null unique,
      name text not null,
      image_path text,
      stock_location_id uuid not null references public.stock_locations(id)
    );
    create table public.ice_types (
      id uuid primary key,
      code text not null unique,
      name text not null,
      unit text not null,
      image_path text,
      is_active boolean not null default true
    );
    create table public.round_stops (
      id uuid primary key,
      round_id uuid not null references public.delivery_rounds(id),
      shop_id uuid not null references public.shops(id),
      shop_code_snapshot text not null,
      shop_name_snapshot text not null,
      building_name_snapshot text not null,
      floor_or_zone_snapshot text not null,
      status public.shop_round_status not null default 'pending',
      note text,
      updated_by uuid not null references public.users(id),
      updated_at timestamptz not null default now()
    );
    create table public.delivery_events (
      id uuid primary key default gen_random_uuid(),
      round_stop_id uuid not null references public.round_stops(id),
      recorded_by uuid not null references public.users(id),
      recorded_at timestamptz not null default now(),
      client_recorded_at timestamptz,
      idempotency_key uuid not null unique,
      note text,
      status public.delivery_event_status not null default 'active',
      cancelled_by uuid references public.users(id),
      cancelled_at timestamptz,
      cancellation_reason text,
      source_stock_location_id uuid references public.stock_locations(id),
      corrects_event_id uuid references public.delivery_events(id),
      check (
        (status = 'active' and cancelled_by is null and cancelled_at is null and cancellation_reason is null)
        or (status = 'cancelled' and cancelled_by is not null and cancelled_at is not null
          and nullif(trim(coalesce(cancellation_reason, '')), '') is not null)
      )
    );
    create table public.delivery_items (
      delivery_event_id uuid not null references public.delivery_events(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity integer not null check (quantity > 0),
      primary key (delivery_event_id, ice_type_id)
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
    create view public.round_ice_reconciliation
    with (security_invoker = true)
    as
    select
      c.round_id,
      c.ice_type_id,
      c.loaded_quantity + c.replenished_quantity - c.remaining_quantity - c.damaged_quantity as expected_quantity,
      coalesce(sum(i.quantity) filter (where e.status = 'active'), 0) as delivered_quantity,
      (c.loaded_quantity + c.replenished_quantity - c.remaining_quantity - c.damaged_quantity)
        - coalesce(sum(i.quantity) filter (where e.status = 'active'), 0) as variance_quantity
    from public.round_ice_counts c
    left join public.round_stops s on s.round_id = c.round_id
    left join public.delivery_events e on e.round_stop_id = s.id
    left join public.delivery_items i on i.delivery_event_id = e.id and i.ice_type_id = c.ice_type_id
    group by c.round_id, c.ice_type_id, c.loaded_quantity, c.replenished_quantity,
      c.remaining_quantity, c.damaged_quantity;
    create table public.stock_movements (
      id uuid primary key default gen_random_uuid(),
      service_date date not null,
      round_id uuid references public.delivery_rounds(id),
      kind public.stock_movement_kind not null,
      from_location_id uuid references public.stock_locations(id),
      to_location_id uuid references public.stock_locations(id),
      note text,
      idempotency_key uuid not null unique,
      request_fingerprint text,
      status public.stock_movement_status not null default 'active',
      recorded_by uuid not null references public.users(id),
      recorded_at timestamptz not null default now()
    );
    create table public.stock_movement_items (
      movement_id uuid not null references public.stock_movements(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity numeric(12,1) not null check (quantity > 0),
      primary key (movement_id, ice_type_id)
    );
    create table public.factory_receipts (
      id uuid primary key default gen_random_uuid(),
      factory_order_id uuid not null unique references public.stock_movements(id),
      service_date date not null,
      truck_location_id uuid not null references public.stock_locations(id)
    );
    create table public.factory_receipt_items (
      factory_receipt_id uuid not null references public.factory_receipts(id),
      ice_type_id uuid not null references public.ice_types(id),
      actual_quantity numeric(12,1) not null,
      primary key (factory_receipt_id, ice_type_id)
    );
    create table public.delivery_event_revisions (
      idempotency_key uuid primary key,
      original_event_id uuid not null references public.delivery_events(id),
      replacement_event_id uuid references public.delivery_events(id),
      action text not null check (action in ('cancel', 'correct')),
      reason text not null,
      revised_by uuid not null references public.users(id),
      revised_at timestamptz not null default now()
    );
    create table public.daily_stock_closures (
      service_date date primary key,
      status text not null
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
    create table public.test_opening_balances (
      service_date date not null,
      location_id uuid not null references public.stock_locations(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity integer not null,
      primary key (service_date, location_id, ice_type_id)
    );
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null references storage.buckets(id),
      name text not null,
      unique (bucket_id, name)
    );
    create function storage.foldername(path text) returns text[]
    language sql immutable as $$
      select string_to_array(path, '/')
    $$;

    create function public.set_updated_at() returns trigger language plpgsql as $$
    begin
      new.updated_at = now();
      return new;
    end;
    $$;
    create function public.stock_balance_at(
      p_service_date date, p_location_id uuid, p_ice_type_id uuid
    ) returns integer language sql stable as $$
      select coalesce((
        select quantity from public.test_opening_balances
        where service_date = p_service_date and location_id = p_location_id
          and ice_type_id = p_ice_type_id
      ), 0) + coalesce((
        select sum(
          case when movement.to_location_id = p_location_id then item.quantity else 0 end
          - case when movement.from_location_id = p_location_id then item.quantity else 0 end
        )::integer
        from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date
          and movement.status = 'active'
          and item.ice_type_id = p_ice_type_id
          and (movement.from_location_id = p_location_id
            or movement.to_location_id = p_location_id)
      ), 0) - coalesce((
        select sum(item.quantity)::integer
        from public.delivery_events event
        join public.delivery_items item on item.delivery_event_id = event.id
        join public.round_stops stop on stop.id = event.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        where round.service_date = p_service_date
          and event.source_stock_location_id = p_location_id
          and item.ice_type_id = p_ice_type_id
          and event.status = 'active'
      ), 0)
    $$;
    create function public.is_delivery_event_visible(target_event_id uuid) returns boolean
    language sql stable as $$
      select exists (
        select 1
        from public.delivery_events event
        join public.round_stops stop on stop.id = event.round_stop_id
        where event.id = target_event_id
          and (public.current_app_role() in ('admin', 'round_lead')
            or public.is_round_member(stop.round_id))
      )
    $$;
    create function public.get_manager_delivery_events(p_round_id uuid) returns jsonb
    language sql stable as $$ select jsonb_build_object('round_id', p_round_id) $$;
    create function public.record_delivery(
      uuid, jsonb, public.shop_round_status, text, timestamptz, uuid
    ) returns jsonb language sql as $$ select '{}'::jsonb $$;
    create function public.revise_delivery_event(
      uuid, text, jsonb, public.shop_round_status, text, text, uuid
    ) returns jsonb language sql as $$ select '{}'::jsonb $$;

    insert into public.users (id, code, role, is_active, display_name, nickname, avatar_path) values
      ('${COURIER_ID}', 'C001', 'courier', true, 'Courier', 'First', 'users/${COURIER_ID}/avatar.webp'),
      ('${ADMIN_ID}', 'A001', 'admin', true, 'Admin', null, null),
      ('${OTHER_COURIER_ID}', 'C002', 'courier', true, 'Other courier', null, null),
      ('${ROUND_LEAD_ID}', 'R001', 'round_lead', true, 'Round lead', null, null),
      ('${INACTIVE_COURIER_ID}', 'C003', 'courier', false, 'Inactive courier', null, null);
    insert into public.delivery_rounds (id, service_date, status)
    values ('${ROUND_ID}', date '${SERVICE_DATE}', 'open');
    insert into public.delivery_round_members (round_id, user_id)
    values ('${ROUND_ID}', '${COURIER_ID}');
    insert into public.stock_locations (
      id, code, name, kind, assigned_user_id, is_courier_source, holds_inventory
    ) values
      ('${HOLDING_ID}', 'TEAM-1', 'Courier stock', 'team', '${COURIER_ID}', false, true),
      ('${SHOP_SOURCE_ID}', 'SITE-1', 'Shop stock', 'work_site', null, false, false),
      ('${TRUCK_ID}', 'TRUCK-1', 'Main truck', 'truck', null, true, true);
    insert into public.shops (id, code, name, stock_location_id)
    values ('${SHOP_ID}', 'SHOP-1', 'Shop One', '${SHOP_SOURCE_ID}');
    insert into public.ice_types (id, code, name, unit)
    values ('${ICE_ID}', 'ICE-1', 'Ice', 'bag');
    insert into public.round_stops (
      id, round_id, shop_id, shop_code_snapshot, shop_name_snapshot,
      building_name_snapshot, floor_or_zone_snapshot, updated_by
    ) values (
      '${STOP_ID}', '${ROUND_ID}', '${SHOP_ID}', 'SHOP-1', 'Shop One',
      'Building A', 'Zone 1', '${ADMIN_ID}'
    );
    insert into public.test_opening_balances (
      service_date, location_id, ice_type_id, quantity
    ) values
      (date '${SERVICE_DATE}', '${HOLDING_ID}', '${ICE_ID}', 10),
      (date '${SERVICE_DATE}', '${SHOP_SOURCE_ID}', '${ICE_ID}', 50),
      (date '${SERVICE_DATE}', '${TRUCK_ID}', '${ICE_ID}', 30);
    insert into public.stock_movements (
      id, service_date, kind, to_location_id, idempotency_key, recorded_by
    ) values (
      '65000000-0000-4000-8000-000000000001', date '${SERVICE_DATE}',
      'factory_order', '${TRUCK_ID}', '65000000-0000-4000-8000-000000000002',
      '${ADMIN_ID}'
    );
    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    values ('65000000-0000-4000-8000-000000000001', '${ICE_ID}', 30);
  `);

  await db.exec(foundation);
  await db.exec(transactions);
  await db.exec(operations);
  await db.exec(recovery);
  await db.exec(collectorAccess);
  await db.exec(adminBackdatedBilling);
  await db.exec(`
    create function public.record_factory_order(
      p_service_date date,
      p_truck_location_id uuid,
      p_items jsonb,
      p_note text default null,
      p_idempotency_key uuid default gen_random_uuid()
    )
    returns jsonb
    language plpgsql
    security definer
    set search_path = public
    as $$
    begin
      perform pg_advisory_xact_lock(hashtextextended(p_service_date::text, 0));

      if exists (
        select 1
        from public.daily_stock_closures
        where service_date = p_service_date and status = 'closed'
      ) then
        raise exception 'Stock for this service date is already closed';
      end if;

      insert into public.stock_movements (
        service_date, kind, to_location_id, idempotency_key, recorded_by
      ) values (
        p_service_date, 'factory_order', p_truck_location_id,
        p_idempotency_key, auth.uid()
      );
      return '{}'::jsonb;
    end;
    $$;

    create function public.cancel_factory_order(
      p_movement_id uuid,
      p_reason text
    )
    returns jsonb
    language plpgsql
    security definer
    set search_path = public
    as $$
    declare
      v_movement public.stock_movements%rowtype;
    begin
      select * into v_movement
      from public.stock_movements
      where id = p_movement_id
      for update;

      perform pg_advisory_xact_lock(hashtextextended(v_movement.service_date::text, 0));

      if exists (
        select 1
        from public.daily_stock_closures closure
        where closure.service_date = v_movement.service_date
          and closure.status = 'closed'
      ) then
        raise exception 'Stock for this service date is already closed';
      end if;

      update public.stock_movements
      set status = 'cancelled'
      where id = p_movement_id;
      return '{}'::jsonb;
    end;
    $$;
  `);
  await db.exec(dailyAggregateStock);
  await db.exec(dailyAggregateCompletion);
  if (applyCollectionShopCards) {
    await db.exec(collectionShopCardsAndChargeNumbers);
    await db.exec(collectionCarryForwardBalances);
  }
  await db.exec(`
    insert into public.ice_type_prices (
      ice_type_id, unit_price, valid_from, created_by
    ) values ('${ICE_ID}', 20, date '2026-07-01', '${ADMIN_ID}');
    insert into public.shop_ice_type_prices (
      shop_id, ice_type_id, unit_price, valid_from, created_by
    ) values ('${SHOP_ID}', '${ICE_ID}', 18, date '2026-07-15', '${ADMIN_ID}');
    insert into public.shop_payment_profiles (
      shop_id, allowed_payment_terms, default_payment_term,
      allowed_payment_methods, default_payment_method, created_by
    ) values (
      '${SHOP_ID}', array['immediate']::public.payment_term[], 'immediate',
      array['cash']::public.payment_method[], 'cash', '${ADMIN_ID}'
    );
  `);
  return db;
}

function itemPayload(quantity) {
  return JSON.stringify([{ ice_type_id: ICE_ID, quantity }]);
}

test('round leads and admins list only active collection couriers', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.auth_context
    set user_id = '${ROUND_LEAD_ID}', app_role = 'round_lead', is_active = true;
  `);

  const roundLeadResult = await db.query(`
    select * from public.get_collection_collectors()
  `);
  assert.deepEqual(
    roundLeadResult.rows.map((collector) => collector.code),
    ['C001', 'C002'],
  );
  assert.deepEqual(Object.keys(roundLeadResult.rows[0]).sort(), [
    'avatar_path',
    'code',
    'display_name',
    'id',
    'nickname',
  ]);

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);
  const adminResult = await db.query(`
    select * from public.get_collection_collectors()
  `);
  assert.deepEqual(
    adminResult.rows.map((collector) => collector.code),
    ['C001', 'C002'],
  );

  await db.exec(`
    update public.auth_context
    set user_id = '${COURIER_ID}', app_role = 'courier';
  `);
  await assert.rejects(
    db.query(`select * from public.get_collection_collectors()`),
    /Only a round lead or admin/i,
  );
});

test('collection runs reject members who are not active couriers', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.auth_context
    set user_id = '${ROUND_LEAD_ID}', app_role = 'round_lead', is_active = true;
  `);

  for (const invalidUserId of [
    ADMIN_ID,
    INACTIVE_COURIER_ID,
    '10000000-0000-4000-8000-000000000099',
  ]) {
    await assert.rejects(
      db.query(`
        select public.open_collection_run(
          date '${SERVICE_DATE}',
          '[{"user_id":"${invalidUserId}"}]'::jsonb
        )
      `),
      /Collection members must be active couriers/i,
    );
  }

  const runCount = await db.query(`select count(*)::integer as count from public.collection_runs`);
  assert.equal(runCount.rows[0].count, 0);

  const validRun = await db.query(`
    select public.open_collection_run(
      date '${SERVICE_DATE}',
      '[{"user_id":"${OTHER_COURIER_ID}"}]'::jsonb
    ) as result
  `);
  assert.ok(validRun.rows[0].result.collection_run_id);
});

test('POS context and delivery use override price, aggregate stock, and idempotent charge', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`delete from public.delivery_round_members where round_id = '${ROUND_ID}'`);
  await assert.rejects(
    db.query(`select public.get_delivery_pos_context('${STOP_ID}')`),
    /not assigned/i,
  );
  await db.exec(`
    insert into public.delivery_round_members (round_id, user_id)
    values ('${ROUND_ID}', '${COURIER_ID}')
  `);
  const context = await db.query(`select public.get_delivery_pos_context('${STOP_ID}') as result`);
  assert.equal(context.rows[0].result.service_date, SERVICE_DATE);
  assert.equal(context.rows[0].result.stock_source.id, null);
  assert.equal(context.rows[0].result.stock_source.code, 'DAILY');
  assert.equal(Number(context.rows[0].result.items[0].unit_price), 18);
  assert.equal(context.rows[0].result.items[0].price_source, 'shop_override');
  assert.equal(context.rows[0].result.items[0].stock_quantity, 30);

  const key = '70000000-0000-4000-8000-000000000001';
  const first = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null, '${key}', 'immediate'
    ) as result
  `);
  assert.equal(Number(first.rows[0].result.total_amount), 36);
  assert.equal(first.rows[0].result.payment_status, 'unpaid');
  assert.equal(first.rows[0].result.source_stock_location_id, SHOP_SOURCE_ID);

  const retry = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null, '${key}', 'immediate'
    ) as result
  `);
  assert.equal(retry.rows[0].result.delivery_event_id, first.rows[0].result.delivery_event_id);

  await assert.rejects(
    db.query(`
      select public.record_delivery(
        '${STOP_ID}', '${itemPayload(3)}'::jsonb, 'delivered', null, null, '${key}', 'immediate'
      )
    `),
    /different delivery request/i,
  );

  const counts = await db.query(`
    select
      (select count(*)::integer from public.delivery_events) as events,
      (select count(*)::integer from public.delivery_charges) as charges
  `);
  assert.deepEqual(counts.rows[0], { events: 1, charges: 1 });

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin'
  `);
  const adminContext = await db.query(`
    select public.get_delivery_pos_context('${STOP_ID}') as result
  `);
  assert.equal(adminContext.rows[0].result.stock_source.id, null);
  assert.equal(adminContext.rows[0].result.items[0].stock_quantity, 28);
});

test('delivery creation and correction reject quantities outside half-bag increments', async (t) => {
  const db = await createDatabase(t);

  await assert.rejects(
    db.query(`
      select public.record_delivery(
        '${STOP_ID}', '${itemPayload(0.1)}'::jsonb, 'delivered', null, null,
        '70000000-0000-4000-8000-000000000096', 'immediate'
      )
    `),
    /positive quantity/i,
  );

  const valid = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(0.5)}'::jsonb, 'delivered', null, null,
      '70000000-0000-4000-8000-000000000095', 'immediate'
    ) as result
  `);
  assert.equal(Number(valid.rows[0].result.total_amount), 9);

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);
  await assert.rejects(
    db.query(`
      select public.revise_delivery_event(
        '${valid.rows[0].result.delivery_event_id}', 'correct',
        '${itemPayload(0.1)}'::jsonb, 'delivered', null, 'แก้จำนวน',
        '70000000-0000-4000-8000-000000000094'
      )
    `),
    /positive quantity/i,
  );
});

test('internal transfers do not change aggregate stock and corrections preserve aggregate inventory', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
    insert into public.stock_movements (
      id, service_date, kind, from_location_id, to_location_id,
      idempotency_key, recorded_by
    ) values (
      '65000000-0000-4000-8000-000000000010', date '${SERVICE_DATE}',
      'transfer', '${TRUCK_ID}', '${HOLDING_ID}',
      '65000000-0000-4000-8000-000000000011', '${ADMIN_ID}'
    );
    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    values ('65000000-0000-4000-8000-000000000010', '${ICE_ID}', 10);
  `);

  const contextResult = await db.query(`
    select public.get_delivery_pos_context('${STOP_ID}') as result
  `);
  assert.equal(contextResult.rows[0].result.stock_source.id, null);
  assert.equal(contextResult.rows[0].result.items[0].stock_quantity, 30);

  const key = '70000000-0000-4000-8000-000000000099';
  await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      '${key}', 'immediate'
    )
  `);
  await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      '${key}', 'immediate'
    )
  `);

  const balances = await db.query(`
    select
      public.daily_aggregate_stock_balance_at(date '${SERVICE_DATE}', '${ICE_ID}') as aggregate,
      (select count(*)::integer from public.stock_movements
       where idempotency_key = '${key}') as movements,
      (select count(*)::integer from public.delivery_events
       where idempotency_key = '${key}') as deliveries,
      (select source_stock_location_id from public.delivery_events
       where idempotency_key = '${key}') as source
  `);
  assert.deepEqual({ ...balances.rows[0], aggregate: Number(balances.rows[0].aggregate) }, {
    aggregate: 28,
    movements: 0,
    deliveries: 1,
    source: SHOP_SOURCE_ID,
  });

  const original = await db.query(`
    select id from public.delivery_events where idempotency_key = '${key}'
  `);
  await db.query(`
    select public.revise_delivery_event(
      '${original.rows[0].id}', 'correct', '${itemPayload(1)}'::jsonb,
      'delivered', null, 'แก้จำนวน', '70000000-0000-4000-8000-000000000098'
    )
  `);
  const correctedBalances = await db.query(`
    select
      public.daily_aggregate_stock_balance_at(date '${SERVICE_DATE}', '${ICE_ID}') as aggregate
  `);
  assert.deepEqual(
    { aggregate: Number(correctedBalances.rows[0].aggregate) },
    { aggregate: 29 },
  );

  await db.exec(`
    update public.auth_context
    set user_id = '${ROUND_LEAD_ID}', app_role = 'round_lead';
  `);
  const roundLeadContext = await db.query(`
    select public.get_delivery_pos_context('${STOP_ID}') as result
  `);
  assert.equal(roundLeadContext.rows[0].result.stock_source.id, null);
  assert.equal(roundLeadContext.rows[0].result.items[0].stock_quantity, 29);
});

test('admin delivery rejects a future service date at the database boundary', async (t) => {
  const db = await createDatabase(t);
  const futureRoundId = '20000000-0000-4000-8000-000000000099';
  const futureStopId = '40000000-0000-4000-8000-000000000099';
  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';

    insert into public.delivery_rounds (id, service_date, status)
    values ('${futureRoundId}', date '${NEXT_SERVICE_DATE_TEXT}', 'open');
    insert into public.round_stops (
      id, round_id, shop_id, shop_code_snapshot, shop_name_snapshot,
      building_name_snapshot, floor_or_zone_snapshot, updated_by
    ) values (
      '${futureStopId}', '${futureRoundId}', '${SHOP_ID}', 'SHOP-1', 'Shop One',
      'Building A', 'Zone 1', '${ADMIN_ID}'
    );
    insert into public.test_opening_balances (
      service_date, location_id, ice_type_id, quantity
    ) values (
      date '${NEXT_SERVICE_DATE_TEXT}', '${TRUCK_ID}', '${ICE_ID}', 5
    );
  `);

  await assert.rejects(
    db.query(`
      select public.record_delivery(
        '${futureStopId}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
        '70000000-0000-4000-8000-000000000097', 'immediate'
      )
    `),
    /future service date/i,
  );
});

test('half-bag refill is idempotent, cancellable, and aggregate close zeros the day', async (t) => {
  const db = await createDatabase(t);
  const refillKey = '70000000-0000-4000-8000-000000000090';
  const refillItems = JSON.stringify([{ ice_type_id: ICE_ID, quantity: 0.5 }]);

  await db.query(`
    select public.record_daily_stock_refill(
      date '${SERVICE_DATE}', '${refillItems}'::jsonb, 'เติมให้จุดบริการ', '${refillKey}'
    )
  `);
  await db.query(`
    select public.record_daily_stock_refill(
      date '${SERVICE_DATE}', '${refillItems}'::jsonb, 'เติมให้จุดบริการ', '${refillKey}'
    )
  `);
  let state = await db.query(`
    select
      public.daily_aggregate_stock_balance_at(date '${SERVICE_DATE}', '${ICE_ID}') as balance,
      (select count(*)::integer from public.daily_stock_uses) as uses
  `);
  assert.deepEqual(
    { balance: Number(state.rows[0].balance), uses: state.rows[0].uses },
    { balance: 29.5, uses: 1 },
  );

  const refill = await db.query(`
    select id from public.daily_stock_uses where idempotency_key = '${refillKey}'
  `);
  await db.exec(`
    update public.auth_context
    set user_id = '${ROUND_LEAD_ID}', app_role = 'round_lead'
  `);
  await db.query(`
    select public.cancel_daily_stock_refill('${refill.rows[0].id}', 'บันทึกผิด')
  `);
  const refillHistory = await db.query(`
    select public.get_daily_stock_refill_history(date '${SERVICE_DATE}') as result
  `);
  assert.equal(refillHistory.rows[0].result[0].status, 'cancelled');
  assert.equal(refillHistory.rows[0].result[0].cancellation_reason, 'บันทึกผิด');
  assert.equal(Number(refillHistory.rows[0].result[0].items[0].quantity), 0.5);
  state = await db.query(`
    select public.daily_aggregate_stock_balance_at(
      date '${SERVICE_DATE}', '${ICE_ID}'
    ) as balance
  `);
  assert.equal(Number(state.rows[0].balance), 30);

  await db.query(`
    select public.close_daily_aggregate_stock(
      date '${SERVICE_DATE}',
      '[{"ice_type_id":"${ICE_ID}","actual_quantity":30}]'::jsonb,
      null,
      '70000000-0000-4000-8000-000000000091'
    )
  `);
  state = await db.query(`
    select
      public.daily_aggregate_stock_balance_at(date '${SERVICE_DATE}', '${ICE_ID}') as balance,
      (select system_quantity from public.daily_aggregate_stock_closure_items
       where service_date = date '${SERVICE_DATE}' and ice_type_id = '${ICE_ID}') as system,
      (select status from public.daily_aggregate_stock_closures
       where service_date = date '${SERVICE_DATE}') as status,
      public.get_daily_aggregate_stock_summary(date '${SERVICE_DATE}') as summary
  `);
  assert.deepEqual(
    {
      balance: Number(state.rows[0].balance),
      system: Number(state.rows[0].system),
      status: state.rows[0].status,
      returned: Number(state.rows[0].summary.items[0].returned_quantity),
    },
    { balance: 0, system: 30, status: 'closed', returned: 30 },
  );

  await assert.rejects(
    db.query(`
      select public.record_daily_stock_refill(
        date '${SERVICE_DATE}', '${refillItems}'::jsonb, null,
        '70000000-0000-4000-8000-000000000092'
      )
    `),
    /already closed/i,
  );
});

test('aggregate close makes all stock movements immutable', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);
  await db.query(`
    select public.close_daily_aggregate_stock(
      date '${SERVICE_DATE}',
      '[{"ice_type_id":"${ICE_ID}","actual_quantity":30}]'::jsonb,
      null,
      '70000000-0000-4000-8000-000000000093'
    )
  `);

  await assert.rejects(
    db.query(`
      select public.record_factory_order(
        date '${SERVICE_DATE}', '${TRUCK_ID}', '${itemPayload(1)}'::jsonb, null,
        '70000000-0000-4000-8000-000000000092'
      )
    `),
    /already closed/i,
  );
  await assert.rejects(
    db.query(`
      select public.cancel_factory_order(
        '65000000-0000-4000-8000-000000000001', 'ยกเลิกหลังปิดวัน'
      )
    `),
    /already closed/i,
  );
  await assert.rejects(
    db.query(`
      update public.stock_movements
      set service_date = date '${NEXT_SERVICE_DATE_TEXT}'
      where id = '65000000-0000-4000-8000-000000000001'
    `),
    /already closed/i,
  );

  const movement = await db.query(`
    select service_date::text, status from public.stock_movements
    where id = '65000000-0000-4000-8000-000000000001'
  `);
  assert.deepEqual(movement.rows[0], {
    service_date: SERVICE_DATE,
    status: 'active',
  });
});

test('missing payment profile or effective price fails before stock and ledger writes', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`delete from public.shop_payment_profiles where shop_id = '${SHOP_ID}'`);

  await assert.rejects(
    db.query(`
      select public.record_delivery(
        '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
        '70000000-0000-4000-8000-000000000002', 'immediate'
      )
    `),
    /payment profile/i,
  );

  await db.exec(`
    insert into public.shop_payment_profiles (
      shop_id, allowed_payment_terms, default_payment_term,
      allowed_payment_methods, default_payment_method, created_by
    ) values (
      '${SHOP_ID}', array['immediate']::public.payment_term[], 'immediate',
      array['cash']::public.payment_method[], 'cash', '${ADMIN_ID}'
    );
    delete from public.shop_ice_type_prices where shop_id = '${SHOP_ID}';
    delete from public.ice_type_prices where ice_type_id = '${ICE_ID}';
  `);

  await assert.rejects(
    db.query(`
      select public.record_delivery(
        '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
        '70000000-0000-4000-8000-000000000003', 'immediate'
      )
    `),
    /effective price/i,
  );

  const counts = await db.query(`
    select
      (select count(*)::integer from public.delivery_events) as events,
      (select count(*)::integer from public.delivery_charges) as charges,
      public.stock_balance_at(date '${SERVICE_DATE}', '${HOLDING_ID}', '${ICE_ID}') as stock
  `);
  assert.deepEqual(counts.rows[0], { events: 0, charges: 0, stock: 10 });
});

test('financial correction reprices at original service date and cancellation voids its charge', async (t) => {
  const db = await createDatabase(t);
  const original = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      '70000000-0000-4000-8000-000000000004', 'immediate'
    ) as result
  `);
  const originalEventId = original.rows[0].result.delivery_event_id;

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
    update public.shop_ice_type_prices
    set valid_to = date '${SERVICE_DATE}'
    where shop_id = '${SHOP_ID}' and ice_type_id = '${ICE_ID}';
    insert into public.shop_ice_type_prices (
      shop_id, ice_type_id, unit_price, valid_from, created_by
    ) values ('${SHOP_ID}', '${ICE_ID}', 30, date '${NEXT_SERVICE_DATE_TEXT}', '${ADMIN_ID}');
  `);

  await db.query(`
    select public.revise_delivery_event(
      '${originalEventId}', 'correct', '${itemPayload(3)}'::jsonb,
      'delivered', null, 'แก้จำนวน',
      '80000000-0000-4000-8000-000000000001'
    )
  `);

  const correction = await db.query(`
    select
      original.status as original_status,
      original_charge.status as original_charge_status,
      replacement.id as replacement_id,
      item.unit_price,
      replacement_charge.original_amount,
      replacement_charge.status as replacement_charge_status
    from public.delivery_events original
    join public.delivery_events replacement on replacement.corrects_event_id = original.id
    join public.delivery_items item on item.delivery_event_id = replacement.id
    join public.delivery_charges original_charge on original_charge.delivery_event_id = original.id
    join public.delivery_charges replacement_charge on replacement_charge.delivery_event_id = replacement.id
    where original.id = '${originalEventId}'
  `);
  assert.equal(correction.rows[0].original_status, 'cancelled');
  assert.equal(correction.rows[0].original_charge_status, 'voided');
  assert.equal(Number(correction.rows[0].unit_price), 18);
  assert.equal(Number(correction.rows[0].original_amount), 54);
  assert.equal(correction.rows[0].replacement_charge_status, 'active');

  await db.query(`
    select public.revise_delivery_event(
      '${correction.rows[0].replacement_id}', 'cancel', '[]'::jsonb,
      'delivered', null, 'ยกเลิกรายการ',
      '80000000-0000-4000-8000-000000000002'
    )
  `);
  const cancelled = await db.query(`
    select event.status, charge.status as charge_status
    from public.delivery_events event
    join public.delivery_charges charge on charge.delivery_event_id = event.id
    where event.id = '${correction.rows[0].replacement_id}'
  `);
  assert.deepEqual(cancelled.rows[0], { status: 'cancelled', charge_status: 'voided' });
});

test('legacy unpriced correction stays outside the financial ledger', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
    insert into public.delivery_events (
      round_stop_id, recorded_by, idempotency_key, source_stock_location_id
    ) values (
      '${STOP_ID}', '${ADMIN_ID}', '70000000-0000-4000-8000-000000000005',
      '${SHOP_SOURCE_ID}'
    );
    insert into public.delivery_items (delivery_event_id, ice_type_id, quantity)
    select id, '${ICE_ID}', 1 from public.delivery_events
    where idempotency_key = '70000000-0000-4000-8000-000000000005';
  `);
  const legacy = await db.query(`
    select id from public.delivery_events
    where idempotency_key = '70000000-0000-4000-8000-000000000005'
  `);

  await db.query(`
    select public.revise_delivery_event(
      '${legacy.rows[0].id}', 'correct', '${itemPayload(2)}'::jsonb,
      'delivered', null, 'แก้ legacy',
      '80000000-0000-4000-8000-000000000003'
    )
  `);

  const replacement = await db.query(`
    select item.unit_price,
      (select count(*)::integer from public.delivery_charges charge
       where charge.delivery_event_id = event.id) as charges
    from public.delivery_events event
    join public.delivery_items item on item.delivery_event_id = event.id
    where event.corrects_event_id = '${legacy.rows[0].id}'
  `);
  assert.deepEqual(replacement.rows[0], { unit_price: null, charges: 0 });
});

test('charge reference migration backfills history and advances the sequence for new charges', async (t) => {
  const db = await createDatabase(t, { applyCollectionShopCards: false });
  const original = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '70000000-0000-4000-8000-000000000099', 'immediate'
    ) as result
  `);
  const originalEventId = original.rows[0].result.delivery_event_id;

  await db.exec(collectionShopCardsAndChargeNumbers);
  const historical = await db.query(`
    select charge_number
    from public.delivery_charges
    where delivery_event_id = '${originalEventId}'
  `);
  assert.match(historical.rows[0].charge_number, /^C\d{6}-000001$/);

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin'
  `);
  await db.query(`
    select public.revise_delivery_event(
      '${originalEventId}', 'correct', '${itemPayload(2)}'::jsonb,
      'delivered', null, 'verify charge sequence',
      '80000000-0000-4000-8000-000000000099'
    )
  `);
  const references = await db.query(`
    select charge_number
    from public.delivery_charges
    order by charge_number
  `);
  assert.deepEqual(
    references.rows.map((row) => row.charge_number.slice(-6)),
    ['000001', '000002'],
  );
  assert.equal(new Set(references.rows.map((row) => row.charge_number)).size, 2);
});

test('credit-limit approval must match and is consumed by exactly one delivery', async (t) => {
  const db = await createDatabase(t);
  const todayStr = new Date(Date.now() + 7 * 3600000).toISOString().split('T')[0];
  const expectedDueDate = new Date(Date.now() + 7 * 3600000);
  expectedDueDate.setDate(expectedDueDate.getDate() + 30);
  const expectedDueDateStr = expectedDueDate.toISOString().split('T')[0];

  await db.exec(`
    update public.delivery_rounds
    set service_date = date '${todayStr}'
    where id = '${ROUND_ID}';
    update public.shop_payment_profiles
    set allowed_payment_terms = array['credit']::public.payment_term[],
        default_payment_term = 'credit',
        allow_outstanding = true,
        credit_due_rule = 'net_days',
        credit_days = 30,
        credit_limit = 20
    where shop_id = '${SHOP_ID}';
    insert into public.test_opening_balances (
      service_date, location_id, ice_type_id, quantity
    ) values (
      date '${todayStr}',
      '${HOLDING_ID}', '${ICE_ID}', 10
    ) on conflict (service_date, location_id, ice_type_id) do update
      set quantity = excluded.quantity;
  `);
  const fingerprint = await db.query(`
    select public.delivery_request_fingerprint(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, 'credit'
    ) as value
  `);
  const approval = await db.query(`
    insert into public.financial_approval_requests (
      shop_id, round_stop_id, kind, requested_amount, reason,
      request_fingerprint, status, requested_by, decided_by, decided_at
    ) values (
      '${SHOP_ID}', '${STOP_ID}', 'credit_limit', 35, 'credit test',
      '${fingerprint.rows[0].value}', 'approved', '${COURIER_ID}', '${ADMIN_ID}', now()
    ) returning id
  `);
  const approvalId = approval.rows[0].id;

  await assert.rejects(
    db.query(`
      select public.record_delivery(
        '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
        '70000000-0000-4000-8000-000000000006', 'credit', '${approvalId}'
      )
    `),
    /approval does not match/i,
  );

  await db.exec(`
    update public.financial_approval_requests
    set requested_amount = 36
    where id = '${approvalId}'
  `);
  const delivered = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      '70000000-0000-4000-8000-000000000006', 'credit', '${approvalId}'
    ) as result
  `);
  assert.equal(Number(delivered.rows[0].result.total_amount), 36);
  assert.equal(delivered.rows[0].result.payment_term, 'credit');
  assert.equal(delivered.rows[0].result.due_date, expectedDueDateStr);

  const consumed = await db.query(`
    select status, consumed_by_delivery_event_id
    from public.financial_approval_requests where id = '${approvalId}'
  `);
  assert.deepEqual(consumed.rows[0], {
    status: 'consumed',
    consumed_by_delivery_event_id: delivered.rows[0].result.delivery_event_id,
  });

  const retry = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      '70000000-0000-4000-8000-000000000006', 'credit', '${approvalId}'
    ) as result
  `);
  assert.equal(retry.rows[0].result.delivery_event_id, delivered.rows[0].result.delivery_event_id);
});

test('credit-limit approval expires after its business day', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.delivery_rounds
    set service_date = (now() at time zone 'Asia/Bangkok')::date - 1
    where id = '${ROUND_ID}';
    update public.shop_payment_profiles
    set allowed_payment_terms = array['credit']::public.payment_term[],
        default_payment_term = 'credit',
        allow_outstanding = true,
        credit_due_rule = 'net_days',
        credit_days = 30,
        credit_limit = 20
    where shop_id = '${SHOP_ID}';
    insert into public.test_opening_balances (
      service_date, location_id, ice_type_id, quantity
    ) values (
      (now() at time zone 'Asia/Bangkok')::date - 1,
      '${HOLDING_ID}', '${ICE_ID}', 10
    ) on conflict (service_date, location_id, ice_type_id) do update
      set quantity = excluded.quantity;
    insert into public.stock_movements (
      id, service_date, kind, to_location_id, idempotency_key, recorded_by
    ) values (
      '65000000-0000-4000-8000-000000000020',
      (now() at time zone 'Asia/Bangkok')::date - 1,
      'factory_order', '${TRUCK_ID}',
      '65000000-0000-4000-8000-000000000021', '${ADMIN_ID}'
    );
    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    values ('65000000-0000-4000-8000-000000000020', '${ICE_ID}', 10);
  `);
  const fingerprint = await db.query(`
    select public.delivery_request_fingerprint(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, 'credit'
    ) as value
  `);
  const approval = await db.query(`
    insert into public.financial_approval_requests (
      shop_id, round_stop_id, kind, requested_amount, reason,
      request_fingerprint, status, requested_by, decided_by, decided_at
    ) values (
      '${SHOP_ID}', '${STOP_ID}', 'credit_limit', 36, 'expired credit test',
      '${fingerprint.rows[0].value}', 'approved', '${COURIER_ID}', '${ADMIN_ID}', now()
    ) returning id
  `);

  await assert.rejects(
    db.query(`
      select public.record_delivery(
        '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
        '70000000-0000-4000-8000-000000000010', 'credit', '${approval.rows[0].id}'
      )
    `),
    /approval has expired/i,
  );
});

test('active payment allocations block financial cancellation', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '70000000-0000-4000-8000-000000000007', 'immediate'
    ) as result
  `);
  await db.exec(`
    begin;
    with payment as (
      insert into public.payments (
        shop_id, payment_method, received_amount, allocated_amount,
        idempotency_key, request_fingerprint, recorded_by
      ) values (
        '${SHOP_ID}', 'cash', 18, 18,
        '90000000-0000-4000-8000-000000000001', 'payment', '${COURIER_ID}'
      ) returning id
    )
    insert into public.payment_allocations (payment_id, charge_id, amount)
    select payment.id, '${delivery.rows[0].result.charge_id}', 18 from payment;
    commit;
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);

  await assert.rejects(
    db.query(`
      select public.revise_delivery_event(
        '${delivery.rows[0].result.delivery_event_id}', 'cancel', '[]'::jsonb,
        'delivered', null, 'cannot cancel paid',
        '80000000-0000-4000-8000-000000000004'
      )
    `),
    /void active payment allocations/i,
  );
  const state = await db.query(`
    select event.status, charge.status as charge_status
    from public.delivery_events event
    join public.delivery_charges charge on charge.delivery_event_id = event.id
    where event.id = '${delivery.rows[0].result.delivery_event_id}'
  `);
  assert.deepEqual(state.rows[0], { status: 'active', charge_status: 'active' });
});

test('correcting a priced delivery to an issue voids the charge without replacing it', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      '70000000-0000-4000-8000-000000000009', 'immediate'
    ) as result
  `);
  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin'
  `);
  await db.query(`
    select public.revise_delivery_event(
      '${delivery.rows[0].result.delivery_event_id}', 'correct', '[]'::jsonb,
      'issue', 'บันทึกผิด ร้านปิด', 'แก้สถานะ',
      '80000000-0000-4000-8000-000000000005'
    )
  `);
  const state = await db.query(`
    select
      original.status as original_status,
      original_charge.status as original_charge_status,
      replacement.id as replacement_id,
      replacement.status as replacement_status,
      (select count(*)::integer from public.delivery_charges charge
       where charge.delivery_event_id = replacement.id) as replacement_charges,
      stop.status as stop_status,
      stop.note
    from public.delivery_events original
    join public.delivery_events replacement on replacement.corrects_event_id = original.id
    join public.delivery_charges original_charge on original_charge.delivery_event_id = original.id
    join public.round_stops stop on stop.id = replacement.round_stop_id
    where original.id = '${delivery.rows[0].result.delivery_event_id}'
  `);
  const { replacement_id: issueEventId, ...issueState } = state.rows[0];
  assert.deepEqual(issueState, {
    original_status: 'cancelled',
    original_charge_status: 'voided',
    replacement_status: 'active',
    replacement_charges: 0,
    stop_status: 'issue',
    note: 'บันทึกผิด ร้านปิด',
  });

  await db.query(`
    select public.revise_delivery_event(
      '${issueEventId}', 'correct', '${itemPayload(1)}'::jsonb,
      'delivered', null, 'แก้กลับเป็นส่งแล้ว',
      '80000000-0000-4000-8000-000000000006'
    )
  `);
  const restored = await db.query(`
    select item.unit_price, charge.original_amount, charge.payment_term,
      charge.status as charge_status
    from public.delivery_events issue
    join public.delivery_events replacement on replacement.corrects_event_id = issue.id
    join public.delivery_items item on item.delivery_event_id = replacement.id
    join public.delivery_charges charge on charge.delivery_event_id = replacement.id
    where issue.id = '${issueEventId}'
  `);
  assert.deepEqual(restored.rows[0], {
    unit_price: '18.00',
    original_amount: '18.00',
    payment_term: 'immediate',
    charge_status: 'active',
  });
});

test('revision retries created before fingerprinting remain idempotent', async (t) => {
  const db = await createDatabase(t);
  const legacyEvent = await db.query(`
    insert into public.delivery_events (
      round_stop_id, recorded_by, idempotency_key, source_stock_location_id,
      status, cancelled_by, cancelled_at, cancellation_reason
    ) values (
      '${STOP_ID}', '${ADMIN_ID}', '70000000-0000-4000-8000-000000000011',
      '${SHOP_SOURCE_ID}', 'cancelled', '${ADMIN_ID}', now(), 'legacy cancellation'
    ) returning id
  `);
  await db.exec(`
    insert into public.delivery_event_revisions (
      idempotency_key, original_event_id, action, reason, revised_by,
      request_fingerprint
    ) values (
      '80000000-0000-4000-8000-000000000007', '${legacyEvent.rows[0].id}',
      'cancel', 'legacy cancellation', '${ADMIN_ID}', null
    );
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);

  const retry = await db.query(`
    select public.revise_delivery_event(
      '${legacyEvent.rows[0].id}', 'cancel', '[]'::jsonb,
      'delivered', null, 'legacy cancellation',
      '80000000-0000-4000-8000-000000000007'
    ) as result
  `);
  assert.equal(retry.rows[0].result.round_id, ROUND_ID);
});

test('payment recording enforces actor scope, collection scope, and stored evidence', async (t) => {
  const db = await createDatabase(t);
  const delivered = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '90000000-0000-4000-8000-000000000001', 'immediate'
    ) as result
  `);
  const chargeId = delivered.rows[0].result.charge_id;

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);
  const run = await db.query(`
    select public.open_collection_run(
      date '${SERVICE_DATE}',
      '[{"user_id":"${OTHER_COURIER_ID}"}]'::jsonb
    ) as result
  `);
  await db.exec(`
    update public.auth_context
    set user_id = '${OTHER_COURIER_ID}', app_role = 'courier';
  `);

  await assert.rejects(
    db.query(`
      select public.record_payment(
        '${SHOP_ID}', '[{"charge_id":"${chargeId}","amount":18}]'::jsonb,
        'cash', 18, null, null, null, 18, null,
        '90000000-0000-4000-8000-000000000002'
      )
    `),
    /assigned scope/i,
  );
  const queue = await db.query(`
    select public.get_today_collection_run_queue('${run.rows[0].result.collection_run_id}') as result
  `);
  assert.equal(queue.rows[0].result[0].charges[0].charge_id, chargeId);
  assert.match(queue.rows[0].result[0].charges[0].charge_number, /^C\d{6}-\d{6}$/);
  assert.equal(Object.hasOwn(queue.rows[0].result[0], 'image_path'), true);

  await db.exec(`
    update public.auth_context
    set user_id = '${COURIER_ID}', app_role = 'courier';
    update public.shop_payment_profiles
    set allowed_payment_terms = array['immediate', 'end_of_day']::public.payment_term[]
    where shop_id = '${SHOP_ID}';
  `);
  const endOfDayDelivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '90000000-0000-4000-8000-000000000007', 'end_of_day'
    ) as result
  `);
  await assert.rejects(
    db.query(`
      select public.record_payment(
        '${SHOP_ID}',
        '[{"charge_id":"${endOfDayDelivery.rows[0].result.charge_id}","amount":18}]'::jsonb,
        'cash', 18, null, null, null, 18, null,
        '90000000-0000-4000-8000-000000000008'
      )
    `),
    /assigned scope/i,
  );

  await db.exec(`
    update public.shop_payment_profiles
    set cash_evidence_required = true
    where shop_id = '${SHOP_ID}';
  `);
  const evidencePath = `${COURIER_ID}/payment.webp`;
  await assert.rejects(
    db.query(`
      select public.record_payment(
        '${SHOP_ID}', '[{"charge_id":"${chargeId}","amount":18}]'::jsonb,
        'cash', 18, null, '${evidencePath}', null, 18, null,
        '90000000-0000-4000-8000-000000000004'
      )
    `),
    /evidence does not exist/i,
  );

  await db.exec(`
    insert into storage.objects (bucket_id, name)
    values ('payment-evidence', '${evidencePath}');
  `);
  const payment = await db.query(`
    select public.record_payment(
      '${SHOP_ID}', '[{"charge_id":"${chargeId}","amount":18}]'::jsonb,
      'cash', 18, null, '${evidencePath}', null, 18, null,
      '90000000-0000-4000-8000-000000000004'
    ) as result
  `);
  assert.equal(Number(payment.rows[0].result.allocated_amount), 18);
});

test('couriers collect prior balances together with new charges from today', async (t) => {
  const db = await createDatabase(t);
  const priorDelivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '90000000-0000-4000-8000-000000000010', 'immediate'
    ) as result
  `);
  const priorChargeId = priorDelivery.rows[0].result.charge_id;

  await db.exec(`
    update public.delivery_charges set service_date = date '${PREVIOUS_SERVICE_DATE_TEXT}'
    where id = '${priorChargeId}';
    update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);
  const run = await db.query(`
    select public.open_collection_run(
      date '${SERVICE_DATE}', '[{"user_id":"${OTHER_COURIER_ID}"}]'::jsonb
    ) as result
  `);
  const todayDelivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '90000000-0000-4000-8000-000000000013', 'immediate'
    ) as result
  `);
  const todayChargeId = todayDelivery.rows[0].result.charge_id;
  await db.exec(`
    update public.shop_payment_profiles
    set allow_outstanding = true
    where shop_id = '${SHOP_ID}';
    update public.auth_context set user_id = '${COURIER_ID}', app_role = 'courier';
  `);

  await assert.rejects(
    db.query(`
      select public.get_collection_run_queue(
        '${run.rows[0].result.collection_run_id}'
      )
    `),
    /not assigned to this user/i,
  );
  await db.exec(`
    update public.auth_context set user_id = '${OTHER_COURIER_ID}', app_role = 'courier';
  `);

  const canonicalQueue = await db.query(`
    select public.get_collection_run_queue(
      '${run.rows[0].result.collection_run_id}'
    ) as result
  `);
  const compatibilityQueue = await db.query(`
    select public.get_today_collection_run_queue(
      '${run.rows[0].result.collection_run_id}'
    ) as result
  `);
  assert.deepEqual(compatibilityQueue.rows[0].result, canonicalQueue.rows[0].result);

  const queueShop = canonicalQueue.rows[0].result[0];
  assert.equal(Number(queueShop.outstanding_amount), 36);
  assert.equal(queueShop.charge_count, 2);
  assert.deepEqual(
    queueShop.charges.map((charge) => charge.service_date),
    [PREVIOUS_SERVICE_DATE_TEXT, SERVICE_DATE],
  );
  assert.deepEqual(
    queueShop.charges.map((charge) => charge.charge_id),
    [priorChargeId, todayChargeId],
  );

  const partialPayment = await db.query(`
    select public.record_payment(
      '${SHOP_ID}', '[{"charge_id":"${priorChargeId}","amount":10}]'::jsonb,
      'cash', 10, null, null, '${run.rows[0].result.collection_run_id}', 36, null,
      '90000000-0000-4000-8000-000000000011'
    ) as result
  `);
  assert.equal(Number(partialPayment.rows[0].result.allocated_amount), 10);

  const remainingQueue = await db.query(`
    select public.get_collection_run_queue(
      '${run.rows[0].result.collection_run_id}'
    ) as result
  `);
  assert.equal(Number(remainingQueue.rows[0].result[0].outstanding_amount), 26);
  assert.deepEqual(
    remainingQueue.rows[0].result[0].charges.map((charge) => Number(charge.outstanding_amount)),
    [8, 18],
  );

  const finalPayment = await db.query(`
    select public.record_payment(
      '${SHOP_ID}', '[
        {"charge_id":"${priorChargeId}","amount":8},
        {"charge_id":"${todayChargeId}","amount":18}
      ]'::jsonb,
      'cash', 26, null, null, '${run.rows[0].result.collection_run_id}', 26, null,
      '90000000-0000-4000-8000-000000000012'
    ) as result
  `);
  assert.equal(Number(finalPayment.rows[0].result.allocated_amount), 26);
});

test('daily aggregate completion patches the pre-recovery payment contract', async (t) => {
  const db = await createDatabase(t);
  await db.exec(legacyRecordPayment);
  await db.exec(dailyAggregateCompletion);

  const definition = await db.query(`
    select pg_get_functiondef(
      'public.record_payment(uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid)'::regprocedure
    ) as value
  `);
  assert.match(definition.rows[0].value, /charge\.payment_term not in \('immediate', 'end_of_day'\)/i);
  assert.match(definition.rows[0].value, /charge\.service_date is distinct from v_collection_service_date/i);
});

test('an approved outstanding exception is consumed by one partial payment', async (t) => {
  const db = await createDatabase(t);
  const delivered = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      '90000000-0000-4000-8000-000000000005', 'immediate'
    ) as result
  `);
  const chargeId = delivered.rows[0].result.charge_id;
  const approval = await db.query(`
    select public.request_financial_approval(
      '${STOP_ID}', 'outstanding_balance', '[]'::jsonb, 'immediate',
      16, 'ลูกค้าจ่ายบางส่วน', '${chargeId}'
    ) as result
  `);
  assert.equal(approval.rows[0].result.status, 'pending');

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);
  await db.query(`
    select public.decide_financial_approval(
      '${approval.rows[0].result.id}', 'approved', null
    )
  `);
  await db.exec(`
    update public.auth_context
    set user_id = '${COURIER_ID}', app_role = 'courier';
  `);

  const payment = await db.query(`
    select public.record_payment(
      '${SHOP_ID}', '[{"charge_id":"${chargeId}","amount":20}]'::jsonb,
      'cash', 20, null, null, null, 36, '${approval.rows[0].result.id}',
      '90000000-0000-4000-8000-000000000006'
    ) as result
  `);
  assert.equal(Number(payment.rows[0].result.allocated_amount), 20);

  const consumed = await db.query(`
    select approval.status, approval.consumed_by_payment_id,
      payment.approval_request_id
    from public.financial_approval_requests approval
    join public.payments payment on payment.id = approval.consumed_by_payment_id
    where approval.id = '${approval.rows[0].result.id}'
  `);
  assert.deepEqual(consumed.rows[0], {
    status: 'consumed',
    consumed_by_payment_id: payment.rows[0].result.payment_id,
    approval_request_id: approval.rows[0].result.id,
  });

  const retry = await db.query(`
    select public.record_payment(
      '${SHOP_ID}', '[{"charge_id":"${chargeId}","amount":20}]'::jsonb,
      'cash', 20, null, null, null, 36, '${approval.rows[0].result.id}',
      '90000000-0000-4000-8000-000000000006'
    ) as result
  `);
  assert.equal(retry.rows[0].result.payment_id, payment.rows[0].result.payment_id);
});
