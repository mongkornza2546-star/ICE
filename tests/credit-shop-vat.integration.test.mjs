import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createVatDatabase } from './helpers/creditVatDatabase.mjs';

const admin = '10000000-0000-4000-8000-000000000001';
const shop = '30000000-0000-4000-8000-000000000001';
const ice = '40000000-0000-4000-8000-000000000001';
const stop = '60000000-0000-4000-8000-000000000001';
const run = '70000000-0000-4000-8000-000000000001';
const today = "(clock_timestamp() at time zone 'Asia/Bangkok')::date";
const items = quantity => JSON.stringify([{ ice_type_id: ice, quantity }]);
async function value(db, sql, args = []) { return (await db.query(sql, args)).rows[0].value; }
async function record(db, quantity, rate, key = randomUUID()) {
 return value(db, `select public.record_delivery_with_vat_check($1, $2::jsonb, 'delivered', null, now(), $3, 'credit', null, $4, $5) as value`,
 [stop, items(quantity), key, rate, Math.round(quantity * 25 * (1 + rate / 100) * 100) / 100]);
}
async function statements(db) { return value(db, `select public.get_billing_statements('${shop}') as value`); }
async function issue(db, charges) { return value(db, `select public.create_billing_statement($1, $2::uuid[]) as value`, [shop, charges]); }
async function pay(db, charge, amount, expected, statement = null, key = randomUUID()) {
 const allocations = JSON.stringify([{charge_id: charge, amount}]);
 if (statement) return value(db, `select public.record_billing_statement_payment($1, $2::jsonb, 'cash', $3, null, null, $4, $5, $6) as value`, [statement, allocations, amount, run, expected, key]);
 return value(db, `select public.record_regular_collection_payment($1, $2::jsonb, 'cash', $3, null, null, $4, $5, null, $6) as value`, [shop, allocations, amount, run, expected, key]);
}

