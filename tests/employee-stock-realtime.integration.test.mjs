import assert from 'node:assert/strict';
import test from 'node:test';
import { createVatDatabase } from './helpers/creditVatDatabase.mjs';

const id = n => `96000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const admin = id(1), courier = id(2), other = id(3), outsider = id(4);
const round = id(10), otherRound = id(11), tomorrowRound = id(12), building = id(20), ice = id(21);
const today = "(clock_timestamp() at time zone 'Asia/Bangkok')::date";

test('courier realtime visibility follows the dated shared truck and own holding', async t => {
  const db = await createVatDatabase();
  t.after(() => db.close());
  const value = async sql => (await db.query(sql)).rows[0].value;
  await db.exec(`
    grant usage on schema public to authenticated, anon;
    insert into auth.users(id,email,raw_user_meta_data) values
      ('${admin}','realtime-admin@test.local','{"display_name":"Admin"}'),
      ('${courier}','realtime-courier@test.local','{"display_name":"Courier"}'),
      ('${other}','realtime-other@test.local','{"display_name":"Other"}'),
      ('${outsider}','realtime-outsider@test.local','{"display_name":"Outsider"}');
    update public.users set role='admin',is_active=true where id='${admin}';
    update public.users set role='courier',is_active=true where id in ('${courier}','${other}','${outsider}');
    set request.jwt.claim.sub='${admin}';
    insert into public.buildings(id,code,name) values ('${building}','RT-STOCK','Realtime stock');
    insert into public.employee_work_site_assignments(user_id,stock_location_id,assigned_by)
      select employee,location.id,'${admin}' from public.stock_locations location
      cross join unnest(array['${courier}'::uuid,'${other}'::uuid]) employee
      where location.building_id='${building}' and location.is_default_for_building;
    update public.stock_locations set is_courier_source=true,is_active=true,holds_inventory=true where code='TRUCK-MAIN';
    insert into public.stock_locations(id,code,name,kind) values ('${id(22)}','RT-OTHER-TRUCK','Unrelated truck','truck');
    insert into public.ice_types(id,code,name,unit) values ('${ice}','RT-ICE','Ice','bag');
    insert into public.delivery_round_name_options(name,sort_order) values ('Other round',99);
    insert into public.delivery_rounds(id,service_date,name,round_type,status,opened_by) values
      ('${round}',${today},'งานประจำวัน','daily','open','${admin}'),
      ('${otherRound}',${today},'Other round','special','open','${admin}'),
      ('${tomorrowRound}',${today}+1,'งานประจำวัน','daily','open','${admin}');
    insert into public.delivery_round_members(round_id,user_id) values ('${round}','${courier}');
  `);
  const truck = await value("select id as value from public.stock_locations where code='TRUCK-MAIN'");
  const holding = await value(`select id as value from public.stock_locations where assigned_user_id='${courier}' and kind='team'`);
  const otherHolding = await value(`select id as value from public.stock_locations where assigned_user_id='${other}' and kind='team'`);
  const site = await value(`select id as value from public.stock_locations where building_id='${building}' and is_default_for_building`);
  const movements = [
    [id(101), otherRound, today, 'factory_order', null, truck],
    [id(102), round, today, 'transfer', site, holding],
    [id(103), round, today, 'damage', holding, null],
    [id(104), otherRound, today, 'transfer', otherHolding, truck],
    [id(105), otherRound, today, 'damage', otherHolding, null],
    [id(106), round, today, 'factory_order', null, id(22)],
    [id(107), tomorrowRound, `${today}+1`, 'factory_order', null, truck],
  ];
  for (const [movement, roundId, date, kind, from, to] of movements) {
    await db.query(`insert into public.stock_movements(id,service_date,round_id,kind,from_location_id,to_location_id,idempotency_key,recorded_by)
      values ($1,${date},$2,$3,$4,$5,$1,$6)`, [movement, roundId, kind, from, to, admin]);
    await db.query('insert into public.stock_movement_items(movement_id,ice_type_id,quantity) values ($1,$2,1)', [movement, ice]);
  }
  // Model platform table grants. The policy must still keep item rows private.
  await db.exec('grant select on public.stock_movement_items to authenticated');
  const asUser = async user => db.exec(`reset role; set request.jwt.claim.sub='${user}'; set role authenticated`);
  const visible = async () => (await db.query('select id from public.stock_movements order by id')).rows.map(row => row.id);

  await t.test('related changes are visible, including another round using the shared truck', async () => {
    await asUser(courier);
    const state = await value(`select public.get_employee_stock_state('${round}') as value`);
    assert.equal(state.truck_location.id, truck);
    assert.equal(state.holding_location.id, holding);
    assert.deepEqual(await visible(), [id(101), id(102), id(103), id(104)]);
    assert.equal(await value('select count(*)::int as value from public.stock_movement_items'), 0);
    assert.equal(await value(`select count(*)::int as value from pg_publication_tables where pubname='supabase_realtime' and tablename='stock_movements'`), 1);
  });

  await t.test('cancellation stays visible so clients can refresh reversed stock', async () => {
    await db.exec(`reset role; update public.stock_movements set status='cancelled',cancelled_by='${admin}',cancelled_at=now(),cancellation_reason='Test reversal' where id='${id(103)}'`);
    await asUser(courier);
    assert.equal(await value(`select status::text as value from public.stock_movements where id='${id(103)}'`), 'cancelled');
  });

  await t.test('unassigned and inactive couriers cannot read movement rows', async () => {
    await asUser(outsider);
    assert.deepEqual(await visible(), []);
    await db.exec(`reset role; update public.users set is_active=false where id='${courier}'`);
    await asUser(courier);
    assert.deepEqual(await visible(), []);
    await db.exec(`reset role; update public.users set is_active=true where id='${courier}'`);
  });

  await t.test('couriers cannot use the read grant to mutate movements', async () => {
    // Even environments with broad table grants must enforce the read-only RLS.
    await db.exec('reset role; grant select,insert,update,delete on all tables in schema public to authenticated');
    await asUser(courier);
    assert.deepEqual((await db.query(`update public.stock_movements set note='unauthorized' where id='${id(101)}' returning id`)).rows, []);
    assert.deepEqual((await db.query(`delete from public.stock_movements where id='${id(101)}' returning id`)).rows, []);
    await assert.rejects(db.query(`insert into public.stock_movements(service_date,round_id,kind,to_location_id,idempotency_key,recorded_by)
      values (${today},'${round}','factory_order','${truck}','${id(199)}','${courier}')`), /row-level security/);
  });

  await t.test('manager visibility is retained and anonymous execution is denied', async () => {
    await asUser(admin);
    assert.equal((await visible()).length, movements.length);
    await db.exec(`reset role; update public.users set role='round_lead' where id='${admin}'`);
    await asUser(admin);
    assert.equal((await visible()).length, movements.length);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select * from public.stock_movements'), /permission denied/);
    await assert.rejects(db.query(`select public.can_read_employee_stock_movement(${today},null,'${truck}')`), /permission denied/);
  });
});
