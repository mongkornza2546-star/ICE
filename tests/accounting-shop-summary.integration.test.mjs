import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const accountingMigration = readFileSync(
  new URL('../supabase/migrations/0143_accounting_shop_summary.sql', import.meta.url),
  'utf8',
);
const activeShopsMigration = readFileSync(
  new URL('../supabase/migrations/0144_accounting_all_active_shops.sql', import.meta.url),
  'utf8',
);
const areaGroupsMigration = readFileSync(
  new URL('../supabase/migrations/0145_accounting_shop_summary_area_groups.sql', import.meta.url),
  'utf8',
);
const migration = `${accountingMigration}\n${activeShopsMigration}\n${areaGroupsMigration}`;

const USER_ID = '10000000-0000-4000-8000-000000000001';
const SHOP_ID = '20000000-0000-4000-8000-000000000001';
const OLD_BUILDING_ID = '30000000-0000-4000-8000-000000000001';
const CURRENT_BUILDING_ID = '30000000-0000-4000-8000-000000000002';
const OLD_ZONE_ID = '40000000-0000-4000-8000-000000000001';
const CURRENT_ZONE_ID = '40000000-0000-4000-8000-000000000002';
const STOP_ID = '50000000-0000-4000-8000-000000000001';
const CURRENT_STOP_ID = '50000000-0000-4000-8000-000000000002';
const IMMEDIATE_EVENT_ID = '60000000-0000-4000-8000-000000000001';
const CREDIT_EVENT_ID = '60000000-0000-4000-8000-000000000002';
const IMMEDIATE_CHARGE_ID = '70000000-0000-4000-8000-000000000001';
const CREDIT_CHARGE_ID = '70000000-0000-4000-8000-000000000002';
const PAYMENT_ID = '80000000-0000-4000-8000-000000000001';
const OLD_EVENT_ID = '60000000-0000-4000-8000-000000000003';
const OLD_CHARGE_ID = '70000000-0000-4000-8000-000000000003';
const OLD_RECEIPT_ID = '80000000-0000-4000-8000-000000000002';
const LATER_RECEIPT_ID = '80000000-0000-4000-8000-000000000003';
const ADJUSTMENT_ID = '90000000-0000-4000-8000-000000000001';
const REFUND_ID = '90000000-0000-4000-8000-000000000002';
const ICE_ID = 'a0000000-0000-4000-8000-000000000001';

