import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createVatDatabase } from './helpers/creditVatDatabase.mjs';

const id = n => `95000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const admin = id(1), courier = id(2), building = id(3), shop = id(4), ice = id(5), round = id(6), stop = id(7);
const today = "(clock_timestamp() at time zone 'Asia/Bangkok')::date";
const value = async (db, sql, args = []) => (await db.query(sql, args)).rows[0].value;

test('split POS reads preserve full-context data and avoid unrelated ledger work', async t => {
  const db = await createVatDatabase();
  t.after(() => db.close());
  await db.exec(`
    grant usage on schema public to authenticated, anon;
    insert into auth.users(id,email,raw_user_meta_data) values
      ('${admin}','parts-admin@example.test','{"display_name":"Admin"}'),
      ('${courier}','parts-courier@example.test','{"display_name":"Courier"}');
    update public.users set role='admin',is_active=true where id='${admin}';
    update public.users set role='courier',is_active=true where id='${courier}';
    set request.jwt.claim.sub='${admin}';
    insert into public.buildings(id,code,name) values ('${building}','PARTS','Parts test');
    insert into public.building_zones(id,building_id,code,name) values ('${id(8)}','${building}','ZONE','1');
    insert into public.shops(id,code,name,building_id,floor_or_zone,zone_id,stock_location_id)
      select '${shop}','PARTS-SHOP','Parts shop','${building}','1','${id(8)}',id
      from public.stock_locations where building_id='${building}' and is_default_for_building;
    update public.stock_locations set is_courier_source=true,is_active=true,holds_inventory=true where code='TRUCK-MAIN';
    insert into public.ice_types(id,code,name,unit) values ('${ice}','PARTS-ICE','Test ice','bag');
    insert into public.ice_type_prices(ice_type_id,unit_price,valid_from,created_by)
      values ('${ice}',25,${today},'${admin}');
    insert into public.shop_ice_type_prices(shop_id,ice_type_id,unit_price,valid_from,created_by)
      values ('${shop}','${ice}',30,${today},'${admin}');
    insert into public.shop_payment_profiles(shop_id,allowed_payment_terms,default_payment_term,
      allowed_payment_methods,default_payment_method,allow_outstanding,vat_enabled,credit_limit,credit_due_rule,created_by)
      values ('${shop}','{credit}','credit','{cash}','cash',true,true,1000,'end_of_month','${admin}');
    insert into public.delivery_rounds(id,service_date,name,round_type,status,opened_by)
      values ('${round}',${today},'งานประจำวัน','daily','open','${admin}');
    insert into public.round_stops(id,round_id,shop_id,shop_code_snapshot,shop_name_snapshot,
      building_id_snapshot,building_name_snapshot,floor_or_zone_snapshot,sequence_no,updated_by)
      values ('${stop}','${round}','${shop}','PARTS-SHOP','Parts shop','${building}','Parts test','1',1,'${admin}');
  `);
  const part = kind => value(db, `select public.get_delivery_pos_context_part($1,$2) as value`, [stop, kind]);

  await t.test('the parallel pair reproduces the original prices, stock, credit and VAT', async () => {
    const full = await value(db, `select public.get_delivery_pos_context('${stop}') as value`);
    const stock = await part('stock'), sale = await part('sale');
    const quantities = new Map(stock.items.map(item => [item.ice_type_id, item.stock_quantity]));
    assert.deepEqual({ ...sale, stock_source: stock.stock_source, stock_check_required: stock.stock_check_required,
      items: sale.items.map(item => ({ ...item, stock_quantity: quantities.get(item.ice_type_id) })),
    }, full);
    assert.equal(sale.items.find(item => item.ice_type_id === ice).unit_price, 30);
    assert.equal(sale.payment_profile.vat_enabled, true);
    assert.equal(sale.payment_profile.credit_remaining, 1000);
    assert.equal('payment_profile' in stock, false);
    assert.equal('unit_price' in stock.items[0], false);
    assert.equal('stock_quantity' in sale.items[0], false);
    assert.equal((await value(db, `select public.get_employee_active_session(${today}) as value`)).pos_context_parts_version, 1);
  });

  await t.test('sale can finish without invoking either stock ledger function', async () => {
    await db.exec('begin');
    try {
      for (const signature of ['stock_balance_at(date,uuid,uuid)', 'daily_aggregate_stock_balance_at(date,uuid)']) {
        const definition = await value(db, `select pg_get_functiondef($1::regprocedure) as value`, [`public.${signature}`]);
        await db.exec(definition.replace('LANGUAGE sql', 'LANGUAGE plpgsql')
          .replace(/AS \$function\$[\s\S]*\$function\$/, "AS $function$ begin raise exception 'unexpected ledger scan'; end; $function$"));
      }
      assert.equal((await part('sale')).payment_profile.credit_remaining, 1000);
      await assert.rejects(part('stock'), /unexpected ledger scan/);
    } finally { await db.exec('rollback'); }
  });

  await t.test('each part enforces permissions and valid input', async () => {
    await assert.rejects(part('invalid'), /Unknown POS context part/);
    await assert.rejects(part(null), /Unknown POS context part/);
    await db.exec('set role anon');
    for (const kind of ['stock', 'sale']) await assert.rejects(part(kind), /permission denied/);
    await db.exec('reset role');
    await db.exec(`set request.jwt.claim.sub='${courier}'`);
    for (const kind of ['stock', 'sale']) await assert.rejects(part(kind), /not assigned/);
    await db.exec(`set request.jwt.claim.sub='${admin}'; set role authenticated`);
    assert.equal((await part('sale')).round_stop_id, stop);
    await db.exec('reset role');
    await db.exec(`update public.users set is_active=false where id='${admin}'`);
    for (const kind of ['stock', 'sale']) await assert.rejects(part(kind), /active user/);
    await db.exec(`update public.users set is_active=true where id='${admin}'`);
  });

  await t.test('migration is safe to reapply and leaves legacy readers unchanged', async () => {
    const before = await value(db, `select pg_get_functiondef('public.get_delivery_pos_context(uuid)'::regprocedure) as value`);
    await db.exec(readFileSync(new URL('../supabase/migrations/0257_parallel_delivery_pos_context.sql', import.meta.url), 'utf8'));
    assert.equal(await value(db, `select pg_get_functiondef('public.get_delivery_pos_context(uuid)'::regprocedure) as value`), before);
    assert.equal((await part('sale')).round_stop_id, stop);
  });
});
