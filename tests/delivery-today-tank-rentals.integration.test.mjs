import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createVatDatabase } from './helpers/creditVatDatabase.mjs';

const id = n => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const admin = id(1), courier = id(2), building = id(3), shop = id(4);
const ice = id(5), round = id(6), stop = id(7);
const today = "(clock_timestamp() at time zone 'Asia/Bangkok')::date";
const value = async (db, sql, args = []) => (await db.query(sql, args)).rows[0].value;


test('today tank history remains readable after closing, independent of POS availability', async t => {
  const db = await createVatDatabase();
  t.after(() => db.close());
  await db.exec(readFileSync(new URL('../supabase/migrations/20261027144838_delivery_today_tank_rentals.sql', import.meta.url), 'utf8'));
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
  {
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


  }

  const regular = async () => value(db, `select card->'today_tank_rentals' as value from public.get_round_shop_cards_with_tank_history('${round}',null) card`);
  const events = async () => (await value(db, `select public.get_event_delivery_cards_with_tank_history('${round}',null,null) as value`)).cards[0].today_tank_rentals;
  await db.exec(`update public.stock_locations set is_courier_source=true,is_active=true,holds_inventory=true where code='TRUCK-MAIN'`);
  assert.deepEqual(await regular(), []);
  assert.deepEqual(await events(), []);
  await db.exec(`
    insert into public.shop_rented_tanks(id,shop_id,tank_code,image_path,rented_at,created_by)
    values ('${id(40)}','${shop}','T-TODAY','tanks/1.jpg',${today},'${admin}'),
      ('${id(41)}','${shop}','T-OLD','tanks/2.jpg',${today}-1,'${admin}'),
      ('${id(42)}','${shop}','T-FUTURE','tanks/3.jpg',${today}+1,'${admin}');
    insert into public.shop_tank_rentals(id,request_id,shop_id,quantity,unit_price,handed_out_on,due_on,shop_code_snapshot,shop_name_snapshot,recorded_by)
    values ('${id(43)}','${id(43)}','${shop}',3,100,${today},${today}+1,'TRUCK-SHOP','Truck shop','${admin}'),
      ('${id(44)}','${id(44)}','${shop}',7,100,${today}-1,${today}+1,'TRUCK-SHOP','Truck shop','${admin}');
    insert into public.shop_tank_rental_returns(request_id,rental_id,quantity,returned_on,recorded_by)
    values ('${id(45)}','${id(43)}',3,${today},'${admin}');
    insert into public.event_tank_register(id,request_id,event_participation_id,movement_kind,quantity,service_date,rental_start_date,rental_unit_price,recorded_by)
    values ('${id(50)}','${id(50)}','${id(22)}','handoff',5,${today}-1,${today},100,'${admin}'),
      ('${id(51)}','${id(51)}','${id(22)}','handoff',9,${today}-2,${today}-1,100,'${admin}'),
      ('${id(52)}','${id(52)}','${id(22)}','handoff',11,${today},${today}+1,100,'${admin}'),
      ('${id(53)}','${id(53)}','${id(22)}','return',1,${today},null,null,'${admin}');
  `);
  const rentals = await regular();
  assert.deepEqual(rentals.map(row => row.id).sort(), [id(40), id(43)]);
  assert.equal(rentals.reduce((sum, row) => sum + row.quantity, 0), 4, 'a return does not erase today’s rental history');
  assert.equal(rentals.find(row => row.id === id(40)).tank_code, 'T-TODAY');
  const eventRentals = await events();
  assert.deepEqual(eventRentals, [{ id: id(50), quantity: 5, tank_code: null, recorded_by: 'Admin', note: '' }]);
  const originalRegular = (await db.query(`select * from public.get_round_shop_cards('${round}',null)`)).rows;
  const enrichedRegular = (await db.query(`select card from public.get_round_shop_cards_with_tank_history('${round}',null) card`)).rows.map(({card}) => {
    const { today_tank_rentals, ...original } = card;
    return original;
  });
  assert.deepEqual(enrichedRegular, originalRegular, 'preserves the original regular card contract');
  const originalEvent = await value(db, `select public.get_event_delivery_cards('${round}',null,null) as value`);
  const enrichedEvent = await value(db, `select public.get_event_delivery_cards_with_tank_history('${round}',null,null) as value`);
  assert.deepEqual({ ...enrichedEvent, cards: enrichedEvent.cards.map(({today_tank_rentals, ...card}) => card) }, originalEvent);
  await db.exec(`set role authenticated; set request.jwt.claim.sub='${courier}'`);
  assert.deepEqual(await regular(), rentals, 'assigned couriers can read rental history');
  assert.deepEqual(await events(), eventRentals);
  await db.exec(`reset role; update public.delivery_rounds set status='closed',closed_at=now(),closed_by='${admin}' where id='${round}'; set role authenticated`);
  assert.deepEqual(await regular(), rentals, 'closed rounds retain regular tank history');
  assert.deepEqual(await events(), eventRentals, 'closed rounds retain event tank history');
  for (const [rpc, target] of [['get_delivery_pos_context', stop], ['get_event_delivery_pos_context', id(23)]]) {
    await assert.rejects(value(db, `select public.${rpc}($1) as value`, [target]), /already closed/i);
    await assert.rejects(value(db, `select public.${rpc}_part($1,'sale') as value`, [target]), /already closed/i);
  }
  await assert.rejects(value(db, `select public.delivery_today_tank_rentals('${stop}') as value`), /permission denied/);
  await db.exec(`reset role; delete from public.delivery_round_members where round_id='${round}' and user_id='${courier}'; set role authenticated`);
  await assert.rejects(regular(), /not assigned/i);
  await assert.rejects(events(), /not assigned/i);
  await db.exec(`reset role; set role anon; set request.jwt.claim.sub=''`);
  await assert.rejects(regular(), /permission denied/i);
  await assert.rejects(events(), /permission denied/i);
});
