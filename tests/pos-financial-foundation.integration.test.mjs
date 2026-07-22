import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migration = readFileSync(
  new URL('../supabase/migrations/0029_pos_financial_foundation.sql', import.meta.url),
  'utf8',
);
const adminSettingsFixMigration = readFileSync(
  new URL('../supabase/migrations/0037_admin_financial_settings_fixes.sql', import.meta.url),
  'utf8',
);
const bulkShopPriceMigration = readFileSync(
  new URL('../supabase/migrations/0041_bulk_shop_ice_type_prices.sql', import.meta.url),
  'utf8',
);

const USER_ID = '00000000-0000-4000-8000-000000000001';
const SHOP_ID = '00000000-0000-4000-8000-000000000002';
const ICE_TYPE_ID = '00000000-0000-4000-8000-000000000003';
const STOP_ID = '00000000-0000-4000-8000-000000000004';
const EVENT_ID = '00000000-0000-4000-8000-000000000005';
const ADMIN_ID = '00000000-0000-4000-8000-000000000006';
const OTHER_SHOP_ID = '00000000-0000-4000-8000-000000000007';
const SECOND_EVENT_ID = '00000000-0000-4000-8000-000000000008';
const CORRECTION_EVENT_ID = '00000000-0000-4000-8000-000000000009';
const ROUND_ID = '00000000-0000-4000-8000-000000000010';
const HIDDEN_ROUND_ID = '00000000-0000-4000-8000-000000000020';
const HIDDEN_STOP_ID = '00000000-0000-4000-8000-000000000021';
const HIDDEN_EVENT_ID = '00000000-0000-4000-8000-000000000022';

async function queryAsUser(db, userId, sql) {
  await db.query(`select set_config('app.test_user_id', $1, false)`, [userId]);
  await db.exec('set role authenticated');
  try {
    return await db.query(sql);
  } finally {
    await db.exec('reset role');
  }
}

async function createDatabase(t) {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto } });
  t.after(() => db.close());

  await db.exec(`
    create extension if not exists pgcrypto;
    create role authenticated;
    create schema auth;

    create function auth.uid() returns uuid
    language sql stable as $$
      select nullif(current_setting('app.test_user_id', true), '')::uuid
    $$;

    create type public.app_role as enum ('courier', 'round_lead', 'admin');
    create type public.delivery_event_status as enum ('active', 'cancelled');

    create table public.users (
      id uuid primary key,
      role public.app_role not null,
      is_active boolean not null default true
    );
    create table public.shops (
      id uuid primary key,
      status text not null default 'active'
    );
    create table public.ice_types (id uuid primary key);
    create table public.round_stops (
      id uuid primary key,
      round_id uuid not null,
      shop_id uuid not null references public.shops(id)
    );
    create table public.delivery_round_members (
      round_id uuid not null,
      user_id uuid not null references public.users(id),
      primary key (round_id, user_id)
    );
    create table public.delivery_events (
      id uuid primary key,
      round_stop_id uuid not null references public.round_stops(id),
      recorded_by uuid not null references public.users(id),
      status public.delivery_event_status not null default 'active',
      cancelled_by uuid references public.users(id),
      cancelled_at timestamptz,
      cancellation_reason text,
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

    create function public.set_updated_at() returns trigger
    language plpgsql as $$
    begin
      new.updated_at = now();
      return new;
    end;
    $$;

    create function public.is_active_user() returns boolean
    language sql stable security definer set search_path = public as $$
      select exists (
        select 1 from public.users where id = auth.uid() and is_active
      )
    $$;

    create function public.current_app_role() returns public.app_role
    language sql stable security definer set search_path = public as $$
      select role from public.users where id = auth.uid() and is_active
    $$;

    create function public.is_delivery_event_visible(target_event_id uuid) returns boolean
    language sql stable security definer set search_path = public as $$
      select exists (
        select 1
        from public.delivery_events event
        join public.round_stops stop on stop.id = event.round_stop_id
        where event.id = target_event_id
          and (
            public.current_app_role() in ('admin', 'round_lead')
            or exists (
              select 1 from public.delivery_round_members member
              where member.round_id = stop.round_id and member.user_id = auth.uid()
            )
          )
      )
    $$;

    select set_config('app.test_user_id', '${ADMIN_ID}', false);
    insert into public.users (id, role) values
      ('${USER_ID}', 'courier'),
      ('${ADMIN_ID}', 'admin');
    insert into public.shops (id) values ('${SHOP_ID}'), ('${OTHER_SHOP_ID}');
    insert into public.ice_types (id) values ('${ICE_TYPE_ID}');
    insert into public.round_stops (id, round_id, shop_id) values
      ('${STOP_ID}', '${ROUND_ID}', '${SHOP_ID}'),
      ('${HIDDEN_STOP_ID}', '${HIDDEN_ROUND_ID}', '${SHOP_ID}');
    insert into public.delivery_round_members (round_id, user_id)
    values ('${ROUND_ID}', '${USER_ID}');
    insert into public.delivery_events (id, round_stop_id, recorded_by) values
      ('${EVENT_ID}', '${STOP_ID}', '${USER_ID}'),
      ('${SECOND_EVENT_ID}', '${STOP_ID}', '${USER_ID}'),
      ('${HIDDEN_EVENT_ID}', '${HIDDEN_STOP_ID}', '${ADMIN_ID}');
    insert into public.delivery_items (delivery_event_id, ice_type_id, quantity)
    values ('${EVENT_ID}', '${ICE_TYPE_ID}', 2);
  `);

  await db.exec(migration);
  await db.exec(adminSettingsFixMigration);
  await db.exec(bulkShopPriceMigration);
  return db;
}

