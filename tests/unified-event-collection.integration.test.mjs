import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createVatDatabase } from './helpers/creditVatDatabase.mjs';

const id = n => `91000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const admin = id(1), shop = id(2), job = id(3), config = id(4), participation = id(5);
const today = "(clock_timestamp() at time zone 'Asia/Bangkok')::date";
const value = async (db, sql, args = []) => (await db.query(sql, args)).rows[0].value;

for (const chargeKind of ['ice', 'rental']) test(`event ${chargeKind} collection groups days and records one atomic payment and receipt`, async t => {
  const db = await createVatDatabase();
  t.after(() => db.close());
  await db.exec(`
    grant usage on schema public to authenticated;
    insert into auth.users(id,email,raw_user_meta_data)
      values ('${admin}','event-collection@example.test','{"display_name":"Admin"}');
    update public.users set role='admin',is_active=true where id='${admin}';
    set request.jwt.claim.sub='${admin}';
    insert into public.buildings(id,code,name) values ('${id(6)}','EC','Event collection');
    insert into public.building_zones(id,building_id,code,name) values ('${id(7)}','${id(6)}','EC','Hall');
    insert into public.shops(id,code,name,building_id,floor_or_zone,zone_id,stock_location_id)
      select '${shop}','EV-B28','บูธ B28','${id(6)}','Hall','${id(7)}',id
      from public.stock_locations where building_id='${id(6)}' and is_default_for_building;
    insert into public.event_jobs(id,name,organizer_name,contact_name,contact_phone,location,
      start_date,end_date,status,created_by,published_by,published_at)
      values ('${job}','เกษตร','Organizer','Contact','0800000000','Hall',
        ${today}-2,${today}+1,'published','${admin}','${admin}',now());
    insert into public.event_job_config_versions(id,event_job_id,version_no,tank_rental_unit_price,
      payment_term,allowed_payment_methods,default_payment_method,bank_transfer_reference_required,
      qr_reference_required,policy_fingerprint,created_by)
      values ('${config}','${job}',1,20,'end_of_day','{cash,bank_transfer}','cash',false,false,'policy','${admin}');
    update public.event_jobs set current_config_version_id='${config}' where id='${job}';
    insert into public.event_participations(id,event_job_id,shop_id,booth_number,event_zone,contact_name,
      contact_phone,start_date,end_date,status,config_version_id,tank_rental_unit_price_snapshot,
      payment_term_snapshot,allowed_payment_methods_snapshot,default_payment_method_snapshot,
      cash_reference_required_snapshot,cash_evidence_required_snapshot,bank_transfer_reference_required_snapshot,
      bank_transfer_evidence_required_snapshot,qr_reference_required_snapshot,qr_evidence_required_snapshot,
      settlement_policy_fingerprint,created_by,updated_by)
      values ('${participation}','${job}','${shop}','B28','Hall','Contact','0800000000',
        ${today}-2,${today}+1,'active','${config}',20,'end_of_day','{cash,bank_transfer}','cash',
        false,false,false,false,false,false,'policy','${admin}','${admin}');
  `);
  if (chargeKind === 'rental') {
    await db.exec(`select public.record_event_tank_movement('${participation}','handoff',6,${today}-1,'',gen_random_uuid());
      select public.record_event_tank_movement('${participation}','handoff',5,${today},'',gen_random_uuid());`);
  } else {
    await db.exec(`insert into public.ice_types(id,code,name,unit) values ('${id(8)}','ICE','น้ำแข็ง','ถุง');
      update public.stock_locations set is_active=true,is_courier_source=true,holds_inventory=true where code='TRUCK-MAIN';
      insert into public.ice_type_prices(ice_type_id,unit_price,valid_from,created_by) values ('${id(8)}',20,${today}-2,'${admin}');
      select public.enable_event_ice_delivery_pilot('${participation}',clock_timestamp()+interval '1 hour');`);
    for (let day = 0; day < 2; day++) {
      await db.exec(`
        insert into public.delivery_rounds(id,service_date,name,round_type,status,opened_by)
          values ('${id(10 + day)}',${today}-${1-day},'งานประจำวัน','daily','open','${admin}');
        insert into public.round_stops(id,round_id,shop_id,shop_code_snapshot,shop_name_snapshot,
          building_id_snapshot,building_name_snapshot,floor_or_zone_snapshot,sequence_no,status,updated_by,
          destination_kind,event_participation_id,is_operational,event_job_name_snapshot,event_location_snapshot)
          values ('${id(12 + day)}','${id(10 + day)}','${shop}','EV-B28','บูธ B28','${id(6)}','Event collection',
            'Hall',1,'pending','${admin}','event','${participation}',true,'เกษตร','Hall');
        insert into public.stock_movements(id,service_date,round_id,kind,to_location_id,idempotency_key,recorded_by)
          select '${id(14 + day)}',${today}-${1-day},'${id(10 + day)}','factory_order',id,gen_random_uuid(),'${admin}'
          from public.stock_locations where code='TRUCK-MAIN';
        insert into public.stock_movement_items(movement_id,ice_type_id,quantity) values ('${id(14 + day)}','${id(8)}',10);
        select public.record_event_ice_delivery('${id(12 + day)}','[{"ice_type_id":"${id(8)}","quantity":${6-day}}]',
          'delivered',null,now(),gen_random_uuid());
      `);
    }
  }
  const queue = () => value(db, `select public.get_daily_shop_collection_queue_v2(${today}) as value`);
  const initial = await queue();
  const rows = initial.queue.filter(row => row.event_participation_id === participation);
  assert.equal(rows.length, 1, '120 + 100 must appear as one event-shop card');
  const row = rows[0];
  assert.equal(row.collection_scope, 'event_participation');
  assert.equal(row.queue_key, `event-participation:${participation}`);
  assert.equal(row.outstanding_amount, 220);
  assert.equal(row.charge_count, 2);
  assert.equal(new Set(row.charges.map(c => c.service_date)).size, 2);
  const run = initial.collection_run_id;
  const args = (overrides = {}) => ({
    p_expected_participation_id: participation, p_expected_policy_fingerprint: 'policy',
    p_allocations: row.charges.map(c => ({ charge_id: c.charge_id, amount: c.outstanding_amount })),
    p_payment_method: 'cash', p_received_amount: 250, p_reference_number: null, p_evidence_path: null,
    p_collection_run_id: run, p_expected_outstanding_amount: 220, p_idempotency_key: randomUUID(), ...overrides,
  });
  const pay = input => value(db, `select public.record_event_collection_payment($1,$2,$3::jsonb,
    $4::public.payment_method,$5,$6,$7,$8,$9,$10) as value`, [
    input.p_expected_participation_id, input.p_expected_policy_fingerprint, JSON.stringify(input.p_allocations),
    input.p_payment_method, input.p_received_amount, input.p_reference_number, input.p_evidence_path,
    input.p_collection_run_id, input.p_expected_outstanding_amount, input.p_idempotency_key,
  ]);
  await t.test('rejects stale balance, duplicate bills, bad policy and non-cash change without writing', async () => {
    await assert.rejects(pay(args({ p_expected_outstanding_amount: 219 })), /outstanding.*changed/i);
    await assert.rejects(pay(args({ p_expected_policy_fingerprint: 'wrong' })), /context.*changed|policy/i);
    await assert.rejects(pay(args({ p_allocations: [args().p_allocations[0], args().p_allocations[0]] })), /distinct charge/i);
    await assert.rejects(pay(args({ p_payment_method: 'bank_transfer' })), /Only cash/i);
    await assert.rejects(pay(args({ p_allocations: row.charges.map((c, i) => ({ charge_id: c.charge_id,
      amount: c.outstanding_amount + (i === 0 ? 1 : -1) })) })), /latest charge balance/i);
    assert.equal(await value(db, 'select count(*)::int as value from payments'), 0);
  });
  await t.test('legacy queue preserves daily identities and each row can still be collected', async () => {
    await db.exec('begin');
    try {
      await db.exec('set local role authenticated');
      const legacy = await value(db, `select public.get_daily_shop_collection_queue(${today}) as value`);
      const dailyRows = legacy.queue.filter(item => item.event_participation_id === participation);
      assert.equal(dailyRows.length, 2);
      for (const daily of dailyRows) {
        assert.ok(daily.settlement_service_date);
        const paid = await value(db, `select public.record_event_payment($1,$2,$3,'policy',$4::jsonb,
          'cash',$5,null,null,$6,$5,$7) as value`, [daily.event_settlement_context_id, participation,
          daily.settlement_service_date, JSON.stringify(daily.charges.map(c => ({
            charge_id: c.charge_id, amount: c.outstanding_amount,
          }))), daily.outstanding_amount, legacy.collection_run_id, randomUUID()]);
        assert.equal(paid.allocated_amount, daily.outstanding_amount);
      }
      await db.exec('set constraints all immediate');
      assert.equal((await queue()).queue.length, 0);
    } finally { await db.exec('rollback'); }
  });
  await t.test('versioned queue preserves closed-day capabilities and authorization', async () => {
    await db.exec('begin');
    try {
      await db.exec(`update public.collection_runs set status='closed',closed_by='${admin}',closed_at=now() where id='${run}'`);
      await db.exec('set local role authenticated');
      const legacy = await value(db, `select public.get_daily_shop_collection_queue(${today}) as value`);
      const combined = await queue();
      assert.equal(legacy.queue.length, 2);
      assert.equal(combined.queue.length, 1);
      assert.equal(combined.queue[0].outstanding_amount, 220);
      assert.deepEqual({ ...combined, queue: [] }, { ...legacy, queue: [] });
      await db.exec(`reset role; update public.users set is_active=false where id='${admin}'; set local role authenticated`);
      await assert.rejects(queue(), /active user/i);
    } finally { await db.exec('rollback'); }
    assert.equal(await value(db, `select has_function_privilege('anon',
      'public.get_daily_shop_collection_queue_v2(date)','EXECUTE') as value`), false);
  });
  await t.test('rejects non-finite received, expected and allocation amounts without recording money', async () => {
    for (const amount of ['NaN', 'Infinity', '-Infinity']) {
      for (const invalid of [
        { p_received_amount: amount },
        { p_expected_outstanding_amount: amount },
        { p_allocations: [{ charge_id: row.charges[0].charge_id, amount }] },
      ]) {
        await db.exec('begin');
        try { await assert.rejects(pay(args(invalid)), /finite/i); }
        finally { await db.exec('rollback'); }
      }
    }
    await assert.rejects(value(db, `select public.record_backdated_collection_payment(
      'record_event_collection_payment',${today}-1,$1::jsonb) as value`,
    [JSON.stringify(args({ p_received_amount: 'NaN' }))]), /finite/i);
    assert.equal(await value(db, 'select count(*)::int as value from payments'), 0);
  });
  let payment;
  const request = args();
  await t.test('one payment, two allocations, one receipt and one change amount with safe retries', async () => {
    await db.exec(`update public.users set role='courier',can_collect_shop_payments=true where id='${admin}'`);
    await db.exec('set role authenticated');
    try {
      assert.equal((await queue()).queue[0].outstanding_amount, 220);
      payment = await pay(request);
    } finally {
      await db.exec(`reset role; update public.users set role='admin' where id='${admin}'`);
    }
    assert.equal(payment.allocated_amount, 220);
    assert.equal(payment.change_amount, 30);
    assert.equal((await pay(request)).payment_id, payment.payment_id);
    await assert.rejects(pay({ ...request, p_received_amount: 260 }), /different payment/i);
    assert.equal(await value(db, 'select count(*)::int as value from payments'), 1);
    const receipt = await value(db, 'select public.get_payment_receipt_snapshot($1) as value', [payment.payment_id]);
    assert.equal(receipt.charges.length, 2);
    assert.equal(new Set(receipt.charges.map(c => c.service_date)).size, 2);
    assert.equal(receipt.allocated_amount, 220);
    const history = await value(db, `select public.get_payment_history(${today},${today}) as value`);
    assert.equal(history.items.length, 1);
    assert.equal(history.range_summary.active_allocated_amount, 220);
    assert.equal((await queue()).queue.length, 0);
    if (chargeKind === 'ice') {
      for (const charge of row.charges) {
        await assert.rejects(value(db, `select public.apply_open_event_delivery_correction(
          $1,'cancel','[]','delivered',null,'ทดสอบ',gen_random_uuid(),null) as value`, [charge.delivery_event_id]), /รับชำระแล้ว/);
      }
      assert.equal((await queue()).queue.length, 0, 'paid invoice protection must hold for both service days');
    }
  });
  await t.test('void restores both days and a selected partial payment leaves the right balance', async () => {
    await value(db, 'select public.void_payment($1,$2) as value', [payment.payment_id, 'ทดสอบคืนยอด']);
    assert.equal((await queue()).queue[0].outstanding_amount, 220);
    const partial = await pay(args({ p_allocations: [{ charge_id: row.charges[0].charge_id, amount: 50 }], p_received_amount: 50 }));
    assert.equal(partial.allocated_amount, 50);
    const remaining = (await queue()).queue[0];
    assert.equal(remaining.outstanding_amount, 170);
    assert.equal(remaining.charge_count, 2);
    assert.equal(remaining.queue_key, row.queue_key);
  });
  await t.test('backdated collection keeps one receipt, guards replay dates and tracks later-day remaining debt', async () => {
    const request = args({ p_received_amount: 80, p_expected_outstanding_amount: 170,
      p_allocations: [{ charge_id: row.charges[0].charge_id, amount: 70 }, { charge_id: row.charges[1].charge_id, amount: 10 }] });
    const payBackdated = () => value(db, `select public.record_backdated_collection_payment(
      'record_event_collection_payment',${today}-1,$1::jsonb) as value`, [JSON.stringify(request)]);
    const paid = await payBackdated();
    assert.equal((await payBackdated()).payment_id, paid.payment_id);
    await assert.rejects(pay(request), /different received date/);
    const remaining = (await queue()).queue[0];
    assert.equal(remaining.outstanding_amount, 90);
    assert.equal(remaining.charge_count, 1);
    assert.ok(remaining.latest_payment_at, 'payment must remain visible after its anchor day is fully paid');
  });
  await t.test('same shop in another event stays separate and cannot enter the payment or allocation ledger', async () => {
    await db.exec(`
      insert into public.event_jobs select (jsonb_populate_record(null::public.event_jobs,
        to_jsonb(j) || jsonb_build_object('id','${id(30)}','name','Other event','current_config_version_id',null))).*
        from public.event_jobs j where id='${job}';
      insert into public.event_job_config_versions select (jsonb_populate_record(null::public.event_job_config_versions,
        to_jsonb(c) || jsonb_build_object('id','${id(31)}','event_job_id','${id(30)}'))).*
        from public.event_job_config_versions c where id='${config}';
      update public.event_jobs set current_config_version_id='${id(31)}' where id='${id(30)}';
      insert into public.event_participations select (jsonb_populate_record(null::public.event_participations,
        to_jsonb(p) || jsonb_build_object('id','${id(32)}','event_job_id','${id(30)}','config_version_id','${id(31)}'))).*
        from public.event_participations p where id='${participation}';
      select public.record_event_tank_movement('${id(32)}','handoff',50,${today},'',gen_random_uuid());
    `);
    const separated = (await queue()).queue;
    assert.equal(separated.length, 2);
    const other = separated.find(r => r.event_participation_id === id(32));
    assert.equal(other.outstanding_amount, 1000);
    const mixed = args({ p_received_amount: 20, p_expected_outstanding_amount: 90,
      p_allocations: [{ charge_id: row.charges[1].charge_id, amount: 10 }, { charge_id: other.charges[0].charge_id, amount: 10 }] });
    await assert.rejects(pay(mixed), /active charge in this event settlement/);
    await db.exec('begin');
    try {
      await db.query(`update public.payment_allocations set charge_id=$1 where payment_id=$2 and charge_id=$3`,
        [other.charges[0].charge_id, payment.payment_id, row.charges[0].charge_id]);
      await assert.rejects(db.exec('set constraints all immediate'), /payment shop and settlement context/);
    } finally { await db.exec('rollback'); }
    await assert.rejects(db.query('update public.payments set event_collection=false where id=$1', [payment.payment_id]), /immutable/);
  });
  await t.test('legacy event writer still rejects multiple days', async () => {
    await assert.rejects(value(db, `select public.record_event_payment($1,$2,$3,'policy',$4::jsonb,
      'cash',20,null,null,$5,null,$6) as value`, [row.event_settlement_context_id, participation,
      row.charges[1].service_date, JSON.stringify(row.charges.map(c => ({ charge_id: c.charge_id, amount: 10 }))), run, randomUUID()]),
    /active charge in this event settlement/);
    await assert.rejects(pay(args({ p_expected_participation_id: null })), /identity/);
  });
  await t.test('closed-day queue still groups and only an active admin can collect after close', async () => {
    await db.exec(`update public.collection_runs set status='closed',closed_by='${admin}',closed_at=now() where id='${run}'`);
    const remaining = (await queue()).queue.find(r => r.event_participation_id === participation);
    assert.equal(remaining.outstanding_amount, 90);
    const request = args({ p_received_amount: 90, p_expected_outstanding_amount: 90,
      p_allocations: [{ charge_id: row.charges[1].charge_id, amount: 90 }] });
    await db.exec(`update public.users set role='courier',can_collect_shop_payments=true where id='${admin}'`);
    await assert.rejects(pay(request), /stale or closed/);
    await db.exec(`update public.users set role='admin',is_active=false where id='${admin}'`);
    await assert.rejects(pay(request), /cannot collect/);
    await db.exec(`update public.users set is_active=true where id='${admin}'`);
    assert.equal((await pay(request)).allocated_amount, 90);
    assert.equal((await queue()).queue.some(r => r.event_participation_id === participation), false);
    assert.equal(await value(db, `select has_function_privilege('anon',
      'public.record_event_collection_payment(uuid,text,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid)','EXECUTE') as value`), false);
  });
});