async function createDatabase(t, { applyMigration = true } = {}) {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role authenticated;
    create type public.payment_term as enum ('immediate', 'end_of_day', 'credit');
    create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');
    create type public.financial_record_status as enum ('active', 'voided');
    create type public.shop_status as enum ('active', 'inactive');

    create function public.is_active_user() returns boolean
    language sql stable as $$ select true $$;
    create function public.current_app_role() returns text
    language sql stable as $$ select 'admin'::text $$;

    create table public.users (
      id uuid primary key,
      display_name text not null
    );
    create table public.buildings (
      id uuid primary key,
      code text not null unique default gen_random_uuid()::text,
      name text not null,
      is_active boolean not null default true,
      created_at timestamptz not null default now()
    );
    create table public.building_zones (
      id uuid primary key,
      building_id uuid not null references public.buildings(id),
      name text not null,
      sort_order integer not null default 1,
      is_active boolean not null default true
    );
    create table public.shops (
      id uuid primary key,
      code text not null,
      name text not null,
      building_id uuid not null references public.buildings(id),
      zone_id uuid not null references public.building_zones(id),
      status public.shop_status not null default 'active'
    );
    create table public.shop_payment_profiles (
      shop_id uuid primary key references public.shops(id),
      allowed_payment_terms public.payment_term[] not null,
      default_payment_term public.payment_term not null
    );
    create table public.delivery_rounds (
      id uuid primary key,
      service_date date not null,
      round_type text not null default 'daily',
      opened_at timestamptz not null default now(),
      cancelled_at timestamptz,
      created_at timestamptz not null default now()
    );
    create table public.round_stops (
      id uuid primary key,
      shop_id uuid not null references public.shops(id),
      building_id_snapshot uuid not null,
      building_name_snapshot text not null,
      floor_or_zone_snapshot text not null,
      round_id uuid references public.delivery_rounds(id),
      sequence_no integer,
      status text not null default 'pending',
      updated_at timestamptz not null default now()
    );
    create table public.delivery_events (
      id uuid primary key,
      round_stop_id uuid not null references public.round_stops(id),
      recorded_by uuid not null references public.users(id),
      status text not null,
      recorded_at timestamptz not null
    );
    create table public.delivery_charges (
      id uuid primary key,
      delivery_event_id uuid not null references public.delivery_events(id),
      shop_id uuid not null references public.shops(id),
      service_date date not null,
      payment_term public.payment_term not null,
      due_date date,
      original_amount numeric(12,2) not null,
      status public.financial_record_status not null,
      charge_number text not null unique default gen_random_uuid()::text
    );
    create table public.payments (
      id uuid primary key,
      shop_id uuid not null references public.shops(id),
      allocated_amount numeric(12,2) not null,
      status public.financial_record_status not null,
      recorded_at timestamptz not null,
      payment_method public.payment_method not null default 'cash'
    );
    create table public.payment_allocations (
      payment_id uuid not null references public.payments(id),
      charge_id uuid not null references public.delivery_charges(id),
      amount numeric(12,2) not null,
      primary key (payment_id, charge_id)
    );
    create table public.delivery_charge_adjustments (
      idempotency_key uuid primary key,
      charge_id uuid not null references public.delivery_charges(id),
      amount_delta numeric(12,2) not null,
      status public.financial_record_status not null,
      scope text not null default 'round_closed',
      corrected_total numeric(12,2) not null default 0,
      reason text not null default 'Test adjustment',
      created_at timestamptz not null default now()
    );
    create table public.ice_types (
      id uuid primary key,
      code text not null,
      name text not null,
      unit text not null
    );
    create table public.delivery_items (
      delivery_event_id uuid not null references public.delivery_events(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity numeric(12,1) not null,
      unit_price numeric(12,2) not null,
      line_total numeric(12,2) not null,
      primary key (delivery_event_id, ice_type_id)
    );
    create table public.delivery_adjustment_items (
      adjustment_id uuid not null references public.delivery_charge_adjustments(idempotency_key),
      ice_type_id uuid not null references public.ice_types(id),
      original_quantity numeric(12,1) not null,
      corrected_quantity numeric(12,1) not null,
      quantity_delta numeric(12,1) not null,
      unit_price numeric(12,2) not null,
      primary key (adjustment_id, ice_type_id)
    );
    create table public.payment_receipt_snapshots (
      payment_id uuid primary key references public.payments(id),
      receipt_data jsonb not null,
      created_at timestamptz not null default now()
    );
    create table public.refund_obligations (
      id uuid primary key,
      payment_id uuid not null references public.payments(id),
      source_charge_id uuid not null references public.delivery_charges(id),
      amount numeric(12,2) not null,
      status text not null
    );
    create sequence public.effective_charge_call_seq;
    create function public.effective_delivery_charge_amount(p_charge_id uuid)
    returns numeric language plpgsql volatile as $$
    begin
      perform nextval('public.effective_charge_call_seq');
      return (select charge.original_amount + coalesce(sum(adjustment.amount_delta)
        filter (where adjustment.status = 'active'), 0)
      from public.delivery_charges charge
      left join public.delivery_charge_adjustments adjustment
        on adjustment.charge_id = charge.id
      where charge.id = p_charge_id
      group by charge.id);
    end
    $$;

    create function public.ensure_daily_delivery_round(p_service_date date)
    returns uuid language plpgsql security definer set search_path = public as $$
    declare
      v_round_id uuid;
    begin
      select id into v_round_id from public.delivery_rounds
      where service_date = p_service_date and round_type = 'daily' and cancelled_at is null
      order by created_at limit 1;
      if v_round_id is not null then return v_round_id; end if;

      v_round_id := gen_random_uuid();
      insert into public.delivery_rounds (id, service_date) values (v_round_id, p_service_date);
      insert into public.round_stops (
        id, shop_id, building_id_snapshot, building_name_snapshot,
        floor_or_zone_snapshot, round_id, sequence_no
      )
      select gen_random_uuid(), shop.id, building.id, building.name, zone.name,
        v_round_id, row_number() over (order by shop.code)::integer
      from public.shops shop
      join public.buildings building on building.id = shop.building_id
      join public.building_zones zone on zone.id = shop.zone_id
      where shop.status = 'active';
      return v_round_id;
    end
    $$;

    insert into public.users values ('${USER_ID}', 'Courier One');
    insert into public.buildings (id, name) values
      ('${OLD_BUILDING_ID}', 'Old Building'),
      ('${CURRENT_BUILDING_ID}', 'Current Building');
    insert into public.building_zones values
      ('${OLD_ZONE_ID}', '${OLD_BUILDING_ID}', 'Old Zone'),
      ('${CURRENT_ZONE_ID}', '${CURRENT_BUILDING_ID}', 'Current Zone');
    insert into public.shops values
      ('${SHOP_ID}', 'S001', 'Mixed Shop', '${OLD_BUILDING_ID}', '${OLD_ZONE_ID}', 'active');
    insert into public.shop_payment_profiles values
      ('${SHOP_ID}', array['immediate', 'end_of_day', 'credit']::public.payment_term[], 'immediate');
    insert into public.round_stops (
      id, shop_id, building_id_snapshot, building_name_snapshot, floor_or_zone_snapshot
    ) values
      ('${STOP_ID}', '${SHOP_ID}', '${OLD_BUILDING_ID}', 'Old Building', 'Old Zone');
  `);

  if (applyMigration) await db.exec(migration);
  return db;
}

async function getSummary(db, filters = '{}', limit = '100', offset = '0') {
  const result = await db.query(`
    select public.get_accounting_shop_summary(
      date '2026-08-01', date '2026-08-01', '${filters}'::jsonb, ${limit}, ${offset}
    ) as summary
  `);
  return result.rows[0].summary;
}

async function getInvoiceDetail(db, filters = '{}', limit = '100', offset = '0') {
  const result = await db.query(`
    select public.get_accounting_shop_invoice_detail(
      '${SHOP_ID}', date '2026-08-01', date '2026-08-01',
      '${filters}'::jsonb, ${limit}, ${offset}
    ) as detail
  `);
  return result.rows[0].detail;
}

test('active shops without period sales remain visible while inactive shops are excluded', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    insert into public.shops (id, code, name, building_id, zone_id, status) values
      ('20000000-0000-4000-8000-000000000099', 'S099', 'Inactive Shop',
        '${OLD_BUILDING_ID}', '${OLD_ZONE_ID}', 'inactive');
  `);

  const summary = await getSummary(db);

  assert.equal(summary.total_count, 1);
  assert.equal(summary.rows[0].shop_id, SHOP_ID);
  assert.equal(summary.rows[0].sales_amount, 0);
  assert.equal(summary.rows[0].paid_amount, 0);
  assert.equal(summary.rows[0].outstanding_amount, 0);
  assert.equal(summary.rows[0].cumulative_outstanding_amount, 0);
  assert.equal(summary.rows[0].cumulative_overdue_amount, 0);
  assert.equal(summary.rows[0].invoice_count, 0);
  assert.equal(summary.rows[0].payment_status, 'paid');
  assert.equal(summary.rows[0].delivery_sequence, null);
  assert.equal(summary.rows[0].building_id, OLD_BUILDING_ID);
  assert.equal(summary.rows[0].current_zone_id, OLD_ZONE_ID);
  assert.deepEqual(summary.facets.shops.map((facet) => facet.value), [SHOP_ID]);
});

