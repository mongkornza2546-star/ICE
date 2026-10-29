export const id = n => `97000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const admin=id(1), courier=id(2), other=id(3), building=id(4), shop=id(5), ice=id(6), round=id(7), stop=id(8);
export const today="(clock_timestamp() at time zone 'Asia/Bangkok')::date";

export async function seedOffline(db) {
 await db.exec(`
  grant usage on schema public to authenticated,anon;
  insert into auth.users(id,email,raw_user_meta_data) values ('${admin}','off-admin@test.local','{"display_name":"Admin"}'),('${courier}','off-courier@test.local','{"display_name":"Courier"}'),('${other}','off-other@test.local','{"display_name":"Other"}');
  update public.users set role='admin',is_active=true where id='${admin}';
  update public.users set role='courier',is_active=true,can_collect_shop_payments=true where id in ('${courier}','${other}');
  set request.jwt.claim.sub='${admin}';
  insert into public.buildings(id,code,name) values('${building}','OFF','Offline');
  insert into public.employee_work_site_assignments(user_id,stock_location_id,assigned_by)
    select '${courier}',id,'${admin}' from public.stock_locations where building_id='${building}' and is_default_for_building;
  insert into public.building_zones(id,building_id,code,name) values('${id(9)}','${building}','ZONE','1');
  insert into public.shops(id,code,name,building_id,floor_or_zone,zone_id,stock_location_id)
    select '${shop}','OFF-SHOP','Offline shop','${building}','1','${id(9)}',id from public.stock_locations where building_id='${building}' and is_default_for_building;
  update public.stock_locations set is_courier_source=true,is_active=true,holds_inventory=true where code='TRUCK-MAIN';
  insert into public.ice_types(id,code,name,unit) values('${ice}','OFF-ICE','Ice','bag');
  insert into public.ice_type_prices(ice_type_id,unit_price,valid_from,created_by) values('${ice}',25,${today},'${admin}');
  insert into public.shop_payment_profiles(shop_id,allowed_payment_terms,default_payment_term,allowed_payment_methods,default_payment_method,allow_outstanding,credit_due_rule,credit_days,created_by)
    values('${shop}','{end_of_day,immediate}','end_of_day','{cash}','cash',true,null,null,'${admin}');
  insert into public.delivery_rounds(id,service_date,name,round_type,status,opened_by) values('${round}',${today},'งานประจำวัน','daily','open','${admin}');
  insert into public.delivery_round_members(round_id,user_id) values('${round}','${courier}');
  insert into public.round_stops(id,round_id,shop_id,shop_code_snapshot,shop_name_snapshot,building_id_snapshot,building_name_snapshot,floor_or_zone_snapshot,sequence_no,updated_by)
    values('${stop}','${round}','${shop}','OFF-SHOP','Offline shop','${building}','Offline','1',1,'${admin}');
  insert into public.stock_movements(id,service_date,round_id,kind,to_location_id,idempotency_key,recorded_by)
    select '${id(10)}',${today},'${round}','factory_order',id,gen_random_uuid(),'${admin}' from public.stock_locations where code='TRUCK-MAIN';
  insert into public.stock_movement_items(movement_id,ice_type_id,quantity) values('${id(10)}','${ice}',100);
  set request.jwt.claim.sub='${courier}';
 `);
}
