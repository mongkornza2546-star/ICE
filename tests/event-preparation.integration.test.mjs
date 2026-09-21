import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

function migration(name) { return readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'); }
function definition(name, sql) {
  return sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))[0];
}

test('preparation keeps public dates, scopes early stops and records tank custody with opening-day rental', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create type public.payment_term as enum ('immediate', 'end_of_day', 'credit');
    create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');
    create type public.round_destination_kind as enum ('regular', 'event');

    create function auth.uid() returns uuid language sql stable
    as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
    create function public.is_active_user() returns boolean language sql stable
    as $$ select current_setting('app.test_active', true) is distinct from 'off' $$;
    create function public.current_app_role() returns text language sql stable
    as $$ select coalesce(nullif(current_setting('app.test_role', true), ''), 'admin') $$;
    create function public.set_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at = now(); return new; end;
    $$;

    create table public.users (id uuid primary key);
    create table public.shops (
      id uuid primary key,
      code text not null,
      name text not null,
      contact_name text,
      contact_phone text,
      status text not null
    );
    create table public.ice_types (
      id uuid primary key,
      code text not null,
      name text not null,
      is_active boolean not null
    );
    create table public.ice_type_prices (
      id uuid primary key default gen_random_uuid(),
      ice_type_id uuid not null references public.ice_types(id),
      unit_price numeric(12,2) not null,
      valid_from date not null,
      valid_to date,
      is_active boolean not null
    );
    create table public.delivery_rounds (
      id uuid primary key default gen_random_uuid(),
      service_date date not null
    );
    create table public.round_stops (
      id uuid primary key default gen_random_uuid(),
      round_id uuid references public.delivery_rounds(id),
      destination_kind public.round_destination_kind not null default 'regular',
      event_participation_id uuid,
      is_operational boolean not null default true,
      event_job_name_snapshot text,
      event_location_snapshot text,
      event_booth_snapshot text,
      event_zone_snapshot text,
      event_landmark_snapshot text,
      event_contact_name_snapshot text,
      event_contact_phone_snapshot text,
      constraint round_stops_destination_context_check check (
        (destination_kind = 'regular' and event_participation_id is null)
        or (destination_kind = 'event' and event_participation_id is not null)
      )
    );
    create unique index round_stops_regular_destination_unique_idx
      on public.round_stops (round_id, id) where destination_kind = 'regular';
    create unique index round_stops_event_destination_unique_idx
      on public.round_stops (round_id, event_participation_id) where destination_kind = 'event';
    create table public.delivery_events (
      id uuid primary key default gen_random_uuid(),
      round_stop_id uuid not null references public.round_stops(id)
    );
    create table public.audit_logs (
      id uuid primary key default gen_random_uuid(),
      actor_id uuid not null references public.users(id),
      entity_type text not null,
      entity_id uuid not null,
      action text not null,
      before_value jsonb,
      after_value jsonb,
      reason text,
      occurred_at timestamptz not null default now()
    );

    insert into public.users values ('10000000-0000-4000-8000-000000000001');
    insert into public.shops values
      ('20000000-0000-4000-8000-000000000001', 'S001', 'Shop one', 'One', '0800000001', 'active'),
      ('20000000-0000-4000-8000-000000000002', 'S002', 'Shop two', 'Two', '0800000002', 'active'),
      ('20000000-0000-4000-8000-000000000003', 'S003', 'Shop three', 'Three', '0800000003', 'active'),
      ('20000000-0000-4000-8000-000000000004', 'S004', 'Shop four', null, null, 'active');
    insert into public.ice_types values
      ('30000000-0000-4000-8000-000000000001', 'ICE', 'Ice', true);
  `);

  await db.exec(`
    create table public.buildings (id uuid primary key default gen_random_uuid(), code text unique not null, name text not null, is_active boolean default true, sort_order integer default 1);
    create table public.building_zones (id uuid primary key default gen_random_uuid(), building_id uuid references public.buildings(id), code text not null, name text not null, sort_order integer not null, is_active boolean default true, unique(building_id, code), unique(building_id, name), unique(building_id, sort_order));
    create table public.stock_locations (id uuid primary key default gen_random_uuid(), code text unique not null, name text not null, kind text, building_id uuid references public.buildings(id), is_active boolean default true, created_at timestamptz default now());
    alter table public.shops alter column status set default 'active';
    alter table public.shops add column zone_id uuid references public.building_zones(id);
    alter table public.shops add column building_id uuid references public.buildings(id);
    alter table public.shops add column floor_or_zone text;
    alter table public.shops add column stock_location_id uuid references public.stock_locations(id);
    alter table public.shops add column delivery_sequence integer;
    create unique index shops_code_ci_uidx on public.shops(upper(code));
    alter table public.users add column is_active boolean default true;
    alter table public.users add column role text default 'admin';
    create table public.delivery_round_members(round_id uuid, user_id uuid, primary key(round_id,user_id));
    create function public.is_round_member(uuid) returns boolean language sql as $$ select false $$;
    alter table public.delivery_rounds add column name text;
    alter table public.delivery_rounds add column opened_by uuid;
    alter table public.delivery_rounds add column created_at timestamptz default now();
    create table public.round_ice_counts(round_id uuid, ice_type_id uuid, loaded_quantity integer, replenished_quantity integer, remaining_quantity integer, damaged_quantity integer, updated_by uuid);
    alter table public.delivery_rounds add column round_type text default 'daily';
    alter table public.delivery_rounds add column status text default 'open';
    alter table public.delivery_rounds add column cancelled_at timestamptz;
    alter table public.round_stops add column shop_id uuid references public.shops(id);
    alter table public.round_stops add column shop_code_snapshot text;
    alter table public.round_stops add column shop_name_snapshot text;
    alter table public.round_stops add column building_id_snapshot uuid;
    alter table public.round_stops add column building_name_snapshot text;
    alter table public.round_stops add column floor_or_zone_snapshot text;
    alter table public.round_stops add column sequence_no integer;
    alter table public.round_stops add column updated_by uuid;
    alter table public.round_stops add column updated_at timestamptz;
    drop index round_stops_regular_destination_unique_idx;
    create unique index round_stops_regular_destination_unique_idx on public.round_stops(round_id,shop_id) where destination_kind='regular';
  `);
  // Real location/stock triggers exercise the same mandatory columns as production.
  await db.exec(definition('sync_shop_location_from_zone', migration('0005_building_zones')));
  await db.exec(definition('ensure_building_stock_location', migration('0007_daily_mobile_stock')));
  await db.exec(definition('assign_shop_stock_location', migration('0007_daily_mobile_stock')));
  await db.exec(`
    create trigger buildings_create_stock_location after insert on public.buildings for each row execute function public.ensure_building_stock_location();
    create trigger shops_sync_location_from_zone before insert or update on public.shops for each row execute function public.sync_shop_location_from_zone();
    create trigger shops_assign_stock_location before insert or update on public.shops for each row execute function public.assign_shop_stock_location();
    insert into public.buildings(code, name) values ('B', 'ตึก B');
    insert into public.building_zones(building_id, code, name, sort_order) select id, 'REG', 'ร้านประจำ', 1 from public.buildings;
    update public.shops set zone_id = (select id from public.building_zones);
    alter table public.shops alter column building_id set not null;
    alter table public.shops alter column zone_id set not null;
    alter table public.shops alter column floor_or_zone set not null;
    alter table public.shops alter column stock_location_id set not null;
  `);
  await db.exec(migration('0163_event_lifecycle_foundation'));
  await db.exec(migration('0169_event_management_read_model'));
  await db.exec(definition('ensure_daily_delivery_round', migration('0042_daily_work_session_architecture')).replaceAll('ensure_daily_delivery_round', 'ensure_daily_delivery_round_before_area_order'));
  await db.exec(definition('ensure_daily_delivery_round', migration('0145_accounting_shop_summary_area_groups')));
  await db.exec(definition('create_delivery_round', migration('0006_rounds_without_routes').replace('create function public.create_delivery_round', 'create or replace function public.create_delivery_round')));
  await db.exec(definition('sync_daily_round_active_shops', migration('0157_event_destination_compatibility_fence')));
  await db.exec(migration('0176_event_quick_entry_and_bulk_booths'));
  await db.exec(migration('0184_event_participation_booth_uniqueness'));
  await db.exec(definition('audit_row_update', migration('0001_phase_1_foundation')));
  await db.exec('create trigger shops_audit_update after update on public.shops for each row execute function public.audit_row_update()');

  await db.exec(`
    create type public.shop_round_status as enum ('pending', 'delivered', 'full_bin', 'closed_shop', 'no_access', 'issue');
    create type public.delivery_round_status as enum ('open', 'closed');
    create table public.event_settlement_contexts (
      id uuid primary key default gen_random_uuid(), event_participation_id uuid, shop_id uuid,
      config_version_id uuid, settlement_policy_fingerprint text, service_date date
    );
  `);
  await db.exec(definition('get_event_delivery_cards', migration('0165_event_read_models_and_destination_counts')));
  await db.exec(definition('get_event_delivery_pos_context', migration('0170_event_ice_delivery_pos')));
  await db.exec(definition('record_event_ice_delivery', migration('0170_event_ice_delivery_pos')));
  await db.exec(definition('enforce_event_settlement_context', migration('0171_event_ice_delivery_financial_closeout')));
  await db.exec(`create trigger validate_context before insert on public.event_settlement_contexts for each row execute function public.enforce_event_settlement_context()`);
  await db.exec(`
    create type public.price_source as enum ('standard');
    create table public.event_ice_delivery_pilots(event_participation_id uuid primary key, expires_at timestamptz);
    alter table public.event_settlement_contexts add unique(event_participation_id,service_date);
    alter table public.shops add column image_path text;
    alter table public.ice_types add column unit text default 'ถุง';
    alter table public.ice_types add column image_path text;
    alter table public.stock_locations add column assigned_user_id uuid;
    alter table public.round_stops add column status public.shop_round_status default 'pending';
    alter table public.round_stops add column note text;
    alter table public.delivery_events add column recorded_by uuid;
    alter table public.delivery_events add column client_recorded_at timestamptz;
    alter table public.delivery_events add column idempotency_key uuid unique;
    alter table public.delivery_events add column request_fingerprint text;
    alter table public.delivery_events add column note text;
    alter table public.delivery_events add column source_stock_location_id uuid;
    create table public.delivery_items(delivery_event_id uuid,ice_type_id uuid,quantity numeric,unit_price numeric,price_source public.price_source,price_source_id uuid);
    create table public.delivery_charges(delivery_event_id uuid,shop_id uuid,service_date date,payment_term public.payment_term,original_amount numeric,due_date date,approval_request_id uuid,event_settlement_context_id uuid);
    create table public.daily_aggregate_stock_closures(service_date date);
    create function public.daily_aggregate_stock_balance_at(date,uuid) returns numeric language sql as $$ select 100::numeric $$;
    create function public.stock_balance_at(date,uuid,uuid) returns numeric language sql as $$ select 100::numeric $$;
    create function public.delivery_request_fingerprint(uuid,jsonb,public.shop_round_status,text,public.payment_term) returns text language sql as $$ select md5(concat($1,$2,$3,$4,$5)) $$;
    create function public.is_delivery_event_visible(uuid) returns boolean language sql as $$ select true $$;
    create function public.delivery_financial_response(uuid) returns jsonb language sql as $$ select jsonb_build_object('event_id',$1) $$;
  `);
  await db.exec(definition('lock_event_ice_delivery_write_eligibility', migration('0171_event_ice_delivery_financial_closeout')));
  await db.exec(definition('get_or_create_event_settlement_context', migration('0171_event_ice_delivery_financial_closeout')));
  await db.exec(migration('0171_event_ice_delivery_financial_closeout').match(/do \$event_financial_writer\$[\s\S]*?\$event_financial_writer\$;/)[0]);
  await db.exec(migration('0187_event_preparation_and_tank_register'));
  const day = (delta) => db.query("select ((now() at time zone 'Asia/Bangkok')::date + $1::int)::text as day", [delta]).then(r => r.rows[0].day);
  const today = await day(0), tomorrow = await day(1), yesterday = await day(-1);
  const saved = (await db.query(`select public.save_event_job(null, 'งานทดสอบ', '', '', '', '', $1, $1, null, 100, null, null, false, false, false, false, false, false) as value`, [tomorrow])).rows[0].value;
  const id = saved.event_job.id;
  await db.query('select public.create_event_shops($1,$2,$3)', [id, randomUUID(), JSON.stringify([
    { name: 'รับก่อนงาน', booth_number: '001', start_date: tomorrow, end_date: tomorrow },
    { name: 'รับวันเปิดงาน', booth_number: '002', start_date: tomorrow, end_date: tomorrow },
  ])]);
  const parts = (await db.query('select * from public.event_participations where event_job_id=$1 order by booth_number', [id])).rows;
  const prepare = (date = today, ids = [parts[0].id]) => db.query('select public.prepare_event_shops($1,$2,$3) as value', [id,date,ids]);
  await db.exec("select set_config('app.test_role','courier',false)");
  await assert.rejects(prepare(), /Only an active admin/);
  await db.exec("select set_config('app.test_role','admin',false)");
  await assert.rejects(prepare(tomorrow), /ก่อนวันเปิดงาน/);
  await assert.rejects(prepare(today, [parts[0].id, parts[0].id]), /ร้านซ้ำ/);
  await assert.rejects(prepare(today, [randomUUID()]), /ไม่ได้อยู่ในงาน/);
  await db.query('insert into public.ice_type_prices(ice_type_id,unit_price,valid_from,is_active) values ($1,20,$2,true)', ['30000000-0000-4000-8000-000000000001', tomorrow]);
  await db.query('select public.publish_event_job($1)',[id]);
  await assert.rejects(prepare(), /ตั้งราคาน้ำแข็ง/);
  await db.query('update public.ice_type_prices set valid_from=$1', [yesterday]);
  assert.equal((await prepare()).rows[0].value.prepared_count,1);
  assert.equal((await prepare()).rows[0].value.prepared_count,1);
  const job = (await db.query('select to_jsonb(j) as value from public.event_jobs j where id=$1',[id])).rows[0].value;
  assert.equal(job.start_date, tomorrow);
  assert.equal(job.preparation_start_date, today);
  const round = (await db.query('select public.ensure_daily_delivery_round($1) as id',[today])).rows[0].id;
  await db.exec('update public.event_delivery_feature_settings set event_stops_enabled=true');
  await db.query('select public.sync_daily_round_destinations($1)',[round]);
  assert.deepEqual((await db.query("select event_participation_id from public.round_stops where round_id=$1 and destination_kind='event'", [round])).rows.map(r => r.event_participation_id),[parts[0].id]);
  const nextRound = (await db.query('select public.ensure_daily_delivery_round($1) as id',[tomorrow])).rows[0].id;
  await db.query('select public.sync_daily_round_destinations($1)',[nextRound]);
  assert.equal((await db.query("select count(*)::int as count from public.round_stops where round_id=$1 and destination_kind='event'",[nextRound])).rows[0].count,2);
  const context = (part, date) => db.query(`insert into public.event_settlement_contexts(event_participation_id,shop_id,config_version_id,settlement_policy_fingerprint,service_date)
    select id,shop_id,config_version_id,settlement_policy_fingerprint,$2 from public.event_participations where id=$1`, [part,date]);
  await context(parts[0].id,today);
  await assert.rejects(context(parts[1].id,today),/does not match/);
  await assert.rejects(context(parts[0].id,yesterday),/does not match/);
  await db.exec('update public.event_delivery_feature_settings set event_ice_delivery_enabled=true');
  const stop=(await db.query("select id from public.round_stops where round_id=$1 and event_participation_id=$2",[round,parts[0].id])).rows[0].id;
  const pos=(await db.query('select public.get_event_delivery_pos_context($1) as value',[stop])).rows[0].value;
  assert.equal(pos.service_date,today);
  assert.equal(pos.items[0].unit_price,20);
  const iceRequest=randomUUID();
  const deliver=()=>db.query("select public.record_event_ice_delivery($1,$2,'delivered','ลงก่อนเปิดงาน',now(),$3) as value",[stop,JSON.stringify([{ice_type_id:'30000000-0000-4000-8000-000000000001',quantity:2}]),iceRequest]);
  const delivered=(await deliver()).rows[0].value;
  assert.deepEqual((await deliver()).rows[0].value,delivered);
  const charge=(await db.query('select to_jsonb(c) as value from public.delivery_charges c where delivery_event_id=$1',[delivered.event_id])).rows[0].value;
  assert.equal(charge.service_date,today);
  assert.equal(charge.original_amount,40);
  assert.ok(charge.event_settlement_context_id);
  assert.equal((await db.query('select count(*)::int as count from public.delivery_items')).rows[0].count,1);
  const movement = (kind='handoff', quantity=2, date=today, request=randomUUID(), part=parts[0].id) => db.query('select to_jsonb(public.record_event_tank_movement($1,$2,$3,$4,$5,$6)) as value',[part,kind,quantity,date,'',request]).then(r=>r.rows[0].value);
  await assert.rejects(movement('handoff',1,tomorrow), /วันอนาคต/);
  await assert.rejects(movement('handoff',1,today,randomUUID(),parts[1].id), /วันที่ร้านเปิดรับของ/);
  const req=randomUUID();
  const handoff=await movement('handoff',2,today,req);
  assert.equal(handoff.rental_start_date,tomorrow);
  assert.equal(Number(handoff.rental_unit_price),100);
  assert.equal((await movement('handoff',2,today,req)).id,handoff.id);
  await assert.rejects(movement('handoff',3,today,req),/different input/);
  await assert.rejects(movement('return',3), /เกิน/);
  await assert.rejects(movement('return',1,yesterday), /เกิน/);
  await movement('return',1);
  const detail=(await db.query('select public.get_event_management_detail($1) as value',[id])).rows[0].value;
  assert.equal(detail.tank_movements.length,2);
  assert.equal(detail.participations.find(p=>p.id===parts[0].id).preparation_start_date,today);
  await prepare(yesterday);
  await assert.rejects(prepare(today), /เลื่อนให้ช้าลงไม่ได้/);
  await db.query('select public.cancel_event_job($1,$2)',[id,'จบงาน']);
  await assert.rejects(prepare(), /ยกเลิก/);
  await assert.rejects(movement('handoff',1), /งานเผยแพร่/);
  await movement('return',1);
  await assert.rejects(movement('return',1), /เกิน/);
  await db.exec("select set_config('app.test_role','courier',false)");
  await assert.rejects(movement('return',1), /Only an active admin/);
  // The migration must preserve stock-date and financial locking safeguards in the writer.
  const writer=(await db.query("select pg_get_functiondef('public.record_event_ice_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid)'::regprocedure) as body")).rows[0].body;
  assert.match(writer,/coalesce\(job.preparation_start_date, job.start_date\)/);
  assert.match(writer,/coalesce\(participation.preparation_start_date, participation.start_date\)/);
  assert.match(writer,/pg_advisory_xact_lock/);
  assert.match(writer,/stock_balance_at\(v_service_date/);
});