test('old debt drives cumulative balance and payment status without becoming period sales', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    insert into public.delivery_events values
      ('${OLD_EVENT_ID}', '${STOP_ID}', '${USER_ID}', 'active', '2026-07-01T03:00:00Z');
    insert into public.delivery_charges values
      ('${OLD_CHARGE_ID}', '${OLD_EVENT_ID}', '${SHOP_ID}', '2026-07-01',
        'credit', '2026-07-31', 90, 'active');
  `);

  const summary = await getSummary(db);
  const shop = summary.rows[0];

  assert.equal(shop.sales_amount, 0);
  assert.equal(shop.outstanding_amount, 0);
  assert.equal(shop.cumulative_outstanding_amount, 90);
  assert.equal(shop.cumulative_overdue_amount, 90);
  assert.equal(shop.oldest_outstanding_due_date, '2026-07-31');
  assert.equal(shop.payment_status, 'overdue');
  assert.equal(summary.totals.outstanding_amount, 0);
  assert.equal(summary.totals.cumulative_outstanding_amount, 90);
  assert.equal(summary.totals.cumulative_overdue_amount, 90);
  assert.equal(summary.totals.cumulative_outstanding_shop_count, 1);

  const detail = await getInvoiceDetail(db);
  assert.equal(detail.length, 1);
  assert.equal(detail[0].charge_id, OLD_CHARGE_ID);
  assert.equal(detail[0].service_date, '2026-07-01');
});

test('current payment-term filtering keeps legacy debt from older invoice terms visible', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.shop_payment_profiles
    set allowed_payment_terms = array['immediate']::public.payment_term[],
      default_payment_term = 'immediate'
    where shop_id = '${SHOP_ID}';
    insert into public.delivery_events values
      ('${OLD_EVENT_ID}', '${STOP_ID}', '${USER_ID}', 'active', '2026-07-01T03:00:00Z');
    insert into public.delivery_charges values
      ('${OLD_CHARGE_ID}', '${OLD_EVENT_ID}', '${SHOP_ID}', '2026-07-01',
        'credit', '2026-07-31', 90, 'active');
  `);

  const summary = await getSummary(db, '{"payment_term":"immediate"}');

  assert.equal(summary.total_count, 1);
  assert.equal(summary.rows[0].payment_term, 'immediate');
  assert.equal(summary.rows[0].cumulative_outstanding_amount, 90);
  assert.equal(summary.rows[0].cumulative_overdue_amount, 90);
  assert.equal(summary.rows[0].payment_status, 'overdue');
});

test('cash received includes later receipts from shops that are no longer active', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    insert into public.shops (id, code, name, building_id, zone_id, status) values
      ('20000000-0000-4000-8000-000000000099', 'S099', 'Moved-out Shop',
        '${OLD_BUILDING_ID}', '${OLD_ZONE_ID}', 'inactive');
    insert into public.payments values
      ('${PAYMENT_ID}', '20000000-0000-4000-8000-000000000099', 100, 'active',
        '2026-08-01T04:00:00Z');
  `);

  const summary = await getSummary(db);

  assert.equal(summary.total_count, 1);
  assert.equal(summary.rows[0].shop_id, SHOP_ID);
  assert.equal(summary.totals.cash_received_in_period, 100);
});

test('payment-term filtering selects current-profile shops without trimming invoice history', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.shop_payment_profiles
    set allowed_payment_terms = array['credit']::public.payment_term[],
      default_payment_term = 'credit'
    where shop_id = '${SHOP_ID}';
    insert into public.delivery_events values
      ('${IMMEDIATE_EVENT_ID}', '${STOP_ID}', '${USER_ID}', 'active', '2026-08-01T02:00:00Z'),
      ('${CREDIT_EVENT_ID}', '${STOP_ID}', '${USER_ID}', 'active', '2026-08-01T03:00:00Z');
    insert into public.delivery_charges values
      ('${IMMEDIATE_CHARGE_ID}', '${IMMEDIATE_EVENT_ID}', '${SHOP_ID}', '2026-08-01',
        'immediate', null, 100, 'active'),
      ('${CREDIT_CHARGE_ID}', '${CREDIT_EVENT_ID}', '${SHOP_ID}', '2026-08-01',
        'credit', '2026-08-31', 200, 'active');
    insert into public.payments values
      ('${PAYMENT_ID}', '${SHOP_ID}', 100, 'active', '2026-08-01T04:00:00Z');
    insert into public.payment_allocations values
      ('${PAYMENT_ID}', '${IMMEDIATE_CHARGE_ID}', 100);
  `);

  const summary = await getSummary(db, '{"payment_term":"credit"}');

  assert.equal(summary.total_count, 1);
  assert.equal(summary.rows[0].payment_term, 'credit');
  assert.equal(summary.rows[0].sales_amount, 300);
  assert.equal(summary.rows[0].paid_amount, 100);
  assert.equal(summary.rows[0].outstanding_amount, 200);
  assert.equal(summary.rows[0].invoice_count, 2);
});

