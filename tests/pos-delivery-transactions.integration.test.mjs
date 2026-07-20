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

const COURIER_ID = '10000000-0000-4000-8000-000000000001';
const ADMIN_ID = '10000000-0000-4000-8000-000000000002';
const ROUND_ID = '20000000-0000-4000-8000-000000000001';
const SHOP_ID = '30000000-0000-4000-8000-000000000001';
const STOP_ID = '40000000-0000-4000-8000-000000000001';
const ICE_ID = '50000000-0000-4000-8000-000000000001';
const HOLDING_ID = '60000000-0000-4000-8000-000000000001';
const SHOP_SOURCE_ID = '60000000-0000-4000-8000-000000000002';
const SERVICE_DATE = '2026-07-20';

async function createDatabase(t) {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto } });
  t.after(() => db.close());

  await db.exec(`
    create extension if not exists pgcrypto;
    create role authenticated;
    create schema auth;

    create type public.app_role as enum ('courier', 'round_lead', 'admin');
    create type public.delivery_round_status as enum ('open', 'closed');
    create type public.shop_round_status as enum (
      'pending', 'delivered', 'full_bin', 'closed_shop', 'no_access', 'issue'
    );
    create type public.delivery_event_status as enum ('active', 'cancelled');
    create type public.stock_location_kind as enum (
      'truck', 'team', 'small_vehicle', 'work_site', 'reserve_bin', 'front_vehicle'
    );

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
      role public.app_role not null,
      is_active boolean not null default true,
      display_name text not null
    );
    create table public.delivery_rounds (
      id uuid primary key,
      service_date date not null,
      status public.delivery_round_status not null
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

    insert into public.users (id, role, display_name) values
      ('${COURIER_ID}', 'courier', 'Courier'),
      ('${ADMIN_ID}', 'admin', 'Admin');
    insert into public.delivery_rounds (id, service_date, status)
    values ('${ROUND_ID}', date '${SERVICE_DATE}', 'open');
    insert into public.delivery_round_members (round_id, user_id)
    values ('${ROUND_ID}', '${COURIER_ID}');
    insert into public.stock_locations (id, code, name, kind, assigned_user_id) values
      ('${HOLDING_ID}', 'TEAM-1', 'Courier stock', 'team', '${COURIER_ID}'),
      ('${SHOP_SOURCE_ID}', 'SITE-1', 'Shop stock', 'work_site', null);
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
      (date '${SERVICE_DATE}', '${SHOP_SOURCE_ID}', '${ICE_ID}', 50);
  `);

  await db.exec(foundation);
  await db.exec(transactions);
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

test('POS context and delivery use override price, assigned stock, and idempotent charge', async (t) => {
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
  assert.equal(context.rows[0].result.stock_source.id, HOLDING_ID);
  assert.equal(Number(context.rows[0].result.items[0].unit_price), 18);
  assert.equal(context.rows[0].result.items[0].price_source, 'shop_override');
  assert.equal(context.rows[0].result.items[0].stock_quantity, 10);

  const key = '70000000-0000-4000-8000-000000000001';
  const first = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null, '${key}', 'immediate'
    ) as result
  `);
  assert.equal(Number(first.rows[0].result.total_amount), 36);
  assert.equal(first.rows[0].result.payment_status, 'unpaid');
  assert.equal(first.rows[0].result.source_stock_location_id, HOLDING_ID);

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
  const managerContext = await db.query(`
    select public.get_delivery_pos_context('${STOP_ID}') as result
  `);
  assert.equal(managerContext.rows[0].result.stock_source.id, SHOP_SOURCE_ID);
  assert.equal(managerContext.rows[0].result.items[0].stock_quantity, 50);
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
    ) values ('${SHOP_ID}', '${ICE_ID}', 30, date '2026-07-21', '${ADMIN_ID}');
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

test('credit-limit approval must match and is consumed by exactly one delivery', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.shop_payment_profiles
    set allowed_payment_terms = array['credit']::public.payment_term[],
        default_payment_term = 'credit',
        allow_outstanding = true,
        credit_due_rule = 'net_days',
        credit_days = 30,
        credit_limit = 20
    where shop_id = '${SHOP_ID}';
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
  assert.equal(delivered.rows[0].result.due_date, '2026-08-19');

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
    );
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
