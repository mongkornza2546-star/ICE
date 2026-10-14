import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = (name) => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');

test('stock summary excludes event report sites, preserves holders and closed snapshots', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role authenticated;
    create table buildings(id uuid primary key default gen_random_uuid(), code text);
    create table stock_locations(
      id uuid primary key default gen_random_uuid(), code text, name text, kind text,
      building_id uuid, is_active boolean default true, holds_inventory boolean, requires_daily_count boolean default false,
      is_courier_source boolean default false, assigned_user_id uuid
    );
    create table users(id uuid, code text, display_name text, nickname text, avatar_path text, is_active boolean);
    create table employee_work_site_assignments(user_id uuid, stock_location_id uuid);
    create table ice_types(id uuid, image_path text);
    insert into buildings(code) values ('A'), (' event-old ');
    insert into stock_locations(code,name,kind,building_id,holds_inventory) values
      ('SITE-A','A · จุดปฏิบัติงาน','work_site',(select id from buildings where code='A'),false),
      (' site-event-old ','ตึก A · จุดปฏิบัติงาน','work_site',null,false),
      ('LEGACY','จุดอีเวนต์เปลี่ยนรหัส','work_site',(select id from buildings where code=' event-old '),false),
      ('SITE-EVENT-TRUCK','รถอีเวนต์','truck',(select id from buildings where code=' event-old '),true),
      ('SITE-EVENT-HOLDER','จุดเก็บสต๊อกเดิม','work_site',null,true);
    create table summary_fixture(value jsonb);
    insert into summary_fixture select jsonb_build_object(
      'is_snapshot', false,
      'locations', jsonb_agg(jsonb_build_object('id',id,'code',code,'name',name,'kind',kind,
        'balances',jsonb_build_array(jsonb_build_object('quantity',-3))))
    ) from stock_locations;
    create function get_stock_control_summary_v2(uuid,date) returns jsonb language sql stable
      as $$ select value from summary_fixture $$;
  `);
  await db.exec(migration('0057_sync_stock_control_summary_holder_flags'));
  const fix = migration('0230_deduplicate_event_work_sites');
  await db.exec(fix.slice(fix.indexOf('create or replace function public.get_stock_control_summary')));
  const summary = async () => (await db.query('select get_stock_control_summary(null,null) as value')).rows[0].value;
  const live = await summary();
  assert.deepEqual(live.locations.map(l => l.code).sort(), ['SITE-A','SITE-EVENT-HOLDER','SITE-EVENT-TRUCK']);
  assert.ok(live.locations.every(l => l.balances[0].quantity === -3));
  assert.equal((await db.query('select count(*)::int as n from stock_locations')).rows[0].n, 5);
  await db.exec(`update summary_fixture set value=jsonb_set(value,'{is_snapshot}','true')`);
  const closed = await summary();
  assert.equal(closed.locations.length, 5, 'closed reports retain historical locations');
  assert.ok(closed.locations.every(l => l.balances[0].quantity === -3));
});