test('credit VAT through real migrations, delivery writers, billing, collection and cancellation', async t => {
 let legacy, oldStatement;
 const db = await createVatDatabase(async db => {
  await db.exec(`    set request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';
    insert into auth.users (id, email, raw_user_meta_data) values (
      '10000000-0000-4000-8000-000000000001', 'admin@example.test',
      '{"display_name":"VAT admin"}'::jsonb
    );
    update public.users set is_active = true, role = 'admin'
    where id = '10000000-0000-4000-8000-000000000001';

    set session_replication_role = replica;
    insert into public.buildings (id, code, name) values (
      '20000000-0000-4000-8000-000000000001', 'EVT', 'VAT building'
    );
    set session_replication_role = origin;
    insert into public.building_zones (id, building_id, code, name) values (
      '21000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001', 'HALL', 'Event hall'
    );
    insert into public.stock_locations (
      id, code, name, kind, assigned_user_id, is_active,
      holds_inventory, requires_daily_count
    ) values (
      '22000000-0000-4000-8000-000000000001', 'EVENT-HOLD',
      'Event holding', 'team', '10000000-0000-4000-8000-000000000001',
      true, true, false
    );
    set session_replication_role = replica;
    insert into public.shops (
      id, code, name, building_id, floor_or_zone, zone_id,
      contact_name, contact_phone, stock_location_id
    ) values (
      '30000000-0000-4000-8000-000000000001', 'EV01', 'VAT shop',
      '20000000-0000-4000-8000-000000000001', 'Event hall',
      '21000000-0000-4000-8000-000000000001', 'Contact', '0800000000',
      '22000000-0000-4000-8000-000000000001'
    );
    set session_replication_role = origin;
    insert into public.ice_types (id, code, name, unit) values (
      '40000000-0000-4000-8000-000000000001', 'ICE-E', 'VAT ice', 'bag'
    );
    insert into public.ice_type_prices (
      id, ice_type_id, unit_price, valid_from, created_by
    ) values (
      '41000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001', 25,
      (clock_timestamp() at time zone 'Asia/Bangkok')::date,
      '10000000-0000-4000-8000-000000000001'
    );
    insert into public.delivery_rounds (
      id, service_date, name, round_type, status, opened_by
    ) values (
      '50000000-0000-4000-8000-000000000001',
      (clock_timestamp() at time zone 'Asia/Bangkok')::date,
      'งานประจำวัน', 'daily', 'open',
      '10000000-0000-4000-8000-000000000001'
    );
    insert into public.shop_payment_profiles(shop_id, allowed_payment_terms, default_payment_term,
      allowed_payment_methods, default_payment_method, credit_due_rule, credit_days, allow_outstanding, created_by)
    values('${shop}', '{credit}', 'credit', '{cash}', 'cash', 'net_days', 1, true, '${admin}');
    insert into public.round_stops(id, round_id, shop_id, shop_code_snapshot, shop_name_snapshot,
      building_id_snapshot, building_name_snapshot, floor_or_zone_snapshot, sequence_no, updated_by)
    values('${stop}', '50000000-0000-4000-8000-000000000001', '${shop}', 'EV01', 'VAT shop',
      '20000000-0000-4000-8000-000000000001', 'VAT building', 'Hall', 1, '${admin}');
    insert into public.stock_movements(id, service_date, round_id, kind, to_location_id, idempotency_key, recorded_by)
    values('80000000-0000-4000-8000-000000000001', ${today}, '50000000-0000-4000-8000-000000000001',
      'factory_order', '22000000-0000-4000-8000-000000000001', gen_random_uuid(), '${admin}');
    insert into public.stock_movement_items(movement_id, ice_type_id, quantity)
    values('80000000-0000-4000-8000-000000000001', '${ice}', 10000);
    insert into public.collection_runs(id, service_date, opened_by) values('${run}', ${today}, '${admin}');
  `);
  legacy = await value(db, `select public.record_delivery($1, $2::jsonb, 'delivered', null, now(), $3, 'credit', null) as value`, [stop, items(4), randomUUID()]);
  oldStatement = await issue(db, [legacy.charge_id]);
 }, async db => {
  for (const signature of [
    'uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid',
    'uuid,jsonb,public.shop_round_status,text,timestamptz,uuid',
  ]) {
   assert.equal(await value(db, `select has_function_privilege('authenticated',
     'public.record_delivery(${signature})', 'EXECUTE') as value`), true);
  }
  assert.equal(await value(db, `select vat_enabled as value from public.shop_payment_profiles where shop_id='${shop}'`), false);
 });
 t.after(() => db.close());

 await t.test('legacy invoices and statement amounts stay unchanged, VAT starts disabled', async () => {
  const document = await value(db, 'select public.get_charge_print_document($1) as value', [legacy.charge_id]);
  assert.deepEqual(document, { ...legacy.print_document, status: 'active', void_info: null });
  const statement = (await statements(db))[0];
  assert.equal(statement.total_amount, oldStatement.total_amount);
  assert.equal(statement.vat_amount, 0);
  assert.equal(statement.gross_amount, null);
  assert.equal(await value(db, `select vat_enabled as value from public.shop_payment_profiles where shop_id='${shop}'`), false);
 });
 let sale, saleKey = randomUUID();
 await t.test('exclusive VAT is charged once and exposed in every financial read model', async () => {
  await db.exec(`update public.shop_payment_profiles set vat_enabled=true, credit_due_rule='weekly', credit_days=null, credit_collection_weekday=extract(isodow from ${today}) where shop_id='${shop}'`);
  sale = await record(db, 40, 7, saleKey);
  assert.equal(sale.total_amount, 1070);
  assert.equal(sale.subtotal_amount, 1000);
  assert.equal(sale.vat_amount, 70);
  assert.equal(sale.vat_rate, 7);
  assert.equal(sale.print_document.total_amount, 1070);
  assert.equal(sale.print_document.vat_amount, 70);
  const context = await value(db, `select public.get_delivery_pos_context('${stop}') as value`);
  assert.equal(context.payment_profile.vat_enabled, true);
  assert.equal(context.payment_profile.credit_exposure, 1170);
  const receivables = await value(db, `select public.get_credit_receivables() as value`);
  assert.equal(receivables[0].outstanding_amount, 1170);
  assert.equal(receivables[0].vat_enabled, true);
  const detail = await value(db, `select public.get_credit_receivable_detail('${shop}') as value`);
  assert.equal(detail.charges.find(c => c.charge_id === sale.charge_id).vat_amount, 70);
  const daily = await value(db, `select public.get_daily_credit_acknowledgement_details('${shop}', ${today}) as value`);
  assert.ok(Array.isArray(daily));
  assert.equal(daily.find(c => c.charge_id === sale.charge_id).vat_amount, 70);
  const dailyDocument = await value(db, `select public.build_daily_credit_acknowledgement_document(gen_random_uuid(), '${shop}', ${today}, 1, now()) as value`);
  assert.equal(dailyDocument.subtotal_amount, 1100);
  assert.equal(dailyDocument.vat_amount, 70);
  assert.equal(dailyDocument.total_amount, 1170);
 });
 await t.test('stale VAT settings roll the entire sale back; successful replay uses original snapshot', async () => {
  const before = await value(db, 'select count(*)::int as value from public.delivery_events');
  await assert.rejects(record(db, 4, 0), /VAT/);
  assert.equal(await value(db, 'select count(*)::int as value from public.delivery_events'), before);
  await db.exec(`update public.shop_payment_profiles set vat_enabled=false where shop_id='${shop}'`);
  const replay = await record(db, 40, 7, saleKey);
  assert.equal(replay.charge_id, sale.charge_id);
  assert.equal(replay.total_amount, 1070);
  assert.equal(replay.vat_amount, 70);
 });
 await t.test('stale VAT is reported before credit-limit approval is required', async () => {
  const context = await value(db, `select public.get_delivery_pos_context('${stop}') as value`);
  await db.query('update public.shop_payment_profiles set vat_enabled=true, credit_limit=$1 where shop_id=$2',
    [context.payment_profile.credit_exposure + 50, shop]);
  const before = await value(db, 'select count(*)::int as value from public.delivery_events');
  await assert.rejects(record(db, 2, 0), error => error.detail === 'VAT_OR_PRICE_CHANGED');
  assert.equal(await value(db, 'select count(*)::int as value from public.delivery_events'), before);
  await db.exec(`update public.shop_payment_profiles set vat_enabled=false, credit_limit=null where shop_id='${shop}'`);
 });
 let nonVat, statement;
 await t.test('partial payments and mixed old/new bills preserve the full VAT base on statements', async () => {
  const paymentKey = randomUUID();
  const payment = await pay(db, sale.charge_id, 500, 1070, null, paymentKey);
  const replay = await pay(db, sale.charge_id, 500, 1070, null, paymentKey);
  assert.equal(payment.payment_id, replay.payment_id);
  nonVat = await record(db, 2, 0);
  statement = await issue(db, [sale.charge_id, nonVat.charge_id]);
  assert.equal(statement.subtotal_amount, 1050);
  assert.equal(statement.vat_amount, 70);
  assert.equal(statement.gross_amount, 1120);
  assert.equal(statement.total_amount, 620);
  assert.equal(statement.outstanding_amount, 620);
  const queue = await value(db, `select public.get_collection_run_queue('${run}') as value`);
  const queued = queue.flatMap(s => s.charges).find(c => c.charge_id === sale.charge_id);
  assert.equal(queued.subtotal_amount, 1000);
  assert.equal(queued.vat_amount, 70);
  assert.equal(queued.outstanding_amount, 570);
  await pay(db, sale.charge_id, 570, 620, statement.id);
  const latest = (await statements(db)).find(s => s.id === statement.id);
  assert.equal(latest.vat_amount, 70);
  assert.equal(latest.total_amount, 620);
  assert.equal(latest.outstanding_amount, 50);
 });
 await t.test('credit limit includes VAT and rounding occurs per charge', async () => {
  await db.exec(`update public.shop_payment_profiles set vat_enabled=true, credit_limit=200 where shop_id='${shop}'`);
  await assert.rejects(record(db, 2, 7), /credit-limit/); // existing 150 + gross 53.50 > 200
  await db.exec(`update public.shop_payment_profiles set credit_limit=null where shop_id='${shop}'`);
  const half = await record(db, .5, 7);
  assert.equal(half.subtotal_amount, 12.5);
  assert.equal(half.vat_amount, .88);
  assert.equal(half.total_amount, 13.38);
  await db.exec(`update public.shop_payment_profiles set vat_enabled=false where shop_id='${shop}'`);
  const result = await value(db, `select public.apply_open_delivery_correction($1, 'cancel', '[]', 'delivered', null, 'VAT cancellation test', $2, null) as value`, [half.delivery_event_id, randomUUID()]);
  assert.equal(result.new_amount, 0);
  assert.equal(await value(db, 'select vat_amount as value from public.delivery_charges where id=$1', [half.charge_id]), '0.88');
  const cancelled = await value(db, 'select public.get_charge_print_document($1) as value', [half.charge_id]);
  assert.equal(cancelled.total_amount, 13.38);
  assert.equal(cancelled.status, 'voided');
 });
 await t.test('paid bills and closed-period edits remain protected', async () => {
  await assert.rejects(value(db, `select public.apply_open_delivery_correction($1, 'cancel', '[]', 'delivered', null, 'paid', $2, null) as value`, [sale.delivery_event_id, randomUUID()]), /ชำระ|ล่าสุด/);
  await assert.rejects(value(db, `select public.create_closed_delivery_adjustment($1, $2::jsonb, 'closed', $3) as value`, [sale.delivery_event_id, items(1), randomUUID()]), /cannot be edited/);
  await assert.rejects(db.exec(`update public.delivery_charges set vat_amount=0 where id='${sale.charge_id}'`), /immutable/);
 });
 await t.test('rental charges never acquire VAT and changing to cash disables VAT without changing history', async () => {
  await db.exec(`update public.shop_payment_profiles set vat_enabled=true where shop_id='${shop}'`);
  const rental = await value(db, `select public.create_shop_tank_rental('${shop}', 2, 100, ${today}, ${today}+2, 'VAT excluded', '${randomUUID()}') as value`);
  const row = (await db.query('select original_amount, subtotal_amount, vat_amount, vat_rate from public.delivery_charges where tank_rental_id=$1', [rental])).rows[0];
  assert.equal(Number(row.original_amount), 200);
  assert.equal(Number(row.vat_amount), 0);
  await db.exec(`update public.shop_payment_profiles set allowed_payment_terms='{end_of_day,immediate}', default_payment_term='end_of_day', credit_due_rule=null, credit_days=null, credit_collection_weekday=null where shop_id='${shop}'`);
  assert.equal(await value(db, `select vat_enabled as value from public.shop_payment_profiles where shop_id='${shop}'`), false);
  assert.equal((await statements(db)).find(s=>s.id===statement.id).vat_amount, 70);
 });
 await t.test('authenticated callers cannot bypass the checked writer', async () => {
  for (const signature of [
    'uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid',
    'uuid,jsonb,public.shop_round_status,text,timestamptz,uuid',
  ]) {
   assert.equal(await value(db, `select has_function_privilege('authenticated',
     'public.record_delivery(${signature})', 'EXECUTE') as value`), false);
  }
 });
 await t.test('half-unit prices round identically in checked delivery and the charge snapshot', async () => {
  await db.exec(`update public.shop_payment_profiles set allowed_payment_terms='{credit}', default_payment_term='credit', credit_due_rule='net_days', credit_days=1, vat_enabled=true where shop_id='${shop}'`);
  await db.exec(`insert into public.shop_ice_type_prices(shop_id, ice_type_id, unit_price, valid_from, created_by)
    values('${shop}', '${ice}', 2.01, ${today}, '${admin}')`);
  const context = await value(db, `select public.get_delivery_pos_context('${stop}') as value`);
  await db.query('update public.shop_payment_profiles set credit_limit=$1 where shop_id=$2',
    [context.payment_profile.credit_exposure + 1.07, shop]);
  await assert.rejects(value(db, `select public.record_delivery_with_vat_check($1, $2::jsonb, 'delivered', null, now(), $3, 'credit', null, 7, 1.07) as value`,
    [stop, items(.5), randomUUID()]), error => error.detail === 'VAT_OR_PRICE_CHANGED');
  await db.exec(`update public.shop_payment_profiles set credit_limit=null where shop_id='${shop}'`);
  const result = await value(db, `select public.record_delivery_with_vat_check($1, $2::jsonb, 'delivered', null, now(), $3, 'credit', null, 7, 1.08) as value`,
    [stop, items(.5), randomUUID()]);
  assert.equal(result.subtotal_amount, 1.01);
  assert.equal(result.vat_amount, .07);
  assert.equal(result.total_amount, 1.08);
 });
});
