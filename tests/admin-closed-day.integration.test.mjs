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

for (const daysAgo of [0, 1]) test(`admin appends after stock/cash close (${daysAgo} days ago)`, async t => {
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
  await t.test('closed round remains selectable without reopening it', async () => {
    const session = await value(db, `select public.get_employee_active_session(${today}) as value`);
    assert.equal(session.sessions.length, 1);
    assert.equal(session.sessions[0].status, 'closed');
    assert.equal(session.sessions[0].can_record_delivery, true);
    const cards = await value(db, `select jsonb_agg(card) as value from public.get_round_shop_cards('${round}',null) card`);
    assert.ok(cards.some(card=>card.round_stop_id===stop));
  });
  await t.test('admin delivery succeeds after stock close with replay protection', async () => {
    const key=randomUUID();
    const preview=await context();
    assert.equal(preview.stock_check_required,false);
    await db.exec('set role authenticated');
    try {
      const result=await record(1,key);
      assert.equal((await record(1,key)).delivery_event_id,result.delivery_event_id);
    } finally { await db.exec('reset role'); }
    assert.equal(await aggregate(),0);
  });
  await t.test('admin collection remains writable after close', async () => {
    const queue=await value(db, `select public.get_daily_shop_collection_queue(${today}) as value`);
    assert.equal(queue.status,'closed');
    assert.equal(queue.can_record_payment,true);
    assert.equal(queue.collection_run_id,run.collection_run_id);
  });

  await t.test('cash receipt uses the closed date, preserves snapshots and replays only once', async () => {
    const date=await value(db, `select ${today}::text as value`);
    const queue=await value(db, `select public.get_daily_shop_collection_queue(${today}) as value`);
    const row=queue.queue.find(s=>s.shop_id===shop);
    const args={p_shop_id:shop,p_allocations:row.charges.map(c=>({charge_id:c.charge_id,amount:c.outstanding_amount})),
      p_payment_method:'cash',p_received_amount:row.outstanding_amount,p_collection_run_id:run.collection_run_id,
      p_expected_outstanding_amount:row.outstanding_amount,p_idempotency_key:randomUUID()};
    const pay=()=>daysAgo ? value(db, `select public.record_backdated_collection_payment('record_shop_collection_payment',$1,$2::jsonb) as value`,[date,JSON.stringify(args)])
      : value(db, `select public.record_shop_collection_payment($1,$2::jsonb,'cash',$3,null,null,$4,$3,null,$5) as value`,
        [shop,JSON.stringify(args.p_allocations),args.p_received_amount,run.collection_run_id,args.p_idempotency_key]);
    const result=await pay();
    assert.equal((await pay()).payment_id,result.payment_id);
    assert.equal(await value(db, `select count(*)::int as value from public.payments`),1);
    assert.equal(await value(db, `select (recorded_at at time zone 'Asia/Bangkok')::date::text as value from public.payments`),date);
    assert.deepEqual(await value(db, `select to_jsonb(s) as value from public.daily_close_employee_snapshots s`),snapshot);
    assert.equal(await value(db, `select status::text as value from public.collection_runs where id=$1`,[run.collection_run_id]),'closed');
    assert.equal(await value(db, `select count(*)::int as value from public.audit_logs where action='admin_post_close_entry' and entity_type='payments'`),1);
    await db.exec(`update public.users set role='round_lead' where id='${admin}'`);
    await assert.rejects(value(db, `select public.void_payment($1,'closed receipt') as value`,[result.payment_id]),/ปิดตรวจนับเงินสดแล้ว|closed/);
    await db.exec(`update public.users set role='admin' where id='${admin}'`);
  });
  await t.test('event deliveries and collections also append after closure', async () => {
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

    const preview = await value(db, `select public.get_event_delivery_pos_context('${eventStop}') as value`);
    assert.equal(preview.stock_check_required,false);
    const key=randomUUID();
    const recordEvent=()=>value(db, `select public.record_event_ice_delivery('${eventStop}',$1::jsonb,'delivered',null,now(),$2) as value`,
      [JSON.stringify([{ice_type_id:ice,quantity:1.5}]),key]);
    const sale=await recordEvent();
    assert.equal((await recordEvent()).delivery_event_id,sale.delivery_event_id);
    const queue=await value(db,`select public.get_daily_shop_collection_queue(${today}) as value`);
    const row=queue.queue.find(s=>s.destination_kind==='event');
    const args={p_expected_settlement_context_id:row.event_settlement_context_id,
      p_expected_participation_id:row.event_participation_id,p_expected_service_date:row.settlement_service_date,
      p_expected_policy_fingerprint:row.settlement_policy_fingerprint,
      p_allocations:row.charges.map(c=>({charge_id:c.charge_id,amount:c.outstanding_amount})),
      p_payment_method:'cash',p_received_amount:row.outstanding_amount,p_collection_run_id:run.collection_run_id,
      p_expected_outstanding_amount:row.outstanding_amount,p_idempotency_key:randomUUID()};
    const date=await value(db,`select ${today}::text as value`);
    const result=daysAgo ? await value(db, `select public.record_backdated_collection_payment('record_event_payment',$1,$2::jsonb) as value`,[date,JSON.stringify(args)])
      : await value(db,`select public.record_event_payment($1,$2,$3,$4,$5::jsonb,'cash',$6,null,null,$7,$6,$8) as value`,
        [args.p_expected_settlement_context_id,args.p_expected_participation_id,date,args.p_expected_policy_fingerprint,
          JSON.stringify(args.p_allocations),args.p_received_amount,run.collection_run_id,args.p_idempotency_key]);
    assert.ok(result.payment_id);
    assert.deepEqual(await value(db, `select to_jsonb(s) as value from public.daily_close_employee_snapshots s`),snapshot);
    await assert.rejects(movement('factory_order',null,truck,1),/closed/);
  });
  await t.test('courier, round lead, inactive admin and cancelled rounds cannot use the exception', async () => {
    for(const role of ['courier','round_lead']) {
      await db.query(`update public.users set role=$1 where id=$2`,[role,admin]);
      await assert.rejects(record(1),/closed|assigned/);
      await assert.rejects(value(db,`select public.ensure_daily_collection_context(${today}) as value`),/closed|current Bangkok/);
      assert.equal(await value(db,`select public.can_use_collection_context($1) as value`,[run.collection_run_id]),false);
    }
    await db.exec(`update public.users set role='admin',is_active=false where id='${admin}'`);
    await assert.rejects(record(1),/active/);
    await db.exec(`update public.users set is_active=true where id='${admin}'`);
    await assert.rejects(value(db,`select public.ensure_daily_collection_context((clock_timestamp() at time zone 'Asia/Bangkok')::date+1) as value`),/current Bangkok/);
    await db.exec(`update public.delivery_rounds set cancelled_at=now(),cancelled_by='${admin}',cancellation_reason='Test cancelled' where id='${round}'`);
    await assert.rejects(record(1),/cancelled/);
    await assert.rejects(context(),/cancelled/);
    await assert.rejects(movement('factory_order',null,truck,1),/closed|ยกเลิก/);
  });
  await t.test('closed stock without a collection run gets a closed admin context', async () => {
    const date=await value(db, `select ((clock_timestamp() at time zone 'Asia/Bangkok')::date - 2)::text as value`);
    await db.query(`insert into public.daily_aggregate_stock_closures(service_date,status,closed_by,idempotency_key)
      values ($1,'closed',$2,$3)`,[date,admin,randomUUID()]);
    const first=await value(db,`select public.ensure_daily_collection_context($1) as value`,[date]);
    const second=await value(db,`select public.ensure_daily_collection_context($1) as value`,[date]);
    assert.equal(first.status,'closed');
    assert.equal(first.can_record_payment,true);
    assert.equal(first.collection_run_id,second.collection_run_id);
    assert.equal(await value(db,`select status::text as value from public.collection_runs where id=$1`,[first.collection_run_id]),'closed');
  });
  await db.exec(readFileSync(new URL('../supabase/migrations/0254_admin_post_close_entries.sql',import.meta.url),'utf8'));
});
