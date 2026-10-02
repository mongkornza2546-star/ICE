import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0201_accounting_daily_tanks_payment_split.sql', import.meta.url),
  'utf8',
);

test('daily accounting exposes tank handoffs from every supported tank source', () => {
  assert.match(migration, /public\.shop_rented_tanks/);
  assert.match(migration, /public\.shop_tank_rentals/);
  assert.match(migration, /public\.event_tank_register/);
  assert.match(migration, /'tank_quantity'/);
});

test('daily accounting splits cash from bank transfer and QR', () => {
  assert.match(migration, /payment\.payment_method = 'cash'/);
  assert.match(migration, /payment\.payment_method in \('bank_transfer', 'qr'\)/);
  assert.match(migration, /'transfer_received'/);
  assert.match(migration, /confirmation\.refund_method in \('bank_transfer', 'qr'\)/);
});

test('the replacement reader preserves authorization and reloads PostgREST', () => {
  assert.match(migration, /get_accounting_shop_daily_matrix_before_tank_payment_split/);
  assert.match(migration, /revoke all on function public\.get_accounting_shop_daily_matrix/);
  assert.match(migration, /grant execute on function public\.get_accounting_shop_daily_matrix[\s\S]*to authenticated/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
});

test('the database reader combines tank sources and payment channels without losing prior values', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');
    create table public.shop_rented_tanks (shop_id uuid not null, rented_at date not null);
    create table public.shop_tank_rentals (id uuid primary key, shop_id uuid not null, quantity integer not null, handed_out_on date not null);
    create table public.event_participations (id uuid primary key, shop_id uuid not null);
    create table public.event_tank_register (id uuid primary key, event_participation_id uuid not null, movement_kind text not null, quantity integer not null, service_date date not null);
    create table public.delivery_charges (
      id uuid primary key, tank_rental_id uuid, event_tank_rental_id uuid,
      status text not null, original_amount numeric(12,2) not null
    );
    create function public.effective_delivery_charge_amount(p_charge_id uuid)
    returns numeric language sql stable as $$
      select original_amount from public.delivery_charges where id = p_charge_id
    $$;
    create table public.payments (
      shop_id uuid not null, payment_method public.payment_method not null,
      allocated_amount numeric(12,2) not null, status text not null, recorded_at timestamptz not null
    );
    create table public.casual_transactions (
      transaction_kind text not null, payment_method public.payment_method,
      sale_amount numeric(12,2) not null, recorded_at timestamptz not null
    );
    create table public.casual_refund_confirmations (
      refund_method public.payment_method not null, refunded_amount numeric(12,2) not null,
      confirmed_at timestamptz not null
    );
    create function public.get_accounting_shop_daily_matrix(date, date, uuid[])
    returns jsonb language sql stable security definer as $$
      select jsonb_build_object(
        'ice_types', '[]'::jsonb,
        'rows', jsonb_build_array(jsonb_build_object(
          'shop_id', '10000000-0000-4000-8000-000000000001',
          'payment_condition', 'เก็บท้ายวัน',
          'days', jsonb_build_array(jsonb_build_object(
            'service_date', '2026-10-01', 'status', 'purchased', 'items', '[]'::jsonb,
            'sales_amount', 100, 'cash_received', 60, 'invoice_count', 1
          ))
        )),
        'casual_days', jsonb_build_array(jsonb_build_object(
          'service_date', '2026-10-01', 'items', '[]'::jsonb, 'sales_amount', 150,
          'cash_received', 150, 'cash_refunded', 25, 'transaction_count', 3
        ))
      )
    $$;
  `);
  await db.exec(migration);
  await db.exec(`
    insert into public.shop_rented_tanks values ('10000000-0000-4000-8000-000000000001', '2026-10-01');
    insert into public.shop_tank_rentals values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 2, '2026-10-01');
    insert into public.event_participations values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
    insert into public.event_tank_register values ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'handoff', 3, '2026-10-01');
    insert into public.delivery_charges values
      ('50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', null, 'active', 200),
      ('50000000-0000-4000-8000-000000000002', null, '40000000-0000-4000-8000-000000000001', 'active', 300);
    insert into public.payments values
      ('10000000-0000-4000-8000-000000000001', 'cash', 30, 'active', '2026-10-01T12:00:00+07:00'),
      ('10000000-0000-4000-8000-000000000001', 'bank_transfer', 20, 'active', '2026-10-01T12:00:00+07:00'),
      ('10000000-0000-4000-8000-000000000001', 'qr', 10, 'active', '2026-10-01T12:00:00+07:00');
    insert into public.casual_transactions values
      ('paid', 'cash', 50, '2026-10-01T12:00:00+07:00'),
      ('paid', 'bank_transfer', 60, '2026-10-01T12:00:00+07:00'),
      ('paid', 'qr', 40, '2026-10-01T12:00:00+07:00');
    insert into public.casual_refund_confirmations values
      ('cash', 10, '2026-10-01T13:00:00+07:00'),
      ('bank_transfer', 15, '2026-10-01T13:00:00+07:00');
  `);
  const response = await db.query(`
    select public.get_accounting_shop_daily_matrix(
      '2026-10-01', '2026-10-01',
      array['10000000-0000-4000-8000-000000000001']::uuid[]
    ) as result
  `);
  const result = response.rows[0].result;
  assert.deepEqual(result.rows[0].days[0], {
    cash_received: 30,
    invoice_count: 1,
    items: [],
    sales_amount: 100,
    service_date: '2026-10-01',
    status: 'purchased',
    tank_quantity: 6,
    transfer_received: 30,
  });
  assert.deepEqual(result.casual_days[0], {
    cash_received: 50,
    cash_refunded: 10,
    items: [],
    sales_amount: 150,
    service_date: '2026-10-01',
    transaction_count: 3,
    transfer_received: 100,
    transfer_refunded: 15,
  });
});