test('receipt-date cash is independent of invoice filters while later receipts still settle period sales', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    insert into public.delivery_events values
      ('${CREDIT_EVENT_ID}', '${STOP_ID}', '${USER_ID}', 'active', '2026-08-01T03:00:00Z'),
      ('${OLD_EVENT_ID}', '${STOP_ID}', '${USER_ID}', 'active', '2026-07-31T03:00:00Z');
    insert into public.delivery_charges values
      ('${CREDIT_CHARGE_ID}', '${CREDIT_EVENT_ID}', '${SHOP_ID}', '2026-08-01',
        'credit', current_date + 30, 200, 'active'),
      ('${OLD_CHARGE_ID}', '${OLD_EVENT_ID}', '${SHOP_ID}', '2026-07-31',
        'immediate', null, 80, 'active');
    insert into public.payments values
      ('${OLD_RECEIPT_ID}', '${SHOP_ID}', 80, 'active', '2026-08-01T05:00:00Z'),
      ('${LATER_RECEIPT_ID}', '${SHOP_ID}', 50, 'active', '2026-08-02T05:00:00Z');
    insert into public.payment_allocations values
      ('${OLD_RECEIPT_ID}', '${OLD_CHARGE_ID}', 80),
      ('${LATER_RECEIPT_ID}', '${CREDIT_CHARGE_ID}', 50);
  `);

  const summary = await getSummary(
    db,
    '{"payment_term":"credit","payment_status":"outstanding"}',
  );

  assert.equal(summary.rows[0].sales_amount, 200);
  assert.equal(summary.rows[0].paid_amount, 50);
  assert.equal(summary.rows[0].outstanding_amount, 150);
  assert.equal(summary.totals.cash_received_in_period, 80);
});

test('adjusted charges use one effective amount while gross receipt cash remains intact for refunds', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    insert into public.delivery_events values
      ('${CREDIT_EVENT_ID}', '${STOP_ID}', '${USER_ID}', 'active', '2026-08-01T03:00:00Z');
    insert into public.delivery_charges values
      ('${CREDIT_CHARGE_ID}', '${CREDIT_EVENT_ID}', '${SHOP_ID}', '2026-08-01',
        'credit', '2026-08-31', 200, 'active');
    insert into public.delivery_charge_adjustments values
      ('${ADJUSTMENT_ID}', '${CREDIT_CHARGE_ID}', -60, 'active');
    insert into public.payments values
      ('${PAYMENT_ID}', '${SHOP_ID}', 200, 'active', '2026-08-01T05:00:00Z');
    insert into public.payment_allocations values
      ('${PAYMENT_ID}', '${CREDIT_CHARGE_ID}', 140);
    insert into public.refund_obligations values
      ('${REFUND_ID}', '${PAYMENT_ID}', '${CREDIT_CHARGE_ID}', 60, 'pending');
  `);

  const summary = await getSummary(db);
  const calls = await db.query(
    'select last_value::integer as count from public.effective_charge_call_seq',
  );

  assert.equal(summary.rows[0].sales_amount, 140);
  assert.equal(summary.rows[0].paid_amount, 140);
  assert.equal(summary.rows[0].outstanding_amount, 0);
  assert.equal(summary.totals.cash_received_in_period, 200);
  assert.equal(calls.rows[0].count, 1);
});

