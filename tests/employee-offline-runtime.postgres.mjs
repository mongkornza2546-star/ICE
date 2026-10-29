import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { initializeVatDatabase } from './helpers/creditVatDatabase.mjs';
import { seedOffline, courier, admin, ice, round, stop, shop } from './helpers/offlineFixture.mjs';

const container = `ice-offline-concurrency-${process.pid}`;
const docker = (args, input) => spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
const psqlArgs = ['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'];
function sql(text) {
  const r = docker(psqlArgs, text);
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout.trim();
}
function concurrent(text) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', psqlArgs); let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
    child.stdin.end(text);
  });
}
const quote = v => v == null ? 'null' : `'${String(typeof v === 'object' ? JSON.stringify(v) : v).replaceAll("'", "''")}'`;
const run = (statement, actor = courier) => `begin; set local statement_timeout='15s'; set local request.jwt.claim.sub='${actor}'; ${statement}; commit;`;
const read = statement => JSON.parse(sql(run(`select to_jsonb(q) from (${statement}) q`)));
const policy = c => { const { credit_exposure, credit_remaining, ...profile } = c.payment_profile; return { stock_source_id: c.stock_source.id, payment_profile: profile, prices: c.items.map(i => ({ ice_type_id: i.ice_type_id, unit_price: i.unit_price, price_source_id: i.price_source_id })) }; };
try {
  const r = docker(['run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=test', 'postgres:16']);
  if (r.status !== 0) throw new Error(r.stderr);
  let ready = false;
  for (let n = 0; n < 100; n++) { if (docker([...psqlArgs, '-c', 'select 1']).status === 0) { ready = true; break; } await new Promise(r => setTimeout(r, 200)); }
  assert.ok(ready, 'Postgres readiness');
  const schema = [];
  await initializeVatDatabase({ exec: async s => { schema.push(`begin; ${s} commit;`); } });
  sql(schema.join("\n"));
  await seedOffline({ exec: async s => sql(s) });
  const date = read("select (clock_timestamp() at time zone 'Asia/Bangkok')::date as day").day;
  sql(run(`select public.get_employee_offline_capability('${date}')`));
  const makeCall = (rpc, args, expected, device = randomUUID(), sequence = 1) => {
    const key = args.p_idempotency_key;
    const meta = { envelope: { schemaVersion: 1, payloadVersion: 1, commandId: key, idempotencyKey: key, deviceId: device, ownerId: courier, serviceDate: date, sequence, clientRecordedAt: new Date().toISOString() }, expected };
    return `select public.offline_${rpc}(${Object.entries({ ...args, p_offline: meta }).map(([k, v]) => `${k}=>${quote(v)}`).join(',')})`;
  };
  const before = read(`select public.get_employee_stock_state('${round}') as value`).value;
  const transfer = makeCall('record_employee_stock_transfer', { p_round_id: round, p_items: [{ ice_type_id: ice, quantity: 20 }], p_idempotency_key: randomUUID() }, { truck_location_id: before.truck_location.id, holding_location_id: before.holding_location.id });
  const sameKey = await Promise.all([concurrent(run(transfer)), concurrent(run(transfer))]);
  assert.deepEqual(sameKey.map(JSON.parse).map(r => r.status), ['applied', 'applied']);
  assert.equal(read(`select public.get_employee_stock_state('${round}') as value`).value.holding_location.balances.find(b => b.ice_type_id === ice).quantity, 20);
  console.log('PASS concurrent identical key: one withdrawal');

  const context = read(`select public.get_delivery_pos_context('${stop}') as value`).value;
  const sale = () => makeCall('record_delivery_with_vat_check', { p_round_stop_id: stop, p_items: [{ ice_type_id: ice, quantity: 15 }], p_stop_status: 'delivered', p_note: null, p_client_recorded_at: new Date().toISOString(), p_idempotency_key: randomUUID(), p_payment_term: 'end_of_day', p_approval_id: null, p_expected_vat_rate: 0, p_expected_total: 375 }, policy(context));
  const sales = (await Promise.all([concurrent(run(sale())), concurrent(run(sale()))])).map(JSON.parse);
  assert.deepEqual(sales.map(r => r.status).sort(), ['applied', 'conflict']);
  assert.equal(read(`select public.get_employee_stock_state('${round}') as value`).value.holding_location.balances.find(b => b.ice_type_id === ice).quantity, 5);
  assert.equal(read('select count(*)::int as count from public.delivery_events').count, 1);
  console.log('PASS two devices competing for stock: one delivery, one reviewable conflict');

  const queue = read(`select public.get_daily_shop_collection_queue_v2('${date}') as value`).value;
  const row = queue.queue.find(s => s.shop_id === shop);
  const payment = () => makeCall('record_shop_collection_payment', { p_shop_id: shop, p_collection_run_id: queue.collection_run_id, p_allocations: [{ charge_id: row.charges[0].charge_id, amount: 375 }], p_payment_method: 'cash', p_received_amount: 400, p_reference_number: null, p_evidence_path: null, p_expected_outstanding_amount: 375, p_approval_id: null, p_idempotency_key: randomUUID() }, { queueKey: row.queue_key, payment_profile: row.payment_profile, charges: row.charges.map(c => ({ charge_id: c.charge_id, outstanding_amount: c.outstanding_amount })) });
  const payments = (await Promise.all([concurrent(run(payment())), concurrent(run(payment()))])).map(JSON.parse);
  assert.deepEqual(payments.map(r => r.status).sort(), ['applied', 'conflict']);
  assert.equal(read('select count(*)::int as count from public.payments').count, 1);
  assert.equal(read('select sum(allocated_amount) as amount from public.payments').amount, 375);
  console.log('PASS two devices collecting the same receivable: one payment and receipt');

  // Concurrent configuration changes must either precede validation (conflict)
  // or wait until the original policy has committed, never tear a transaction.
  const racingSale = makeCall('record_delivery_with_vat_check', { p_round_stop_id: stop, p_items: [{ ice_type_id: ice, quantity: 1 }], p_stop_status: 'delivered', p_note: null, p_client_recorded_at: new Date().toISOString(), p_idempotency_key: randomUUID(), p_payment_term: 'end_of_day', p_approval_id: null, p_expected_vat_rate: 0, p_expected_total: 25 }, policy(context));
  const [result] = await Promise.all([concurrent(run(racingSale)), concurrent(run(`update public.shop_payment_profiles set cash_reference_required=true where shop_id='${shop}'`, admin))]);
  assert.ok(['applied', 'conflict'].includes(JSON.parse(result).status));
  console.log('PASS configuration edit versus offline write commits without deadlock');
} finally { docker(['rm', '-f', container]); }
