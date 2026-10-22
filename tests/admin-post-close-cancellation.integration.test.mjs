import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createVatDatabase } from './helpers/creditVatDatabase.mjs';

const id = n => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const admin = id(1), courier = id(2), building = id(3), shop = id(4);
const ice = id(5), round = id(6), stop = id(7);
const today = "(clock_timestamp() at time zone 'Asia/Bangkok')::date";
const value = async (db, sql, args = []) => (await db.query(sql, args)).rows[0].value;

for (const daysAgo of [0, 1]) test(`admin cancels after stock/cash close (${daysAgo} days ago)`, async t => {
  const today = `((clock_timestamp() at time zone 'Asia/Bangkok')::date - ${daysAgo})`;
  const db = await createVatDatabase();
  t.after(() => db.close());
  await db.exec('grant usage on schema public to authenticated');
  await db.exec(`
    insert into auth.users(id,email,raw_user_meta_data) values
      ('${admin}','truck-admin@example.test','{"display_name":"Admin"}'),
      ('${courier}','truck-courier@example.test','{"display_name":"Courier"}');
    update public.users set role='admin',is_active=true where id='${admin}';
    update public.users set role='courier',is_active=true where id='${courier}';
    set request.jwt.claim.sub='${admin}';
    insert into public.buildings(id,code,name) values ('${building}','TRUCK-TEST','Truck test');
    insert into public.employee_work_site_assignments(user_id,stock_location_id,assigned_by)
      select '${courier}',id,'${admin}' from public.stock_locations
      where building_id='${building}' and is_default_for_building;
    insert into public.building_zones(id,building_id,code,name) values ('${id(8)}','${building}','ZONE','1');
    insert into public.shops(id,code,name,building_id,floor_or_zone,zone_id,stock_location_id)
      select '${shop}','TRUCK-SHOP','Truck shop','${building}','1','${id(8)}',id
      from public.stock_locations where building_id='${building}' and is_default_for_building;
    insert into public.ice_types(id,code,name,unit) values ('${ice}','TRUCK-ICE','Test ice','bag');
    insert into public.ice_type_prices(ice_type_id,unit_price,valid_from,created_by)
      values ('${ice}',25,${today},'${admin}');
    insert into public.shop_payment_profiles(shop_id,allowed_payment_terms,default_payment_term,
      allowed_payment_methods,default_payment_method,allow_outstanding,created_by)
      values ('${shop}','{end_of_day}','end_of_day','{cash}','cash',true,'${admin}');
    insert into public.delivery_rounds(id,service_date,name,round_type,status,opened_by)
      values ('${round}',${today},'งานประจำวัน','daily','open','${admin}');
    insert into public.delivery_round_members(round_id,user_id) values ('${round}','${courier}');
    insert into public.round_stops(id,round_id,shop_id,shop_code_snapshot,shop_name_snapshot,
      building_id_snapshot,building_name_snapshot,floor_or_zone_snapshot,sequence_no,updated_by)
      values ('${stop}','${round}','${shop}','TRUCK-SHOP','Truck shop',
        '${building}','Truck test','1',1,'${admin}');
  `);
  const truck = await value(db, `select id as value from public.stock_locations where code='TRUCK-MAIN'`);
  await db.query(`update public.stock_locations set is_courier_source=true,is_active=true,holds_inventory=true where id=$1`, [truck]);
  const holding = await value(db, `select public.ensure_courier_stock_holder('${courier}') as value`);
  const site = await value(db, `select stock_location_id as value from public.shops where id='${shop}'`);
  async function movement(kind, from, to, quantity) {
    const movementId = randomUUID();
    await db.query(`insert into public.stock_movements(id,service_date,round_id,kind,from_location_id,
      to_location_id,idempotency_key,recorded_by) values ($1,${today},'${round}',$2,$3,$4,$1,'${admin}')`,
    [movementId, kind, from, to]);
    await db.query(`insert into public.stock_movement_items(movement_id,ice_type_id,quantity)
      values ($1,'${ice}',$2)`, [movementId, quantity]);
  }
  const balance = location => value(db, `select public.stock_balance_at(${today},$1,'${ice}')::float8 as value`, [location]);
  const aggregate = () => value(db, `select public.daily_aggregate_stock_balance_at(${today},'${ice}')::float8 as value`);
  const record = (quantity, key = randomUUID()) => value(db, `select public.record_delivery_with_vat_check(
    '${stop}',$1::jsonb,'delivered',null,now(),$2,'end_of_day',null,0,$3) as value`,
  [JSON.stringify([{ ice_type_id: ice, quantity }]), key, quantity * 25]);
  const context = () => value(db, `select public.get_delivery_pos_context('${stop}') as value`);

  await movement('factory_order', null, truck, 10);
  const sale = await record(2);
  const run = await value(db, `select public.ensure_daily_collection_context(${today}) as value`);
  await db.exec(`
    update public.delivery_rounds set status='closed',closed_at=now(),closed_by='${admin}' where id='${round}';
    update public.collection_runs set status='closed',closed_at=now(),closed_by='${admin}';
    insert into public.daily_aggregate_stock_closures(service_date,closed_by,idempotency_key,status)
      values (${today},'${admin}',gen_random_uuid(),'closed');
  `);
  await db.exec(`
    insert into public.daily_close_reconciliation_requests(idempotency_key,service_date,request_fingerprint,recorded_by)
      values ('${id(30)}',${today},'closed-snapshot','${admin}');
    insert into public.daily_close_employee_snapshots(service_date,employee_id,expected_cash_amount,actual_cash_amount,recorded_by,request_idempotency_key)
      values (${today},'${admin}',0,0,'${admin}','${id(30)}');
  `);
  const snapshot = await value(db, `select to_jsonb(s) as value from public.daily_close_employee_snapshots s`);

  const correctionContext = event => value(db, `select public.get_delivery_correction_context($1) as value`,[event]);
  const cancel = (event,key=randomUUID(),reason='บันทึกผิด') => value(db, `select public.apply_open_delivery_correction($1,'cancel','[]','delivered',null,$2,$3,null) as value`,[event,reason,key]);
  const voidPayment = (payment,reason='รับเงินผิด') => value(db, `select public.void_payment($1,$2) as value`,[payment,reason]);
  await t.test('unpaid closed delivery can be cancelled only by admin, with reason and single audit', async () => {
    for(const role of ['courier','round_lead']) {
      await db.query(`update public.users set role=$1 where id=$2`,[role,admin]);
      assert.equal((await correctionContext(sale.delivery_event_id)).can_cancel,false);
      await assert.rejects(cancel(sale.delivery_event_id),/ปิด/);
    }
    await db.exec(`update public.users set role='admin' where id='${admin}'`);
    const preview=await correctionContext(sale.delivery_event_id);
    assert.equal(preview.can_cancel,true);
    assert.equal(preview.can_cancel_closed_period,true);
    await assert.rejects(cancel(sale.delivery_event_id,randomUUID(),''),/reason/);
    const key=randomUUID();
    await cancel(sale.delivery_event_id,key);
    assert.equal((await cancel(sale.delivery_event_id,key)).idempotent_replay,true);
    assert.equal(await value(db,`select status::text as value from public.delivery_events where id=$1`,[sale.delivery_event_id]),'cancelled');
    assert.equal(await aggregate(),0);
    assert.equal(await value(db,`select count(*)::int as value from public.audit_logs where action='admin_post_close_cancelled' and entity_id=$1`,[sale.delivery_event_id]),1);
  });
  await t.test('voiding closed-day cash restores debt without altering the close snapshot', async () => {
    const next=await record(1);
    const date=await value(db,`select ${today}::text as value`);
    const queue=await value(db,`select public.get_daily_shop_collection_queue(${today}) as value`);
    const row=queue.queue.find(s=>s.shop_id===shop);
    const args={p_shop_id:shop,p_allocations:[{charge_id:next.charge_id,amount:25}],p_payment_method:'cash',
      p_received_amount:25,p_collection_run_id:run.collection_run_id,p_expected_outstanding_amount:row.outstanding_amount,p_idempotency_key:randomUUID()};
    const payment=daysAgo ? await value(db,`select public.record_backdated_collection_payment('record_shop_collection_payment',$1,$2::jsonb) as value`,[date,JSON.stringify(args)])
      : await value(db,`select public.record_shop_collection_payment($1,$2::jsonb,'cash',25,null,null,$3,$4,null,$5) as value`,[shop,JSON.stringify(args.p_allocations),run.collection_run_id,row.outstanding_amount,args.p_idempotency_key]);
    await assert.rejects(cancel(next.delivery_event_id),/รับชำระแล้ว/);
    for(const role of ['courier','round_lead']) {
      await db.query(`update public.users set role=$1 where id=$2`,[role,admin]);
      await assert.rejects(voidPayment(payment.payment_id),/closed|cannot collect/);
    }
    await db.exec(`update public.users set role='admin',is_active=false where id='${admin}'`);
    await assert.rejects(voidPayment(payment.payment_id),/active|cannot collect/);
    await db.exec(`update public.users set is_active=true where id='${admin}'`);
    await assert.rejects(voidPayment(payment.payment_id,''),/reason/);
    await assert.rejects(db.query(`update public.payments set allocated_amount=allocated_amount-1 where id=$1`,[payment.payment_id]),/ปิดตรวจนับเงินสดแล้ว/);
    await db.exec('set role authenticated');
    try { await voidPayment(payment.payment_id); } finally { await db.exec('reset role'); }
    assert.equal(await value(db,`select status::text as value from public.payments where id=$1`,[payment.payment_id]),'voided');
    assert.equal((await correctionContext(next.delivery_event_id)).allocated_amount,0);
    assert.equal((await correctionContext(next.delivery_event_id)).can_cancel,true);
    await cancel(next.delivery_event_id);
    assert.deepEqual(await value(db,`select to_jsonb(s) as value from public.daily_close_employee_snapshots s`),snapshot);
    assert.equal(await value(db,`select status::text as value from public.collection_runs where id=$1`,[run.collection_run_id]),'closed');
    assert.equal(await value(db,`select count(*)::int as value from public.audit_logs where action='admin_post_close_cancelled' and entity_id=$1`,[payment.payment_id]),1);
    await assert.rejects(voidPayment(payment.payment_id),/already voided/);
  });
  await t.test('event cancellation uses the same closed-period policy and audit', async () => {
    const event = id(20), config = id(21), participation = id(22), eventStop = id(23);
    await db.exec(`
      insert into public.event_jobs(id,name,organizer_name,contact_name,contact_phone,location,
        start_date,end_date,status,created_by,published_by,published_at)
      values ('${event}','Truck event','Organizer','Contact','0800000000','Hall',
        ${today},${today},'published','${admin}','${admin}',now());
      insert into public.event_job_config_versions(id,event_job_id,version_no,tank_rental_unit_price,
        payment_term,allowed_payment_methods,default_payment_method,bank_transfer_reference_required,
        qr_reference_required,policy_fingerprint,created_by)
      values ('${config}','${event}',1,100,'end_of_day','{cash}','cash',false,false,'truck-policy','${admin}');
      update public.event_jobs set current_config_version_id='${config}' where id='${event}';
      insert into public.event_participations(id,event_job_id,shop_id,booth_number,event_zone,contact_name,
        contact_phone,start_date,end_date,status,config_version_id,tank_rental_unit_price_snapshot,
        payment_term_snapshot,allowed_payment_methods_snapshot,default_payment_method_snapshot,
        cash_reference_required_snapshot,cash_evidence_required_snapshot,bank_transfer_reference_required_snapshot,
        bank_transfer_evidence_required_snapshot,qr_reference_required_snapshot,qr_evidence_required_snapshot,
        settlement_policy_fingerprint,created_by,updated_by)
      values ('${participation}','${event}','${shop}','A1','Hall','Contact','0800000000',
        ${today},${today},'active','${config}',100,'end_of_day','{cash}','cash',
        false,false,false,false,false,false,'truck-policy','${admin}','${admin}');
      insert into public.round_stops(id,round_id,shop_id,shop_code_snapshot,shop_name_snapshot,
        building_id_snapshot,building_name_snapshot,floor_or_zone_snapshot,sequence_no,status,updated_by,
        destination_kind,event_participation_id,is_operational,event_job_name_snapshot,event_location_snapshot)
      values ('${eventStop}','${round}','${shop}','TRUCK-SHOP','Truck shop','${building}','Truck test',
        'Hall',2,'pending','${admin}','event','${participation}',true,'Truck event','Hall');
      select public.enable_event_ice_delivery_pilot('${participation}',clock_timestamp()+interval '1 hour');
    `);

    const eventSale=await value(db,`select public.record_event_ice_delivery('${eventStop}',$1::jsonb,'delivered',null,now(),$2) as value`,
      [JSON.stringify([{ice_type_id:ice,quantity:1}]),randomUUID()]);
    const preview=await value(db,`select public.get_event_delivery_correction_context($1) as value`,[eventSale.delivery_event_id]);
    assert.equal(preview.can_cancel_closed_period,true);
    const key=randomUUID();
    const apply=()=>value(db,`select public.apply_open_event_delivery_correction($1,'cancel','[]','delivered',null,'event mistake',$2,null) as value`,[eventSale.delivery_event_id,key]);
    await db.exec('set role authenticated');
    try { await apply(); assert.equal((await apply()).idempotent_replay,true); }
    finally { await db.exec('reset role'); }
    assert.equal(await value(db,`select status::text as value from public.delivery_events where id=$1`,[eventSale.delivery_event_id]),'cancelled');
    assert.equal(await value(db,`select count(*)::int as value from public.audit_logs where action='admin_post_close_cancelled' and entity_id=$1`,[eventSale.delivery_event_id]),1);
    assert.equal(await aggregate(),0);
  });
  await db.exec(readFileSync(new URL('../supabase/migrations/0255_admin_post_close_cancellations.sql',import.meta.url),'utf8'));

});
