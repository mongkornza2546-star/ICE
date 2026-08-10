import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0146_accounting_shop_daily_matrix.sql', import.meta.url),
  'utf8',
);
const definition = migration.match(
  /create or replace function public\.get_accounting_shop_daily_matrix[\s\S]*?\n\$\$;/,
)?.[0] ?? '';

test('daily matrix validates role, date range, and selected shop scope', () => {
  assert.match(definition, /current_app_role\(\) not in \('admin', 'round_lead'\)/);
  assert.match(definition, /p_to_date - p_from_date > 30/);
  assert.match(definition, /unnest\(coalesce\(p_shop_ids/);
  assert.match(definition, /cardinality\(p_shop_ids\).*500/);
});

test('daily sales use effective active charges and corrected quantities', () => {
  assert.match(definition, /public\.effective_delivery_charge_amount\(charge\.id\)/);
  assert.match(definition, /charge\.status = 'active' and event\.status = 'active'/);
  assert.match(definition, /delivery_charge_adjustments[\s\S]*?adjustment\.status = 'active'/);
  assert.match(definition, /coalesce\(original\.quantity, 0\) \+ coalesce\(adjustment\.quantity_delta, 0\)/);
});

test('daily item JSON is preaggregated once before matrix cells are built', () => {
  const matrixRows = definition.match(
    /matrix_rows as materialized \([\s\S]*?\n  \), visible_ice_types/,
  )?.[0] ?? '';

  assert.match(definition, /daily_item_json as materialized \([\s\S]*?group by item\.shop_id, item\.service_date/);
  assert.match(definition, /left join daily_item_json item_json/);
  assert.notEqual(matrixRows, '');
  assert.doesNotMatch(matrixRows, /from daily_items/);
});

test('daily receipts follow the actual Bangkok payment date independently of sales', () => {
  assert.match(definition, /payment\.recorded_at at time zone 'Asia\/Bangkok'/);
  assert.match(definition, /sum\(payment\.allocated_amount\)/);
  assert.match(definition, /payment\.status = 'active'/);
  assert.match(definition, /'sales_amount'.*coalesce\(sales\.sales_amount, 0\)/s);
  assert.match(definition, /'cash_received'.*coalesce\(payment\.cash_received, 0\)/s);
});

test('daily matrix gives every blank state an explicit business meaning', () => {
  for (const status of [
    'purchased',
    'closed_shop',
    'no_purchase',
    'skipped',
    'recorded_no_sale',
    'not_recorded',
    'not_scheduled',
  ]) {
    assert.match(definition, new RegExp(`'${status}'`));
  }
});

test('daily matrix is executable only by authenticated users and reloads PostgREST', () => {
  assert.match(migration, /revoke all on function public\.get_accounting_shop_daily_matrix/);
  assert.match(migration, /grant execute on function public\.get_accounting_shop_daily_matrix[\s\S]*?to authenticated/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
});

test('daily matrix handles corrections, legacy zero-price rows, dedupe, and Bangkok dates', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role authenticated;
    create type public.shop_status as enum ('active', 'inactive');
    create type public.payment_term as enum ('immediate', 'end_of_day', 'credit');
    create type public.credit_due_rule as enum ('net_days', 'weekly', 'end_of_month');
    create type public.shop_round_status as enum ('pending', 'delivered', 'full_bin', 'closed_shop', 'no_access', 'issue');
    create function public.is_active_user() returns boolean language sql stable as $$ select true $$;
    create function public.current_app_role() returns text language sql stable as $$ select 'admin'::text $$;
    create table public.shops (id uuid primary key, status public.shop_status not null);
    create table public.shop_payment_profiles (
      shop_id uuid primary key references public.shops(id),
      allowed_payment_terms public.payment_term[] not null,
      default_payment_term public.payment_term not null,
      credit_due_rule public.credit_due_rule,
      credit_collection_weekday smallint,
      credit_days integer
    );
    create table public.delivery_rounds (id uuid primary key, service_date date not null, cancelled_at timestamptz);
    create table public.round_stops (
      id uuid primary key, shop_id uuid not null references public.shops(id),
      round_id uuid not null references public.delivery_rounds(id), status public.shop_round_status not null
    );
    create table public.delivery_events (
      id uuid primary key, round_stop_id uuid not null references public.round_stops(id), status text not null
    );
    create table public.delivery_charges (
      id uuid primary key, shop_id uuid not null references public.shops(id), service_date date not null,
      delivery_event_id uuid not null references public.delivery_events(id), status text not null,
      original_amount numeric(12,2) not null
    );
    create table public.ice_types (
      id uuid primary key, code text not null, name text not null, unit text not null, is_active boolean not null
    );
    create table public.delivery_items (
      delivery_event_id uuid not null references public.delivery_events(id),
      ice_type_id uuid not null references public.ice_types(id), quantity numeric(12,1) not null
    );
    create table public.delivery_charge_adjustments (
      idempotency_key uuid primary key, charge_id uuid not null references public.delivery_charges(id),
      amount_delta numeric(12,2) not null, status text not null
    );
    create table public.delivery_adjustment_items (
      adjustment_id uuid not null references public.delivery_charge_adjustments(idempotency_key),
      ice_type_id uuid not null references public.ice_types(id), quantity_delta numeric(12,1) not null
    );
    create or replace function public.effective_delivery_charge_amount(p_charge_id uuid)
    returns numeric language sql stable as $$
      select (charge.original_amount + coalesce(sum(adjustment.amount_delta)
        filter (where adjustment.status = 'active'), 0))::numeric
      from public.delivery_charges charge
      left join public.delivery_charge_adjustments adjustment on adjustment.charge_id = charge.id
      where charge.id = p_charge_id
      group by charge.id
    $$;
    create table public.payments (
      id uuid primary key, shop_id uuid not null references public.shops(id),
      allocated_amount numeric(12,2) not null, status text not null, recorded_at timestamptz not null
    );
  `);
  await db.exec(migration);
  await db.exec(`
    insert into public.shops values
      ('10000000-0000-4000-8000-000000000001', 'active'),
      ('10000000-0000-4000-8000-000000000002', 'active');
    insert into public.shop_payment_profiles values (
      '10000000-0000-4000-8000-000000000001', array['credit']::public.payment_term[],
      'credit', 'weekly', 5, null
    );
    insert into public.ice_types values
      ('20000000-0000-4000-8000-000000000001', 'MILL', 'โม่', 'ถุง', true),
      ('20000000-0000-4000-8000-000000000002', 'SMALL', 'เล็ก', 'ถุง', true);
    insert into public.delivery_rounds values
      ('30000000-0000-4000-8000-000000000001', '2026-08-07', null),
      ('30000000-0000-4000-8000-000000000002', '2026-08-09', null),
      ('30000000-0000-4000-8000-000000000003', '2026-08-10', null);
    insert into public.round_stops values
      ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001', 'delivered'),
      ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000002', 'delivered'),
      ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000003', 'delivered');
    insert into public.delivery_events values
      ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'active'),
      ('50000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', 'active'),
      ('50000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000003', 'active');
    insert into public.delivery_charges values
      ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        '2026-08-07', '50000000-0000-4000-8000-000000000001', 'active', 240),
      ('60000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
        '2026-08-09', '50000000-0000-4000-8000-000000000002', 'active', 240),
      ('60000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
        '2026-08-10', '50000000-0000-4000-8000-000000000003', 'active', 0);
    insert into public.delivery_items values
      ('50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 2),
      ('50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 2),
      ('50000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 2),
      ('50000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 2),
      ('50000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 3);
    insert into public.delivery_charge_adjustments values
      ('80000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002',
        -240, 'active'),
      ('80000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000002',
        100, 'voided');
    insert into public.delivery_adjustment_items values
      ('80000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', -2),
      ('80000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', -2),
      ('80000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 1),
      ('80000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 1);
    insert into public.payments values (
      '70000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
      120, 'active', '2026-08-08T00:30:00+07:00'
    );
  `);
  const result = await db.query(`
    select public.get_accounting_shop_daily_matrix(
      date '2026-08-07', date '2026-08-10',
      array[
        '10000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000002'
      ]::uuid[]
    ) as matrix
  `);
  const matrix = result.rows[0].matrix;
  assert.deepEqual(matrix.rows.map((row) => row.shop_id), [
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
  ]);

  const shop = matrix.rows[1];
  assert.equal(shop.payment_condition, 'เก็บทุกวันศุกร์');
  assert.equal(shop.days[0].status, 'purchased');
  assert.equal(shop.days[0].sales_amount, 240);
  assert.equal(shop.days[0].cash_received, 0);
  assert.equal(shop.days[1].status, 'not_scheduled');
  assert.equal(shop.days[1].sales_amount, 0);
  assert.equal(shop.days[1].cash_received, 120);
  assert.deepEqual(shop.days[0].items.map((item) => Number(item.quantity)), [2, 2]);
  assert.equal(shop.days[2].status, 'recorded_no_sale');
  assert.equal(shop.days[2].sales_amount, 0);
  assert.equal(shop.days[2].invoice_count, 1);
  assert.deepEqual(shop.days[2].items, []);
  assert.equal(shop.days[3].status, 'recorded_no_sale');
  assert.equal(shop.days[3].sales_amount, 0);
  assert.equal(shop.days[3].invoice_count, 1);
  assert.deepEqual(shop.days[3].items.map((item) => Number(item.quantity)), [3]);

  await assert.rejects(
    db.query(`
      select public.get_accounting_shop_daily_matrix(
        date '2026-08-01', date '2026-09-01', '{}'::uuid[]
      )
    `),
    /cannot exceed 31 days/i,
  );
  await assert.rejects(
    db.query(`
      select public.get_accounting_shop_daily_matrix(
        date '2026-08-07', date '2026-08-07',
        array(select '10000000-0000-4000-8000-000000000001'::uuid
          from generate_series(1, 501))
      )
    `),
    /cannot exceed 500 shops/i,
  );
  await db.exec(`
    create or replace function public.current_app_role()
    returns text language sql stable as $$ select 'driver'::text $$
  `);
  await assert.rejects(
    db.query(`
      select public.get_accounting_shop_daily_matrix(
        date '2026-08-07', date '2026-08-07', '{}'::uuid[]
      )
    `),
    /only a round lead or admin/i,
  );
});
