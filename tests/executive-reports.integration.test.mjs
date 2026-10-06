import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../supabase/migrations/0209_executive_reports.sql', import.meta.url), 'utf8');

function productionFunction(file, name) {
  const sql = readFileSync(new URL(`../supabase/migrations/${file}.sql`, import.meta.url), 'utf8');
  const start = sql.search(new RegExp(`create (?:or replace )?function public\\.${name}\\(`));
  assert.notEqual(start, -1, `Missing production function ${name}`);
  return sql.slice(start, sql.indexOf('$$;', start) + 3);
}

async function database(t) {
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
    create table public.shops (id uuid primary key, name text, building_id uuid);
    create table public.buildings (id uuid primary key, name text);
    create table public.round_stops (id uuid primary key, building_id_snapshot uuid,
      building_name_snapshot text, event_participation_id uuid);
    create table public.delivery_events (id uuid primary key, round_stop_id uuid,
      status text, recorded_at timestamptz);
    create table public.delivery_charges (id uuid primary key, delivery_event_id uuid,
      shop_id uuid, service_date date, due_date date, status text, original_amount numeric,
      event_settlement_context_id uuid, charge_number text,
      tank_rental_id uuid, event_tank_rental_id uuid);
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
      fulfillment_mode text default 'measured', source_stock_location_id uuid);
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
      service_date date);
    create table public.stock_movement_items (movement_id uuid, ice_type_id uuid, quantity numeric);
  `);
  await db.exec(productionFunction('0128_delivery_corrections_refunds_and_adjustments', 'effective_delivery_charge_amount'));
  await db.exec(productionFunction('0179_casual_loose_stock_conversion', 'casual_loose_stock_totals'));
  await db.exec(productionFunction('0189_event_tank_rental_billing', 'charge_line_items'));
  // Use the production default grants so private helpers cannot pass security
  // tests merely because the fixture omitted inherited EXECUTE privileges.
  await db.exec(readFileSync(new URL('../supabase/migrations/0040_fix_supabase_linter_security_warnings.sql', import.meta.url), 'utf8'));
  await db.exec(migration);
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
  }
  await db.exec(`select set_config('test.app_role', 'admin', false), set_config('test.active', 'true', false)`);
  assert.equal((await db.query(`select public.get_executive_report('2026-09-01', '2026-09-02') as report`)).rows[0].report.sales, 0);
  assert.equal((await db.query(`select public.get_executive_report_details('2026-09-01', '2026-09-02', 'sales') as details`)).rows[0].details.total, 0);
  assert.equal((await db.query(`select public.get_executive_report_invoice('50000000-0000-4000-8000-000000000001') as invoice`)).rows[0].invoice, null);
});

test('the facts helper stays private under production default grants', async (t) => {
  const db = await database(t);
  await db.exec(`select set_config('test.app_role', 'courier', false); set role authenticated`);
  await assert.rejects(db.query(`select * from public.executive_report_facts('2026-09-01', '2026-09-02')`), /permission denied for function executive_report_facts/);
  await db.exec('reset role; set role anon');
  await assert.rejects(db.query(`select * from public.executive_report_facts('2026-09-01', '2026-09-02')`), /permission denied for function executive_report_facts/);
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
  assert.equal((await getReport('2026-09-01', '2026-09-01')).products[0].delivered, 1);
  assert.equal((await getReport('2026-09-02', '2026-09-02')).products[0].delivered, 4);
  await db.exec(`update public.casual_transactions set status = 'voided' where id = 'a0000000-0000-4000-8000-000000000004'`);
  assert.equal((await getReport('2026-09-01', '2026-09-02')).products[0].delivered, 3, 'voids recompute converted quantities');
});
