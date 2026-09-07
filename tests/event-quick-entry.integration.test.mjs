import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

function migration(name) { return readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'); }
function definition(name, sql) {
  return sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))[0];
}

test('quick entry creates and publishes 300 booths atomically without regular delivery duplicates', async (t) => {
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
  await db.exec(definition('audit_row_update', migration('0001_phase_1_foundation')));
  await db.exec('create trigger shops_audit_update after update on public.shops for each row execute function public.audit_row_update()');
  const createEvent = async () => (await db.query(`select public.save_event_job(null, '', null, '', null, '', '2026-09-07', '2026-09-07', null, null, null, null, false, false, false, false, false, false) as value`)).rows[0].value;
  const saved = await createEvent();
  const id = saved.event_job.id;
  assert.equal(saved.event_job.name, 'อีเวนต์ 2026-09-07');
  assert.equal(saved.event_job.contact_name, '');
  assert.deepEqual(saved.configuration.allowed_payment_methods, ['cash']);
  const rows = ['A', 'F', 'T'].flatMap((prefix, i) => Array.from({length: [250,40,10][i]}, (_, n) => ({ name: '', booth_number: `${prefix}${n+1}`, event_zone: 'ตึก B', start_date: '2026-09-07', end_date: '2026-09-07' })));
  const createShops = async (eventId, data, request = randomUUID()) => (await db.query('select public.create_event_shops($1, $2, $3) as value', [eventId, request, JSON.stringify(data)])).rows[0].value;
  await db.exec("select set_config('app.test_role', 'courier', false)");
  await assert.rejects(createShops(id, rows), /Only an active admin or round lead/);
  await db.exec("select set_config('app.test_role', 'round_lead', false)");
  const request = randomUUID();
  assert.deepEqual(await createShops(id, rows, request), { created_count: 300, skipped_count: 0 });
  assert.deepEqual(await createShops(id, rows, request), { created_count: 300, skipped_count: 0 });
  assert.deepEqual(await createShops(id, rows), { created_count: 0, skipped_count: 300 });
  await assert.rejects(createShops(id, rows.slice(0,1), request), /different input/);
  const countShops = async () => Number((await db.query('select count(*) as n from public.shops')).rows[0].n);
  assert.equal(await countShops(), 304);
  const boothCodes = (await db.query('select booth_number from public.event_participations where event_job_id=$1', [id])).rows.map(r => r.booth_number);
  assert.equal(new Set(boothCodes).size, 300);
  assert.ok(boothCodes.includes('A250') && boothCodes.includes('F40') && boothCodes.includes('T10'));
  const participant = (await db.query('select * from public.event_participations where event_job_id=$1 and booth_number=$2', [id, 'A1'])).rows[0];
  const rename = async (p, name, endDate = p.end_date) => db.query(
    'select public.save_event_participation_with_shop_name($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [p.id,p.event_job_id,p.shop_id,p.booth_number,p.event_zone,'จุดสังเกตใหม่',p.contact_name,p.contact_phone,p.start_date,endDate,p.rents_tank_from_us,name],
  );
  await db.exec("select set_config('app.test_role', 'courier', false)");
  await assert.rejects(rename(participant, 'Unauthorized'), /Only an active admin or round lead/);
  await db.exec("select set_config('app.test_role', 'round_lead', false)");
  await db.exec("select set_config('app.test_active', 'off', false)");
  await assert.rejects(rename(participant, 'Inactive'), /Only an active admin or round lead/);
  await db.exec("select set_config('app.test_active', 'on', false)");
  await assert.rejects(rename(participant, '   '), /name is required/);
  await assert.rejects(rename(participant, 'Should roll back', '2026-09-08'), /within the event date range/);
  assert.equal((await db.query('select name from public.shops where id=$1', [participant.shop_id])).rows[0].name, 'บูธ A1');
  assert.equal((await db.query('select landmark from public.event_participations where id=$1', [participant.id])).rows[0].landmark, null);
  await rename(participant, ' ร้านอาหารจากเชียงใหม่ ');
  // A shop-write failure must also undo the participation update and audit entry.
  await db.exec("alter table public.shops add constraint test_name_write_failure check (name <> 'FAIL_RENAME')");
  await assert.rejects(rename({...participant, booth_number:'CHANGED'}, 'FAIL_RENAME'), /test_name_write_failure/);
  assert.equal((await db.query('select booth_number from public.event_participations where id=$1', [participant.id])).rows[0].booth_number, 'A1');
  await db.exec('alter table public.shops drop constraint test_name_write_failure');
  const renamedDetail = (await db.query('select public.get_event_management_detail($1) as value', [id])).rows[0].value;
  assert.equal(renamedDetail.participations.find(p => p.id === participant.id).shop_name, 'ร้านอาหารจากเชียงใหม่');
  assert.equal(renamedDetail.participations.find(p => p.id === participant.id).landmark, 'จุดสังเกตใหม่');
  assert.equal(Number((await db.query("select count(*) as n from public.audit_logs where entity_type='shops' and entity_id=$1 and after_value->>'name'=$2", [participant.shop_id,'ร้านอาหารจากเชียงใหม่'])).rows[0].n), 1);
  // A later invalid row rolls back both its customer and all earlier rows.
  await assert.rejects(createShops(id, [{...rows[0], booth_number:'Z1'}, {...rows[0], booth_number:'Z2', end_date:'2026-09-08'}]), /within the event date range/);
  assert.equal(await countShops(), 304);
  await db.exec(`insert into public.ice_type_prices(ice_type_id, unit_price, valid_from, valid_to, is_active) select id,50,'2026-09-07','2026-09-07',true from public.ice_types`);
  const readiness = (await db.query('select public.event_publish_readiness($1) as value', [id])).rows[0].value;
  assert.equal(readiness.is_ready, true);
  await db.query('select public.publish_event_job($1)', [id]);
  assert.deepEqual(await createShops(id, [{...rows[0], booth_number:'A251'}]), { created_count:1, skipped_count:0 });
  assert.equal(Number((await db.query('select count(*) as n from public.event_participations where event_job_id=$1 and config_version_id is not null', [id])).rows[0].n),301);
  const round = (await db.query("select public.ensure_daily_delivery_round('2026-09-07') as id")).rows[0].id;
  assert.equal(Number((await db.query('select count(*) as n from public.round_stops')).rows[0].n), 4);
  await db.query('select public.sync_daily_round_active_shops($1)', [round]);
  assert.equal(Number((await db.query('select count(*) as n from public.round_stops')).rows[0].n), 4);
  await db.exec('update public.event_delivery_feature_settings set event_stops_enabled=true');
  await db.query('select public.sync_daily_round_destinations($1)', [round]);
  assert.deepEqual((await db.query('select destination_kind, count(*)::integer as n from public.round_stops group by destination_kind order by destination_kind')).rows, [{destination_kind:'regular',n:4},{destination_kind:'event',n:301}]);
  await db.query('select public.sync_daily_round_destinations($1)', [round]);
  assert.equal(Number((await db.query('select count(*) as n from public.round_stops')).rows[0].n),305);
  await db.exec("select set_config('app.test_role', 'admin', false)");
  // Published renames keep the same customer and frozen delivery history.
  const beforeRename = (await db.query('select shop_name_snapshot from public.round_stops where event_participation_id=$1', [participant.id])).rows[0].shop_name_snapshot;
  await rename(participant, 'ชื่อร้านที่แก้หลังเผยแพร่');
  assert.equal((await db.query('select shop_name_snapshot from public.round_stops where event_participation_id=$1', [participant.id])).rows[0].shop_name_snapshot, beforeRename);
  assert.equal((await db.query('select shop_id from public.event_participations where id=$1', [participant.id])).rows[0].shop_id, participant.shop_id);
  const other = await createEvent();
  assert.deepEqual(await createShops(other.event_job.id, [rows[0]]), {created_count:1,skipped_count:0});
  assert.deepEqual(await createShops(other.event_job.id, [{start_date:'2026-09-07',end_date:'2026-09-07'}]), {created_count:1,skipped_count:0});
  const fallbackShop = (await db.query('select name, stock_location_id from public.shops where event_job_id=$1 and name like $2', [other.event_job.id, 'ร้านใหม่ %'])).rows[0];
  assert.ok(fallbackShop.name && fallbackShop.stock_location_id);
  const regular = (await db.query("select * from public.save_event_participation(null,$1,'20000000-0000-4000-8000-000000000001',null,null,null,null,null,'2026-09-07','2026-09-07',false)", [other.event_job.id])).rows[0];
  await assert.rejects(rename(regular, 'Must not rename regular shop'), /Only an event-owned shop/);
  await assert.rejects(rename({...participant,event_job_id:other.event_job.id}, 'Wrong event'), /does not belong/);
  await assert.rejects(rename({...participant,shop_id:regular.shop_id}, 'Wrong shop'), /does not belong/);
  const otherParticipant = (await db.query('select * from public.event_participations where event_job_id=$1 and shop_id<>$2 limit 1', [other.event_job.id, regular.shop_id])).rows[0];
  await db.query('select public.cancel_event_participation($1,$2)', [otherParticipant.id, 'cancel booth']);
  await assert.rejects(rename(otherParticipant, 'Cancelled booth'), /Cancelled participations are immutable/);
  await db.query('select public.cancel_event_job($1,$2)', [other.event_job.id,'cancel']);
  await assert.rejects(rename(otherParticipant, 'Cancelled event'), /Cancelled events/);
  await assert.rejects(createShops(other.event_job.id, [rows[1]]), /Cancelled events/);
});