test('shop rows, sales filters, and facets use the current shop location', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.shops
    set building_id = '${CURRENT_BUILDING_ID}', zone_id = '${CURRENT_ZONE_ID}'
    where id = '${SHOP_ID}';
    insert into public.round_stops (
      id, shop_id, building_id_snapshot, building_name_snapshot, floor_or_zone_snapshot
    ) values
      ('${CURRENT_STOP_ID}', '${SHOP_ID}', '${CURRENT_BUILDING_ID}', 'Current Building', 'Current Zone');
    insert into public.delivery_events values
      ('${IMMEDIATE_EVENT_ID}', '${STOP_ID}', '${USER_ID}', 'active', '2026-08-01T02:00:00Z'),
      ('${CREDIT_EVENT_ID}', '${CURRENT_STOP_ID}', '${USER_ID}', 'active', '2026-08-01T03:00:00Z');
    insert into public.delivery_charges values
      ('${IMMEDIATE_CHARGE_ID}', '${IMMEDIATE_EVENT_ID}', '${SHOP_ID}', '2026-08-01',
        'immediate', null, 100, 'active'),
      ('${CREDIT_CHARGE_ID}', '${CREDIT_EVENT_ID}', '${SHOP_ID}', '2026-08-01',
        'credit', '2026-08-31', 50, 'active');
  `);

  const allLocations = await getSummary(db);
  const oldBuilding = await getSummary(db, `{"building_id":"${OLD_BUILDING_ID}"}`);
  const currentBuilding = await getSummary(db, `{"building_id":"${CURRENT_BUILDING_ID}"}`);
  const oldCurrentZone = await getSummary(db, `{"zone_id":"${OLD_ZONE_ID}"}`);
  const currentZone = await getSummary(db, `{"zone_id":"${CURRENT_ZONE_ID}"}`);

  assert.equal(allLocations.total_count, 1);
  assert.equal(allLocations.rows.length, 1);
  assert.equal(allLocations.rows[0].sales_amount, 150);
  assert.equal(allLocations.rows[0].building_id, CURRENT_BUILDING_ID);
  assert.deepEqual(allLocations.facets.buildings.map((facet) => facet.value), [CURRENT_BUILDING_ID]);

  assert.equal(oldBuilding.total_count, 0);
  assert.equal(currentBuilding.total_count, 1);
  assert.equal(currentBuilding.rows[0].sales_amount, 150);
  assert.equal(currentBuilding.rows[0].building_name, 'Current Building');
  assert.equal(currentBuilding.rows[0].current_zone_id, CURRENT_ZONE_ID);
  assert.equal(currentBuilding.rows[0].current_zone_name, 'Current Zone');
  assert.equal(currentBuilding.rows[0].historical_zone_name, 'Current Zone');
  assert.deepEqual(allLocations.facets.zones[0], {
    value: CURRENT_ZONE_ID,
    label: 'Current Building / Current Zone',
    count: 1,
  });
  assert.deepEqual(oldBuilding.facets.zones, []);
  assert.deepEqual(currentBuilding.facets.zones[0], {
    value: CURRENT_ZONE_ID,
    label: 'Current Zone',
    count: 1,
  });

  assert.equal(oldCurrentZone.total_count, 0);
  assert.equal(currentZone.total_count, 1);
  assert.equal(currentZone.rows[0].sales_amount, 150);
});

test('building-filtered cash follows the current location of the active shop', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.shops
    set building_id = '${CURRENT_BUILDING_ID}', zone_id = '${CURRENT_ZONE_ID}'
    where id = '${SHOP_ID}';
    insert into public.delivery_events values
      ('${IMMEDIATE_EVENT_ID}', '${STOP_ID}', '${USER_ID}', 'active', '2026-07-01T02:00:00Z');
    insert into public.delivery_charges values
      ('${IMMEDIATE_CHARGE_ID}', '${IMMEDIATE_EVENT_ID}', '${SHOP_ID}', '2026-07-01',
        'immediate', null, 100, 'active');
    update public.delivery_charges set charge_number = 'INV-OLD-DEBT'
    where id = '${IMMEDIATE_CHARGE_ID}';
    insert into public.payments values
      ('${PAYMENT_ID}', '${SHOP_ID}', 100, 'active', '2026-08-01T04:00:00Z');
    insert into public.payment_allocations values
      ('${PAYMENT_ID}', '${IMMEDIATE_CHARGE_ID}', 100);
    insert into public.payment_receipt_snapshots (payment_id, receipt_data) values
      ('${PAYMENT_ID}', '{"charges":[{"charge_number":"INV-OLD-DEBT","received_amount":100}]}');
    update public.delivery_charges set status = 'voided'
    where id = '${IMMEDIATE_CHARGE_ID}';
    update public.delivery_events set status = 'cancelled'
    where id = '${IMMEDIATE_EVENT_ID}';
  `);

  const allBuildings = await getSummary(db);
  const oldBuilding = await getSummary(db, `{"building_id":"${OLD_BUILDING_ID}"}`);
  const oldBuildingWithInvoiceFilters = await getSummary(
    db,
    `{"building_id":"${OLD_BUILDING_ID}","payment_term":"credit","payment_status":"outstanding"}`,
  );
  const currentBuilding = await getSummary(db, `{"building_id":"${CURRENT_BUILDING_ID}"}`);

  assert.equal(allBuildings.total_count, 1);
  assert.equal(allBuildings.totals.cash_received_in_period, 100);
  assert.equal(oldBuilding.total_count, 0);
  assert.equal(oldBuilding.totals.cash_received_in_period, 0);
  assert.equal(oldBuildingWithInvoiceFilters.total_count, 0);
  assert.equal(oldBuildingWithInvoiceFilters.totals.cash_received_in_period, 0);
  assert.equal(currentBuilding.total_count, 1);
  assert.equal(currentBuilding.totals.cash_received_in_period, 100);
});

