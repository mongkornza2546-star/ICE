import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const foundation = readFileSync(
  new URL('../supabase/migrations/0153_casual_transaction_foundation.sql', import.meta.url),
  'utf8',
);
const production = readFileSync(
  new URL('../supabase/migrations/0154_casual_measured_transactions.sql', import.meta.url),
  'utf8',
);
const looseTransactions = readFileSync(
  new URL('../supabase/migrations/0155_casual_loose_transactions.sql', import.meta.url),
  'utf8',
);
const aggregateStock = readFileSync(
  new URL('../supabase/migrations/0107_daily_aggregate_stock.sql', import.meta.url),
  'utf8',
);

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const ICE_ID = '20000000-0000-4000-8000-000000000001';
const ROUND_ID = '30000000-0000-4000-8000-000000000001';
const HOLDING_ID = '40000000-0000-4000-8000-000000000001';
const TRUCK_ID = '40000000-0000-4000-8000-000000000002';
const MOVEMENT_ID = '50000000-0000-4000-8000-000000000001';
const SERVICE_DATE = '2026-08-20';

async function createDatabase(t, role = 'courier') {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create schema storage;
    create type public.app_role as enum ('courier', 'round_lead', 'admin');
    create type public.delivery_round_status as enum ('open', 'closed');
    create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');
    create type public.financial_record_status as enum ('active', 'voided');
    create type public.stock_location_kind as enum ('truck', 'team', 'small_vehicle', 'work_site', 'reserve_bin', 'front_vehicle');
    create type public.stock_movement_kind as enum ('factory_order', 'transfer', 'damage', 'return_to_factory');
    create type public.stock_movement_status as enum ('active', 'cancelled');

    create function auth.uid() returns uuid language sql stable as $$ select '${USER_ID}'::uuid $$;
    create function public.current_app_role() returns public.app_role language sql stable as $$ select '${role}'::public.app_role $$;
    create function public.is_active_user() returns boolean language sql stable as $$ select true $$;
    create function public.is_round_member(target_round_id uuid) returns boolean language sql stable as $$ select true $$;
    create function public.next_sales_document_number(text, date) returns text language sql as $$ select 'REC2608-00001' $$;

    create table public.users (id uuid primary key, display_name text);
    create table public.delivery_rounds (
      id uuid primary key, service_date date not null, name text not null,
      status public.delivery_round_status not null, cancelled_at timestamptz
    );
    create table public.stock_locations (
      id uuid primary key, code text not null, name text not null,
      kind public.stock_location_kind not null, is_active boolean not null default true,
      assigned_user_id uuid, is_courier_source boolean not null default false
    );
    create table public.ice_types (
      id uuid primary key, code text not null, name text not null, unit text not null,
      is_active boolean not null default true
    );
    create table public.stock_movements (
      id uuid primary key, service_date date not null, status public.stock_movement_status not null,
      kind public.stock_movement_kind not null, from_location_id uuid, to_location_id uuid
    );
    create table public.stock_movement_items (movement_id uuid, ice_type_id uuid, quantity numeric(12,1));
    create table public.factory_receipts (id uuid primary key, factory_order_id uuid, service_date date, truck_location_id uuid);
    create table public.factory_receipt_items (factory_receipt_id uuid, ice_type_id uuid, actual_quantity numeric(12,1));
    create table public.delivery_events (id uuid primary key, round_stop_id uuid, source_stock_location_id uuid, status text);
    create table public.delivery_items (delivery_event_id uuid, ice_type_id uuid, quantity numeric(12,1));
    create table public.round_stops (id uuid primary key, round_id uuid);
    create table public.delivery_charges (id uuid primary key, delivery_event_id uuid, service_date date);
    create table public.delivery_charge_adjustments (id uuid primary key, charge_id uuid, idempotency_key uuid, status text, scope text);
    create table public.delivery_adjustment_items (adjustment_id uuid, ice_type_id uuid, quantity_delta numeric(12,1));
    create table public.daily_stock_closures (service_date date primary key, status text);
    create table public.daily_stock_closure_items (service_date date, location_id uuid, ice_type_id uuid, variance_quantity numeric(12,1));
    create table public.daily_aggregate_stock_closures (service_date date primary key, status text);
    create table public.daily_stock_uses (
      id uuid primary key default gen_random_uuid(), service_date date not null,
      kind text not null check (kind = 'refill'), status text not null default 'active',
      note text, idempotency_key uuid not null unique, request_fingerprint text not null,
      recorded_by uuid not null references public.users(id), recorded_at timestamptz not null default now(),
      cancelled_by uuid, cancelled_at timestamptz, cancellation_reason text
    );
    create table public.daily_stock_use_items (use_id uuid, ice_type_id uuid, quantity numeric(12,1));
    create table public.audit_logs (
      id uuid primary key default gen_random_uuid(), actor_id uuid, entity_type text,
      entity_id uuid, action text, before_value jsonb, after_value jsonb,
      reason text, occurred_at timestamptz default now()
    );
    create table public.payments (id uuid primary key default gen_random_uuid(), idempotency_key uuid, evidence_path text);
    create table storage.objects (bucket_id text, name text);

    create function public.accounting_transaction_rows(
      p_from_date date, p_to_date date
    ) returns table (
      occurred_at timestamptz, service_date date, type text, group_id uuid,
      source_id uuid, source_table text, delivery_event_id uuid, payment_id uuid,
      document_number text, reference_number text, shop_id uuid, shop_code text,
      shop_name text, holder_name text, employee_id uuid, employee_name text,
      ice_type_id uuid, ice_type_name text, unit text, quantity_in numeric,
      quantity_out numeric, sales_amount numeric, cash_in numeric, cash_out numeric,
      receivable_delta numeric, status text, note text, issue_code text,
      issue_label text, can_correct boolean, details jsonb
    ) language sql stable as $$
      select null::timestamptz, null::date, null::text, null::uuid, null::uuid,
        null::text, null::uuid, null::uuid, null::text, null::text, null::uuid,
        null::text, null::text, null::text, null::uuid, null::text, null::uuid,
        null::text, null::text, null::numeric, null::numeric, null::numeric,
        null::numeric, null::numeric, null::numeric, null::text, null::text,
        null::text, null::text, null::boolean, null::jsonb
      where false
    $$;

    create function public.get_accounting_transactions(
      p_from_date date, p_to_date date, p_filters jsonb default '{}'::jsonb,
      p_sort jsonb default '{"key":"occurred_at","direction":"desc"}'::jsonb,
      p_limit integer default 100, p_offset integer default 0
    ) returns jsonb language plpgsql stable as $$
    begin
      return (
        with base as materialized (
          select row.* from public.accounting_transaction_rows(p_from_date, p_to_date) row
        ) select jsonb_build_object(
          'rows', coalesce((select jsonb_agg(to_jsonb(row)) from base row), '[]'::jsonb),
          'total_count', (select count(*) from base)
        )
      );
    end;
    $$;

    create function public.accounting_aggregate_reconciliation_rows(p_service_date date)
    returns table (
      id uuid, code text, name text, unit text, factory_in numeric, sold numeric,
      damaged numeric, returned_to_factory numeric, expected numeric, actual numeric,
      variance numeric, count_status text
    ) language sql stable as $$
      with source_latest as (
        select greatest(
          coalesce((select max(greatest(usage.recorded_at,
              coalesce(usage.cancelled_at, usage.recorded_at)))
            from public.daily_stock_uses usage
            where usage.service_date = p_service_date), '-infinity')
        ) as recorded_at
      ), ice as (
        select ice_type.id, ice_type.code, ice_type.name, ice_type.unit
        from public.ice_types ice_type
      ), aggregate_values as (
        select ice.*,
          (coalesce((select sum(item.quantity_delta)
            from public.delivery_charge_adjustments adjustment
            join public.delivery_adjustment_items item
              on item.adjustment_id = adjustment.idempotency_key
            where adjustment.status = 'active'
              and item.ice_type_id = ice.id), 0))::numeric as sold,
          0::numeric as factory_in
        from ice
      )
      select value.id, value.code, value.name, value.unit, value.factory_in, value.sold,
        0::numeric, 0::numeric, value.factory_in - value.sold,
        null::numeric, null::numeric, 'incomplete'::text
      from aggregate_values value cross join source_latest;
    $$;

    create function public.get_accounting_reconciliation(p_service_date date)
    returns jsonb language sql stable as $$
      select jsonb_build_object(
        'service_date', p_service_date,
        'aggregate', coalesce((select jsonb_agg(jsonb_build_object(
          'ice_type_id', row.id,
          'sold', row.sold,
          'expected', row.expected
        )) from public.accounting_aggregate_reconciliation_rows(p_service_date) row), '[]'::jsonb),
        'holders', '[]'::jsonb,
        'financial', jsonb_build_object(
          'effective_sales', 0, 'allocated_to_sales', 0,
          'outstanding_collectible', 0, 'outstanding_credit', 0,
          'cash_received', 0, 'cash_refunded', 0, 'net_cash', 0, 'pending_refunds', 0
        )
      );
    $$;

    create function public.get_accounting_shop_summary(
      p_from_date date, p_to_date date, p_filters jsonb default '{}'::jsonb,
      p_limit integer default 100, p_offset integer default 0
    ) returns jsonb language sql stable as $$
      select jsonb_build_object(
        'rows', '[]'::jsonb, 'groups', '[]'::jsonb, 'total_count', 0,
        'totals', jsonb_build_object(
          'sales_amount', 0, 'paid_amount', 0, 'outstanding_amount', 0,
          'overdue_amount', 0, 'outstanding_shop_count', 0,
          'cumulative_outstanding_amount', 0, 'cumulative_overdue_amount', 0,
          'cumulative_outstanding_shop_count', 0, 'cash_received_in_period', 0
        ),
        'facets', jsonb_build_object('shops', '[]'::jsonb, 'buildings', '[]'::jsonb, 'zones', '[]'::jsonb)
      );
    $$;

    insert into public.users values ('${USER_ID}', 'พนักงาน');
    insert into public.delivery_rounds values ('${ROUND_ID}', '${SERVICE_DATE}', 'งานประจำวัน', 'open', null);
    insert into public.stock_locations values
      ('${HOLDING_ID}', 'HOLD-1', 'จุดถือครอง', 'team', true, '${USER_ID}', false),
      ('${TRUCK_ID}', 'TRUCK-1', 'รถหลัก', 'truck', true, null, true);
    insert into public.ice_types values ('${ICE_ID}', 'ICE', 'น้ำแข็ง', 'ถุง', true);
    insert into public.stock_movements values ('${MOVEMENT_ID}', '${SERVICE_DATE}', 'active', 'factory_order', null, '${HOLDING_ID}');
    insert into public.stock_movement_items values ('${MOVEMENT_ID}', '${ICE_ID}', 5);
  `);
  await db.exec(foundation);
  await db.exec(production);
  await db.exec(looseTransactions);
  return db;
}

async function createConvertedDatabase(t, beforeConversion) {
  const db = await createDatabase(t);
  await db.exec(`create table public.ice_type_prices (ice_type_id uuid, unit_price numeric, valid_from date, valid_to date, is_active boolean);
    insert into public.ice_type_prices values ('${ICE_ID}', 100, '2026-01-01', null, true);
    create table public.daily_aggregate_stock_closure_items (
      service_date date, ice_type_id uuid, system_quantity numeric,
      actual_quantity numeric, variance_quantity numeric, note text
    );
    create sequence casual_receipt_test_seq;
    create or replace function public.next_sales_document_number(text, date) returns text language sql as $$ select 'REC-' || nextval('casual_receipt_test_seq') $$;`);
  await db.exec(aggregateStock.slice(
    aggregateStock.indexOf('create or replace function public.get_daily_aggregate_stock_summary('),
    aggregateStock.indexOf('create or replace function public.record_daily_stock_refill('),
  ));
  if (beforeConversion) await beforeConversion(db);
  await db.exec(readFileSync(new URL('../supabase/migrations/0179_casual_loose_stock_conversion.sql', import.meta.url), 'utf8'));
  return db;
}

async function recordLoose(db, amount, index, roundId = ROUND_ID, iceId = ICE_ID) {
  const result = await db.query(`select public.record_casual_loose_transaction(
    '${roundId}', '${iceId}', 'paid', ${amount}, 'cash', ${amount},
    null, null, null, now(), '60000000-0000-4000-8000-${String(index).padStart(12, '0')}') as result`);
  return result.rows[0].result.transaction.id;
}

test('daily close explains casual stock deductions and preserves the count through void and close', async (t) => {
  const db = await createConvertedDatabase(t);
  const readItem = async () => (await db.query(`
    select public.get_daily_aggregate_stock_summary('${SERVICE_DATE}') as result
  `)).rows[0].result.items[0];

  await recordLoose(db, 60, 601);
  const id = await recordLoose(db, 50, 602);
  let item = await readItem();
  assert.equal(item.ordered_quantity, 5);
  assert.equal(item.available_quantity, 4);
  assert.equal(item.sold_quantity, 1);

  await db.query(`select public.void_casual_transaction('${id}', 'คืนเงินแล้ว', 'cash', null, null,
    '70000000-0000-4000-8000-000000000602')`);
  item = await readItem();
  assert.equal(item.available_quantity, 5);
  assert.equal(item.sold_quantity, 0);

  await recordLoose(db, 50, 603);
  await db.query(`select public.record_casual_transaction('${ROUND_ID}', '${ICE_ID}', 0.5, 'free', 0, null, null,
    null, null, null, now(), '60000000-0000-4000-8000-000000000604')`);
  item = await readItem();
  assert.equal(item.available_quantity, 3.5);
  assert.equal(item.sold_quantity, 1.5);

  await db.exec(`
    insert into public.round_stops values ('90000000-0000-4000-8000-000000000601', '${ROUND_ID}');
    insert into public.delivery_events values ('90000000-0000-4000-8000-000000000602',
      '90000000-0000-4000-8000-000000000601', '${HOLDING_ID}', 'active');
    insert into public.delivery_items values ('90000000-0000-4000-8000-000000000602', '${ICE_ID}', 1);
  `);
  item = await readItem();
  assert.equal(item.available_quantity, 2.5);
  assert.equal(item.sold_quantity, 2.5);

  await db.exec(`
    alter table public.daily_aggregate_stock_closures
      add column idempotency_key uuid, add column note text, add column closed_by uuid, add column closed_at timestamptz;
    alter table public.delivery_rounds add column closed_by uuid, add column closed_at timestamptz;
    create or replace function public.current_app_role() returns public.app_role language sql stable as $$ select 'round_lead'::public.app_role $$;
  `);
  await db.exec(aggregateStock.slice(
    aggregateStock.indexOf('create or replace function public.close_daily_aggregate_stock('),
    aggregateStock.indexOf('-- Keep pricing, charges,'),
  ));
  const closed = (await db.query(`select public.close_daily_aggregate_stock('${SERVICE_DATE}',
    '[{"ice_type_id":"${ICE_ID}","actual_quantity":2.5}]'::jsonb, null,
    '80000000-0000-4000-8000-000000000601') as result`)).rows[0].result;
  assert.equal(closed.status, 'closed');
  assert.equal(closed.items[0].sold_quantity, 2.5);
  assert.equal(closed.items[0].available_quantity, 0);
  assert.equal(closed.items[0].actual_quantity, 2.5);
  assert.equal(closed.items[0].variance_quantity, 0);
  const count = (await db.query(`select system_quantity, actual_quantity, variance_quantity
    from public.daily_aggregate_stock_closure_items`)).rows[0];
  assert.equal(Number(count.system_quantity), 2.5);
  assert.equal(Number(count.actual_quantity), 2.5);
  assert.equal(Number(count.variance_quantity), 0);
  assert.deepEqual((await db.query(`select
    has_function_privilege('authenticated', 'public.get_daily_aggregate_stock_summary(date)', 'execute') as reader,
    has_function_privilege('anon', 'public.get_daily_aggregate_stock_summary(date)', 'execute') as anonymous,
    has_function_privilege('authenticated', 'public.get_daily_aggregate_stock_summary_without_casual(date)', 'execute') as backup
  `)).rows[0], { reader: true, anonymous: false, backup: false });
});

test('loose money crosses a whole-bag threshold once, replays safely, and restores stock on void', async (t) => {
  const db = await createConvertedDatabase(t);
  await recordLoose(db, 60, 101);
  const id = await recordLoose(db, 50, 102);
  await recordLoose(db, 50, 102);
  let balance = await db.query(`select public.stock_balance_at('${SERVICE_DATE}', '${HOLDING_ID}', '${ICE_ID}') as holding,
    public.daily_aggregate_stock_balance_at('${SERVICE_DATE}', '${ICE_ID}') as aggregate`);
  assert.deepEqual(balance.rows[0], { holding: '4.0', aggregate: '4.0' });
  let totals = await db.query(`select * from public.casual_loose_stock_totals('${SERVICE_DATE}')`);
  assert.equal(totals.rows[0].quantity, '1');
  assert.equal(totals.rows[0].remainder_amount, '10');
  await db.exec(`update public.ice_type_prices set unit_price = 200`);
  await recordLoose(db, 90, 103);
  totals = await db.query(`select * from public.casual_loose_stock_totals('${SERVICE_DATE}')`);
  assert.equal(totals.rows[0].quantity, '2');
  assert.equal(totals.rows[0].unit_price, '100');
  await db.query(`select public.void_casual_transaction('${id}', 'คืนเงินแล้ว', 'cash', null, null, '70000000-0000-4000-8000-000000000102')`);
  balance = await db.query(`select public.stock_balance_at('${SERVICE_DATE}', '${HOLDING_ID}', '${ICE_ID}') as holding`);
  assert.equal(balance.rows[0].holding, '4.0');
  const reconciliation = await db.query(`select public.get_accounting_reconciliation('${SERVICE_DATE}') as result`);
  assert.equal(reconciliation.rows[0].result.aggregate[0].sold, 1);
  const ledger = await db.query(`select sum(quantity_out) as quantity from public.accounting_casual_transaction_rows('${SERVICE_DATE}', '${SERVICE_DATE}') where type = 'SALE'`);
  assert.equal(Number(ledger.rows[0].quantity), 1);
});

test('conversion rejects missing prices and overselling atomically; measured sales are not converted again', async (t) => {
  const db = await createConvertedDatabase(t);
  await db.exec('delete from public.ice_type_prices');
  await assert.rejects(recordLoose(db, 60, 201), /ราคากลาง/);
  await db.exec(`insert into public.ice_type_prices values ('${ICE_ID}', 100, '2026-01-01', null, true)`);
  await assert.rejects(recordLoose(db, 600, 202), /สต๊อกไม่พอ/);
  assert.equal((await db.query('select count(*)::int as count from public.casual_transactions')).rows[0].count, 0);
  await db.query(`select public.record_casual_transaction('${ROUND_ID}', '${ICE_ID}', 0.5, 'paid', 100, 'cash', 100,
    null, null, null, now(), '60000000-0000-4000-8000-000000000203')`);
  await recordLoose(db, 100, 204);
  assert.equal((await db.query(`select public.stock_balance_at('${SERVICE_DATE}', '${HOLDING_ID}', '${ICE_ID}') as amount`)).rows[0].amount, '3.5');
});

test('loose thresholds do not pool money across days, ice types or holding locations', async (t) => {
  const db = await createConvertedDatabase(t);
  const secondIce = '20000000-0000-4000-8000-000000000002';
  const secondRound = '30000000-0000-4000-8000-000000000002';
  const secondHolding = '40000000-0000-4000-8000-000000000003';
  await db.exec(`
    insert into public.ice_types values ('${secondIce}', 'ICE2', 'น้ำแข็งสอง', 'ถุง', true);
    insert into public.ice_type_prices values ('${secondIce}', 100, '2026-01-01', null, true);
    insert into public.stock_movement_items values ('${MOVEMENT_ID}', '${secondIce}', 5);
    insert into public.delivery_rounds values ('${secondRound}', '2026-08-21', 'วันถัดไป', 'open', null);
    insert into public.stock_movements values ('50000000-0000-4000-8000-000000000002', '2026-08-21', 'active', 'factory_order', null, '${HOLDING_ID}');
    insert into public.stock_movement_items values ('50000000-0000-4000-8000-000000000002', '${ICE_ID}', 5);
  `);
  await recordLoose(db, 60, 401);
  await recordLoose(db, 60, 402, ROUND_ID, secondIce);
  await recordLoose(db, 60, 403, secondRound);
  await db.exec(`update public.stock_locations set is_active = false where id = '${HOLDING_ID}';
    insert into public.stock_locations values ('${secondHolding}', 'HOLD2', 'จุดสอง', 'team', true, '${USER_ID}', false);
    insert into public.stock_movements values ('50000000-0000-4000-8000-000000000003', '${SERVICE_DATE}', 'active', 'transfer', '${HOLDING_ID}', '${secondHolding}');
    insert into public.stock_movement_items values ('50000000-0000-4000-8000-000000000003', '${ICE_ID}', 2);`);
  await recordLoose(db, 60, 404);
  assert.equal(Number((await db.query(`select sum(quantity) as quantity from public.casual_loose_stock_totals('${SERVICE_DATE}')`)).rows[0].quantity), 0);
  await recordLoose(db, 40, 405);
  assert.equal(Number((await db.query(`select public.stock_balance_at('${SERVICE_DATE}', '${secondHolding}', '${ICE_ID}') as quantity`)).rows[0].quantity), 1);
  assert.equal(Number((await db.query(`select quantity from public.casual_loose_stock_totals('2026-08-21')`)).rows[0].quantity), 0);
});

test('backfills open-day loose sales but leaves closed-day stock untouched', async (t) => {
  const closedRound = '30000000-0000-4000-8000-000000000009';
  const db = await createConvertedDatabase(t, async (legacy) => {
    await recordLoose(legacy, 120, 501);
    await legacy.exec(`insert into public.delivery_rounds values ('${closedRound}', '2026-08-19', 'วันเก่า', 'open', null)`);
    await recordLoose(legacy, 120, 502, closedRound);
    await legacy.exec(`insert into public.daily_aggregate_stock_closures values ('2026-08-19', 'closed')`);
  });
  assert.equal(Number((await db.query(`select quantity from public.casual_loose_stock_totals('${SERVICE_DATE}')`)).rows[0].quantity), 1);
  assert.deepEqual((await db.query(`select * from public.casual_loose_stock_totals('2026-08-19')`)).rows, []);
  assert.equal(Number((await db.query(`select public.daily_aggregate_stock_balance_at('2026-08-19', '${ICE_ID}') as quantity`)).rows[0].quantity), 0);
  await assert.rejects(db.exec('update public.casual_loose_stock_prices set unit_price = 200'), /immutable/);
});

test('casual daily matrix includes measured, converted, free and loose quantities without a shop', async (t) => {
  const db = await createConvertedDatabase(t);
  const paidId = await recordLoose(db, 110, 301);
  await db.query(`select public.record_casual_transaction('${ROUND_ID}', '${ICE_ID}', 0.5, 'free', 0, null, null,
    null, null, null, now(), '60000000-0000-4000-8000-000000000302')`);
  await db.exec(`
    create or replace function public.current_app_role() returns public.app_role language sql stable as $$ select 'admin'::public.app_role $$;
    create table public.shops (id uuid, status text);
    create table public.shop_payment_profiles (shop_id uuid, allowed_payment_terms text[], default_payment_term text, credit_due_rule text, credit_collection_weekday int, credit_days int);
    alter table public.round_stops add column shop_id uuid, add column status text;
    alter table public.delivery_charges add column shop_id uuid, add column status text;
    alter table public.payments add column shop_id uuid, add column status text, add column allocated_amount numeric, add column recorded_at timestamptz;
    create function public.effective_delivery_charge_amount(uuid) returns numeric language sql as $$ select 0::numeric $$;
  `);
  await db.exec(readFileSync(new URL('../supabase/migrations/0146_accounting_shop_daily_matrix.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/0180_accounting_casual_daily_matrix.sql', import.meta.url), 'utf8'));
  const result = (await db.query(`select public.get_accounting_shop_daily_matrix('${SERVICE_DATE}', '${SERVICE_DATE}', '{}'::uuid[]) as result`)).rows[0].result;
  assert.deepEqual(result.rows, []);
  assert.equal(result.casual_days[0].sales_amount, 110);
  assert.equal(result.casual_days[0].items[0].quantity, 1.5);
  assert.equal(result.casual_days[0].items[0].automatic_quantity, 1);
  assert.equal(result.casual_days[0].items[0].free_quantity, 0.5);
  assert.equal(result.casual_days[0].items[0].remainder_amount, 10);
  const receiptDate = (await db.query(`select (recorded_at at time zone 'Asia/Bangkok')::date::text as value from public.casual_transactions where id = '${paidId}'`)).rows[0].value;
  await db.query(`select public.void_casual_transaction('${paidId}', 'คืนเงินแล้ว', 'cash', null, null, '70000000-0000-4000-8000-000000000301')`);
  const receiptDay = (await db.query(`select public.get_accounting_shop_daily_matrix('${receiptDate}', '${receiptDate}', '{}'::uuid[]) as result`)).rows[0].result.casual_days[0];
  assert.equal(receiptDay.cash_received, 110);
  assert.equal(receiptDay.cash_refunded, 110);
  await assert.rejects(db.query(`select public.get_accounting_shop_daily_matrix('2026-01-01', '2026-08-20', '{}'::uuid[])`), /31 days/);
  await db.exec(`create or replace function public.current_app_role() returns public.app_role language sql stable as $$ select 'courier'::public.app_role $$;`);
  await assert.rejects(db.query(`select public.get_accounting_shop_daily_matrix('${SERVICE_DATE}', '${SERVICE_DATE}', '{}'::uuid[])`), /round lead or admin/);
});

test('takes the service-date advisory lock before mutable row locks', () => {
  const recordBody = production.slice(
    production.indexOf('create function public.record_casual_transaction'),
    production.indexOf('create function public.get_casual_receipt_snapshot'),
  );
  const voidBody = production.slice(
    production.indexOf('create function public.void_casual_transaction'),
    production.indexOf('create function public.accounting_casual_transaction_rows'),
  );
  assert.ok(recordBody.indexOf('hashtextextended(v_service_date::text, 0)') < recordBody.indexOf('for update'));
  assert.ok(voidBody.indexOf('hashtextextended(v_service_date::text, 0)') < voidBody.indexOf('for update'));
  assert.ok(voidBody.indexOf('for update') < voidBody.indexOf('Casual transactions cannot be voided after stock is closed'));
});

test('round leads can see casual transactions recorded by other employees', async (t) => {
  const db = await createDatabase(t, 'round_lead');
  await db.exec(`
    insert into public.users values ('${OTHER_USER_ID}', 'พนักงานคนอื่น');
    insert into public.casual_transactions (
      service_date, round_id, source_stock_location_id, ice_type_id,
      transaction_kind, fulfillment_mode, quantity, sale_amount,
      idempotency_key, request_fingerprint, client_recorded_at, recorded_by
    ) values (
      '${SERVICE_DATE}', '${ROUND_ID}', '${HOLDING_ID}', '${ICE_ID}',
      'free', 'measured', 0.5, 0,
      '60000000-0000-4000-8000-000000000009', 'other-employee-request', now(), '${OTHER_USER_ID}'
    );
  `);

  const context = await db.query(`select public.get_casual_transaction_context('${ROUND_ID}') as result`);
  assert.equal(context.rows[0].result.history.length, 1);
  assert.equal(context.rows[0].result.history[0].ice_type_name, 'น้ำแข็ง');
});

test('records an atomic paid casual sale, deducts stock, and replays idempotently', async (t) => {
  const db = await createDatabase(t);
  const key = '60000000-0000-4000-8000-000000000001';
  const call = `select public.record_casual_transaction(
    '${ROUND_ID}', '${ICE_ID}', 0.5, 'paid', 75, 'cash', 100,
    null, null, null, now(), '${key}'
  ) as result`;

  const first = await db.query(call);
  const replay = await db.query(call);
  assert.equal(first.rows[0].result.transaction.receipt_number, 'REC2608-00001');
  assert.equal(first.rows[0].result.receipt.shop_name, 'ลูกค้าขาจร');
  assert.equal(replay.rows[0].result.transaction.id, first.rows[0].result.transaction.id);

  const balance = await db.query(`select public.stock_balance_at('${SERVICE_DATE}', '${HOLDING_ID}', '${ICE_ID}') as quantity`);
  assert.equal(balance.rows[0].quantity, '4.5');
  const count = await db.query('select count(*)::integer as count from public.casual_transactions');
  assert.equal(count.rows[0].count, 1);
});

test('records zero-quantity free and five-baht paid casual scraps without deducting stock', async (t) => {
  const db = await createDatabase(t);
  const free = await db.query(`select public.record_casual_loose_transaction(
    '${ROUND_ID}', '${ICE_ID}', 'free', 0, null, null,
    null, null, null, now(), '60000000-0000-4000-8000-000000000010'
  ) as result`);
  const paid = await db.query(`select public.record_casual_loose_transaction(
    '${ROUND_ID}', '${ICE_ID}', 'paid', 5, 'cash', 5,
    null, null, null, now(), '60000000-0000-4000-8000-000000000011'
  ) as result`);

  assert.equal(free.rows[0].result.transaction.quantity, null);
  assert.equal(free.rows[0].result.transaction.fulfillment_mode, 'loose');
  assert.equal(paid.rows[0].result.transaction.quantity, null);
  assert.equal(paid.rows[0].result.transaction.sale_amount, 5);
  assert.equal(paid.rows[0].result.transaction.receipt_number, 'REC2608-00001');
  const ledger = await db.query(`
    select type, quantity_out
    from public.accounting_casual_transaction_rows('${SERVICE_DATE}', '${SERVICE_DATE}')
    where type in ('FREE', 'SALE')
    order by type
  `);
  assert.deepEqual(ledger.rows, [
    { type: 'FREE', quantity_out: '0' },
    { type: 'SALE', quantity_out: '0' },
  ]);
  const transactions = await db.query(`select public.get_accounting_transactions(
    '${SERVICE_DATE}', '${SERVICE_DATE}', '{}'::jsonb, '{}'::jsonb, 100, 0
  ) as result`);
  assert.deepEqual(
    transactions.rows[0].result.rows
      .filter((row) => row.type === 'FREE' || row.type === 'SALE')
      .map((row) => row.quantity_out),
    [0, 0],
  );

  await db.query(`select public.void_casual_transaction(
    '${paid.rows[0].result.transaction.id}', 'ยกเลิกเศษน้ำแข็ง', 'cash', null, null,
    '70000000-0000-4000-8000-000000000010'
  )`);
  const balance = await db.query(`select public.stock_balance_at('${SERVICE_DATE}', '${HOLDING_ID}', '${ICE_ID}') as quantity`);
  assert.equal(balance.rows[0].quantity, '5.0');
});

test('voiding a paid casual sale records the refund and restores stock', async (t) => {
  const db = await createDatabase(t);
  const sale = await db.query(`select public.record_casual_transaction(
    '${ROUND_ID}', '${ICE_ID}', 1, 'paid', 100, 'cash', 100,
    null, null, null, now(), '60000000-0000-4000-8000-000000000002'
  ) as result`);
  const transactionId = sale.rows[0].result.transaction.id;

  await db.query(`select public.void_casual_transaction(
    '${transactionId}', 'ลูกค้าคืนสินค้า', 'cash', null, null,
    '70000000-0000-4000-8000-000000000001'
  )`);

  const balance = await db.query(`select public.stock_balance_at('${SERVICE_DATE}', '${HOLDING_ID}', '${ICE_ID}') as quantity`);
  assert.equal(balance.rows[0].quantity, '5.0');
  const row = await db.query(`select status, void_reason from public.casual_transactions where id = '${transactionId}'`);
  assert.deepEqual(row.rows[0], { status: 'voided', void_reason: 'ลูกค้าคืนสินค้า' });
  const refund = await db.query(`select refunded_amount, refund_method from public.casual_refund_confirmations where transaction_id = '${transactionId}'`);
  assert.deepEqual(refund.rows[0], { refunded_amount: '100', refund_method: 'cash' });

  const accountingDates = await db.query(`
    select
      (transaction.recorded_at at time zone 'Asia/Bangkok')::date::text as received_date,
      (confirmation.confirmed_at at time zone 'Asia/Bangkok')::date::text as refunded_date
    from public.casual_transactions transaction
    join public.casual_refund_confirmations confirmation on confirmation.transaction_id = transaction.id
    where transaction.id = '${transactionId}'
  `);
  const { received_date: receivedDate, refunded_date: refundedDate } = accountingDates.rows[0];
  const ledger = await db.query(`
    select type, cash_in, cash_out
    from public.accounting_casual_transaction_rows('${receivedDate}', '${refundedDate}')
    where type in ('REC', 'REF')
    order by type
  `);
  assert.deepEqual(ledger.rows, [
    { type: 'REC', cash_in: '100', cash_out: '0' },
    { type: 'REF', cash_in: '0', cash_out: '100' },
  ]);
  const reconciliation = await db.query(`select public.get_accounting_reconciliation('${receivedDate}') as result`);
  assert.equal(reconciliation.rows[0].result.financial.casual_received, 100);
  assert.equal(reconciliation.rows[0].result.financial.casual_refunded, 100);
  assert.equal(reconciliation.rows[0].result.financial.net_cash, 0);
});

test('rejects stock overdraws and transfer payments without evidence', async (t) => {
  const db = await createDatabase(t);
  await assert.rejects(db.query(`select public.record_casual_transaction(
    '${ROUND_ID}', '${ICE_ID}', 5.5, 'free', 0, null, null,
    null, null, null, now(), '60000000-0000-4000-8000-000000000003'
  )`), /does not have enough stock|not sufficient/i);
  await assert.rejects(db.query(`select public.record_casual_transaction(
    '${ROUND_ID}', '${ICE_ID}', 0.5, 'paid', 75, 'bank_transfer', 75,
    null, null, null, now(), '60000000-0000-4000-8000-000000000004'
  )`), /require evidence/i);
});

test('rejects records and voids after the service date is closed', async (t) => {
  const db = await createDatabase(t);
  const sale = await db.query(`select public.record_casual_transaction(
    '${ROUND_ID}', '${ICE_ID}', 0.5, 'paid', 75, 'cash', 75,
    null, null, null, now(), '60000000-0000-4000-8000-000000000007'
  ) as result`);
  const transactionId = sale.rows[0].result.transaction.id;
  await db.query(`insert into public.daily_aggregate_stock_closures (service_date, status)
    values ('${SERVICE_DATE}', 'closed')`);

  await assert.rejects(db.query(`select public.record_casual_transaction(
    '${ROUND_ID}', '${ICE_ID}', 0.5, 'free', 0, null, null,
    null, null, null, now(), '60000000-0000-4000-8000-000000000008'
  )`), /already closed/i);
  await assert.rejects(db.query(`select public.void_casual_transaction(
    '${transactionId}', 'ปิดยอดแล้ว', 'cash', null, null,
    '70000000-0000-4000-8000-000000000002'
  )`), /after stock is closed/i);
  const row = await db.query(`select status from public.casual_transactions where id = '${transactionId}'`);
  assert.equal(row.rows[0].status, 'active');
});

test('advertises measured and loose capabilities and includes casual sales in accounting', async (t) => {
  const db = await createDatabase(t);
  const capability = await db.query('select public.get_casual_transaction_capability() as result');
  assert.deepEqual(capability.rows[0].result, {
    enabled: true,
    version: 2,
    fulfillment_modes: ['measured', 'loose'],
  });

  await db.query(`select public.record_casual_transaction(
    '${ROUND_ID}', '${ICE_ID}', 0.5, 'paid', 75, 'cash', 100,
    null, null, null, now(), '60000000-0000-4000-8000-000000000005'
  )`);
  const receiptDate = await db.query(`
    select (recorded_at at time zone 'Asia/Bangkok')::date::text as value
    from public.casual_transactions
    where idempotency_key = '60000000-0000-4000-8000-000000000005'
  `);
  const receivedOnServiceDate = receiptDate.rows[0].value === SERVICE_DATE;
  const rows = await db.query(`
    select type, shop_name, employee_name, quantity_out, sales_amount, cash_in
    from public.accounting_casual_transaction_rows('${SERVICE_DATE}', '${SERVICE_DATE}')
    order by type
  `);
  assert.deepEqual(rows.rows, [
    ...(receivedOnServiceDate ? [{ type: 'REC', shop_name: 'ลูกค้าขาจร', employee_name: 'พนักงาน', quantity_out: '0', sales_amount: '0', cash_in: '75' }] : []),
    { type: 'SALE', shop_name: 'ลูกค้าขาจร', employee_name: 'พนักงาน', quantity_out: '0.5', sales_amount: '75', cash_in: '0' },
  ]);
  const reconciliation = await db.query(`select public.get_accounting_reconciliation('${SERVICE_DATE}') as result`);
  assert.equal(reconciliation.rows[0].result.financial.effective_sales, 75);
  assert.equal(reconciliation.rows[0].result.financial.cash_received, receivedOnServiceDate ? 75 : 0);
  assert.equal(reconciliation.rows[0].result.aggregate[0].sold, 0.5);
  const transactions = await db.query(`select public.get_accounting_transactions(
    '${SERVICE_DATE}', '${SERVICE_DATE}', '{}'::jsonb, '{}'::jsonb, 100, 0
  ) as result`);
  assert.equal(transactions.rows[0].result.total_count, receivedOnServiceDate ? 2 : 1);
  assert.deepEqual(transactions.rows[0].result.rows.map((row) => row.type).sort(), receivedOnServiceDate ? ['REC', 'SALE'] : ['SALE']);
  const summary = await db.query(`select public.get_accounting_shop_summary(
    '${SERVICE_DATE}', '${SERVICE_DATE}', '{}'::jsonb, 100, 0
  ) as result`);
  assert.equal(summary.rows[0].result.totals.casual_sales_amount, 75);
  assert.equal(summary.rows[0].result.totals.sales_amount, 0);
  assert.equal(summary.rows[0].result.totals.casual_received_amount, receivedOnServiceDate ? 75 : 0);
  assert.equal(summary.rows[0].result.totals.casual_refunded_amount, 0);
  assert.equal(summary.rows[0].result.totals.casual_net_cash, receivedOnServiceDate ? 75 : 0);
});

test('stores the employee name in the immutable casual receipt snapshot', async (t) => {
  const db = await createDatabase(t);
  const sale = await db.query(`select public.record_casual_transaction(
    '${ROUND_ID}', '${ICE_ID}', 0.5, 'paid', 75, 'cash', 75,
    null, null, null, now(), '60000000-0000-4000-8000-000000000006'
  ) as result`);
  assert.equal(sale.rows[0].result.receipt.recorded_by_name, 'พนักงาน');
});