test('admin price setters atomically close open-ended prices before inserting successors', async (t) => {
  const db = await createDatabase(t);

  await queryAsUser(
    db,
    ADMIN_ID,
    `select id from public.set_ice_type_price(
      '${ICE_TYPE_ID}', 20, date '2026-07-01', null
    )`,
  );
  await queryAsUser(
    db,
    ADMIN_ID,
    `select id from public.set_ice_type_price(
      '${ICE_TYPE_ID}', 25, date '2026-08-01', null
    )`,
  );

  const standardPrices = await db.query(`
    select unit_price, valid_from::text, valid_to::text
    from public.ice_type_prices
    where ice_type_id = '${ICE_TYPE_ID}'
    order by valid_from
  `);
  assert.deepEqual(standardPrices.rows, [
    { unit_price: '20.00', valid_from: '2026-07-01', valid_to: '2026-07-31' },
    { unit_price: '25.00', valid_from: '2026-08-01', valid_to: null },
  ]);

  await queryAsUser(
    db,
    ADMIN_ID,
    `select id from public.set_shop_ice_type_price(
      '${SHOP_ID}', '${ICE_TYPE_ID}', 18, date '2026-07-01', null
    )`,
  );
  await queryAsUser(
    db,
    ADMIN_ID,
    `select id from public.set_shop_ice_type_price(
      '${SHOP_ID}', '${ICE_TYPE_ID}', 22, date '2026-08-01', null
    )`,
  );

  const shopPrices = await db.query(`
    select unit_price, valid_from::text, valid_to::text
    from public.shop_ice_type_prices
    where shop_id = '${SHOP_ID}' and ice_type_id = '${ICE_TYPE_ID}'
    order by valid_from
  `);
  assert.deepEqual(shopPrices.rows, [
    { unit_price: '18.00', valid_from: '2026-07-01', valid_to: '2026-07-31' },
    { unit_price: '22.00', valid_from: '2026-08-01', valid_to: null },
  ]);
});

