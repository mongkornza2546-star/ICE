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


for (const destination of ['regular', 'event']) test(`admin cancels ${destination} deliveries in any order`, async t => {
  const db = await createVatDatabase();
  t.after(() => db.close());
  const migration = readFileSync(new URL('../supabase/migrations/20261027162143_delivery_history_cancellation_policy.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration); // Safe deployment retry.
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
    insert into public.delivery_round_members(round_id,user_id) values ('${round}','${admin}');
    insert into public.round_stops(id,round_id,shop_id,shop_code_snapshot,shop_name_snapshot,
      building_id_snapshot,building_name_snapshot,floor_or_zone_snapshot,sequence_no,updated_by)
      values ('${stop}','${round}','${shop}','TRUCK-SHOP','Truck shop',
        '${building}','Truck test','1',1,'${admin}');
  `);
  const truck = await value(db, `select id as value from public.stock_locations where code='TRUCK-MAIN'`);
  await db.query(`update public.stock_locations set is_courier_source=true,is_active=true,holds_inventory=true where id=$1`, [truck]);
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

  await movement('factory_order', null, truck, 10);
  let targetStop = stop;
  if (destination === 'event') {
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


    targetStop = eventStop;
  }
  const record = async (quantity, note) => destination === 'event'
    ? value(db, `select public.record_event_ice_delivery($1,$2::jsonb,'delivered',$3,now(),$4) as value`,
      [targetStop, JSON.stringify([{ ice_type_id: ice, quantity }]), note, randomUUID()])
    : value(db, `select public.record_delivery_with_vat_check($1,$2::jsonb,'delivered',$3,now(),$4,'end_of_day',null,0,$5) as value`,
      [targetStop, JSON.stringify([{ ice_type_id: ice, quantity }]), note, randomUUID(), quantity * 25]);
  const context = event => value(db, `select public.${destination === 'event' ? 'get_event_delivery_correction_context' : 'get_delivery_correction_context'}($1) as value`, [event]);
  const cancel = (event, key = randomUUID()) => value(db, `select public.${destination === 'event' ? 'apply_open_event_delivery_correction' : 'apply_open_delivery_correction'}($1,'cancel','[]','delivered',null,'บันทึกผิด',$2,null) as value`, [event, key]);
  const history = async () => destination === 'event'
    ? (await value(db, `select public.get_event_delivery_cards('${round}',null,null) as value`)).cards[0].today_history
    : (await db.query(`select today_history from public.get_round_shop_cards('${round}',null)`)).rows[0].today_history;
  const state = event => value(db, `select status::text as value from public.delivery_events where id=$1`, [event]);
  const first = await record(2, 'first');
  const middle = await record(3, 'middle');
  const last = await record(1, 'last');
  // Equal timestamps exercise the UUID tie-breaker as well as ordinary ordering.
  await db.query(`update public.delivery_events set recorded_at=$1 where id=$2`, ['2026-10-27T01:00:00Z', first.delivery_event_id]);
  await db.query(`update public.delivery_events set recorded_at=$1 where id=any($2::uuid[])`, ['2026-10-27T02:00:00Z', [middle.delivery_event_id, last.delivery_event_id]]);
  // Pick the actual latest row using the same stable order as the application.
  const ordered = (await db.query(`select id from public.delivery_events where round_stop_id=$1 order by recorded_at,id`, [targetStop])).rows.map(row => row.id);
  const oldest = ordered[0], newer = ordered[1], latest = ordered[2];
  const quantities = new Map([[first.delivery_event_id, 2], [middle.delivery_event_id, 3], [last.delivery_event_id, 1]]);
  const latestNote = latest === middle.delivery_event_id ? 'middle' : 'last';
  assert.equal(await balance(truck), 4);
  assert.equal(await aggregate(), 4);
  assert.equal((await context(oldest)).is_latest, false);
  assert.equal((await context(oldest)).can_cancel, true);
  assert.equal((await history()).length, 3);
  for (const row of await history()) {
    assert.equal(row.can_cancel, true, 'every active unpaid row offers cancellation');
    if (destination === 'regular') assert.equal(row.correction_blocker, null);
  }
  for (const role of ['courier', 'round_lead']) {
    await db.query(`update public.users set role=$1 where id='${admin}'`, [role]);
    assert.equal((await context(oldest)).can_cancel, false);
    assert.equal((await context(latest)).can_cancel, true);
    for (const row of await history()) {
      const policy = await context(row.event_id ?? row.delivery_event_id);
      assert.equal(row.can_cancel, policy.can_cancel, `${role} history must match cancellation eligibility`);
      if (destination === 'regular') {
        assert.equal(row.can_correct, false);
        assert.equal(row.correction_blocker, policy.blocker_reason);
      }
    }
    await assert.rejects(cancel(oldest), /ล่าสุด/);
  }
  await db.exec(`update public.users set role='admin',is_active=false where id='${admin}'`);
  await assert.rejects(cancel(oldest), /active|viewed/);
  await db.exec(`update public.users set is_active=true where id='${admin}'`);

  if (destination === 'regular') {
    assert.equal(await value(db, `select has_function_privilege('anon',
      'public.get_delivery_cancellation_policy(uuid)', 'execute') as value`), false);
    assert.equal(await value(db, `select has_function_privilege('authenticated',
      'public.get_delivery_cancellation_policy(uuid)', 'execute') as value`), false);
    await db.exec('begin');
    try {
      await db.exec(`create or replace function public.get_delivery_correction_context(p_event_id uuid)
        returns jsonb language plpgsql stable security definer set search_path=public as $$
        begin raise exception 'History must not load dialog details'; end; $$`);
      assert.equal((await history()).length, 3, 'history only needs the lightweight eligibility policy');
    } finally { await db.exec('rollback'); }
  }

  // A closed round still allows the admin to cancel an older unpaid delivery.
  await db.exec('begin');
  try {
    await db.exec(`update public.delivery_rounds set status='closed',closed_at=now(),closed_by='${admin}' where id='${round}'`);
    assert.equal((await context(oldest)).can_cancel, true);
    const olderHistory = (await history()).find(row => (row.event_id ?? row.delivery_event_id) === oldest);
    assert.equal(olderHistory.can_cancel, true, 'closed unpaid delivery must remain reachable from history');
    if (destination === 'regular') {
      assert.equal(olderHistory.can_correct, false);
      assert.equal(olderHistory.correction_blocker, null);
    }
    await cancel(oldest);
    assert.equal(await state(oldest), 'cancelled');
  } finally { await db.exec('rollback'); }

  // Losing the latest-only restriction must not detach a paid bill's receipt.
  await db.exec('begin');
  try {
    const run = await value(db, `select public.ensure_daily_collection_context(${today}) as value`);
    const allocations = JSON.stringify([{ charge_id: first.charge_id, amount: 25 }]);
    if (destination === 'event') {
      await db.query(`select public.record_event_payment(context.id, context.event_participation_id,
        context.service_date, context.settlement_policy_fingerprint, $1::jsonb,
        'cash',25,null,null,$2,150,$3) from public.event_settlement_contexts context`,
      [allocations, run.collection_run_id, randomUUID()]);
    } else {
      await db.query(`select public.record_shop_collection_payment('${shop}',$1::jsonb,
        'cash',25,null,null,$2,150,null,$3)`, [allocations, run.collection_run_id, randomUUID()]);
    }
    assert.equal((await context(oldest)).can_cancel, false);
    const olderHistory = (await history()).find(row => (row.event_id ?? row.delivery_event_id) === oldest);
    assert.equal(olderHistory.can_cancel, false, 'paid delivery must not offer cancellation in history');
    if (destination === 'regular') {
      assert.equal(olderHistory.can_correct, false, 'legacy edit flag must not expose a cancellation button');
      assert.equal(olderHistory.correction_blocker, (await context(oldest)).blocker_reason);
    }
    await db.exec('savepoint paid_cancel');
    await assert.rejects(cancel(oldest), /รับชำระแล้ว/);
    await db.exec('rollback to savepoint paid_cancel');
    assert.equal(await state(oldest), 'active');
    assert.equal(await balance(truck), 4);
  } finally { await db.exec('rollback'); }

  let expectedStock = 4;
  for (const event of [newer, oldest, latest]) {
    const key = randomUUID();
    await db.exec('set role authenticated');
    try {
      await cancel(event, key);
      assert.equal((await cancel(event, key)).idempotent_replay, true);
    } finally { await db.exec('reset role'); }
    expectedStock += quantities.get(event);
    assert.equal(await balance(truck), expectedStock);
    assert.equal(await aggregate(), expectedStock);
    assert.equal(await state(event), 'cancelled');
    assert.equal((await context(event)).can_cancel, false);
    if (destination === 'regular') {
      const cancelledHistory = (await history()).find(row => row.event_id === event);
      assert.equal(cancelledHistory.can_cancel, false);
      assert.equal(cancelledHistory.can_correct, false);
      assert.equal(cancelledHistory.correction_blocker, (await context(event)).blocker_reason);
    }
    await assert.rejects(cancel(event), /ยกเลิกหรือแทนที่/);
    assert.equal(await value(db, `select count(*)::int as value from public.delivery_event_revisions where original_event_id=$1`, [event]), 1);
    if (event !== latest) {
      assert.equal(await state(latest), 'active');
      assert.deepEqual((await db.query(`select status::text,note from public.round_stops where id=$1`, [targetStop])).rows[0], { status: 'delivered', note: latestNote });
    }
  }
  assert.equal(await value(db, `select status::text as value from public.round_stops where id=$1`, [targetStop]), 'pending');
  assert.equal(await value(db, `select count(*)::int as value from public.delivery_charges where status='active'`), 0);
});