test('a receipt for a moved shop is attributed once to its current building', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.shops
    set building_id = '${CURRENT_BUILDING_ID}', zone_id = '${CURRENT_ZONE_ID}'
    where id = '${SHOP_ID}';
    insert into public.round_stops (
      id, shop_id, building_id_snapshot, building_name_snapshot, floor_or_zone_snapshot
    ) values
      ('${CURRENT_STOP_ID}', '${SHOP_ID}', '${CURRENT_BUILDING_ID}', 'Current Building', 'Current Zone');
    insert into public.delivery_events values
      ('${IMMEDIATE_EVENT_ID}', '${STOP_ID}', '${USER_ID}', 'active', '2026-07-01T02:00:00Z'),
      ('${CREDIT_EVENT_ID}', '${CURRENT_STOP_ID}', '${USER_ID}', 'active', '2026-07-01T03:00:00Z');
    insert into public.delivery_charges values
      ('${IMMEDIATE_CHARGE_ID}', '${IMMEDIATE_EVENT_ID}', '${SHOP_ID}', '2026-07-01',
        'immediate', null, 30, 'active'),
      ('${CREDIT_CHARGE_ID}', '${CREDIT_EVENT_ID}', '${SHOP_ID}', '2026-07-01',
        'credit', '2026-07-31', 70, 'active');
    update public.delivery_charges
    set charge_number = case id
      when '${IMMEDIATE_CHARGE_ID}' then 'INV-OLD-BUILDING'
      else 'INV-CURRENT-BUILDING' end;
    insert into public.payments values
      ('${PAYMENT_ID}', '${SHOP_ID}', 100, 'active', '2026-08-01T04:00:00Z');
    insert into public.payment_allocations values
      ('${PAYMENT_ID}', '${IMMEDIATE_CHARGE_ID}', 10),
      ('${PAYMENT_ID}', '${CREDIT_CHARGE_ID}', 90);
    insert into public.payment_receipt_snapshots (payment_id, receipt_data) values
      ('${PAYMENT_ID}', '{"charges":[
        {"charge_number":"INV-OLD-BUILDING","received_amount":30},
        {"charge_number":"INV-CURRENT-BUILDING","received_amount":70}
      ]}');
  `);

  const allBuildings = await getSummary(db);
  const oldBuilding = await getSummary(db, `{"building_id":"${OLD_BUILDING_ID}"}`);
  const currentBuilding = await getSummary(db, `{"building_id":"${CURRENT_BUILDING_ID}"}`);

  assert.equal(allBuildings.totals.cash_received_in_period, 100);
  assert.equal(oldBuilding.totals.cash_received_in_period, 0);
  assert.equal(currentBuilding.totals.cash_received_in_period, 100);
});

test('invoice detail server-filters the exact term, historical building, and current-zone cohort', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.shops
    set building_id = '${CURRENT_BUILDING_ID}', zone_id = '${CURRENT_ZONE_ID}'
    where id = '${SHOP_ID}';
    insert into public.round_stops (
      id, shop_id, building_id_snapshot, building_name_snapshot, floor_or_zone_snapshot
    ) values
      ('${CURRENT_STOP_ID}', '${SHOP_ID}', '${CURRENT_BUILDING_ID}', 'Current Building', 'Current Zone');
    insert into public.delivery_events values
      ('${IMMEDIATE_EVENT_ID}', '${STOP_ID}', '${USER_ID}', 'active', '2026-08-01T02:00:00Z'),
      ('${CREDIT_EVENT_ID}', '${STOP_ID}', '${USER_ID}', 'active', '2026-08-01T03:00:00Z'),
      ('${OLD_EVENT_ID}', '${CURRENT_STOP_ID}', '${USER_ID}', 'active', '2026-08-01T04:00:00Z');
    insert into public.delivery_charges values
      ('${IMMEDIATE_CHARGE_ID}', '${IMMEDIATE_EVENT_ID}', '${SHOP_ID}', '2026-08-01',
        'immediate', null, 100, 'active'),
      ('${CREDIT_CHARGE_ID}', '${CREDIT_EVENT_ID}', '${SHOP_ID}', '2026-08-01',
        'credit', current_date + 30, 200, 'active'),
      ('${OLD_CHARGE_ID}', '${OLD_EVENT_ID}', '${SHOP_ID}', '2026-08-01',
        'credit', current_date + 30, 300, 'active');
  `);

  const detail = await getInvoiceDetail(
    db,
    `{"payment_term":"credit","building_id":"${OLD_BUILDING_ID}","zone_id":"${CURRENT_ZONE_ID}","payment_status":"outstanding"}`,
  );
  const summary = await getSummary(db,
    `{"payment_term":"credit","building_id":"${CURRENT_BUILDING_ID}","zone_id":"${CURRENT_ZONE_ID}"}`);

  assert.equal(detail.length, 1);
  assert.equal(detail[0].charge_id, CREDIT_CHARGE_ID);
  assert.equal(detail[0].payment_term, 'credit');
  assert.equal(detail[0].total_amount, 200);
  assert.equal(detail[0].allocated_amount, 0);
  assert.equal(detail[0].outstanding_amount, 200);
  assert.equal(detail[0].building_id, OLD_BUILDING_ID);
  assert.equal(detail[0].building_name, 'Old Building');
  assert.equal(detail[0].historical_zone_name, 'Old Zone');
  assert.equal(detail[0].current_zone_id, CURRENT_ZONE_ID);
  assert.equal(detail[0].current_zone_name, 'Current Zone');
  assert.equal(detail.reduce((sum, invoice) => sum + invoice.total_amount, 0), 200);
  assert.equal(summary.rows[0].sales_amount, 600);

  const allDetail = await getInvoiceDetail(db, '{}', 'null', 'null');
  const secondPageRow = await getInvoiceDetail(db, '{}', '1', '1');
  assert.deepEqual(
    allDetail.map((invoice) => invoice.delivery_event_id),
    [OLD_EVENT_ID, CREDIT_EVENT_ID, IMMEDIATE_EVENT_ID],
  );
  assert.equal(secondPageRow[0].delivery_event_id, CREDIT_EVENT_ID);
  await assert.rejects(
    getInvoiceDetail(db, '{}', '0', '0'),
    /invalid accounting shop invoice detail pagination/i,
  );
  await assert.rejects(
    getInvoiceDetail(db, '{}', '501', '0'),
    /invalid accounting shop invoice detail pagination/i,
  );
  await assert.rejects(
    getInvoiceDetail(db, '{}', '100', '-1'),
    /invalid accounting shop invoice detail pagination/i,
  );
});

