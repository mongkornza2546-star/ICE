// Local-only reproduction of the 240 -> 180 stale offline collection conflict.
// Uses isolated PGlite with repository migrations; never connects to production.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createVatDatabase } from '../tests/helpers/creditVatDatabase.mjs';
import { seedOffline, admin, courier, shop, ice, round, stop } from '../tests/helpers/offlineFixture.mjs';

const db = await createVatDatabase();
try {
  await seedOffline(db);
  const value = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
  const call = (rpc, args) => value(`select public.${rpc}(${Object.keys(args).map((k, i) => `${k}=>$${i + 1}`).join(',')}) as value`,
    Object.values(args).map(v => v && typeof v === 'object' ? JSON.stringify(v) : v));
  const day = await value("select (clock_timestamp() at time zone 'Asia/Bangkok')::date::text as value");
  await db.exec(`update public.ice_type_prices set unit_price=60 where ice_type_id='${ice}'`);
  await call('get_employee_offline_capability', { p_service_date: day });
  await call('record_employee_stock_transfer', { p_round_id: round, p_items: [{ ice_type_id: ice, quantity: 10 }], p_idempotency_key: randomUUID() });
  const charges = [];
  for (const quantity of [1, 2, 1]) {
    const delivery = await call('record_delivery_with_vat_check', { p_round_stop_id: stop, p_items: [{ ice_type_id: ice, quantity }],
      p_stop_status: 'delivered', p_note: null, p_client_recorded_at: new Date().toISOString(), p_idempotency_key: randomUUID(),
      p_payment_term: 'end_of_day', p_approval_id: null, p_expected_vat_rate: 0, p_expected_total: quantity * 60 });
    charges.push(await value('select jsonb_build_object(\'id\',id,\'event\',delivery_event_id) as value from public.delivery_charges where id=$1', [delivery.charge_id]));
  }
  const queue = await call('get_daily_shop_collection_queue_v2', { p_service_date: day });
  const row = queue.queue.find(s => s.shop_id === shop);
  assert.equal(row.outstanding_amount, 240);
  const key = randomUUID();
  const args = { p_shop_id: shop, p_collection_run_id: queue.collection_run_id,
    p_allocations: [{ charge_id: charges[0].id, amount: 60 }, { charge_id: charges[1].id, amount: 120 }],
    p_payment_method: 'cash', p_received_amount: 180, p_reference_number: null, p_evidence_path: null,
    p_expected_outstanding_amount: 240, p_approval_id: null, p_idempotency_key: key };
  const meta = { envelope: { schemaVersion: 1, payloadVersion: 1, commandId: key, idempotencyKey: key, deviceId: randomUUID(),
    ownerId: courier, serviceDate: day, sequence: 1, clientRecordedAt: new Date().toISOString() },
    expected: { queueKey: row.queue_key, payment_profile: row.payment_profile,
      charges: row.charges.map(c => ({ charge_id: c.charge_id, outstanding_amount: c.outstanding_amount })) } };

  await db.exec('begin');
  const unchanged = await call('offline_record_shop_collection_payment', { ...args, p_offline: meta });
  assert.equal(unchanged.status, 'applied', JSON.stringify(unchanged));
  assert.equal(unchanged.result.allocated_amount, 180);
  await db.exec('rollback');
  console.log('PASS: unchanged 240 balance accepts selected 60 + 120 cash payment.');

  await db.exec(`set request.jwt.claim.sub='${admin}'`);
  await call('apply_open_delivery_correction', { p_event_id: charges[2].event, p_action: 'cancel', p_items: [],
    p_stop_status: 'delivered', p_note: null, p_reason: 'Fix', p_idempotency_key: randomUUID(), p_approval_id: null });
  await db.exec(`set request.jwt.claim.sub='${courier}'`);
  const latest = (await call('get_daily_shop_collection_queue_v2', { p_service_date: day })).queue.find(s => s.shop_id === shop);
  assert.equal(latest.outstanding_amount, 180);
  assert.deepEqual(latest.payment_profile, row.payment_profile);
  const conflict = await call('offline_record_shop_collection_payment', { ...args, p_offline: meta });
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.error, 'Collection balance or payment terms changed; supervisor review required');
  assert.equal(await value('select count(*)::int as value from public.payments where idempotency_key=$1', [key]), 0);
  console.log('PASS: cancel unselected 60 bill -> exact reported conflict; no payment created.');

  await db.exec(`set request.jwt.claim.sub='${admin}'`);
  await call('resolve_employee_offline_command', { p_id: key, p_decision: 'retry', p_reason: 'Local diagnosis: verify unchanged payload is rechecked' });
  await db.exec(`set request.jwt.claim.sub='${courier}'`);
  const retried = await call('offline_record_shop_collection_payment', { ...args, p_offline: meta });
  assert.equal(retried.status, 'conflict');
  assert.equal(retried.error, conflict.error);
  console.log('PASS: approving retry alone still conflicts because saved expected amount remains 240.');
} finally {
  await db.close();
}