test('bulk shop price setter is idempotent and preserves scheduled successors', async (t) => {
  const db = await createDatabase(t);

  await queryAsUser(
    db,
    ADMIN_ID,
    `select public.bulk_set_shop_ice_type_price(
      array['${SHOP_ID}', '${OTHER_SHOP_ID}', '${SHOP_ID}']::uuid[],
      '${ICE_TYPE_ID}', 40, date '2026-09-01', null
    ) as saved_count`,
  );
  const bulkResult = await queryAsUser(
    db,
    ADMIN_ID,
    `select public.bulk_set_shop_ice_type_price(
      array['${SHOP_ID}', '${OTHER_SHOP_ID}']::uuid[],
      '${ICE_TYPE_ID}', 35, date '2026-08-01', null
    ) as saved_count`,
  );
  await queryAsUser(
    db,
    ADMIN_ID,
    `select public.bulk_set_shop_ice_type_price(
      array['${SHOP_ID}', '${OTHER_SHOP_ID}']::uuid[],
      '${ICE_TYPE_ID}', 36, date '2026-08-01', null
    )`,
  );

  assert.equal(bulkResult.rows[0].saved_count, 2);
  const prices = await db.query(`
    select shop_id, unit_price, valid_from::text, valid_to::text
    from public.shop_ice_type_prices
    where ice_type_id = '${ICE_TYPE_ID}'
    order by shop_id, valid_from
  `);
  assert.deepEqual(prices.rows, [
    { shop_id: SHOP_ID, unit_price: '36.00', valid_from: '2026-08-01', valid_to: '2026-08-31' },
    { shop_id: SHOP_ID, unit_price: '40.00', valid_from: '2026-09-01', valid_to: null },
    { shop_id: OTHER_SHOP_ID, unit_price: '36.00', valid_from: '2026-08-01', valid_to: '2026-08-31' },
    { shop_id: OTHER_SHOP_ID, unit_price: '40.00', valid_from: '2026-09-01', valid_to: null },
  ]);
});

test('bulk shop price setter rolls back every shop when one price is immutable', async (t) => {
  const db = await createDatabase(t);

  const protectedPrice = await queryAsUser(
    db,
    ADMIN_ID,
    `select id from public.set_shop_ice_type_price(
      '${OTHER_SHOP_ID}', '${ICE_TYPE_ID}', 18, date '2026-08-01', null
    )`,
  );
  await db.query(`
    update public.delivery_items
    set unit_price = 18,
        price_source = 'shop_override',
        price_source_id = $1
    where delivery_event_id = '${EVENT_ID}'
  `, [protectedPrice.rows[0].id]);

  await assert.rejects(
    queryAsUser(
      db,
      ADMIN_ID,
      `select public.bulk_set_shop_ice_type_price(
        array['${SHOP_ID}', '${OTHER_SHOP_ID}']::uuid[],
        '${ICE_TYPE_ID}', 35, date '2026-08-01', null
      )`,
    ),
    /effective price|price history|immutable/i,
  );

  const prices = await db.query(`
    select shop_id, unit_price
    from public.shop_ice_type_prices
    where ice_type_id = '${ICE_TYPE_ID}'
    order by shop_id
  `);
  assert.deepEqual(prices.rows, [{ shop_id: OTHER_SHOP_ID, unit_price: '18.00' }]);
});

test('bulk shop price setter rejects non-admin users and inactive shops', async (t) => {
  const db = await createDatabase(t);

  await assert.rejects(
    queryAsUser(
      db,
      USER_ID,
      `select public.bulk_set_shop_ice_type_price(
        array['${SHOP_ID}']::uuid[], '${ICE_TYPE_ID}', 35, date '2026-08-01', null
      )`,
    ),
    /Only admins can manage shop prices/,
  );

  await db.exec(`update public.shops set status = 'inactive' where id = '${OTHER_SHOP_ID}'`);
  await assert.rejects(
    queryAsUser(
      db,
      ADMIN_ID,
      `select public.bulk_set_shop_ice_type_price(
        array['${SHOP_ID}', '${OTHER_SHOP_ID}']::uuid[],
        '${ICE_TYPE_ID}', 35, date '2026-08-01', null
      )`,
    ),
    /do not exist or are inactive/,
  );

  const prices = await db.query('select id from public.shop_ice_type_prices');
  assert.equal(prices.rows.length, 0);
});