test('invoice detail returns original items plus active adjustment and payment payloads', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    insert into public.ice_types values ('${ICE_ID}', 'ICE', 'Bag ice', 'bag');
    insert into public.delivery_events values
      ('${CREDIT_EVENT_ID}', '${STOP_ID}', '${USER_ID}', 'active', '2026-08-01T03:00:00Z');
    insert into public.delivery_charges values
      ('${CREDIT_CHARGE_ID}', '${CREDIT_EVENT_ID}', '${SHOP_ID}', '2026-08-01',
        'credit', '2026-08-31', 200, 'active');
    insert into public.delivery_items values
      ('${CREDIT_EVENT_ID}', '${ICE_ID}', 10, 20, 200);
    insert into public.delivery_charge_adjustments (
      idempotency_key, charge_id, amount_delta, status, scope,
      corrected_total, reason, created_at
    ) values
      ('${ADJUSTMENT_ID}', '${CREDIT_CHARGE_ID}', -60, 'active', 'day_closed',
        140, 'Correct quantity', '2026-08-02T02:00:00Z'),
      ('90000000-0000-4000-8000-000000000003', '${CREDIT_CHARGE_ID}', 20, 'voided',
        'day_closed', 220, 'Voided correction', '2026-08-02T03:00:00Z');
    insert into public.delivery_adjustment_items values
      ('${ADJUSTMENT_ID}', '${ICE_ID}', 10, 7, -3, 20);
    insert into public.payments (
      id, shop_id, allocated_amount, status, recorded_at, payment_method
    ) values
      ('${PAYMENT_ID}', '${SHOP_ID}', 50, 'active', '2026-08-02T04:00:00Z', 'bank_transfer'),
      ('80000000-0000-4000-8000-000000000004', '${SHOP_ID}', 25, 'voided',
        '2026-08-02T05:00:00Z', 'cash');
    insert into public.payment_allocations values
      ('${PAYMENT_ID}', '${CREDIT_CHARGE_ID}', 50),
      ('80000000-0000-4000-8000-000000000004', '${CREDIT_CHARGE_ID}', 25);
  `);

  const detail = await getInvoiceDetail(db);
  const invoice = detail[0];

  assert.equal(invoice.total_amount, 140);
  assert.equal(invoice.allocated_amount, 50);
  assert.equal(invoice.outstanding_amount, 90);
  assert.deepEqual(invoice.items, [{
    ice_type_id: ICE_ID,
    name: 'Bag ice',
    unit: 'bag',
    quantity: 10,
    unit_price: 20,
    line_total: 200,
  }]);
  assert.equal(invoice.adjustments.length, 1);
  assert.equal(invoice.adjustments[0].reason, 'Correct quantity');
  assert.equal(invoice.adjustments[0].corrected_total, 140);
  assert.deepEqual(invoice.adjustments[0].items, [{
    ice_type_id: ICE_ID,
    name: 'Bag ice',
    unit: 'bag',
    original_quantity: 10,
    corrected_quantity: 7,
    quantity_delta: -3,
    unit_price: 20,
    corrected_line_total: 140,
  }]);
  assert.equal(invoice.payments.length, 1);
  assert.equal(invoice.payments[0].payment_method, 'bank_transfer');
  assert.equal(invoice.payments[0].amount, 50);
  assert.equal(
    new Date(invoice.payments[0].recorded_at).toISOString(),
    '2026-08-02T04:00:00.000Z',
  );
});

test('a zero-effective active charge is paid in both summary and invoice detail', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    insert into public.delivery_events values
      ('${CREDIT_EVENT_ID}', '${STOP_ID}', '${USER_ID}', 'active', '2026-08-01T03:00:00Z');
    insert into public.delivery_charges values
      ('${CREDIT_CHARGE_ID}', '${CREDIT_EVENT_ID}', '${SHOP_ID}', '2026-08-01',
        'credit', '2026-08-31', 200, 'active');
    insert into public.delivery_charge_adjustments (
      idempotency_key, charge_id, amount_delta, status, scope,
      corrected_total, reason, created_at
    ) values
      ('${ADJUSTMENT_ID}', '${CREDIT_CHARGE_ID}', -200, 'active', 'day_closed',
        0, 'Remove entire charge', '2026-08-02T02:00:00Z');
  `);

  const summary = await getSummary(db);
  const detail = await getInvoiceDetail(db);

  assert.equal(summary.rows[0].sales_amount, 0);
  assert.equal(summary.rows[0].outstanding_amount, 0);
  assert.equal(summary.rows[0].payment_status, 'paid');
  assert.equal(detail[0].total_amount, 0);
  assert.equal(detail[0].allocated_amount, 0);
  assert.equal(detail[0].outstanding_amount, 0);
  assert.equal(detail[0].payment_status, 'paid');
});

test('area sort uses building, zone, delivery sequence, and code while groups stay complete', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    insert into public.delivery_rounds (id, service_date, opened_at) values
      ('b0000000-0000-4000-8000-000000000001', '2026-08-01', '2026-08-01T01:00:00Z');
    update public.round_stops
    set round_id = 'b0000000-0000-4000-8000-000000000001',
      sequence_no = 2, status = 'closed_shop'
    where id = '${STOP_ID}';
    update public.shops set delivery_sequence = 2 where id = '${SHOP_ID}';
    insert into public.shops (
      id, code, name, building_id, zone_id, status, delivery_sequence
    ) values
      ('20000000-0000-4000-8000-000000000010', 'Z999', 'First delivery',
        '${OLD_BUILDING_ID}', '${OLD_ZONE_ID}', 'active', 1),
      ('20000000-0000-4000-8000-000000000011', 'A000', 'No delivery order',
        '${OLD_BUILDING_ID}', '${OLD_ZONE_ID}', 'active', null);
    insert into public.round_stops (
      id, shop_id, building_id_snapshot, building_name_snapshot, floor_or_zone_snapshot,
      round_id, sequence_no, status
    ) values (
      '50000000-0000-4000-8000-000000000010',
      '20000000-0000-4000-8000-000000000010', '${OLD_BUILDING_ID}',
      'Old Building', 'Old Zone', 'b0000000-0000-4000-8000-000000000001', 1, 'delivered'
    );
  `);

  const area = await getSummary(db);
  const byCode = await getSummary(db, '{"shop_sort":"code"}');

  assert.deepEqual(area.rows.map((row) => row.shop_code), ['Z999', 'S001', 'A000']);
  assert.deepEqual(area.rows.map((row) => row.delivery_sequence), [1, 2, null]);
  assert.deepEqual(byCode.rows.map((row) => row.shop_code), ['A000', 'S001', 'Z999']);
  assert.equal(area.groups.length, 1);
  assert.deepEqual({
    total: area.groups[0].total_shop_count,
    closed: area.groups[0].closed_shop_count,
    recordedNoSale: area.groups[0].recorded_no_sale_shop_count,
    notRecorded: area.groups[0].not_recorded_shop_count,
  }, { total: 3, closed: 1, recordedNoSale: 1, notRecorded: 1 });
  await assert.rejects(
    getSummary(db, '{"shop_sort":"unsupported"}'),
    /unsupported accounting shop sort/i,
  );
});

test('new daily rounds snapshot the configured area and shop delivery order', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.shops set delivery_sequence = 2 where id = '${SHOP_ID}';
    insert into public.shops (
      id, code, name, building_id, zone_id, status, delivery_sequence
    ) values (
      '20000000-0000-4000-8000-000000000010', 'Z999', 'First delivery',
      '${OLD_BUILDING_ID}', '${OLD_ZONE_ID}', 'active', 1
    );
  `);

  const created = await db.query(
    "select public.ensure_daily_delivery_round(date '2026-08-02') as round_id",
  );
  const stops = await db.query(`
    select shop.code, stop.sequence_no
    from public.round_stops stop
    join public.shops shop on shop.id = stop.shop_id
    where stop.round_id = '${created.rows[0].round_id}'
    order by stop.sequence_no
  `);

  assert.deepEqual(stops.rows, [
    { code: 'Z999', sequence_no: 1 },
    { code: 'S001', sequence_no: 2 },
  ]);
});

