import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createVatDatabase } from './helpers/creditVatDatabase.mjs';
import { seedOffline, admin, courier, shop, round, stop, ice, today as fixtureToday } from './helpers/offlineFixture.mjs';

test('offline collection permission and historical replay stay scoped to the original open run', async t => {
  const db = await createVatDatabase(); t.after(() => db.close());
  await seedOffline({ exec: sql => db.exec(sql.replaceAll(fixtureToday, `(${fixtureToday}-1)`)) });
  const value = async (sql, args=[]) => (await db.query(sql,args)).rows[0].value;
  const call = async (name,args) => value(`select public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(',')}) as value`,
    Object.values(args).map(v=>v && typeof v==='object'?JSON.stringify(v):v));
  const today = await value("select (clock_timestamp() at time zone 'Asia/Bangkok')::date::text as value");
  await value(`select public.get_employee_offline_capability('${today}') as value`);
  await db.exec('grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated');
  await db.exec('set role authenticated');
  let queue = await value(`select public.get_daily_shop_collection_queue_v2('${today}') as value`);
  assert.equal(queue.can_record_payment,true);
  await db.exec('reset role');
  await db.exec(`update public.users set can_collect_shop_payments=false where id='${courier}'`);
  assert.equal((await value(`select public.get_daily_shop_collection_queue_v2('${today}') as value`)).can_record_payment,false);
  await db.exec(`update public.users set can_collect_shop_payments=true where id='${courier}'`);
  await call('record_employee_stock_transfer',{p_round_id:round,p_items:[{ice_type_id:ice,quantity:10}],p_idempotency_key:randomUUID()});
  await db.exec(`set request.jwt.claim.sub='${admin}'`);
  await call('record_delivery_with_vat_check',{p_round_stop_id:stop,p_items:[{ice_type_id:ice,quantity:2}],p_stop_status:'delivered',p_note:null,
    p_client_recorded_at:new Date().toISOString(),p_idempotency_key:randomUUID(),p_payment_term:'end_of_day',p_approval_id:null,p_expected_vat_rate:0,p_expected_total:50});
  await db.exec(`set request.jwt.claim.sub='${courier}'`);
  queue = await value(`select public.get_daily_shop_collection_queue_v2('${today}') as value`);
  const row=queue.queue.find(s=>s.shop_id===shop);
  const yesterday=await value("select ((clock_timestamp() at time zone 'Asia/Bangkok')::date-1)::text as value");
  // Simulate reconnecting on the following day without changing the saved run,
  // outstanding balance or permission. The original run remains open.
  await db.exec(`update public.collection_runs set service_date='${yesterday}' where id='${queue.collection_run_id}'`);
  const args={p_shop_id:shop,p_allocations:[{charge_id:row.charges[0].charge_id,amount:20}],p_payment_method:'cash',p_received_amount:20,
    p_reference_number:null,p_evidence_path:null,p_collection_run_id:queue.collection_run_id,p_expected_outstanding_amount:50,p_approval_id:null,p_idempotency_key:randomUUID()};
  const meta={envelope:{schemaVersion:1,payloadVersion:1,commandId:args.p_idempotency_key,idempotencyKey:args.p_idempotency_key,
    ownerId:courier,deviceId:randomUUID(),serviceDate:yesterday,sequence:1,clientRecordedAt:`${yesterday}T04:00:00Z`},
    expected:{queueKey:row.queue_key,payment_profile:row.payment_profile,charges:row.charges.map(c=>({charge_id:c.charge_id,outstanding_amount:c.outstanding_amount}))}};
  await assert.rejects(value(`select public.get_daily_shop_collection_queue_v2('${yesterday}') as value`),/current Bangkok/);
  await assert.rejects(call('record_shop_collection_payment',args));
  await db.exec('begin; set local role authenticated');
  let result;
  try { result=await call('offline_record_shop_collection_payment',{...args,p_offline:meta}); await db.exec('commit'); }
  finally { await db.exec('rollback; reset role'); }
  assert.equal(result.status,'applied',JSON.stringify(result));
  assert.equal(result.result.allocated_amount,20);
  assert.deepEqual(await call('offline_record_shop_collection_payment',{...args,p_offline:meta}),result);
  assert.equal(await value(`select count(*)::int as value from public.payments where idempotency_key='${args.p_idempotency_key}'`),1);
  assert.equal(await value('select count(*)::int as value from employee_offline_private.collection_replay'),0);
  // Successful replay must not leak permission to subsequent normal requests.
  await assert.rejects(value(`select public.get_daily_shop_collection_queue_v2('${yesterday}') as value`),/current Bangkok/);
  for (const role of ['anon','authenticated']) {
    assert.equal(await value(`select has_table_privilege('${role}','employee_offline_private.collection_replay','INSERT') as value`),false);
    assert.equal(await value(`select has_function_privilege('${role}','employee_offline_private.collection_replay_allowed(date,uuid)','EXECUTE') as value`),false);
  }
  // A closed run must remain a reviewable conflict, never be reopened by sync.
  await db.exec(`update public.collection_runs set status='closed',closed_by='${courier}',closed_at=now() where id='${queue.collection_run_id}'`);
  const key=randomUUID(); const closedArgs={...args,p_idempotency_key:key,p_expected_outstanding_amount:30};
  const closedMeta={...meta,envelope:{...meta.envelope,commandId:key,idempotencyKey:key,sequence:2}};
  const closed=await call('offline_record_shop_collection_payment',{...closedArgs,p_offline:closedMeta});
  assert.equal(closed.status,'conflict');
  assert.equal(await value(`select count(*)::int as value from public.payments where idempotency_key='${key}'`),0);
  assert.equal(await value('select count(*)::int as value from employee_offline_private.collection_replay'),0);
});
