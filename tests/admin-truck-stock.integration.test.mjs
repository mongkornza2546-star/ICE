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

test('admin deliveries consume truck stock through real RPCs without changing courier stock', async t => {
  const db = await createVatDatabase();
  t.after(() => db.close());
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
  await movement('factory_order', null, truck, 220);
  await movement('transfer', truck, holding, 83.5);
  await movement('transfer', holding, truck, 3.5);
  await db.exec(`set request.jwt.claim.sub='${courier}'`);
  assert.equal((await context()).stock_source.id, holding);
  const employeeSale = await record(80);
  assert.equal(await balance(holding), 0);
  assert.equal(await balance(truck), 140);
  await db.exec(`set request.jwt.claim.sub='${admin}'`);

  await t.test('source preview and writer both use the configured truck', async () => {
    assert.equal((await context()).stock_source.id, truck);
    assert.equal((await context()).stock_source.kind, 'truck');
    const key = randomUUID();
    const sale = await record(117.5, key);
    assert.equal(await value(db, `select source_stock_location_id as value from public.delivery_events where id=$1`, [sale.delivery_event_id]), truck);
    assert.equal(await balance(truck), 22.5);
    assert.equal(await balance(site), 0);
    assert.equal(await balance(holding), 0);
    assert.equal(await aggregate(), 22.5);
    assert.equal((await record(117.5, key)).delivery_event_id, sale.delivery_event_id);
    assert.equal(await balance(truck), 22.5, 'retry must not deduct stock twice');
    await value(db, `select public.apply_open_delivery_correction($1,'cancel','[]','delivered',null,
      'Truck regression',$2,null) as value`, [sale.delivery_event_id, randomUUID()]);
    assert.equal(await balance(truck), 140, 'cancellation restores the same source');
    assert.equal(await balance(holding), 0);
    assert.equal(await value(db, `select status as value from public.delivery_events where id=$1`, [employeeSale.delivery_event_id]), 'active');
  });

  await t.test('admin cannot consume bags already transferred to a courier', async () => {
    await movement('transfer', truck, holding, 130);
    assert.equal(await balance(truck), 10);
    assert.equal(await aggregate(), 140);
    assert.equal((await context()).items.find(item => item.ice_type_id === ice).stock_quantity, 10);
    const before = await value(db, `select count(*)::int as value from public.delivery_events`);
    await assert.rejects(record(10.5), /stock/);
    assert.equal(await value(db, `select count(*)::int as value from public.delivery_events`), before);
    assert.equal(await balance(truck), 10);
    assert.equal(await balance(holding), 130);
  });

  await t.test('missing source fails without silently using the shop work site', async () => {
    await db.query(`update public.stock_locations set is_courier_source=false where id=$1`, [truck]);
    await assert.rejects(context(), /truck/i);
    await assert.rejects(record(1), /truck/i);
    await db.query(`update public.stock_locations set is_courier_source=true where id=$1`, [truck]);
  });

  await t.test('round lead routing remains unchanged and migration can be reapplied', async () => {
    await db.query(`update public.users set role='round_lead' where id=$1`, [admin]);
    assert.equal((await context()).stock_source.kind, 'daily');
    const sale = await record(1);
    assert.equal(await value(db, `select source_stock_location_id as value from public.delivery_events where id=$1`, [sale.delivery_event_id]), site);
    assert.equal(await balance(truck), 10);
    await db.query(`update public.users set role='admin' where id=$1`, [admin]);
    await db.exec(readFileSync(new URL('../supabase/migrations/0241_admin_delivery_truck_source.sql', import.meta.url), 'utf8'));
    assert.equal((await context()).stock_source.id, truck);
  });

  await t.test('event delivery context and writer also consume the truck', async () => {
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
    assert.equal(preview.stock_source.id, truck);
    assert.equal(preview.items.find(item => item.ice_type_id === ice).stock_quantity, 10);
    const eventRecord = (quantity, key) => value(db, `select public.record_event_ice_delivery(
      '${eventStop}',$1::jsonb,'delivered',null,now(),$2) as value`,
    [JSON.stringify([{ ice_type_id: ice, quantity }]), key]);
    await assert.rejects(eventRecord(10.5, randomUUID()), /stock/);
    const key = randomUUID();
    const sale = await eventRecord(2.5, key);
    assert.equal(await value(db, `select source_stock_location_id as value from public.delivery_events where id=$1`, [sale.delivery_event_id]), truck);
    assert.equal(await balance(truck), 7.5);
    assert.equal((await eventRecord(2.5, key)).delivery_event_id, sale.delivery_event_id);
    assert.equal(await balance(truck), 7.5);
    assert.equal(await balance(holding), 130);
  });

  await t.test('inspected-day repair changes only legacy source attribution and is safe to retry', async () => {
    const repair = readFileSync(new URL('../supabase/scripts/repair_20261020_admin_delivery_sources.sql', import.meta.url), 'utf8')
      .replaceAll('5047b139-345c-4173-b3dd-b5fe5a13bd2e', admin)
      .replace("date '2026-10-20'", today);
    const financialRows = () => value(db, `select jsonb_build_object(
      'charges',(select jsonb_agg(to_jsonb(c) order by id) from public.delivery_charges c),
      'items',(select jsonb_agg(to_jsonb(i) order by delivery_event_id,ice_type_id) from public.delivery_items i),
      'documents',(select jsonb_agg(to_jsonb(d) order by charge_id) from public.delivery_charge_document_snapshots d)
    ) as value`);
    const before = await financialRows();
    const aggregateBefore = await aggregate();
    assert.equal(await balance(site), -1);
    await db.exec(repair);
    assert.equal(await balance(site), 0);
    assert.equal(await balance(truck), 6.5);
    assert.equal(await balance(holding), 130);
    assert.equal(await aggregate(), aggregateBefore);
    assert.deepEqual(await financialRows(), before);
    const audits = (await db.query(`select before_value,after_value from public.audit_logs
      where action='admin_truck_source_repair_20261020'`)).rows;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].before_value.source_stock_location_id, site);
    assert.deepEqual(audits[0].after_value, { ...audits[0].before_value, source_stock_location_id: truck });
    await db.exec(repair);
    assert.equal(await balance(truck), 6.5);
    assert.equal(await value(db, `select count(*)::int as value from public.audit_logs where action='admin_truck_source_repair_20261020'`), 1);
  });
});
