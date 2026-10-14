import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const originalTransfer = readFileSync(new URL('../supabase/migrations/0015_employee_assigned_stock_flow.sql', import.meta.url), 'utf8')
  .match(/create or replace function public\.record_employee_stock_transfer\([\s\S]*?\n\$\$;/)[0];

const USER_ID = '10000000-0000-4000-8000-000000000001';
const ICE_ID = '20000000-0000-4000-8000-000000000001';
const ROUND_ID = '30000000-0000-4000-8000-000000000001';
const TRUCK_ID = '40000000-0000-4000-8000-000000000001';
const HOLDING_ID = '40000000-0000-4000-8000-000000000002';
const SERVICE_DATE = '2026-08-09';

async function createDatabase(t, { migrateBagCounts = true, iceTypeName = 'Ice' } = {}) {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role authenticated;
    create schema auth;
    create type public.app_role as enum ('courier', 'round_lead', 'admin');
    create type public.delivery_round_status as enum ('open', 'closed');
    create type public.stock_movement_kind as enum ('factory_order', 'transfer', 'damage', 'return_to_factory');
    create type public.stock_movement_status as enum ('active', 'cancelled');

    create table public.auth_context (
      singleton boolean primary key default true,
      user_id uuid not null,
      app_role public.app_role not null,
      is_active boolean not null
    );
    insert into public.auth_context values (true, '${USER_ID}', 'courier', true);

    create function auth.uid() returns uuid language sql stable as $$
      select user_id from public.auth_context where singleton
    $$;
    create function public.current_app_role() returns public.app_role language sql stable as $$
      select app_role from public.auth_context where singleton
    $$;
    create function public.is_active_user() returns boolean language sql stable as $$
      select is_active from public.auth_context where singleton
    $$;

    create table public.users (id uuid primary key, display_name text not null);
    create table public.delivery_rounds (
      id uuid primary key,
      service_date date not null,
      status public.delivery_round_status not null
    );
    create table public.stock_locations (id uuid primary key, name text not null);
    create table public.ice_types (
      id uuid primary key,
      code text not null,
      name text not null,
      unit text not null,
      is_active boolean not null
    );
    create table public.stock_movements (
      id uuid primary key default gen_random_uuid(),
      service_date date not null,
      round_id uuid references public.delivery_rounds(id),
      kind public.stock_movement_kind not null,
      from_location_id uuid references public.stock_locations(id),
      to_location_id uuid references public.stock_locations(id),
      idempotency_key uuid not null unique,
      request_fingerprint text,
      status public.stock_movement_status not null default 'active',
      recorded_by uuid not null references public.users(id)
    );
    create table public.stock_movement_items (
      movement_id uuid not null references public.stock_movements(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity numeric(12,1) not null,
      primary key (movement_id, ice_type_id)
    );
    create table public.daily_stock_closures (service_date date primary key, status text not null);
    create table public.audit_logs (
      id uuid primary key default gen_random_uuid(),
      actor_id uuid not null,
      entity_type text not null,
      entity_id uuid not null,
      action text not null,
      after_value jsonb
    );
    create table public.test_location_balances (
      service_date date not null,
      location_id uuid not null,
      ice_type_id uuid not null,
      quantity numeric(12,1) not null,
      primary key (service_date, location_id, ice_type_id)
    );
    create table public.test_aggregate_balances (
      service_date date not null,
      ice_type_id uuid not null,
      quantity numeric(12,1) not null,
      primary key (service_date, ice_type_id)
    );

    create function public.stock_balance_at(p_service_date date, p_location_id uuid, p_ice_type_id uuid)
    returns numeric language sql stable as $$
      select coalesce((select quantity from public.test_location_balances
        where service_date = p_service_date and location_id = p_location_id and ice_type_id = p_ice_type_id), 0)
        + coalesce((select sum(item.quantity) from public.stock_movements movement
          join public.stock_movement_items item on item.movement_id = movement.id
          where movement.service_date = p_service_date and movement.status = 'active'
            and movement.to_location_id = p_location_id and item.ice_type_id = p_ice_type_id), 0)
        - coalesce((select sum(item.quantity) from public.stock_movements movement
          join public.stock_movement_items item on item.movement_id = movement.id
          where movement.service_date = p_service_date and movement.status = 'active'
            and movement.from_location_id = p_location_id and item.ice_type_id = p_ice_type_id), 0)
    $$;

    create function public.daily_aggregate_stock_balance_at(p_service_date date, p_ice_type_id uuid)
    returns numeric language sql stable as $$
      select coalesce((select quantity from public.test_aggregate_balances
        where service_date = p_service_date and ice_type_id = p_ice_type_id), 0)
        - coalesce((select sum(item.quantity) from public.stock_movements movement
          join public.stock_movement_items item on item.movement_id = movement.id
          where movement.service_date = p_service_date and movement.status = 'active'
            and movement.kind = 'damage' and item.ice_type_id = p_ice_type_id), 0)
    $$;

    create function public.get_employee_stock_state(p_round_id uuid) returns jsonb
    language sql stable as $$
      select jsonb_build_object(
        'round_id', round.id,
        'service_date', round.service_date,
        'withdrawn_balances', '[]'::jsonb,
        'truck_location', jsonb_build_object('id', '${TRUCK_ID}', 'name', 'Truck', 'balances', '[]'::jsonb),
        'holding_location', jsonb_build_object(
          'id', '${HOLDING_ID}', 'name', 'Courier holding',
          'balances', jsonb_build_array(jsonb_build_object(
            'ice_type_id', '${ICE_ID}',
            'quantity', public.stock_balance_at(round.service_date, '${HOLDING_ID}', '${ICE_ID}')
          ))
        )
      )
      from public.delivery_rounds round where round.id = p_round_id
    $$;

    insert into public.users values ('${USER_ID}', 'Courier');
    insert into public.delivery_rounds values ('${ROUND_ID}', date '${SERVICE_DATE}', 'open');
    insert into public.stock_locations values
      ('${TRUCK_ID}', 'Truck'), ('${HOLDING_ID}', 'Courier holding');
    insert into public.ice_types values ('${ICE_ID}', 'ICE', 'Ice', 'bag', true);
    insert into public.test_location_balances values
      (date '${SERVICE_DATE}', '${HOLDING_ID}', '${ICE_ID}', 0),
      (date '${SERVICE_DATE}', '${TRUCK_ID}', '${ICE_ID}', 130);
    insert into public.test_aggregate_balances values
      (date '${SERVICE_DATE}', '${ICE_ID}', 3);
  `);

  await db.exec(originalTransfer);
  await db.exec(readFileSync(new URL('../supabase/migrations/0183_employee_stock_transfer_half_bags.sql', import.meta.url), 'utf8'));
  await db.query('update public.ice_types set name = $1 where id = $2', [iceTypeName, ICE_ID]);
  if (migrateBagCounts) {
    await db.exec(readFileSync(new URL('../supabase/migrations/0218_employee_stock_bag_counts.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../supabase/migrations/0219_correct_stock_half_bag_ice_types.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../supabase/migrations/0229_employee_stock_no_overdraw.sql', import.meta.url), 'utf8'));
  }
  return db;
}

test('half bags are available for crushed small tube ice and unavailable for block ice', async (t) => {
  for (const [name, expected] of [['หลอดเล็กโม่', true], ['น้ำแข็งก้อน', false], ['ก้อน', false]]) {
    await t.test(name, async (subtest) => {
      const db = await createDatabase(subtest, { iceTypeName: name });
      const { rows } = await db.query('select allow_half from public.ice_types where id = $1', [ICE_ID]);
      assert.equal(rows[0].allow_half, expected);
      const halfBag = { ice_type_id: ICE_ID, quantity: 0.5, fullBags: 0, halfBags: 1 };
      const record = () => db.query('select public.record_employee_stock_transfer($1, $2::jsonb, $3)',
        [ROUND_ID, JSON.stringify([halfBag]), '50000000-0000-4000-8000-000000000099']);
      if (expected) await record();
      else await assert.rejects(record(), /Invalid full\/half/);
    });
  }
});

function transfer(db, quantity, key = '50000000-0000-4000-8000-000000000001') {
  return db.query(`select public.record_employee_stock_transfer($1, $2::jsonb, $3) as result`,
    [ROUND_ID, JSON.stringify([{ ice_type_id: ICE_ID, quantity }]), key]);
}

test('employee transfer preserves 7.5 and 0.5 bags and retries only once', async (t) => {
  const db = await createDatabase(t);
  const first = await transfer(db, 7.5);
  assert.equal(first.rows[0].result.holding_location.balances[0].quantity, 7.5);
  await transfer(db, 7.5);
  await assert.rejects(transfer(db, 0.5), /different employee stock request/);
  await transfer(db, 0.5, '50000000-0000-4000-8000-000000000002');
  const balances = await db.query(`select public.stock_balance_at($1, $2, $3) as truck,
    public.stock_balance_at($1, $4, $3) as holding`, [SERVICE_DATE, TRUCK_ID, ICE_ID, HOLDING_ID]);
  assert.deepEqual(balances.rows[0], { truck: '122.0', holding: '8.0' });
  const count = await db.query('select count(*)::integer as count from public.stock_movements');
  assert.equal(count.rows[0].count, 2);
});

test('employee transfer rejects invalid fractions and overdraw without writing stock', async (t) => {
  const db = await createDatabase(t);
  for (const quantity of [0.25, 0.51, -0.5, 0]) {
    await assert.rejects(transfer(db, quantity), /positive whole or half-bag quantity/);
  }
  await assert.rejects(transfer(db, 130.5), /truck does not have enough stock/);
  const count = await db.query('select count(*)::integer as count from public.stock_movements');
  assert.equal(count.rows[0].count, 0);
});

for (const operation of ['transfer', 'return', 'damage']) {
  test(`employee ${operation} preserves split, verifies retries, and rejects confirmed overstock`, async (t) => {
    const db = await createDatabase(t);
    await db.exec('update test_location_balances set quantity = 20; update test_aggregate_balances set quantity = 20');
    const item = { ice_type_id: ICE_ID, quantity: 14.5, fullBags: 14, halfBags: 1 };
    const run = (value, key = '60000000-0000-4000-8000-000000000001') => db.query(
      `select public.record_employee_stock_${operation}($1, $2::jsonb, $3)`, [ROUND_ID, JSON.stringify([value]), key]);
    await run(item);
    await run(item);
    // A lost response followed by a balance refresh changes the UI confirmation,
    // but must still acknowledge the same committed movement.
    await run({ ...item, confirmedOverstock: true });
    assert.deepEqual((await db.query('select quantity, full_bags, half_bags from stock_movement_items')).rows,
      [{ quantity: '14.5', full_bags: 14, half_bags: 1 }]);
    const source = operation === 'transfer' ? TRUCK_ID : HOLDING_ID;
    assert.equal((await db.query('select stock_balance_at($1, $2, $3) as quantity', [SERVICE_DATE, source, ICE_ID])).rows[0].quantity, '5.5');
    await assert.rejects(run({ ...item, fullBags: 13, halfBags: 3 }), /different employee stock/);
    const key = '60000000-0000-4000-8000-000000000002';
    await assert.rejects(run(item, key), /enough stock/);
    await assert.rejects(run({ ...item, confirmedOverstock: true }, key), /enough stock/);
    assert.equal((await db.query('select count(*)::int as count from stock_movements')).rows[0].count, 1);
    assert.equal((await db.query('select stock_balance_at($1, $2, $3) as quantity', [SERVICE_DATE, source, ICE_ID])).rows[0].quantity, '5.5');
  });
}
test('bag split validation and allowHalf reject invalid data; old totals stay readable', async (t) => {
  const db = await createDatabase(t);
  await transfer(db, 1.5);
  assert.equal((await db.query('select full_bags from stock_movement_items')).rows[0].full_bags, null);
  await db.exec('update ice_types set allow_half = false');
  for (const item of [
    { quantity: 1.5, fullBags: 1, halfBags: 1 },
    { quantity: 1, fullBags: 0, halfBags: 2 },
    { quantity: 1, fullBags: 1.5, halfBags: 0 },
    { quantity: 1, fullBags: 2, halfBags: 0 },
    { quantity: 1, fullBags: 1 },
  ]) {
    await assert.rejects(db.query('select record_employee_stock_transfer($1, $2::jsonb, $3)',
      [ROUND_ID, JSON.stringify([{ ice_type_id: ICE_ID, ...item }]), '60000000-0000-4000-8000-000000000003']), /Invalid full\/half/);
  }
});

for (const operation of ['transfer', 'return', 'damage']) {
  test(`employee ${operation} retries a pre-migration request without duplicating stock`, async (t) => {
    const db = await createDatabase(t, { migrateBagCounts: false });
    for (const file of ['0137_employee_stock_returns.sql', '0142_employee_stock_damage.sql']) {
      await db.exec(readFileSync(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    }
    await db.exec('update test_location_balances set quantity = 20; update test_aggregate_balances set quantity = 20');
    const item = { ice_type_id: ICE_ID, quantity: 14.5 };
    const key = '60000000-0000-4000-8000-000000000004';
    const run = (value = item, mode = operation) => db.query(
      `select public.record_employee_stock_${mode}($1, $2::jsonb, $3)`, [ROUND_ID, JSON.stringify([value]), key]);
    await run();
    await run();
    await db.exec(readFileSync(new URL('../supabase/migrations/0218_employee_stock_bag_counts.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../supabase/migrations/0229_employee_stock_no_overdraw.sql', import.meta.url), 'utf8'));
    await run();
    await run({ ...item, confirmedOverstock: true });
    await assert.rejects(run({ ...item, quantity: 1 }), /different employee stock/);
    await assert.rejects(run(item, operation === 'damage' ? 'return' : 'damage'), /different employee stock/);
    await db.exec("update auth_context set user_id = '10000000-0000-4000-8000-000000000002'");
    await assert.rejects(run(), /belongs to another user/);
    assert.deepEqual((await db.query('select quantity, full_bags, half_bags from stock_movement_items')).rows,
      [{ quantity: '14.5', full_bags: null, half_bags: null }]);
    assert.equal((await db.query('select count(*)::int as count from stock_movements')).rows[0].count, 1);
  });
}


test('damage cannot bypass aggregate stock with an old confirmation flag', async (t) => {
  const db = await createDatabase(t);
  await db.exec('update test_location_balances set quantity = 20');
  await assert.rejects(db.query('select record_employee_stock_damage($1, $2::jsonb, $3)', [
    ROUND_ID, JSON.stringify([{ ice_type_id: ICE_ID, quantity: 3.5, fullBags: 3, halfBags: 1, confirmedOverstock: true }]),
    '60000000-0000-4000-8000-000000000005',
  ]), /Daily aggregate stock does not have enough stock/);
  assert.equal((await db.query('select count(*)::int as count from stock_movements')).rows[0].count, 0);
  assert.equal((await db.query('select count(*)::int as count from audit_logs')).rows[0].count, 0);
});
