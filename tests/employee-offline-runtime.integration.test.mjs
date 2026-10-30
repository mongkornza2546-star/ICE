import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createVatDatabase } from './helpers/creditVatDatabase.mjs';
import { seedOffline, id, admin, courier, other, building, shop, ice, round, stop, today } from './helpers/offlineFixture.mjs';
const value=async(db,sql,args=[]) => (await db.query(sql,args)).rows[0].value;
const policy = c => { const {credit_exposure,credit_remaining,...profile}=c.payment_profile ?? {}; return {stock_source_id:c.stock_source.id,payment_profile:profile,prices:c.items.map(i=>({ice_type_id:i.ice_type_id,unit_price:i.unit_price,price_source_id:i.price_source_id}))}; };

test('offline typed adapters preserve real stock and financial transactions', async t => {
 const db=await createVatDatabase(); t.after(()=>db.close());
 await seedOffline(db);
 const date=await value(db,`select to_char(${today},'YYYY-MM-DD') as value`);
 const recordedAt=await value(db,"select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as value");
 const device=randomUUID(); let sequence=0;
 const context=()=>value(db,`select public.get_delivery_pos_context('${stop}') as value`);
 const stock=()=>value(db,`select public.get_employee_stock_state('${round}') as value`);
 const envelope=(key,seq=++sequence,owner=courier) => ({schemaVersion:1,payloadVersion:1,commandId:key,idempotencyKey:key,deviceId:device,ownerId:owner,serviceDate:date,sequence:seq,clientRecordedAt:recordedAt});
 const call=async(rpc,args,meta)=>{
  const all={...args,p_offline:meta};const names=Object.keys(all);
  return value(db,`select public.offline_${rpc}(${names.map((n,i)=>`${n}=>$${i+1}`).join(',')}) as value`,Object.values(all).map(v=>v && typeof v==='object'?JSON.stringify(v):v));
 };
 const deliveryArgs=(key,quantity=2)=>({p_round_stop_id:stop,p_items:[{ice_type_id:ice,quantity}],p_stop_status:'delivered',p_note:null,p_client_recorded_at:recordedAt,p_idempotency_key:key,p_payment_term:'end_of_day',p_approval_id:null,p_expected_vat_rate:0,p_expected_total:quantity*25});
 let saved, savedArgs, savedMeta;
 await t.test('capability requires the current owner, role and date',async()=>{
  const cap=await value(db,`select public.get_employee_offline_capability('${date}') as value`);
  assert.equal(cap.profile.id,courier); assert.equal(cap.enabled,true);
  await assert.rejects(value(db,`select public.get_employee_offline_capability('${date}'::date-1) as value`),/today/);
  const batch=await value(db,`select public.get_employee_offline_pos_contexts('${round}') as value`);
  assert.equal(batch[stop].round_stop_id,stop);
 });
 await t.test('withdrawal is applied exactly once with original stock locks',async()=>{
  const before=await stock(); const key=randomUUID();
  const args={p_round_id:round,p_items:[{ice_type_id:ice,quantity:20}],p_idempotency_key:key};
  const meta={envelope:envelope(key),expected:{truck_location_id:before.truck_location.id,holding_location_id:before.holding_location.id}};
  await db.exec('grant usage on schema public, auth to authenticated; grant execute on function auth.uid() to authenticated; begin; set local role authenticated');
  assert.equal(await value(db, 'select current_user as value'), 'authenticated');
  let response;
  try { response=await call('record_employee_stock_transfer',args,meta); await db.exec('commit'); }
  finally { await db.exec('rollback; reset role'); }
  assert.equal(response.status,'applied'); assert.deepEqual(await call('record_employee_stock_transfer',args,meta),response);
  const after=await stock(); assert.equal(after.holding_location.balances.find(i=>i.ice_type_id===ice).quantity,20);
  assert.equal(after.truck_location.balances.find(i=>i.ice_type_id===ice).quantity,80);
 });
 await t.test('delivery and command acknowledgement commit together; replay does not double-charge',async()=>{
  const key=randomUUID(); savedArgs=deliveryArgs(key); savedMeta={envelope:envelope(key),expected:policy(await context())};
  saved=await call('record_delivery_with_vat_check',savedArgs,savedMeta);
  assert.equal(saved.status,'applied'); assert.equal(saved.result.total_amount,50);
  assert.deepEqual(await call('record_delivery_with_vat_check',savedArgs,savedMeta),saved);
  assert.equal(await value(db,`select count(*)::int as value from public.delivery_events where idempotency_key='${key}'`),1);
  assert.equal((await stock()).holding_location.balances.find(i=>i.ice_type_id===ice).quantity,18);
  await assert.rejects(call('record_delivery_with_vat_check',{...savedArgs,p_expected_total:51},savedMeta),/IDEMPOTENCY_PAYLOAD_MISMATCH/);
 });
 await t.test('different user cannot replay or read another user command',async()=>{
  await db.exec(`set request.jwt.claim.sub='${other}'`);
  await assert.rejects(call('record_delivery_with_vat_check',savedArgs,savedMeta),/owner mismatch/);
  assert.deepEqual(await value(db,`select public.get_employee_offline_commands(null) as value`),[]);
  await db.exec(`set request.jwt.claim.sub='${courier}'`);
 });
 await t.test('changed prices record a conflict without creating stock or money entries',async()=>{
  const key=randomUUID(), args=deliveryArgs(key),meta={envelope:envelope(key),expected:policy(await context())};
  await db.exec(`insert into public.shop_ice_type_prices(shop_id,ice_type_id,unit_price,valid_from,created_by) values('${shop}','${ice}',30,${today},'${admin}')`);
  const response=await call('record_delivery_with_vat_check',args,meta);
  assert.equal(response.status,'conflict'); assert.match(response.error,/Price changed/);
  assert.equal(await value(db,`select count(*)::int as value from public.delivery_events where idempotency_key='${key}'`),0);
  assert.equal((await stock()).holding_location.balances.find(i=>i.ice_type_id===ice).quantity,18);
  await assert.rejects(value(db,`select public.resolve_employee_offline_command('${key}','retry','review') as value`),/administrator/);
  await db.exec(`set request.jwt.claim.sub='${admin}'; delete from public.shop_ice_type_prices where shop_id='${shop}' and ice_type_id='${ice}'`);
  assert.equal((await value(db,`select public.resolve_employee_offline_command('${key}','retry','ราคาแก้กลับแล้ว ตรวจของจริงแล้ว') as value`)).status,'retry_requested');
  await db.exec(`set request.jwt.claim.sub='${courier}'`);
  assert.equal((await call('record_delivery_with_vat_check',args,meta)).status,'applied');
  assert.equal(await value(db,`select count(*)::int as value from public.offline_sync_issue_decisions`),1);
 });
 await t.test('atomic immediate sale creates one charge, one payment and an official receipt',async()=>{
  const key=randomUUID(); const args={p_round_stop_id:stop,p_items:[{ice_type_id:ice,quantity:1}],p_note:null,p_client_recorded_at:recordedAt,
    p_payment_method:'cash',p_received_amount:30,p_reference_number:null,p_evidence_path:null,p_expected_total:25,p_idempotency_key:key};
  const meta={envelope:envelope(key),expected:policy(await context())};
  const response=await call('record_immediate_sale',args,meta);
  assert.equal(response.status,'applied',JSON.stringify(response)); assert.equal(response.result.payment.allocated_amount,25);
  assert.equal(response.result.payment.change_amount,5); assert.ok(response.result.receipt_number);
  assert.deepEqual(await call('record_immediate_sale',args,meta),response);
  assert.equal(await value(db,`select count(*)::int as value from public.payments where idempotency_key='${key}'`),1);
 });
 await t.test('partial collection preserves allocations and change, and replay never receives money twice',async()=>{
  const queue=await value(db,`select public.get_daily_shop_collection_queue_v2('${date}') as value`);
  const row=queue.queue.find(s=>s.shop_id===shop); assert.equal(row.outstanding_amount,100);
  const key=randomUUID();const args={p_shop_id:shop,p_collection_run_id:queue.collection_run_id,
    p_allocations:[{charge_id:row.charges[0].charge_id,amount:30}],p_payment_method:'cash',p_received_amount:50,
    p_reference_number:null,p_evidence_path:null,p_expected_outstanding_amount:100,p_approval_id:null,p_idempotency_key:key};
  const meta={envelope:envelope(key),expected:{queueKey:row.queue_key,payment_profile:row.payment_profile,
    charges:row.charges.map(c=>({charge_id:c.charge_id,outstanding_amount:c.outstanding_amount}))}};
  const result=await call('record_shop_collection_payment',args,meta);
  assert.equal(result.status,'applied',JSON.stringify(result)); assert.equal(result.result.allocated_amount,30); assert.equal(result.result.change_amount,20);
  assert.deepEqual(await call('record_shop_collection_payment',args,meta),result);
  const after=await value(db,`select public.get_daily_shop_collection_queue_v2('${date}') as value`);
  assert.equal(after.queue.find(s=>s.shop_id===shop).outstanding_amount,70);
  assert.equal(await value(db,`select count(*)::int as value from public.payments where idempotency_key='${key}'`),1);
 });
 await t.test('changed payment policy pauses the command and an approved retry rechecks the original policy',async()=>{
  const key=randomUUID(),args=deliveryArgs(key,1),meta={envelope:envelope(key),expected:policy(await context())};
  const before=await stock();
  await db.exec(`update public.shop_payment_profiles set cash_reference_required=true where shop_id='${shop}'`);
  assert.match((await call('record_delivery_with_vat_check',args,meta)).error,/Payment terms/);
  assert.deepEqual(await stock(),before);
  await db.exec(`set request.jwt.claim.sub='${admin}'; update public.shop_payment_profiles set cash_reference_required=false where shop_id='${shop}'`);
  await value(db,`select public.resolve_employee_offline_command('${key}','retry','ตรวจเงื่อนไขเดิมแล้ว') as value`);
  await db.exec(`set request.jwt.claim.sub='${courier}'`);
  assert.equal((await call('record_delivery_with_vat_check',args,meta)).status,'applied');
 });
 await t.test('return and damage retain the original stock accounting with exactly-once replay',async()=>{
  for (const rpc of ['record_employee_stock_return','record_employee_stock_damage']) {
   const key=randomUUID(),before=await stock();
   const args={p_round_id:round,p_items:[{ice_type_id:ice,quantity:1}],p_idempotency_key:key};
   const meta={envelope:envelope(key),expected:{truck_location_id:before.truck_location.id,holding_location_id:before.holding_location.id}};
   const result=await call(rpc,args,meta); assert.equal(result.status,'applied',JSON.stringify(result));
   assert.deepEqual(await call(rpc,args,meta),result);
   const after=await stock();
   assert.equal(after.holding_location.balances.find(i=>i.ice_type_id===ice).quantity,before.holding_location.balances.find(i=>i.ice_type_id===ice).quantity-1);
   assert.equal(after.truck_location.balances.find(i=>i.ice_type_id===ice).quantity,before.truck_location.balances.find(i=>i.ice_type_id===ice).quantity+(rpc.endsWith('return')?1:0));
  }
 });
 await t.test('overdraw conflicts roll back all writer changes and cannot be discarded by the courier',async()=>{
  const key=randomUUID(),args=deliveryArgs(key,999),meta={envelope:envelope(key),expected:policy(await context())};
  const before=await stock(); const result=await call('record_delivery_with_vat_check',args,meta);
  assert.equal(result.status,'conflict'); assert.deepEqual(await stock(),before);
  await assert.rejects(value(db,`select public.resolve_employee_offline_command('${key}','approve_discard','discard') as value`),/administrator/);
  await db.exec(`set request.jwt.claim.sub='${admin}'`);
  await assert.rejects(value(db,`select public.resolve_employee_offline_command('${key}','approve_discard',' ') as value`),/reason/);
  assert.equal((await value(db,`select public.resolve_employee_offline_command('${key}','approve_discard','ไม่มีการส่งจริง ตรวจสต๊อกแล้ว') as value`)).status,'discard_approved');
  await db.exec(`set request.jwt.claim.sub='${courier}'`);
 });
 await t.test('commands drafted before a discarded predecessor require their own review',async()=>{
  const key=randomUUID(),args=deliveryArgs(key,1),meta={envelope:envelope(key),expected:policy(await context())};
  const before=await stock(); const result=await call('record_delivery_with_vat_check',args,meta);
  assert.equal(result.status,'conflict'); assert.match(result.error,/Preceding command was discarded/); assert.deepEqual(await stock(),before);
  await db.exec(`set request.jwt.claim.sub='${admin}'`);
  await value(db,`select public.resolve_employee_offline_command('${key}','retry','ตรวจรายการต่อเนื่องและสต๊อกจริงแล้ว') as value`);
  await db.exec(`set request.jwt.claim.sub='${courier}'`);
  assert.equal((await call('record_delivery_with_vat_check',args,meta)).status,'applied');
 });
 await t.test('event delivery prepares a zero-debt booth and collects its confirmed charge exactly once', async()=>{
  const job=id(30), config=id(31), participation=id(32), eventStop=id(33);
  await db.exec(`set request.jwt.claim.sub='${admin}';
    insert into public.event_jobs(id,name,organizer_name,contact_name,contact_phone,location,start_date,end_date,status,created_by,published_by,published_at)
      values('${job}','Offline event','Org','Contact','0800000000','Hall',${today},${today}+1,'published','${admin}','${admin}',now());
    insert into public.event_job_config_versions(id,event_job_id,version_no,tank_rental_unit_price,payment_term,allowed_payment_methods,default_payment_method,bank_transfer_reference_required,qr_reference_required,policy_fingerprint,created_by)
      values('${config}','${job}',1,20,'end_of_day','{cash}','cash',false,false,'offline-event-policy','${admin}');
    update public.event_jobs set current_config_version_id='${config}' where id='${job}';
    insert into public.event_participations(id,event_job_id,shop_id,booth_number,event_zone,contact_name,contact_phone,start_date,end_date,status,config_version_id,tank_rental_unit_price_snapshot,
      payment_term_snapshot,allowed_payment_methods_snapshot,default_payment_method_snapshot,cash_reference_required_snapshot,cash_evidence_required_snapshot,bank_transfer_reference_required_snapshot,
      bank_transfer_evidence_required_snapshot,qr_reference_required_snapshot,qr_evidence_required_snapshot,settlement_policy_fingerprint,created_by,updated_by)
      values('${participation}','${job}','${shop}','B1','Hall','Contact','0800000000',${today},${today}+1,'active','${config}',20,'end_of_day','{cash}','cash',false,false,false,false,false,false,'offline-event-policy','${admin}','${admin}');
    select public.enable_event_ice_delivery_pilot('${participation}',clock_timestamp()+interval '1 hour');
    insert into public.round_stops(id,round_id,shop_id,shop_code_snapshot,shop_name_snapshot,building_id_snapshot,building_name_snapshot,floor_or_zone_snapshot,sequence_no,status,updated_by,
      destination_kind,event_participation_id,is_operational,event_job_name_snapshot,event_location_snapshot)
      values('${eventStop}','${round}','${shop}','OFF-SHOP','Offline shop','${building}','Offline','Hall',2,'pending','${admin}','event','${participation}',true,'Offline event','Hall');
    set request.jwt.claim.sub='${courier}';`);
  const batch=await value(db,`select public.get_employee_offline_pos_contexts('${round}') as value`);
  const prepared=batch[eventStop];
  assert.equal(prepared.offline_collection_template.queue_key,`event-participation:${participation}`);
  assert.equal(prepared.offline_collection_template.settlement_policy_fingerprint,'offline-event-policy');
  assert.equal(prepared.offline_collection_template.outstanding_amount,0);
  const eventDevice=randomUUID(), key=randomUUID();
  const meta={envelope:{...envelope(key,1),deviceId:eventDevice},expected:{...policy(prepared),expected_total:25}};
  const args={p_round_stop_id:eventStop,p_items:[{ice_type_id:ice,quantity:1}],p_stop_status:'delivered',p_note:null,p_client_recorded_at:recordedAt,p_idempotency_key:key};
  const delivered=await call('record_event_ice_delivery',args,meta);
  assert.equal(delivered.status,'applied',JSON.stringify(delivered));
  assert.deepEqual(await call('record_event_ice_delivery',args,meta),delivered);
  const queue=await value(db,`select public.get_daily_shop_collection_queue_v2('${date}') as value`);
  const row=queue.queue.find(s=>s.queue_key===`event-participation:${participation}`);
  assert.equal(row.outstanding_amount,25); assert.equal(row.charges[0].charge_id,delivered.result.charge_id);
  const payKey=randomUUID(),payArgs={p_expected_participation_id:participation,p_expected_policy_fingerprint:'offline-event-policy',p_allocations:[{charge_id:delivered.result.charge_id,amount:25}],
    p_payment_method:'cash',p_received_amount:30,p_reference_number:null,p_evidence_path:null,p_collection_run_id:queue.collection_run_id,p_expected_outstanding_amount:25,p_idempotency_key:payKey};
  const payMeta={envelope:{...envelope(payKey,2),deviceId:eventDevice},expected:{queueKey:row.queue_key,payment_profile:row.payment_profile,charges:[{charge_id:delivered.result.charge_id,outstanding_amount:25}]}};
  const payment=await call('record_event_collection_payment',payArgs,payMeta);
  assert.equal(payment.status,'applied',JSON.stringify(payment)); assert.equal(payment.result.change_amount,5); assert.ok(payment.result.receipt_number);
  assert.deepEqual(await call('record_event_collection_payment',payArgs,payMeta),payment);
  assert.equal(await value(db,`select count(*)::int as value from public.payments where idempotency_key='${payKey}'`),1);
 });
 await t.test('private helpers and tables are not callable from the client; anonymous writes are denied',async()=>{
  for(const role of ['anon','authenticated']) {
   assert.equal(await value(db,`select has_function_privilege('${role}','public.employee_offline_finish_v2(uuid,jsonb,text)','EXECUTE') as value`),false);
   for (const check of ['employee_offline_assert_command_issue_state_v1', 'employee_offline_assert_decision_transition_v1']) {
    assert.equal(await value(db,`select has_function_privilege('${role}','public.${check}()','EXECUTE') as value`),false);
   }
   assert.equal(await value(db,`select has_table_privilege('${role}','public.employee_offline_commands','INSERT') as value`),false);
  }
  await db.exec('set role anon');
  await assert.rejects(call('record_delivery_with_vat_check',savedArgs,savedMeta),/permission denied/);
  await db.exec('reset role');
 });
});
