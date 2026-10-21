import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../supabase/migrations/0209_executive_reports.sql', import.meta.url), 'utf8');
const salesAndAgingMigration = readFileSync(new URL('../supabase/migrations/0244_executive_sales_and_aging.sql', import.meta.url), 'utf8');

function productionFunction(file, name) {
  const sql = readFileSync(new URL(`../supabase/migrations/${file}.sql`, import.meta.url), 'utf8');
  const start = sql.search(new RegExp(`create (?:or replace )?function public\\.${name}\\(`));
  assert.notEqual(start, -1, `Missing production function ${name}`);
  return sql.slice(start, sql.indexOf('$$;', start) + 3);
}

async function database(t, { salesAndAging = true } = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role authenticated;
    create role anon;
    create role service_role;
    create function public.is_active_user() returns boolean language sql stable as
      $$ select coalesce(current_setting('test.active', true), 'true')::boolean $$;
    create function public.current_app_role() returns text language sql stable as
      $$ select current_setting('test.app_role', true) $$;
    create table public.shops (id uuid primary key, name text, building_id uuid, status text default 'active', event_job_id uuid);
    create table public.buildings (id uuid primary key, name text, code text);
    create table public.round_stops (id uuid primary key, building_id_snapshot uuid,
      building_name_snapshot text, event_participation_id uuid);
    create table public.delivery_events (id uuid primary key, round_stop_id uuid,
      status text, recorded_at timestamptz);
    create table public.delivery_charges (id uuid primary key, delivery_event_id uuid,
      shop_id uuid, service_date date, due_date date, status text, original_amount numeric,
      event_settlement_context_id uuid, charge_number text,
      tank_rental_id uuid, event_tank_rental_id uuid, vat_amount numeric not null default 0);
    create table public.shop_tank_rentals (id uuid primary key, quantity integer,
      unit_price numeric, total_amount numeric generated always as (quantity * unit_price) stored,
      shop_location_snapshot text, recorded_at timestamptz);
    create table public.event_tank_register (id uuid primary key, quantity integer,
      rental_unit_price numeric, recorded_at timestamptz);
    create table public.event_settlement_contexts (id uuid primary key, event_participation_id uuid);
    create table public.event_participations (id uuid primary key, event_job_id uuid);
    create table public.event_jobs (id uuid primary key, name text);
    create table public.payments (id uuid primary key, shop_id uuid, allocated_amount numeric,
      payment_method text, recorded_at timestamptz, status text);
    create table public.payment_allocations (payment_id uuid, charge_id uuid, amount numeric);
    create table public.refund_obligations (id uuid primary key, payment_id uuid);
    create table public.refund_settlements (idempotency_key uuid primary key,
      obligation_id uuid, amount numeric, refund_method text, settled_at timestamptz);
    create table public.casual_transactions (id uuid primary key, service_date date,
      ice_type_id uuid, transaction_kind text, status text, sale_amount numeric,
      quantity numeric, payment_method text, recorded_at timestamptz,
      fulfillment_mode text default 'measured', source_stock_location_id uuid, sale_building_id uuid references public.buildings(id));
    create table public.casual_loose_stock_prices (service_date date,
      source_stock_location_id uuid, ice_type_id uuid, unit_price numeric);
    create table public.casual_refund_confirmations (transaction_id uuid,
      refunded_amount numeric, refund_method text, confirmed_at timestamptz);
    create table public.ice_types (id uuid primary key, name text, unit text, code text);
    create table public.delivery_items (delivery_event_id uuid, ice_type_id uuid,
      quantity numeric, unit_price numeric, line_total numeric);
    create table public.delivery_charge_adjustments (idempotency_key uuid primary key,
      charge_id uuid, status text, amount_delta numeric);
    create table public.delivery_adjustment_items (adjustment_id uuid, ice_type_id uuid,
      quantity_delta numeric);
    create table public.stock_movements (id uuid primary key, kind text, status text,
      service_date date, from_location_id uuid);
    create table public.stock_locations (id uuid primary key, name text, building_id uuid);
    create table public.stock_movement_items (movement_id uuid, ice_type_id uuid, quantity numeric);
  `);
  await db.exec(productionFunction('0128_delivery_corrections_refunds_and_adjustments', 'effective_delivery_charge_amount'));
  await db.exec(productionFunction('0179_casual_loose_stock_conversion', 'casual_loose_stock_totals'));
  await db.exec(productionFunction('0189_event_tank_rental_billing', 'charge_line_items'));
  // Use the production default grants so private helpers cannot pass security
  // tests merely because the fixture omitted inherited EXECUTE privileges.
  await db.exec(readFileSync(new URL('../supabase/migrations/0040_fix_supabase_linter_security_warnings.sql', import.meta.url), 'utf8'));
  await db.exec(migration);
  await db.exec(readFileSync(new URL('../supabase/migrations/0224_executive_report_volume_by_building.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/0225_executive_report_insights.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/0226_executive_quiet_shops_exclude_event_booths.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/0227_executive_sales_navigation.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/0228_executive_daily_comparison.sql', import.meta.url), 'utf8'));
  if (salesAndAging) await db.exec(salesAndAgingMigration);
  await db.exec(readFileSync(new URL('../supabase/migrations/0252_executive_volume_sale_building.sql', import.meta.url), 'utf8'));
  await db.exec(`select set_config('test.app_role', 'admin', false)`);
  return db;
}

test('executive report separates sales, old-debt receipts, refunds, and current debt', async (t) => {
  const db = await database(t);
  await db.exec(`
    insert into public.buildings values ('10000000-0000-4000-8000-000000000001', 'อาคาร A');
    insert into public.shops values ('20000000-0000-4000-8000-000000000001', 'ร้านหนึ่ง', '10000000-0000-4000-8000-000000000001');
    insert into public.round_stops values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'อาคาร A', null);
    insert into public.delivery_events values
      ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'active', '2026-09-01T04:00:00Z'),
      ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', 'active', '2026-08-20T04:00:00Z');
    insert into public.delivery_charges values
      ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '2026-09-01', null, 'active', 100, null),
      ('50000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '2026-08-20', null, 'active', 80, null);
    insert into public.payments values
      ('60000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 30, 'cash', '2026-09-01T05:00:00Z', 'active');
    insert into public.payment_allocations values
      ('60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', 30);
    insert into public.refund_obligations values ('70000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001');
    insert into public.refund_settlements values ('80000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 5, 'cash', '2026-09-02T05:00:00Z');
    insert into public.ice_types values ('90000000-0000-4000-8000-000000000001', 'น้ำแข็ง', 'ถุง');
    insert into public.delivery_items values ('40000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 4);
    insert into public.casual_transactions values
      ('a0000000-0000-4000-8000-000000000001', '2026-09-02', '90000000-0000-4000-8000-000000000001', 'paid', 'active', 20, 1, 'cash', '2026-09-02T06:00:00Z');
  `);
  const result = await db.query(`select public.get_executive_report('2026-09-01', '2026-09-02') as report`);
  const report = result.rows[0].report;
  assert.equal(report.sales, 120);
  assert.equal(report.receipts, 50);
  assert.equal(report.refunds, 5);
  assert.equal(report.netReceipts, 45);
  assert.equal(report.outstanding, 150);
  assert.equal(report.overdue, 150);
  assert.equal(report.debtors, 1);
  assert.equal(report.deliveryCount, 1);
  assert.equal(report.trend.length, 2);
  assert.equal(report.products[0].delivered, 5);
  assert.deepEqual(report.dailyTrend.map(day => [day.date, day.sales, day.products[0]?.delivered]),
    [['2026-09-01', 100, 4], ['2026-09-02', 20, 1]]);
  assertVolumeReconciles(report);
  const oldDebtPayment = await db.query(`select public.get_executive_report_details(
    '2026-09-01', '2026-09-02', 'receipts') as details`);
  assert.equal(oldDebtPayment.rows[0].details.total, 2);
  const debt = await db.query(`select public.get_executive_report_details(
    '2026-09-01', '2026-09-02', 'debt') as details`);
  assert.equal(debt.rows[0].details.total, 1);
  assert.equal(debt.rows[0].details.rows[0].amount, 150);
  const shopDebt = await db.query(`select public.get_executive_report_details(
    '2026-09-01', '2026-09-02', 'debt', 50, 0, null, null, null,
    '20000000-0000-4000-8000-000000000001') as details`);
  assert.equal(shopDebt.rows[0].details.total, 2);
  const invoice = await db.query(`select public.get_executive_report_invoice(
    '50000000-0000-4000-8000-000000000001') as invoice`);
  assert.equal(invoice.rows[0].invoice.total, 100);
  assert.equal(invoice.rows[0].invoice.items[0].quantity, 4);
});

test('only active admins can call the report endpoints as authenticated users', async (t) => {
  const db = await database(t);
  await db.exec('set role authenticated');
  for (const [role, active] of [['round_lead', 'true'], ['courier', 'true'], ['admin', 'false']]) {
    await db.query(`select set_config('test.app_role', $1, false), set_config('test.active', $2, false)`, [role, active]);
    await assert.rejects(db.query(`select public.get_executive_report('2026-09-01', '2026-09-02')`), /Only an active admin/);
    await assert.rejects(db.query(`select public.get_executive_report_details('2026-09-01', '2026-09-02', 'debt')`), /Only an active admin/);
    await assert.rejects(db.query(`select public.get_executive_report_invoice('50000000-0000-4000-8000-000000000001')`), /Only an active admin/);
    await assert.rejects(db.query(`select public.get_executive_report_aging_details('days31plus')`), /Only an active admin/);
  }
  await db.exec(`select set_config('test.app_role', 'admin', false), set_config('test.active', 'true', false)`);
  assert.equal((await db.query(`select public.get_executive_report('2026-09-01', '2026-09-02') as report`)).rows[0].report.sales, 0);
  assert.equal((await db.query(`select public.get_executive_report_details('2026-09-01', '2026-09-02', 'sales') as details`)).rows[0].details.total, 0);
  assert.equal((await db.query(`select public.get_executive_report_invoice('50000000-0000-4000-8000-000000000001') as invoice`)).rows[0].invoice, null);
  assert.deepEqual((await db.query(`select public.get_executive_report_aging_details('days31plus') as details`)).rows[0].details, { total: 0, rows: [] });
  await db.exec(`select set_config('test.app_role', '', false)`);
  await assert.rejects(db.query(`select public.get_executive_report_aging_details('days31plus')`), /Only an active admin/);
  await db.exec('reset role; set role anon');
  await assert.rejects(db.query(`select public.get_executive_report_aging_details('days31plus')`), /permission denied for function get_executive_report_aging_details/);
});

test('the facts helper stays private under production default grants', async (t) => {
  const db = await database(t);
  await db.exec(`select set_config('test.app_role', 'courier', false); set role authenticated`);
  await assert.rejects(db.query(`select * from public.executive_report_facts('2026-09-01', '2026-09-02')`), /permission denied for function executive_report_facts/);
  await assert.rejects(db.query(`select public.executive_report_volume_areas('2026-09-01', '2026-09-02')`), /permission denied for function executive_report_volume_areas/);
  await assert.rejects(db.query(`select public.executive_report_insights('2026-09-01', '2026-09-02')`), /permission denied for function executive_report_insights/);
  await assert.rejects(db.query(`select public.executive_report_daily_trend('2026-09-01', '2026-09-02')`), /permission denied for function executive_report_daily_trend/);
  await db.exec('reset role; set role anon');
  await assert.rejects(db.query(`select public.executive_report_daily_trend('2026-09-01', '2026-09-02')`), /permission denied for function executive_report_daily_trend/);
  await assert.rejects(db.query(`select * from public.executive_report_facts('2026-09-01', '2026-09-02')`), /permission denied for function executive_report_facts/);
  await assert.rejects(db.query(`select public.executive_report_volume_areas('2026-09-01', '2026-09-02')`), /permission denied for function executive_report_volume_areas/);
  await assert.rejects(db.query(`select public.executive_report_insights('2026-09-01', '2026-09-02')`), /permission denied for function executive_report_insights/);
});

test('insights age current debt, split receipts by method and flag shops that stopped ordering', async (t) => {
  const db = await database(t);
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await db.exec(`
    create temporary table clock as select (now() at time zone 'Asia/Bangkok')::date as today;
    insert into buildings values ('${id(1)}', 'อาคาร A', 'A');
    insert into shops (id, name, building_id, status) values
      ('${id(2)}', 'ร้านประจำ', '${id(1)}', 'active'),
      ('${id(3)}', 'ร้านหายไป', '${id(1)}', 'active'),
      ('${id(4)}', 'ร้านปิดแล้ว', '${id(1)}', 'inactive'),
      ('${id(5)}', 'ร้านรายสัปดาห์', '${id(1)}', 'active');
    -- Rentals carry current debt without being reorder signals.
    insert into shop_tank_rentals (id, quantity, unit_price, recorded_at) values
      ('${id(10)}', 1, 100, now()), ('${id(11)}', 1, 50, now()), ('${id(12)}', 1, 40, now()),
      ('${id(13)}', 1, 70, now()), ('${id(14)}', 1, 30, now());
    insert into delivery_charges (id, shop_id, service_date, due_date, status, original_amount, tank_rental_id)
      select v.id::uuid, v.shop::uuid, clock.today - v.age, clock.today - v.age, 'active', v.amount, v.rental::uuid
      from clock, (values
        ('${id(20)}', '${id(2)}', 0, 100, '${id(10)}'),
        ('${id(21)}', '${id(2)}', 3, 50, '${id(11)}'),
        ('${id(22)}', '${id(3)}', 10, 40, '${id(12)}'),
        ('${id(23)}', '${id(3)}', 45, 70, '${id(13)}'),
        ('${id(24)}', '${id(2)}', 45, 30, '${id(14)}')) v(id, shop, age, amount, rental);
    insert into payments values
      ('${id(30)}', '${id(3)}', 15, 'cash', now(), 'active'),
      ('${id(31)}', '${id(2)}', 30, 'bank_transfer', now(), 'active'),
      ('${id(32)}', '${id(5)}', 20, 'qr', now(), 'active'),
      ('${id(33)}', '${id(2)}', 99, 'cash', now(), 'voided');
    insert into payment_allocations values ('${id(30)}', '${id(22)}', 15), ('${id(31)}', '${id(24)}', 30);
    insert into casual_transactions (id, service_date, transaction_kind, status, sale_amount, quantity, payment_method, recorded_at)
      select '${id(34)}', today, 'paid', 'active', 10, 1, 'cash', now() from clock;
    create temporary table seeded_orders as
      select gen_random_uuid() as event_id, gen_random_uuid() as charge_id, plan.shop::uuid as shop_id, clock.today - plan.age as day
      from clock, (
        select '${id(2)}' as shop, generate_series(2, 20, 2) as age
        union all select '${id(3)}', generate_series(30, 40, 2)
        union all select '${id(4)}', generate_series(30, 40, 2)
        union all select '${id(5)}', generate_series(12, 33, 7)
      ) plan;
    insert into delivery_events (id, status, recorded_at) select event_id, 'active', now() from seeded_orders;
    insert into delivery_charges (id, delivery_event_id, shop_id, service_date, due_date, status, original_amount)
      select charge_id, event_id, shop_id, day, day, 'active', 60 from seeded_orders;
    -- Settled long ago so orders disturb neither debt aging nor this period's receipts.
    insert into payments values ('${id(35)}', '${id(2)}', 0, 'cash', now() - interval '200 days', 'active');
    insert into payment_allocations select '${id(35)}', charge_id, 60 from seeded_orders;
  `);
  const report = (await db.query('select get_executive_report(today, today) as report from clock')).rows[0].report;
  const sum = (rows) => rows.reduce((total, row) => total + row.amount, 0);
  assert.deepEqual(report.debtAging, [
    { bucket: 'notDue', amount: 100, shops: 1 },
    { bucket: 'days1to7', amount: 50, shops: 1 },
    { bucket: 'days8to30', amount: 25, shops: 1 },
    { bucket: 'days31plus', amount: 70, shops: 1 },
  ]);
  assert.equal(sum(report.debtAging), report.outstanding);
  assert.equal(sum(report.debtAging.slice(1)), report.overdue);
  assert.deepEqual(report.receiptMethods, [
    { method: 'bank_transfer', amount: 30 }, { method: 'cash', amount: 25 }, { method: 'qr', amount: 20 },
  ]);
  assert.equal(sum(report.receiptMethods), report.receipts);
  // Weekly shop is 12 days quiet against a 7-day rhythm; the inactive shop is ignored.
  assert.equal(report.quietShops.total, 1);
  assert.deepEqual(report.quietShops.rows.map((row) => [row.name, row.building, row.daysSince, row.usualGap, row.monthlySales]),
    [['ร้านหายไป', 'อาคาร A', 30, 2, 981.82]]);
  assert.equal(report.quietShops.monthlySales, 981.82);
});

test('quiet-shop alerts exclude event booths and use sales excluding VAT while retaining gross debt', async (t) => {
  const db = await database(t);
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await db.exec(`
    create temporary table clock as select (now() at time zone 'Asia/Bangkok')::date as today;
    insert into buildings values ('${id(1)}', 'ตึก C', 'C');
    insert into event_jobs values ('${id(2)}', 'งานตึก C');
    insert into shops (id, name, building_id, status, event_job_id) values
      ('${id(3)}', 'บูธ 18', '${id(1)}', 'active', '${id(2)}'),
      ('${id(4)}', 'ร้านประจำ', '${id(1)}', 'active', null);
    -- Booth records stay active after the event ends. Both customers have
    -- the same five-day history, reproducing the 20-day false alert.
    create temporary table seeded_orders as
      select gen_random_uuid() as event_id, gen_random_uuid() as charge_id,
        shop.id as shop_id, today - age as day
      from clock, shops shop, generate_series(20, 24) age;
    insert into delivery_events (id, status, recorded_at)
      select event_id, 'active', day::timestamptz from seeded_orders;
    insert into delivery_charges (id, delivery_event_id, shop_id, service_date, due_date, status, original_amount, vat_amount)
      select charge_id, event_id, shop_id, day, day, 'active', 77.04, 5.04 from seeded_orders;
  `);
  const report = (await db.query('select get_executive_report(today - 30, today) as report from clock')).rows[0].report;
  assert.equal(report.quietShops.total, 1);
  assert.deepEqual(report.quietShops.rows.map((row) => [row.id, row.daysSince, row.usualGap, row.monthlySales]),
    [[id(4), 20, 1, 2160]]);
  assert.equal(report.quietShops.monthlySales, 2160);
  assert.equal(report.sales, 720);
  assert.equal(report.outstanding, 770.4);
  assert.equal(report.debtAging.reduce((sum, row) => sum + row.amount, 0), 770.4);
  assert.equal(report.deliveryCount, 10);
  assert.equal(report.shops.find((shop) => shop.id === id(3)).sales, 360);
  // SQL Editor users may re-run the migration after it was already applied.
  await db.exec(readFileSync(new URL('../supabase/migrations/0226_executive_quiet_shops_exclude_event_booths.sql', import.meta.url), 'utf8'));
  const rerun = (await db.query('select get_executive_report(today - 30, today) as report from clock')).rows[0].report;
  assert.deepEqual({ ...rerun, asOf: report.asOf }, report);
});

test('shop and event rentals reconcile across sales, debt, invoices, and export detail pages', async (t) => {
  const db = await database(t);
  const shop = '20000000-0000-4000-8000-000000000001';
  const building = '10000000-0000-4000-8000-000000000001';
  const job = 'b0000000-0000-4000-8000-000000000001';
  const rentalCharge = '50000000-0000-4000-8000-000000000001';
  const eventCharge = '50000000-0000-4000-8000-000000000002';
  await db.exec(`
    insert into public.buildings values ('${building}', 'อาคาร A');
    insert into public.shops values ('${shop}', 'ร้านหนึ่ง', '${building}');
    insert into public.event_jobs values ('${job}', 'งานประชุม');
    insert into public.event_participations values ('c0000000-0000-4000-8000-000000000001', '${job}');
    insert into public.event_settlement_contexts values
      ('d0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001');
    insert into public.shop_tank_rentals (id, quantity, unit_price, shop_location_snapshot, recorded_at) values
      ('a0000000-0000-4000-8000-000000000001', 2, 125, 'อาคาร A · ชั้น 1', '2026-09-01T04:00:00Z');
    -- Event tanks are handed out before their invoice's service date.
    insert into public.event_tank_register values
      ('a0000000-0000-4000-8000-000000000002', 3, 100, '2026-08-31T04:00:00Z');
    insert into public.delivery_charges (id, shop_id, service_date, due_date, status,
      original_amount, charge_number, tank_rental_id, event_tank_rental_id, event_settlement_context_id) values
      ('${rentalCharge}', '${shop}', '2026-09-01', '2026-09-01', 'active', 250, 'R-001',
        'a0000000-0000-4000-8000-000000000001', null, null),
      ('${eventCharge}', '${shop}', '2026-09-02', '2026-09-02', 'active', 300, 'R-002',
        null, 'a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001');
    insert into public.payments values
      ('60000000-0000-4000-8000-000000000001', '${shop}', 100, 'cash', '2026-09-02T05:00:00Z', 'active'),
      ('60000000-0000-4000-8000-000000000002', '${shop}', 50, 'cash', '2026-09-02T06:00:00Z', 'voided');
    insert into public.payment_allocations values
      ('60000000-0000-4000-8000-000000000001', '${rentalCharge}', 100),
      ('60000000-0000-4000-8000-000000000002', '${rentalCharge}', 50);
    insert into public.delivery_events values
      ('40000000-0000-4000-8000-000000000001', null, 'voided', '2026-09-02T04:00:00Z'),
      ('40000000-0000-4000-8000-000000000002', null, 'active', '2026-09-02T04:00:00Z');
    insert into public.delivery_charges (id, delivery_event_id, shop_id, service_date, status, original_amount) values
      ('50000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000001', '${shop}', '2026-09-02', 'active', 900),
      ('50000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000002', '${shop}', '2026-09-02', 'voided', 900);
    set role authenticated;
  `);
  const report = (await db.query(`select public.get_executive_report('2026-09-01', '2026-09-02') as report`)).rows[0].report;
  assert.equal(report.sales, 550);
  assert.equal(report.receipts, 100);
  assert.equal(report.outstanding, 450);
  assert.equal(report.overdue, 450);
  assert.equal(report.debtors, 1);
  assert.equal(report.deliveryCount, 0);
  assert.deepEqual(report.products, []);
  assert.deepEqual(report.trend.map(({ sales }) => sales), [250, 300]);
  assert.equal(report.shops[0].sales, 550);
  assert.deepEqual(report.areas, [
    { kind: 'event', id: job, name: 'งานประชุม', sales: 300 },
    { kind: 'building', id: building, name: 'อาคาร A', sales: 250 },
  ]);
  for (const [metric, expected] of [['sales', 550], ['receipts', 100], ['refunds', 0], ['debt', 450], ['overdue', 450]]) {
    const details = (await db.query(`select public.get_executive_report_details('2026-09-01', '2026-09-02', $1) as details`, [metric])).rows[0].details;
    assert.equal(details.rows.reduce((sum, row) => sum + row.amount, 0), expected, metric);
  }
  const areaDetails = (await db.query(`select public.get_executive_report_details(
    '2026-09-01', '2026-09-02', 'sales', 50, 0, '2026-09-02', 'event', $1) as details`, [job])).rows[0].details;
  assert.deepEqual(areaDetails.rows.map((row) => row.id), [eventCharge]);
  for (const metric of ['debt', 'overdue']) {
    const rows = [];
    for (let offset = 0; offset < 2; offset++) {
      const page = (await db.query(`select public.get_executive_report_details(
        '2026-09-01', '2026-09-02', $1, 1, $2, null, null, null, $3) as details`, [metric, offset, shop])).rows[0].details;
      assert.equal(page.total, 2);
      rows.push(...page.rows);
    }
    assert.deepEqual(rows.map((row) => [row.id, row.amount]), [[eventCharge, 300], [rentalCharge, 150]]);
  }
  for (const [id, name, quantity, total, paid, area] of [
    [rentalCharge, 'ค่าเช่าถังรายครั้ง', 2, 250, 100, 'อาคาร A · ชั้น 1'],
    [eventCharge, 'ค่าเช่าถังอีเวนต์', 3, 300, 0, 'งานประชุม'],
  ]) {
    const invoice = (await db.query('select public.get_executive_report_invoice($1) as invoice', [id])).rows[0].invoice;
    assert.equal(invoice.total, total);
    assert.equal(invoice.paid, paid);
    assert.equal(invoice.area, area);
    assert.equal(invoice.items[0].name, name);
    assert.equal(invoice.items[0].quantity, quantity);
    assert.equal(invoice.items[0].unit, 'ใบ');
    assert.equal(invoice.payments.reduce((sum, row) => sum + row.amount, 0), paid);
  }
  const later = (await db.query(`select public.get_executive_report('2026-09-03', '2026-09-04') as report`)).rows[0].report;
  assert.equal(later.sales, 0);
  assert.equal(later.previousSales, 550);
  assert.equal(later.outstanding, 450, 'current rental debt is independent of the selected period');
});

test('loose product quantities use daily stock conversion without double-counting measured sales', async (t) => {
  const db = await database(t);
  const ice = '90000000-0000-4000-8000-000000000001';
  const location = 'b0000000-0000-4000-8000-000000000001';
  const secondLocation = 'b0000000-0000-4000-8000-000000000002';
  await db.exec(`
    insert into public.ice_types values ('${ice}', 'น้ำแข็ง', 'ถุง');
    insert into public.casual_loose_stock_prices values
      ('2026-09-01', '${location}', '${ice}', 20),
      ('2026-09-02', '${location}', '${ice}', 20),
      ('2026-09-02', '${secondLocation}', '${ice}', 50),
      ('2026-08-31', '${location}', '${ice}', 20);
    insert into public.casual_transactions (id, service_date, ice_type_id, transaction_kind,
      status, sale_amount, quantity, payment_method, recorded_at, fulfillment_mode, source_stock_location_id) values
      ('a0000000-0000-4000-8000-000000000001', '2026-09-01', '${ice}', 'paid', 'active', 30, null, 'cash', '2026-09-01T04:00:00Z', 'loose', '${location}'),
      ('a0000000-0000-4000-8000-000000000002', '2026-09-02', '${ice}', 'paid', 'active', 30, null, 'cash', '2026-09-02T04:00:00Z', 'loose', '${location}'),
      ('a0000000-0000-4000-8000-000000000003', '2026-09-02', '${ice}', 'paid', 'active', 20, 1, 'cash', '2026-09-02T05:00:00Z', 'measured', '${location}'),
      ('a0000000-0000-4000-8000-000000000004', '2026-09-02', '${ice}', 'paid', 'active', 100, null, 'cash', '2026-09-02T06:00:00Z', 'loose', '${secondLocation}'),
      ('a0000000-0000-4000-8000-000000000005', '2026-09-02', '${ice}', 'paid', 'voided', 100, null, 'cash', '2026-09-02T07:00:00Z', 'loose', '${location}'),
      ('a0000000-0000-4000-8000-000000000006', '2026-08-31', '${ice}', 'paid', 'active', 100, null, 'cash', '2026-08-31T04:00:00Z', 'loose', '${location}');
  `);
  const getReport = async (from, to) => (await db.query('select public.get_executive_report($1, $2) as report', [from, to])).rows[0].report;
  const report = await getReport('2026-09-01', '2026-09-02');
  assert.equal(report.sales, 180);
  assert.equal(report.products[0].delivered, 5, 'floor per day/location, then add the one measured bag');
  assertVolumeReconciles(report);
  assert.equal(report.volumeAreas[0].kind, 'casual');
  assert.equal((await getReport('2026-09-01', '2026-09-01')).products[0].delivered, 1);
  assert.equal((await getReport('2026-09-02', '2026-09-02')).products[0].delivered, 4);
  await db.exec(`update public.casual_transactions set status = 'voided' where id = 'a0000000-0000-4000-8000-000000000004'`);
  assert.equal((await getReport('2026-09-01', '2026-09-02')).products[0].delivered, 3, 'voids recompute converted quantities');
});

test('volume reconciles by destination with corrections, events, damage-only buildings and stock locations', async (t) => {
  const db = await database(t);
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await db.exec(`
    insert into buildings values
      ('${id(1)}', 'อาคาร A', 'A'), ('${id(2)}', 'อาคาร B', 'B'),
      ('${id(3)}', 'อาคาร C', 'C'), ('${id(4)}', 'ตึกงาน', 'EVENT-${id(5)}');
    insert into event_jobs values ('${id(5)}', 'งานประชุม');
    insert into event_participations values ('${id(6)}', '${id(5)}');
    insert into event_settlement_contexts values ('${id(7)}', '${id(6)}');
    insert into shops values ('${id(8)}', 'ร้านที่ย้ายไปตึก B', '${id(2)}'), ('${id(9)}', 'ร้านไม่ระบุตึก', null);
    insert into ice_types values ('${id(10)}', 'หลอดเล็ก', 'ถุง'), ('${id(11)}', 'น้ำแข็งก้อน', 'แถว');
    insert into round_stops values
      ('${id(12)}', '${id(1)}', 'อาคาร A', null),
      ('${id(13)}', '${id(2)}', 'อาคาร B', null);
    insert into delivery_events values
      ('${id(20)}', '${id(12)}', 'active', '2026-09-01'),
      ('${id(21)}', '${id(13)}', 'active', '2026-09-01'),
      ('${id(22)}', '${id(13)}', 'active', '2026-09-01'),
      ('${id(23)}', null, 'active', '2026-09-01'),
      ('${id(24)}', '${id(12)}', 'cancelled', '2026-09-01'),
      ('${id(25)}', '${id(12)}', 'active', '2026-08-31');
    insert into delivery_charges (id, delivery_event_id, shop_id, service_date, status, original_amount, event_settlement_context_id) values
      ('${id(30)}', '${id(20)}', '${id(8)}', '2026-09-01', 'active', 100, null),
      ('${id(31)}', '${id(21)}', '${id(8)}', '2026-09-01', 'active', 100, null),
      ('${id(32)}', '${id(22)}', '${id(8)}', '2026-09-01', 'active', 100, '${id(7)}'),
      ('${id(33)}', '${id(23)}', '${id(9)}', '2026-09-01', 'active', 100, null),
      ('${id(34)}', '${id(24)}', '${id(8)}', '2026-09-01', 'cancelled', 100, null),
      ('${id(35)}', '${id(25)}', '${id(8)}', '2026-08-31', 'active', 100, null);
    insert into delivery_items values
      ('${id(20)}', '${id(10)}', 10), ('${id(20)}', '${id(11)}', 2),
      ('${id(21)}', '${id(10)}', 4), ('${id(22)}', '${id(10)}', 3),
      ('${id(23)}', '${id(10)}', 1), ('${id(24)}', '${id(10)}', 100), ('${id(25)}', '${id(10)}', 100);
    insert into delivery_charge_adjustments values
      ('${id(40)}', '${id(30)}', 'active', -5),
      ('${id(41)}', '${id(30)}', 'voided', 100),
      ('${id(42)}', '${id(34)}', 'active', 100);
    insert into delivery_adjustment_items values
      ('${id(40)}', '${id(10)}', -0.5), ('${id(41)}', '${id(10)}', 100), ('${id(42)}', '${id(10)}', 100);
    insert into stock_locations values
      ('${id(50)}', 'สต็อก A', '${id(1)}'), ('${id(51)}', 'สต็อก C', '${id(3)}'),
      ('${id(52)}', 'รถส่ง', null), ('${id(53)}', 'สต็อกงาน', '${id(4)}');
    insert into stock_movements values
      ('${id(60)}', 'damage', 'active', '2026-09-01', '${id(50)}'),
      ('${id(61)}', 'damage', 'active', '2026-09-01', '${id(51)}'),
      ('${id(62)}', 'damage', 'active', '2026-09-01', '${id(52)}'),
      ('${id(63)}', 'damage', 'active', '2026-09-01', '${id(53)}'),
      ('${id(64)}', 'damage', 'voided', '2026-09-01', '${id(50)}'),
      ('${id(65)}', 'damage', 'active', '2026-08-31', '${id(50)}');
    insert into stock_movement_items values
      ('${id(60)}', '${id(10)}', 0.5), ('${id(61)}', '${id(10)}', 1),
      ('${id(62)}', '${id(10)}', 2), ('${id(63)}', '${id(10)}', 0.5),
      ('${id(64)}', '${id(10)}', 100), ('${id(65)}', '${id(10)}', 100);
  `);
  const report = (await db.query(`select get_executive_report('2026-09-01', '2026-09-01') as report`)).rows[0].report;
  const area = (kind, key) => report.volumeAreas.find((row) => row.kind === kind && row.id === key);
  assert.equal(report.deliveryCount, 4);
  assert.equal(area('building', id(1)).products.find((p) => p.id === id(10)).delivered, 9.5, 'snapshot destination survives shop relocation');
  assert.equal(area('building', id(2)).products[0].delivered, 4, 'event-context delivery does not leak into the regular building');
  assert.equal(area('building', id(3)).products[0].delivered, 0, 'damage-only buildings remain visible');
  assert.equal(area('event', id(5)).products[0].delivered, 3);
  assert.equal(area('event', id(5)).products[0].damaged, 0.5);
  assert.equal(area('stock', id(52)).products[0].damaged, 2);
  assert.equal(area('unknown', null).products[0].delivered, 1);
  assertVolumeReconciles(report);
});

function assertVolumeReconciles(report) {
  assert.equal(report.dailyTrend.length, (Date.parse(report.to) - Date.parse(report.from)) / 86400000 + 1);
  assert.equal(report.dailyTrend.reduce((sum, day) => sum + day.sales, 0), report.sales);
  for (const product of report.products) {
    const delivered = report.dailyTrend.flatMap(day => day.products).filter(row => row.id === product.id)
      .reduce((sum, row) => sum + row.delivered, 0);
    assert.equal(delivered, product.delivered, `Daily quantity must reconcile for ${product.name}`);
  }
  const totals = new Map();
  for (const area of report.volumeAreas) for (const product of area.products) {
    const sum = totals.get(product.id) ?? { delivered: 0, damaged: 0 };
    sum.delivered += product.delivered;
    sum.damaged += product.damaged;
    totals.set(product.id, sum);
  }
  for (const product of report.products) {
    assert.deepEqual(totals.get(product.id), { delivered: product.delivered, damaged: product.damaged });
    totals.delete(product.id);
  }
  for (const sum of totals.values()) assert.deepEqual(sum, { delivered: 0, damaged: 0 });
}

test('quiet shops retain all candidates and renamed areas reconcile with drilldowns', async (t) => {
  const db =  await database(t);
  await db.exec(`
 create temporary table clock as select (now() at time zone 'Asia/Bangkok')::date as today;
 insert into buildings values ('10000000-0000-4000-8000-000000000001', 'New A', 'A');
 insert into shops (id,name,building_id) select gen_random_uuid(), 'Shop '||n, '10000000-0000-4000-8000-000000000001'::uuid from generate_series(1, 12) n;
 create temporary table seeded as select gen_random_uuid() as eid,gen_random_uuid() as cid,shop.id as sid,today-age as day from shops shop,clock,generate_series(20,24) age;
 insert into delivery_events(id,status,recorded_at) select eid,'active',day::timestamptz from seeded;
 insert into delivery_charges(id,delivery_event_id,shop_id,service_date,status,original_amount) select cid,eid,sid,day,'active',72 from seeded;
 `);
  const report = (await db.query('select get_executive_report(today,today) r from clock')).rows[0].r;
  const shop = report.quietShops.rows[0];
  const detail = (await db.query("select get_executive_report_details(today,today,'sales',50,0,null,null,null,$1) d from clock",[shop.id])).rows[0].d;
  const history = (await db.query("select get_executive_report_details(today-89,today,'sales',50,0,null,null,null,$1) d from clock",[shop.id])).rows[0].d;
  await db.exec(`
 insert into round_stops(id,building_id_snapshot,building_name_snapshot) values
 ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Old A'),
 ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001', 'New A');
 update delivery_events set round_stop_id = case when recorded_at::date = (select today-20 from clock) then '30000000-0000-4000-8000-000000000002'::uuid else '30000000-0000-4000-8000-000000000001'::uuid end;
 `);
  const areas = (await db.query('select get_executive_report(today-30,today) r from clock')).rows[0].r.areas;
  const areaDetails = (await db.query("select get_executive_report_details(today-30,today,'sales',100,0,null,'building','10000000-0000-4000-8000-000000000001') d from clock")).rows[0].d;
  assert.equal(report.quietShops.total, 12);
  assert.equal(report.quietShops.rows.length, 12);
  assert.equal(detail.total, 0);
  assert.equal(history.total, 5);
  assert.equal(areas.length, 1);
  assert.equal(areas[0].name, 'New A');
  assert.equal(areas[0].sales,areaDetails.rows.reduce((sum,row)=>sum+row.amount, 0));
  await db.exec(readFileSync(new URL('../supabase/migrations/0227_executive_sales_navigation.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/0228_executive_daily_comparison.sql', import.meta.url), 'utf8'));
  const rerun = (await db.query('select get_executive_report(today-30,today) r from clock')).rows[0].r;
  assert.deepEqual(rerun.areas, areas);
  assert.equal(rerun.quietShops.rows.length, 12);
});


test('daily comparison remains daily for long ranges, includes empty days, and migration is repeatable', async (t) => {
  const db = await database(t);
  await db.exec(readFileSync(new URL('../supabase/migrations/0228_executive_daily_comparison.sql', import.meta.url), 'utf8'));
  const report = (await db.query(`select public.get_executive_report('2024-01-01', '2024-12-31') as report`)).rows[0].report;
  assert.equal(report.trend.length, 12);
  assert.equal(report.dailyTrend.length, 366);
  assert.deepEqual(report.dailyTrend.find(day => day.date === '2024-02-29'), { date: '2024-02-29', sales: 0, products: [] });
  assertVolumeReconciles(report);
  await assert.rejects(db.query(`select public.get_executive_report('2024-01-01', '2025-01-01')`), /valid date range/);
});

test('sales exclude stored VAT consistently after adjustments while receipts, refunds and debt stay gross', async (t) => {
  const db = await database(t, { salesAndAging: false });
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await db.exec(`
    insert into buildings values ('${id(1)}', 'อาคาร A', 'A');
    insert into shops (id, name, building_id) values ('${id(2)}', 'ร้านมี VAT', '${id(1)}');
    insert into event_jobs values ('${id(3)}', 'งานประชุม');
    insert into event_participations values ('${id(4)}', '${id(3)}');
    insert into event_settlement_contexts values ('${id(5)}', '${id(4)}');
    insert into delivery_events (id, status, recorded_at) values
      ('${id(10)}', 'active', '2026-09-01T04:00:00Z'),
      ('${id(11)}', 'active', '2026-09-02T04:00:00Z'),
      ('${id(12)}', 'active', '2026-08-31T04:00:00Z'),
      ('${id(13)}', 'cancelled', '2026-09-01T05:00:00Z'),
      ('${id(14)}', 'active', '2026-09-01T06:00:00Z');
    insert into delivery_charges (id, delivery_event_id, shop_id, service_date, status, original_amount, vat_amount) values
      ('${id(20)}', '${id(10)}', '${id(2)}', '2026-09-01', 'active', 107, 7),
      ('${id(21)}', '${id(11)}', '${id(2)}', '2026-09-02', 'active', 60, 0),
      ('${id(22)}', '${id(12)}', '${id(2)}', '2026-08-31', 'active', 107, 7),
      ('${id(23)}', '${id(13)}', '${id(2)}', '2026-09-01', 'active', 1070, 70),
      ('${id(24)}', '${id(14)}', '${id(2)}', '2026-09-01', 'cancelled', 1070, 70);
    insert into delivery_charge_adjustments values
      ('${id(30)}', '${id(20)}', 'active', -20),
      ('${id(31)}', '${id(20)}', 'voided', 100);
    insert into shop_tank_rentals (id, quantity, unit_price, recorded_at)
      values ('${id(40)}', 1, 50, '2026-09-01T04:00:00Z');
    insert into event_tank_register values ('${id(41)}', 2, 100, '2026-09-02T04:00:00Z');
    insert into delivery_charges (id, shop_id, service_date, status, original_amount, vat_amount,
      tank_rental_id, event_tank_rental_id, event_settlement_context_id) values
      ('${id(42)}', '${id(2)}', '2026-09-01', 'active', 53.50, 3.50, '${id(40)}', null, null),
      ('${id(43)}', '${id(2)}', '2026-09-02', 'active', 214, 14, null, '${id(41)}', '${id(5)}');
    insert into payments values
      ('${id(50)}', '${id(2)}', 32.10, 'cash', '2026-09-01T04:00:00Z', 'active'),
      ('${id(51)}', '${id(2)}', 30, 'bank_transfer', '2026-09-02T04:00:00Z', 'active'),
      ('${id(52)}', '${id(2)}', 100, 'cash', '2026-09-01T04:00:00Z', 'voided');
    insert into payment_allocations values
      ('${id(50)}', '${id(22)}', 32.10), ('${id(51)}', '${id(20)}', 30),
      ('${id(52)}', '${id(20)}', 100);
    insert into refund_obligations values ('${id(60)}', '${id(51)}');
    insert into refund_settlements values ('${id(61)}', '${id(60)}', 5, 'bank_transfer', '2026-09-02T05:00:00Z');
    insert into casual_transactions (id, service_date, transaction_kind, status, sale_amount, quantity, payment_method, recorded_at) values
      ('${id(70)}', '2026-09-02', 'paid', 'active', 20, 1, 'cash', '2026-09-02T04:00:00Z'),
      ('${id(71)}', '2026-09-02', 'paid', 'voided', 15, 1, 'cash', '2026-09-02T05:00:00Z');
    insert into casual_refund_confirmations values ('${id(71)}', 15, 'cash', '2026-09-02T06:00:00Z');
  `);
  const readReport = async () => (await db.query(`select get_executive_report('2026-09-01', '2026-09-02') as report`)).rows[0].report;
  assert.equal((await readReport()).sales, 434.50, 'reproduces the former VAT-inclusive sales total');
  await db.exec(salesAndAgingMigration);
  const report = await readReport();
  assert.equal(report.sales, 410);
  assert.equal(report.salesBasis, 'excluding_vat');
  assert.equal(report.agingDetailsVersion, 1);
  assert.equal(report.previousSales, 100);
  assert.equal(report.receipts, 97.10);
  assert.equal(report.refunds, 20);
  assert.equal(report.netReceipts, 77.10);
  assert.equal(report.outstanding, 459.40);
  assert.equal(report.shops[0].sales, 390);
  assert.deepEqual(report.trend.map(row => row.sales), [130, 280]);
  assertVolumeReconciles(report);
  assert.equal(report.areas.reduce((sum, row) => sum + row.sales, 0), report.sales);
  const details = async (metric, limit = 100, offset = 0, bucket = null, areaKind = null, areaId = null, shopId = null) =>
    (await db.query(`select get_executive_report_details('2026-09-01', '2026-09-02',
      $1, $2, $3, $4, $5, $6, $7) as details`, [metric, limit, offset, bucket, areaKind, areaId, shopId])).rows[0].details;
  for (const [metric, expected] of [['sales', 410], ['receipts', 97.10], ['refunds', 20], ['debt', 459.40]]) {
    const result = await details(metric);
    assert.equal(Number(result.rows.reduce((sum, row) => sum + row.amount, 0).toFixed(2)), expected, metric);
  }
  const salesPages = [];
  for (let offset = 0; offset < 5; offset++) {
    const page = await details('sales', 1, offset);
    assert.equal(page.total, 5);
    salesPages.push(...page.rows);
  }
  assert.equal(new Set(salesPages.map(row => row.id)).size, 5);
  assert.equal(salesPages.reduce((sum, row) => sum + row.amount, 0), 410);
  for (const area of report.areas) {
    const page = await details('sales', 100, 0, null, area.kind, area.id);
    assert.equal(page.rows.reduce((sum, row) => sum + row.amount, 0), area.sales);
  }
  for (const day of report.trend) {
    const page = await details('sales', 100, 0, day.date);
    assert.equal(page.rows.reduce((sum, row) => sum + row.amount, 0), day.sales);
  }
  const shopDetails = await details('sales', 100, 0, null, null, null, id(2));
  assert.equal(shopDetails.rows.reduce((sum, row) => sum + row.amount, 0), report.shops[0].sales);
  for (const [charge, sales, vat, total, paid] of [
    [id(20), 80, 7, 87, 30], [id(21), 60, 0, 60, 0],
    [id(42), 50, 3.50, 53.50, 0], [id(43), 200, 14, 214, 0],
  ]) {
    const invoice = (await db.query('select get_executive_report_invoice($1) as invoice', [charge])).rows[0].invoice;
    assert.deepEqual([invoice.salesAmount, invoice.vatAmount, invoice.total, invoice.paid], [sales, vat, total, paid]);
    assert.equal(invoice.salesAmount + invoice.vatAmount, invoice.total);
  }
  await db.exec(salesAndAgingMigration);
  const repeated = await readReport();
  assert.deepEqual({ ...repeated, asOf: report.asOf }, report, 'migration is repeatable without subtracting VAT twice');
});

test('aging drilldowns preserve exact Bangkok bucket boundaries through shop grouping and invoice pagination', async (t) => {
  const db = await database(t);
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await db.exec(`
    select set_config('TimeZone', case
      when (now() at time zone 'Etc/GMT+12')::date <> (now() at time zone 'Asia/Bangkok')::date
      then 'Etc/GMT+12' else 'Pacific/Kiritimati' end, false);
    create temporary table clock as select (now() at time zone 'Asia/Bangkok')::date as today;
    insert into shops (id, name) values ('${id(1)}', 'ร้าน A'), ('${id(2)}', 'ร้าน B'), ('${id(3)}', 'ไม่มีหนี้');
    create temporary table debt_plan (charge_id uuid, shop_id uuid, age integer, amount numeric, vat numeric, event_status text, charge_status text);
    insert into debt_plan values
      ('${id(20)}', '${id(1)}', -1, 107, 7, 'active', 'active'),
      ('${id(21)}', '${id(1)}', 0, 20, 0, 'active', 'active'),
      ('${id(22)}', '${id(1)}', 1, 30, 0, 'active', 'active'),
      ('${id(23)}', '${id(1)}', 7, 40, 0, 'active', 'active'),
      ('${id(24)}', '${id(1)}', 8, 50, 0, 'active', 'active'),
      ('${id(25)}', '${id(1)}', 30, 60, 0, 'active', 'active'),
      ('${id(26)}', '${id(1)}', 31, 70, 0, 'active', 'active'),
      ('${id(27)}', '${id(1)}', 60, 80, 0, 'active', 'active'),
      ('${id(28)}', '${id(1)}', null, 90, 0, 'active', 'active'),
      ('${id(29)}', '${id(2)}', 31, 100, 0, 'active', 'active'),
      ('${id(30)}', '${id(2)}', 31, 100, 0, 'active', 'active'),
      ('${id(31)}', '${id(2)}', 31, 100, 0, 'active', 'active'),
      ('${id(32)}', '${id(2)}', 31, 1000, 0, 'cancelled', 'active'),
      ('${id(33)}', '${id(2)}', 31, 1000, 0, 'active', 'cancelled'),
      ('${id(34)}', '${id(2)}', 31, 0, 0, 'active', 'active');
    insert into delivery_events (id, status, recorded_at) select charge_id, event_status, now() from debt_plan;
    insert into delivery_charges (id, delivery_event_id, shop_id, service_date, due_date, status, original_amount, vat_amount)
      select charge_id, charge_id, shop_id, today - coalesce(age, 8), today - age, charge_status, amount, vat
      from debt_plan cross join clock;
    insert into delivery_charge_adjustments values
      ('${id(40)}', '${id(29)}', 'active', -10),
      ('${id(41)}', '${id(29)}', 'voided', 200);
    insert into payments values
      ('${id(50)}', '${id(1)}', 32.10, 'cash', now(), 'active'),
      ('${id(51)}', '${id(2)}', 210, 'cash', now(), 'active'),
      ('${id(52)}', '${id(2)}', 90, 'cash', now(), 'voided');
    insert into payment_allocations values
      ('${id(50)}', '${id(20)}', 32.10),
      ('${id(51)}', '${id(30)}', 100), ('${id(51)}', '${id(31)}', 110),
      ('${id(52)}', '${id(29)}', 90);
    insert into shop_tank_rentals (id, quantity, unit_price) values ('${id(60)}', 1, 25);
    insert into event_tank_register (id, quantity, rental_unit_price) values ('${id(61)}', 1, 35);
    insert into delivery_charges (id, shop_id, service_date, due_date, status, original_amount, tank_rental_id, event_tank_rental_id)
      select '${id(62)}'::uuid, '${id(2)}'::uuid, today - 31, today - 31, 'active', 25, '${id(60)}'::uuid, null::uuid from clock
      union all select '${id(63)}', '${id(2)}', today - 7, today - 7, 'active', 35, null, '${id(61)}' from clock;
    set role authenticated;
  `);
  const readAging = async (bucket, shopId = null, limit = 100, offset = 0) =>
    (await db.query('select get_executive_report_aging_details($1, $2, $3, $4) as details', [bucket, shopId, limit, offset])).rows[0].details;
  assert.equal((await db.query(`select current_date <> (now() at time zone 'Asia/Bangkok')::date as different`)).rows[0].different, true);
  const report = (await db.query(`select get_executive_report('2026-01-01', '2026-01-01') as report`)).rows[0].report;
  assert.equal(report.sales, 0, 'aging does not use the historical report period');
  assert.deepEqual(report.debtAging, [
    { bucket: 'notDue', amount: 94.90, shops: 1 },
    { bucket: 'days1to7', amount: 105, shops: 2 },
    { bucket: 'days8to30', amount: 200, shops: 1 },
    { bucket: 'days31plus', amount: 265, shops: 2 },
  ]);
  const expectedCharges = {
    notDue: [id(20), id(21)],
    days1to7: [id(22), id(23), id(63)],
    days8to30: [id(24), id(25), id(28)],
    days31plus: [id(26), id(27), id(29), id(62)],
  };
  for (const bucket of report.debtAging) {
    const shops = await readAging(bucket.bucket);
    assert.equal(shops.total, bucket.shops);
    assert.equal(shops.rows.reduce((sum, row) => sum + row.amount, 0), bucket.amount);
    const charges = [];
    for (const [offset, shop] of shops.rows.entries()) {
      const shopPage = await readAging(bucket.bucket, null, 1, offset);
      assert.deepEqual(shopPage.rows, [shop]);
      assert.equal(shopPage.total, bucket.shops);
      const allInvoices = await readAging(bucket.bucket, shop.shopId);
      const invoicePages = [];
      for (let invoiceOffset = 0; invoiceOffset < allInvoices.total; invoiceOffset++) {
        const page = await readAging(bucket.bucket, shop.shopId, 1, invoiceOffset);
        assert.equal(page.total, allInvoices.total);
        assert.equal(page.rows.length, 1);
        invoicePages.push(...page.rows);
      }
      assert.deepEqual(invoicePages, allInvoices.rows);
      assert.equal(invoicePages.reduce((sum, row) => sum + row.amount, 0), shop.amount);
      assert.ok(invoicePages.every(row => row.shopId === shop.shopId));
      charges.push(...invoicePages.map(row => row.id));
    }
    assert.deepEqual(charges.sort(), expectedCharges[bucket.bucket].sort());
    assert.deepEqual(await readAging(bucket.bucket, id(3)), { total: 0, rows: [] });
    const afterLastPage = await readAging(bucket.bucket, null, 1, shops.total);
    assert.deepEqual(afterLastPage, { total: shops.total, rows: [] });
  }
  assert.equal(report.debtAging.reduce((sum, row) => sum + row.amount, 0), report.outstanding);
  assert.equal(report.debtAging.slice(1).reduce((sum, row) => sum + row.amount, 0), report.overdue);
  for (const args of [
    ['invalid', null, 50, 0], [null, null, 50, 0],
    ['notDue', null, 0, 0], ['notDue', null, 101, 0], ['notDue', null, null, 0],
    ['notDue', null, 50, -1], ['notDue', null, 50, null],
  ]) {
    await assert.rejects(db.query('select get_executive_report_aging_details($1, $2, $3, $4)', args), /Invalid executive report aging detail request/);
  }
});

// Load the real accounting readers and their wrappers into the same database as
// executive reports. This catches scope drift that self-reconciliation misses.
async function accountingParityDatabase(t) {
  const db = await database(t);
  await db.exec(`
    create type payment_term as enum ('immediate', 'end_of_day', 'credit');
    alter table buildings add column sort_order integer default 1;
    alter table shops add column code text, add column zone_id uuid, add column delivery_sequence integer;
    create table building_zones(id uuid primary key, name text, sort_order integer);
    create table shop_payment_profiles(shop_id uuid, allowed_payment_terms payment_term[],
      default_payment_term payment_term, credit_due_rule text, credit_collection_weekday integer, credit_days integer);
    create table delivery_rounds(id uuid, service_date date, cancelled_at timestamptz);
    alter table round_stops add column round_id uuid, add column shop_id uuid, add column status text,
      add column floor_or_zone_snapshot text, add column destination_kind text,
      add column event_job_name_snapshot text, add column event_location_snapshot text,
      add column event_zone_snapshot text, add column event_booth_snapshot text;
    alter table delivery_events add column recorded_by uuid;
    create table users(id uuid primary key, display_name text);
    alter table delivery_charges add column payment_term payment_term default 'end_of_day',
      add column subtotal_amount numeric, add column vat_rate numeric default 0;
    alter table delivery_charge_adjustments add column scope text, add column corrected_total numeric,
      add column reason text, add column created_at timestamptz default now();
    alter table delivery_adjustment_items add column original_quantity numeric,
      add column corrected_quantity numeric, add column unit_price numeric;
    alter table payments add column evidence_path text, add column received_date_override date,
      add column entered_at timestamptz;
    alter table ice_types add column is_active boolean default true;
    create table shop_rented_tanks(shop_id uuid, rented_at date);
    alter table shop_tank_rentals add column shop_id uuid, add column handed_out_on date, add column recorded_by uuid;
    alter table event_tank_register add column event_participation_id uuid, add column movement_kind text,
      add column service_date date, add column recorded_by uuid;
    alter table event_jobs add column status text, add column start_date date, add column end_date date;
    alter table event_participations add column shop_id uuid, add column status text, add column start_date date, add column end_date date;
  `);
  const sql = (name) => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
  const block = (name, tag) => {
    const source = sql(name);
    const start = source.indexOf(`do $${tag}$`);
    assert.notEqual(start, -1);
    return source.slice(start, source.indexOf(`$${tag}$;`, start) + tag.length + 3);
  };
  await db.exec(productionFunction('0145_accounting_shop_summary_area_groups', 'get_accounting_shop_summary'));
  await db.exec('alter function get_accounting_shop_summary(date,date,jsonb,integer,integer) rename to get_accounting_shop_summary_without_casual');
  await db.exec(productionFunction('0154_casual_measured_transactions', 'get_accounting_shop_summary'));
  await db.exec(productionFunction('0144_accounting_all_active_shops', 'get_accounting_shop_invoice_detail'));
  await db.exec(sql('0146_accounting_shop_daily_matrix'));
  await db.exec(block('0152_semi_monthly_credit_collection_cycles', 'extend_accounting_payment_condition'));
  await db.exec(block('0171_event_ice_delivery_financial_closeout', 'accounting_invoice_event_projection'));
  // Other payment readers are unrelated to this fixture; execute the production
  // metadata patch only for the accounting endpoint loaded above.
  await db.exec(block('0204_payment_date_presentation_and_replay', 'payment_date_metadata')
    .replace('as targets(signature, row_alias) loop',
      "as targets(signature, row_alias) where signature like '%get_accounting_shop_invoice_detail%' loop"));
  await db.exec(productionFunction('0216_credit_shop_vat', 'charge_vat_totals'));
  for (const name of ['0180_accounting_casual_daily_matrix', '0199_accounting_event_date_scope',
    '0201_accounting_daily_tanks_payment_split', '0206_accounting_shop_code_numeric_order',
    '0211_accounting_payment_slip', '0212_accounting_received_cash_transfer_split', '0223_accounting_sales_exclude_vat']) {
    await db.exec(sql(name));
  }
  return db;
}

const parityMigration = readFileSync(new URL('../supabase/migrations/0245_accounting_executive_sales_parity.sql', import.meta.url), 'utf8');

test('accounting and executive RPCs reconcile rentals and inactive-shop history through daily rows, invoices and export pages', async (t) => {
  const db = await accountingParityDatabase(t);
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await db.exec(`
    insert into buildings(id,name,code) values ('${id(100)}','อาคาร A','A');
    insert into building_zones values ('${id(101)}','โซน A',1);
    insert into users values ('${id(102)}','ผู้บันทึก');
    insert into shops(id,name,code,building_id,zone_id,status)
      select ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
        'ร้าน ' || n, 'S' || n, '${id(100)}', '${id(101)}',
        case when n in (1,5) then 'active' else 'inactive' end from generate_series(1,7) n;
    insert into event_jobs values ('${id(110)}','งานที่จบแล้ว','cancelled','2026-08-01','2026-08-31');
    update shops set event_job_id='${id(110)}' where id='${id(3)}';
    insert into event_participations values ('${id(111)}','${id(110)}','${id(3)}','cancelled','2026-08-01','2026-08-31');
    insert into event_settlement_contexts values ('${id(112)}','${id(111)}');
    insert into ice_types(id,name,unit,code) values ('${id(103)}','น้ำแข็ง','ถุง','ICE');
    create temporary table sales_plan(charge_id uuid, shop_id uuid, day date, gross numeric, vat numeric, charge_status text, event_status text);
    insert into sales_plan values
      ('${id(20)}','${id(1)}','2026-09-01',107,7,'active','active'),
      ('${id(21)}','${id(2)}','2026-09-02',214,14,'active','active'),
      ('${id(22)}','${id(3)}','2026-09-01',321,21,'active','active'),
      ('${id(23)}','${id(1)}','2026-09-01',900,0,'voided','active'),
      ('${id(24)}','${id(2)}','2026-09-02',800,0,'active','cancelled'),
      ('${id(25)}','${id(2)}','2026-08-31',40,0,'active','active'),
      ('${id(26)}','${id(6)}','2026-08-31',40,0,'active','active'),
      ('${id(27)}','${id(7)}','2026-08-31',20,0,'active','active');
    insert into round_stops(id,shop_id,building_id_snapshot,building_name_snapshot,status,event_participation_id,destination_kind,event_job_name_snapshot)
      select charge_id,shop_id,'${id(100)}','อาคาร A','delivered',
        case when shop_id='${id(3)}' then '${id(111)}'::uuid end,
        case when shop_id='${id(3)}' then 'event' else 'regular' end,
        case when shop_id='${id(3)}' then 'งานที่จบแล้ว' end from sales_plan;
    insert into delivery_events(id,round_stop_id,status,recorded_at,recorded_by)
      select charge_id,charge_id,event_status,day::timestamp at time zone 'Asia/Bangkok','${id(102)}' from sales_plan;
    insert into delivery_charges(id,delivery_event_id,shop_id,service_date,due_date,status,original_amount,vat_amount,subtotal_amount,charge_number)
      select charge_id,charge_id,shop_id,day,day,charge_status,gross,vat,gross-vat,'C-' || charge_id from sales_plan;
    insert into delivery_items select charge_id,'${id(103)}',1,gross-vat,gross-vat from sales_plan;
    insert into delivery_charge_adjustments(idempotency_key,charge_id,status,amount_delta)
      values ('${id(30)}','${id(20)}','active',-20), ('${id(31)}','${id(20)}','voided',999);
    insert into shop_tank_rentals(id,shop_id,quantity,unit_price,handed_out_on,recorded_at,recorded_by)
      values ('${id(40)}','${id(1)}',1,50,'2026-08-31','2026-08-31T04:00:00Z','${id(102)}'),
        ('${id(41)}','${id(2)}',1,60,'2026-09-02','2026-09-02T04:00:00Z','${id(102)}');
    insert into event_tank_register(id,quantity,rental_unit_price,recorded_at,event_participation_id,movement_kind,service_date,recorded_by)
      values ('${id(42)}',2,35,'2026-08-31T04:00:00Z','${id(111)}','handoff','2026-08-31','${id(102)}');
    insert into delivery_charges(id,shop_id,service_date,due_date,status,original_amount,vat_amount,subtotal_amount,tank_rental_id,event_tank_rental_id,event_settlement_context_id,charge_number)
      values ('${id(43)}','${id(1)}','2026-09-02','2026-09-02','active',53.5,3.5,50,'${id(40)}',null,null,'RENT-1'),
        ('${id(44)}','${id(2)}','2026-09-02','2026-09-02','active',60,0,60,'${id(41)}',null,null,'RENT-2'),
        ('${id(45)}','${id(3)}','2026-09-02','2026-09-02','active',70,0,70,null,'${id(42)}','${id(112)}','EVENT-RENT');
    insert into payments(id,shop_id,allocated_amount,payment_method,recorded_at,status,evidence_path,received_date_override,entered_at)
      values ('${id(50)}','${id(1)}',10,'bank_transfer','2026-09-01T04:00:00Z','active','slip.jpg','2026-09-01','2026-09-02T04:00:00Z'),
        ('${id(51)}','${id(2)}',10,'cash','2026-09-01T04:00:00Z','active',null,null,null),
        ('${id(52)}','${id(6)}',40,'cash','2026-08-31T04:00:00Z','active',null,null,null),
        ('${id(53)}','${id(7)}',20,'qr','2026-09-01T04:00:00Z','active',null,null,null),
        ('${id(54)}','${id(1)}',99,'cash','2026-09-01T04:00:00Z','voided',null,null,null);
    insert into payment_allocations values ('${id(50)}','${id(43)}',10), ('${id(51)}','${id(25)}',10),
      ('${id(52)}','${id(26)}',40), ('${id(53)}','${id(27)}',20), ('${id(54)}','${id(20)}',99);
    insert into casual_transactions(id,service_date,transaction_kind,status,sale_amount,quantity,payment_method,recorded_at,ice_type_id)
      values ('${id(60)}','2026-09-01','paid','active',25,1,'cash','2026-09-01T04:00:00Z','${id(103)}'),
        ('${id(61)}','2026-09-01','paid','voided',10,1,'cash','2026-09-01T04:00:00Z','${id(103)}'),
        ('${id(62)}','2026-09-02','free','active',0,1,'cash','2026-09-02T04:00:00Z','${id(103)}');
    insert into casual_refund_confirmations values ('${id(61)}',10,'cash','2026-09-02T04:00:00Z');
  `);
  const summary = async (from = '2026-09-01', to = '2026-09-02', filters = {}, limit = 500, offset = 0) =>
    (await db.query('select get_accounting_shop_summary($1,$2,$3,$4,$5) as data', [from,to,filters,limit,offset])).rows[0].data;
  const executive = async (from = '2026-09-01', to = '2026-09-02') =>
    (await db.query('select get_executive_report($1,$2) as data',[from,to])).rows[0].data;
  const readDaily = async (from, to, ids) =>
    (await db.query('select get_accounting_shop_daily_matrix($1,$2,$3) as data',[from,to,ids])).rows[0].data;
  const invoices = async (shopId, filters = {}, limit = 500, offset = 0) =>
    (await db.query("select get_accounting_shop_invoice_detail($1,'2026-09-01','2026-09-02',$2,$3,$4) as data",[shopId,filters,limit,offset])).rows[0].data;
  const before = await summary();
  assert.equal(before.totals.sales_amount,80);
  assert.equal((await executive()).sales,785, 'reproduce the scope mismatch before 0245');
  await db.exec(parityMigration);
  await db.exec(parityMigration); // SQL Editor retries must preserve later patches.
  await db.exec('set role authenticated');
  const report = await executive();
  const after = await summary();
  assert.equal(after.totals.sales_amount,760);
  assert.equal(after.totals.sales_amount + after.totals.casual_sales_amount, report.sales);
  assert.equal(after.totals.cumulative_outstanding_amount, report.outstanding);
  assert.equal(after.totals.cumulative_overdue_amount, report.overdue);
  assert.equal(after.totals.cash_received_in_period + after.totals.casual_received_amount,report.receipts);
  assert.deepEqual(after.rows.map(row=>row.shop_id).sort(),[1,2,3,5,7].map(id).sort());
  assert.equal(after.facets.shops.length,5,'inactive empty or settled historical-only shops stay out');
  assert.equal(after.groups.reduce((sum,row)=>sum+row.sales_amount,0),760);
  const paged=[];
  for (let offset=0;offset<after.total_count;offset++) paged.push(...(await summary(undefined,undefined,{},1,offset)).rows);
  assert.deepEqual(paged,after.rows,'screen and Excel use the same full ordering and pagination');
  const daily = await readDaily('2026-09-01','2026-09-02',paged.map(row=>row.shop_id));
  assert.equal(daily.rows.length,paged.length);
  for (const row of paged) {
    const days=daily.rows.find(day=>day.shop_id===row.shop_id).days;
    assert.equal(days.reduce((sum,day)=>sum+day.sales_amount,0),row.sales_amount);
    assert.equal(days.reduce((sum,day)=>sum+day.invoice_count,0),row.invoice_count);
    const all=await invoices(row.shop_id);
    const period=all.filter(bill=>bill.service_date>='2026-09-01'&&bill.service_date<='2026-09-02');
    assert.equal(period.reduce((sum,bill)=>sum+bill.sales_amount,0),row.sales_amount);
    assert.equal(period.length,row.invoice_count);
    const invoicePages=[];
    for(let offset=0;offset<all.length;offset++) invoicePages.push(...await invoices(row.shop_id,{},1,offset));
    assert.deepEqual(invoicePages,all);
    assert.equal(new Set(invoicePages.map(bill=>bill.charge_id)).size,all.length);
    const filtered = await summary(undefined,undefined,{shop_id:row.shop_id});
    assert.equal(filtered.totals.sales_amount,row.sales_amount);
    assert.deepEqual(filtered.rows,[row]);
  }
  const regularRent=(await invoices(id(1))).find(bill=>bill.charge_id===id(43));
  assert.equal(regularRent.sales_amount,50);
  assert.equal(regularRent.total_amount,53.5);
  assert.equal(regularRent.outstanding_amount,43.5);
  assert.equal(regularRent.items[0].name,'ค่าเช่าถังรายครั้ง');
  assert.equal(regularRent.recorded_by_name,'ผู้บันทึก');
  assert.equal(regularRent.building_name,'อาคาร A');
  assert.equal(regularRent.payments[0].evidence_path,'slip.jpg');
  assert.equal(regularRent.payments[0].received_date_override,'2026-09-01');
  assert.ok(regularRent.payments[0].entered_at);
  const eventRent=(await invoices(id(3))).find(bill=>bill.charge_id===id(45));
  assert.equal(eventRent.items[0].name,'ค่าเช่าถังอีเวนต์');
  assert.equal(eventRent.event_name,'งานที่จบแล้ว');
  assert.equal(eventRent.destination_kind,'event');
  assert.equal(eventRent.event_participation_id,id(111));
  assert.ok((await invoices(id(1),{building_id:id(100)})).some(bill=>bill.charge_id===id(43)));
  const historical = await readDaily('2026-08-31','2026-09-02',[id(1),id(3)]);
  assert.equal(historical.rows[0].days[0].tank_quantity,1);
  assert.equal(historical.rows[0].days[0].sales_amount,0,'handoff date is not the rental invoice date');
  assert.equal(historical.rows[1].days[0].tank_quantity,2);
  for(const [from,to] of [['2026-09-01','2026-09-01'],['2026-09-02','2026-09-02'],['2026-08-31','2026-08-31']]) {
    const accounting=await summary(from,to);
    assert.equal(accounting.totals.sales_amount+accounting.totals.casual_sales_amount,(await executive(from,to)).sales);
  }
  await db.exec(`reset role; update shops set status='inactive' where id='${id(1)}'; set role authenticated`);
  assert.equal((await summary()).totals.sales_amount+after.totals.casual_sales_amount,(await executive()).sales,
    'deactivating an active shop must not erase historical sales');
  assert.equal((await readDaily('2026-09-01','2026-09-02',[id(1)])).rows[0].days.reduce((sum,day)=>sum+day.sales_amount,0),130);
});

test('accounting parity preserves role gates and keeps underlying readers private', async (t) => {
  const db=await accountingParityDatabase(t);
  await db.exec(parityMigration);
  await db.exec('set role authenticated');
  for(const name of ['get_accounting_shop_summary_without_casual','get_accounting_shop_daily_matrix_without_casual']) {
    const args=name.includes('summary')?"'2026-09-01','2026-09-02'":"'2026-09-01','2026-09-02','{}'::uuid[]";
    await assert.rejects(db.query(`select ${name}(${args})`),/permission denied/);
  }
  await db.exec("select set_config('test.app_role','employee',false)");
  await assert.rejects(db.query("select get_accounting_shop_summary('2026-09-01','2026-09-02')"),/Only a round lead or admin/);
  await assert.rejects(db.query("select get_accounting_shop_daily_matrix('2026-09-01','2026-09-02','{}')"),/Only a round lead or admin/);
  await db.exec("select set_config('test.app_role','round_lead',false)");
  assert.equal((await db.query("select get_accounting_shop_summary('2026-09-01','2026-09-02') as data")).rows[0].data.totals.sales_amount,0);
});

test('rental-only inactive shops and closed event booths remain in accounting with their outstanding bills', async (t) => {
  const db = await accountingParityDatabase(t);
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await db.exec(`
    insert into buildings(id,name) values ('${id(1)}','อาคาร');
    insert into building_zones values ('${id(2)}','โซน',1);
    insert into shops(id,name,code,building_id,zone_id,status,event_job_id) values
      ('${id(3)}','ร้านปิด','S3','${id(1)}','${id(2)}','inactive',null),
      ('${id(4)}','บูธงานที่จบแล้ว','EV4','${id(1)}','${id(2)}','active','${id(5)}');
    insert into event_jobs values ('${id(5)}','งานเก่า','cancelled','2026-08-01','2026-08-31');
    insert into event_participations values ('${id(6)}','${id(5)}','${id(4)}','cancelled','2026-08-01','2026-08-31');
    insert into event_settlement_contexts values ('${id(7)}','${id(6)}');
    insert into shop_tank_rentals(id,quantity,unit_price,shop_id,recorded_at)
      values ('${id(8)}',1,50,'${id(3)}','2026-09-01T04:00:00Z');
    insert into event_tank_register(id,quantity,rental_unit_price,event_participation_id,recorded_at)
      values ('${id(9)}',1,70,'${id(6)}','2026-09-01T04:00:00Z');
    insert into delivery_charges(id,shop_id,service_date,status,original_amount,subtotal_amount,tank_rental_id,event_tank_rental_id,event_settlement_context_id)
      values ('${id(10)}','${id(3)}','2026-09-01','active',50,50,'${id(8)}',null,null),
        ('${id(11)}','${id(4)}','2026-09-01','active',70,70,null,'${id(9)}','${id(7)}');
  `);
  await db.exec(parityMigration);
  for (const date of ['2026-09-01','2026-09-02']) {
    const { rows: [result] } = await db.query(`select
      get_accounting_shop_summary($1::date,$1::date) as accounting,
      get_executive_report($1::date,$1::date) as executive`, [date]);
    assert.equal(result.accounting.total_count,2,'include both rental-only shops even outside the invoice period when unpaid');
    assert.equal(result.accounting.totals.sales_amount,result.executive.sales);
    assert.equal(result.accounting.totals.cumulative_outstanding_amount,120);
    for (const shop of result.accounting.rows) {
      const { rows: [detail] } = await db.query('select get_accounting_shop_invoice_detail($1,$2,$2) as invoices', [shop.shop_id,date]);
      assert.equal(detail.invoices.length,1);
      assert.equal(detail.invoices[0].outstanding_amount,shop.cumulative_outstanding_amount);
    }
  }
});

test('volume attributes measured casual sales to their selling building and preserves unassigned and loose totals', async (t) => {
  const db = await database(t);
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await db.exec(`
    insert into buildings (id, name, code) values
      ('${id(1)}', 'Building A', 'A'), ('${id(2)}', 'Building B', 'B');
    insert into ice_types (id, name, unit) values ('${id(3)}', 'Ice', 'bag');
    insert into casual_loose_stock_prices values ('2026-09-01', '${id(4)}', '${id(3)}', 20);
    insert into casual_transactions (id, service_date, ice_type_id, transaction_kind, status,
      sale_amount, quantity, payment_method, recorded_at, fulfillment_mode, source_stock_location_id, sale_building_id) values
      ('${id(10)}', '2026-09-01', '${id(3)}', 'paid', 'active', 100, 5, 'cash', '2026-09-01T05:00:00Z', 'measured', '${id(4)}', '${id(1)}'),
      ('${id(11)}', '2026-09-01', '${id(3)}', 'paid', 'active', 80, 4, 'cash', '2026-09-01T05:00:00Z', 'measured', '${id(4)}', '${id(2)}'),
      ('${id(12)}', '2026-09-01', '${id(3)}', 'paid', 'active', 40, 2, 'cash', '2026-09-01T05:00:00Z', 'measured', '${id(4)}', null),
      ('${id(13)}', '2026-09-01', '${id(3)}', 'paid', 'active', 60, null, 'cash', '2026-09-01T05:00:00Z', 'loose', '${id(4)}', '${id(1)}'),
      ('${id(14)}', '2026-09-01', '${id(3)}', 'paid', 'active', 40, null, 'cash', '2026-09-01T05:00:00Z', 'loose', '${id(4)}', null),
      ('${id(15)}', '2026-09-01', '${id(3)}', 'free', 'active', 0, 9, null, '2026-09-01T05:00:00Z', 'measured', '${id(4)}', '${id(1)}'),
      ('${id(16)}', '2026-09-01', '${id(3)}', 'paid', 'voided', 140, 7, 'cash', '2026-09-01T05:00:00Z', 'measured', '${id(4)}', '${id(1)}'),
      ('${id(17)}', '2026-09-02', '${id(3)}', 'paid', 'active', 200, 10, 'cash', '2026-09-02T05:00:00Z', 'measured', '${id(4)}', '${id(1)}');
  `);
  const getReport = async () => (await db.query("select get_executive_report('2026-09-01', '2026-09-01') as report")).rows[0].report;
  const report = await getReport();
  assert.equal(report.products[0].delivered, 16);
  assert.equal(report.dailyTrend[0].products[0].delivered, 16);
  assert.deepEqual(report.volumeAreas.map(area => [area.kind, area.id, area.name, area.products[0].delivered]), [
    ['building', id(1), 'Building A', 5], ['building', id(2), 'Building B', 4], ['casual', null, 'ขายหน้ารถ', 7],
  ]);
  assertVolumeReconciles(report);
  await db.exec(readFileSync(new URL('../supabase/migrations/0252_executive_volume_sale_building.sql', import.meta.url), 'utf8'));
  assert.deepEqual((await getReport()).volumeAreas, report.volumeAreas, 'migration can be reapplied safely');
});