test('area-order migration can be reapplied after its helper backup exists', async (t) => {
  const db = await createDatabase(t);

  await assert.doesNotReject(db.exec(areaGroupsMigration));
});

test('building reordering shifts competing positions atomically', async (t) => {
  const db = await createDatabase(t);
  const saved = await db.query(`
    select public.save_building_settings(
      '${CURRENT_BUILDING_ID}', 'CURRENT', 'Current Building', 1, true
    ) as building_id
  `);
  const ordered = await db.query(`
    select id, sort_order from public.buildings order by sort_order
  `);

  assert.equal(saved.rows[0].building_id, CURRENT_BUILDING_ID);
  assert.deepEqual(ordered.rows, [
    { id: CURRENT_BUILDING_ID, sort_order: 1 },
    { id: OLD_BUILDING_ID, sort_order: 2 },
  ]);
});

test('explicit null pagination uses the documented default page', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    insert into public.shops (id, code, name, building_id, zone_id)
    select md5('pagination-shop-' || value)::uuid,
      'P' || lpad(value::text, 3, '0'), 'Pagination Shop ' || value,
      '${OLD_BUILDING_ID}', '${OLD_ZONE_ID}'
    from generate_series(1, 101) value;

    insert into public.round_stops (
      id, shop_id, building_id_snapshot, building_name_snapshot, floor_or_zone_snapshot
    )
    select md5('pagination-stop-' || value)::uuid,
      md5('pagination-shop-' || value)::uuid,
      '${OLD_BUILDING_ID}', 'Old Building', 'Old Zone'
    from generate_series(1, 101) value;

    insert into public.delivery_events
    select md5('pagination-event-' || value)::uuid,
      md5('pagination-stop-' || value)::uuid,
      '${USER_ID}', 'active', '2026-08-01T03:00:00Z'::timestamptz
    from generate_series(1, 101) value;

    insert into public.delivery_charges
    select md5('pagination-charge-' || value)::uuid,
      md5('pagination-event-' || value)::uuid,
      md5('pagination-shop-' || value)::uuid,
      date '2026-08-01', 'immediate', null, 1, 'active'
    from generate_series(1, 101) value;
  `);

  const summary = await getSummary(db, '{}', 'null', 'null');
  const secondPage = await getSummary(db, '{}', '100', '100');
  const searched = await getSummary(db, '{"shop_search":"P101"}');
  const selectedShop = await getSummary(db, `{"shop_id":"${SHOP_ID}"}`);
  const paid = await getSummary(db, '{"payment_status":"paid"}');
  const overdue = await getSummary(db, '{"payment_status":"overdue"}');

  assert.equal(summary.total_count, 102);
  assert.equal(summary.rows.length, 100);
  assert.equal(summary.totals.sales_amount, 101);
  assert.equal(summary.rows[0].shop_code, 'P001');
  assert.equal(summary.rows.at(-1).shop_code, 'P100');
  assert.deepEqual(
    summary.rows.map((row) => row.shop_code),
    summary.rows.map((row) => row.shop_code).toSorted(),
  );
  assert.deepEqual(secondPage.rows.map((row) => row.shop_code), ['P101', 'S001']);
  assert.equal(secondPage.total_count, 102);
  assert.equal(secondPage.totals.sales_amount, 101);
  assert.deepEqual(searched.rows.map((row) => row.shop_code), ['P101']);
  assert.deepEqual(selectedShop.rows.map((row) => row.shop_code), ['S001']);
  assert.equal(paid.total_count, 1);
  assert.deepEqual(paid.rows.map((row) => row.shop_code), ['S001']);
  assert.equal(overdue.total_count, 101);
  await assert.rejects(
    getSummary(db, '{}', '0', '0'),
    /invalid accounting shop summary pagination/i,
  );
  await assert.rejects(
    getSummary(db, '{}', '501', '0'),
    /invalid accounting shop summary pagination/i,
  );
  await assert.rejects(
    getSummary(db, '{}', '100', '-1'),
    /invalid accounting shop summary pagination/i,
  );
});

test('migration adds an active charge-adjustment lookup index', async (t) => {
  const db = await createDatabase(t);

  const indexes = await db.query(`
    select indexdef
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'delivery_charge_adjustments'
      and indexname = 'delivery_charge_adjustments_active_charge_idx'
  `);

  assert.equal(indexes.rows.length, 1);
  assert.match(indexes.rows[0].indexdef, /\(charge_id\)/);
  assert.match(indexes.rows[0].indexdef, /where.*status.*active/i);
});

test('migration requests a PostgREST schema reload', async (t) => {
  const db = await createDatabase(t, { applyMigration: false });
  await db.exec(accountingMigration);
  const payloads = [];
  const unlisten = await db.listen('pgrst', (payload) => payloads.push(payload));

  await db.exec(activeShopsMigration);
  await new Promise((resolve) => setImmediate(resolve));
  await unlisten();

  assert.deepEqual(payloads, ['reload schema']);
});