test('migration preserves legacy rows and enforces financial invariants', async (t) => {
  const db = await createDatabase(t);

  const legacy = await db.query(`
    select unit_price, line_total, price_source, price_source_id
    from public.delivery_items
    where delivery_event_id = '${EVENT_ID}'
  `);
  assert.deepEqual(legacy.rows[0], {
    unit_price: null,
    line_total: null,
    price_source: null,
    price_source_id: null,
  });

  await db.exec(`
    insert into public.ice_type_prices (
      ice_type_id, unit_price, valid_from, valid_to, created_by
    ) values (
      '${ICE_TYPE_ID}', 20, date '2026-07-01', date '2026-07-31', '${USER_ID}'
    );
  `);

  await assert.rejects(
    db.exec(`
      insert into public.ice_type_prices (
        ice_type_id, unit_price, valid_from, valid_to, created_by
      ) values (
        '${ICE_TYPE_ID}', 25, date '2026-07-31', date '2026-08-15', '${USER_ID}'
      );
    `),
    /ice_type_prices_ice_type_id_daterange_excl|conflicting key value violates exclusion constraint/,
  );

  await db.exec(`
    insert into public.ice_type_prices (
      ice_type_id, unit_price, valid_from, valid_to, created_by
    ) values (
      '${ICE_TYPE_ID}', 25, date '2026-08-01', null, '${USER_ID}'
    );
  `);

  await assert.rejects(
    db.exec(`
      insert into public.shop_payment_profiles (
        shop_id, allowed_payment_terms, default_payment_term,
        allowed_payment_methods, default_payment_method, created_by
      ) values (
        '${SHOP_ID}', array['immediate']::public.payment_term[], 'credit',
        array['cash']::public.payment_method[], 'cash', '${USER_ID}'
      );
    `),
    /shop_payment_profiles_default_payment_term_check|violates check constraint/,
  );

  await assert.rejects(
    db.exec(`
      insert into public.shop_payment_profiles (
        shop_id, allowed_payment_terms, default_payment_term,
        allowed_payment_methods, default_payment_method,
        allow_outstanding, credit_due_rule, credit_days, created_by
      ) values (
        '${SHOP_ID}', array['immediate', 'credit']::public.payment_term[], 'credit',
        array['cash']::public.payment_method[], 'cash', true, 'net_days', 30, '${USER_ID}'
      );
    `),
    /shop_payment_profiles_check|violates check constraint/,
  );

  await assert.rejects(
    db.exec(`
      insert into public.shop_payment_profiles (
        shop_id, allowed_payment_terms, default_payment_term,
        allowed_payment_methods, default_payment_method,
        allow_outstanding, credit_due_rule, created_by
      ) values (
        '${SHOP_ID}', array['credit']::public.payment_term[], 'credit',
        array['cash']::public.payment_method[], 'cash', true, 'net_days', '${USER_ID}'
      );
    `),
    /shop_payment_profiles_check|violates check constraint/,
  );

  await db.exec(`
    update public.delivery_items
    set unit_price = 50,
        price_source = 'standard',
        price_source_id = (
          select id from public.ice_type_prices where valid_from = date '2026-07-01'
        )
    where delivery_event_id = '${EVENT_ID}';
  `);

  const snapshot = await db.query(`
    select unit_price, line_total
    from public.delivery_items
    where delivery_event_id = '${EVENT_ID}'
  `);
  assert.equal(Number(snapshot.rows[0].unit_price), 50);
  assert.equal(Number(snapshot.rows[0].line_total), 100);

  await assert.rejects(
    db.exec(`
      update public.ice_type_prices
      set unit_price = 55
      where id = (
        select price_source_id
        from public.delivery_items
        where delivery_event_id = '${EVENT_ID}'
      )
    `),
    /effective price|price history|immutable/i,
  );

  const chargeResult = await db.query(`
    insert into public.delivery_charges (
      delivery_event_id, shop_id, service_date, payment_term, original_amount
    ) values (
      '${EVENT_ID}', '${SHOP_ID}', date '2026-07-20', 'immediate', 100
    ) returning id
  `);
  const chargeId = chargeResult.rows[0].id;

  let balance = await db.query(`
    select outstanding_amount, payment_status
    from public.delivery_charge_balances
    where charge_id = '${chargeId}'
  `);
  assert.equal(Number(balance.rows[0].outstanding_amount), 100);
  assert.equal(balance.rows[0].payment_status, 'unpaid');

  await db.exec('begin');
  const paymentResult = await db.query(`
    insert into public.payments (
      shop_id, payment_method, received_amount, allocated_amount,
      idempotency_key, request_fingerprint, recorded_by
    ) values (
      '${SHOP_ID}', 'cash', 40, 40,
      '00000000-0000-4000-8000-000000000006', 'partial-payment', '${USER_ID}'
    ) returning id
  `);
  const paymentId = paymentResult.rows[0].id;
  await db.exec(`
    insert into public.payment_allocations (payment_id, charge_id, amount)
    values ('${paymentId}', '${chargeId}', 40)
  `);
  await db.exec('commit');

  balance = await db.query(`
    select outstanding_amount, payment_status
    from public.delivery_charge_balances
    where charge_id = '${chargeId}'
  `);
  assert.equal(Number(balance.rows[0].outstanding_amount), 60);
  assert.equal(balance.rows[0].payment_status, 'partial');

  await assert.rejects(
    db.exec(`
      update public.delivery_events
      set status = 'cancelled',
          cancelled_by = '${ADMIN_ID}',
          cancelled_at = now(),
          cancellation_reason = 'must void payment first'
      where id = '${EVENT_ID}'
    `),
    /active payment allocations|void active payments/i,
  );

  await db.exec(`
    update public.payments
    set status = 'voided',
        voided_by = '${USER_ID}',
        voided_at = now(),
        void_reason = 'ทดสอบยกเลิกรับเงิน'
    where id = '${paymentId}'
  `);

  balance = await db.query(`
    select outstanding_amount, payment_status
    from public.delivery_charge_balances
    where charge_id = '${chargeId}'
  `);
  assert.equal(Number(balance.rows[0].outstanding_amount), 100);
  assert.equal(balance.rows[0].payment_status, 'unpaid');

  await db.exec(`
    update public.delivery_events
    set status = 'cancelled',
        cancelled_by = '${ADMIN_ID}',
        cancelled_at = now(),
        cancellation_reason = 'cancel after payment void'
    where id = '${EVENT_ID}'
  `);

  const voidedCharge = await db.query(`
    select status, voided_by, void_reason
    from public.delivery_charges
    where id = '${chargeId}'
  `);
  assert.deepEqual(voidedCharge.rows[0], {
    status: 'voided',
    voided_by: ADMIN_ID,
    void_reason: 'cancel after payment void',
  });

  await assert.rejects(
    db.exec(`
      insert into public.delivery_events (
        id, round_stop_id, recorded_by, corrects_event_id
      ) values (
        '${CORRECTION_EVENT_ID}', '${STOP_ID}', '${ADMIN_ID}', '${EVENT_ID}'
      )
    `),
    /financial-aware revision/i,
  );

  await db.exec('begin');
  const approvalResult = await db.query(`
    insert into public.financial_approval_requests (
      shop_id, round_stop_id, kind, requested_amount, reason,
      request_fingerprint, status, requested_by, decided_by, decided_at
    ) values (
      '${SHOP_ID}', '${STOP_ID}', 'credit_limit', 150, 'approved credit',
      'approval-probe', 'approved', '${USER_ID}', '${ADMIN_ID}', now()
    ) returning id;
  `);
  const approvalId = approvalResult.rows[0].id;
  await db.exec(`
    insert into public.delivery_charges (
      delivery_event_id, shop_id, service_date, payment_term,
      original_amount, due_date, approval_request_id
    ) values (
      '${SECOND_EVENT_ID}', '${SHOP_ID}', date '2026-07-20', 'credit',
      150, date '2026-08-19', '${approvalId}'
    );
    update public.financial_approval_requests
    set status = 'consumed',
        consumed_by_delivery_event_id = '${SECOND_EVENT_ID}',
        consumed_at = now()
    where id = '${approvalId}';
    commit;
  `);

  await db.exec(`
    insert into public.delivery_events (id, round_stop_id, recorded_by)
    values ('${CORRECTION_EVENT_ID}', '${STOP_ID}', '${ADMIN_ID}')
  `);
  await assert.rejects(
    db.exec(`
      insert into public.delivery_charges (
        delivery_event_id, shop_id, service_date, payment_term,
        original_amount, due_date, approval_request_id
      ) values (
        '${CORRECTION_EVENT_ID}', '${SHOP_ID}', date '2026-07-20', 'credit',
        25, date '2026-08-19', '${approvalId}'
      )
    `),
    /unique|approval/i,
  );

  await db.exec('begin');
  const invalidPayment = await db.query(`
    insert into public.payments (
      shop_id, payment_method, received_amount, allocated_amount,
      idempotency_key, request_fingerprint, recorded_by
    ) values (
      '${SHOP_ID}', 'cash', 200, 200,
      '00000000-0000-4000-8000-000000000011', 'over-allocation', '${USER_ID}'
    ) returning id
  `);
  const secondCharge = await db.query(`
    select id from public.delivery_charges where delivery_event_id = '${SECOND_EVENT_ID}'
  `);
  await db.query(`
    insert into public.payment_allocations (payment_id, charge_id, amount)
    values ($1, $2, 200)
  `, [invalidPayment.rows[0].id, secondCharge.rows[0].id]);
  await assert.rejects(db.exec('commit'), /exceed|allocation/i);
  await db.exec('rollback');

  const hiddenCharge = await db.query(`
    insert into public.delivery_charges (
      delivery_event_id, shop_id, service_date, payment_term, original_amount
    ) values (
      '${HIDDEN_EVENT_ID}', '${SHOP_ID}', date '2026-07-20', 'end_of_day', 50
    ) returning id
  `);

  await db.exec('begin');
  const splitPayment = await db.query(`
    insert into public.payments (
      shop_id, payment_method, received_amount, allocated_amount,
      idempotency_key, request_fingerprint, recorded_by
    ) values (
      '${SHOP_ID}', 'cash', 30, 30,
      '00000000-0000-4000-8000-000000000014', 'split-round-payment', '${ADMIN_ID}'
    ) returning id
  `);
  await db.query(`
    insert into public.payment_allocations (payment_id, charge_id, amount)
    values ($1, $2, 10), ($1, $3, 20)
  `, [splitPayment.rows[0].id, secondCharge.rows[0].id, hiddenCharge.rows[0].id]);
  await db.exec('commit');

  await db.exec('begin');
  const mismatchedPayment = await db.query(`
    insert into public.payments (
      shop_id, payment_method, received_amount, allocated_amount,
      idempotency_key, request_fingerprint, recorded_by
    ) values (
      '${SHOP_ID}', 'cash', 40, 40,
      '00000000-0000-4000-8000-000000000012', 'mismatched-allocation', '${USER_ID}'
    ) returning id
  `);
  await db.query(`
    insert into public.payment_allocations (payment_id, charge_id, amount)
    values ($1, $2, 39)
  `, [mismatchedPayment.rows[0].id, secondCharge.rows[0].id]);
  await assert.rejects(db.exec('commit'), /must equal its allocation rows/i);
  await db.exec('rollback');

  await db.exec('begin');
  const crossShopPayment = await db.query(`
    insert into public.payments (
      shop_id, payment_method, received_amount, allocated_amount,
      idempotency_key, request_fingerprint, recorded_by
    ) values (
      '${OTHER_SHOP_ID}', 'cash', 10, 10,
      '00000000-0000-4000-8000-000000000013', 'cross-shop-allocation', '${USER_ID}'
    ) returning id
  `);
  await db.query(`
    insert into public.payment_allocations (payment_id, charge_id, amount)
    values ($1, $2, 10)
  `, [crossShopPayment.rows[0].id, secondCharge.rows[0].id]);
  await assert.rejects(db.exec('commit'), /same shop/i);
  await db.exec('rollback');

  await db.exec(`
    insert into public.shop_ice_type_prices (
      shop_id, ice_type_id, unit_price, valid_from, created_by
    ) values
      ('${SHOP_ID}', '${ICE_TYPE_ID}', 19, date '2026-09-01', '${ADMIN_ID}'),
      ('${OTHER_SHOP_ID}', '${ICE_TYPE_ID}', 18, date '2026-09-01', '${ADMIN_ID}');
    insert into public.shop_payment_profiles (
      shop_id, allowed_payment_terms, default_payment_term,
      allowed_payment_methods, default_payment_method, created_by
    ) values
      ('${SHOP_ID}', array['immediate']::public.payment_term[], 'immediate',
        array['cash']::public.payment_method[], 'cash', '${ADMIN_ID}'),
      ('${OTHER_SHOP_ID}', array['immediate']::public.payment_term[], 'immediate',
        array['cash']::public.payment_method[], 'cash', '${ADMIN_ID}');
    grant usage on schema public, auth to authenticated;
    grant select on public.shop_ice_type_prices, public.shop_payment_profiles,
      public.delivery_charges, public.payments, public.payment_allocations,
      public.delivery_charge_balances to authenticated;
  `);

  const courierPrices = await queryAsUser(
    db,
    USER_ID,
    'select shop_id from public.shop_ice_type_prices order by shop_id',
  );
  assert.deepEqual(courierPrices.rows.map((row) => row.shop_id), [SHOP_ID]);

  const courierProfiles = await queryAsUser(
    db,
    USER_ID,
    'select shop_id from public.shop_payment_profiles order by shop_id',
  );
  assert.deepEqual(courierProfiles.rows.map((row) => row.shop_id), [SHOP_ID]);

  const adminProfiles = await queryAsUser(
    db,
    ADMIN_ID,
    'select shop_id from public.shop_payment_profiles order by shop_id',
  );
  assert.deepEqual(adminProfiles.rows.map((row) => row.shop_id), [SHOP_ID, OTHER_SHOP_ID]);

  const courierPayments = await queryAsUser(
    db,
    USER_ID,
    `select id from public.payments where id = '${splitPayment.rows[0].id}'`,
  );
  assert.equal(courierPayments.rows.length, 0);

  const courierAllocations = await queryAsUser(
    db,
    USER_ID,
    `select charge_id from public.payment_allocations
     where payment_id = '${splitPayment.rows[0].id}' order by charge_id`,
  );
  assert.deepEqual(
    courierAllocations.rows.map((row) => row.charge_id),
    [secondCharge.rows[0].id],
  );

  const courierBalances = await queryAsUser(
    db,
    USER_ID,
    `select charge_id, allocated_amount, payment_status
     from public.delivery_charge_balances
     where charge_id in ('${secondCharge.rows[0].id}', '${hiddenCharge.rows[0].id}')`,
  );
  assert.equal(courierBalances.rows.length, 1);
  assert.equal(courierBalances.rows[0].charge_id, secondCharge.rows[0].id);
  assert.equal(Number(courierBalances.rows[0].allocated_amount), 10);
  assert.equal(courierBalances.rows[0].payment_status, 'partial');

  const rls = await db.query(`
    select relname
    from pg_class
    where relnamespace = 'public'::regnamespace
      and relrowsecurity
      and relname in ('delivery_charges', 'payments', 'financial_approval_requests')
    order by relname
  `);
  assert.deepEqual(
    rls.rows.map((row) => row.relname),
    ['delivery_charges', 'financial_approval_requests', 'payments'],
  );
});
