import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0022_restore_building_default_stock_locations.sql', import.meta.url),
  'utf8',
);

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create type public.stock_location_kind as enum (
      'truck', 'team', 'small_vehicle', 'work_site', 'reserve_bin', 'front_vehicle'
    );
    create table public.buildings (
      id uuid primary key default gen_random_uuid(),
      code text not null unique,
      name text not null,
      is_active boolean not null default true
    );
    create table public.stock_locations (
      id uuid primary key default gen_random_uuid(),
      code text not null unique,
      name text not null,
      kind public.stock_location_kind not null,
      building_id uuid references public.buildings(id),
      is_active boolean not null default true,
      is_default_for_building boolean not null default false
    );
    create unique index stock_locations_one_default_per_building_idx
      on public.stock_locations (building_id)
      where is_default_for_building;
    create table public.building_zones (
      id uuid primary key default gen_random_uuid(),
      building_id uuid not null references public.buildings(id),
      code text not null,
      name text not null
    );
    create table public.shops (
      id uuid primary key default gen_random_uuid(),
      code text not null unique,
      name text not null,
      zone_id uuid not null references public.building_zones(id),
      stock_location_id uuid not null references public.stock_locations(id)
    );

    create function public.assign_shop_stock_location()
    returns trigger
    language plpgsql
    set search_path = public
    as $$
    declare
      v_building_id uuid;
    begin
      select building_id into v_building_id
      from public.building_zones
      where id = new.zone_id;

      select id into new.stock_location_id
      from public.stock_locations
      where building_id = v_building_id
        and kind = 'work_site'
        and is_default_for_building
        and is_active;

      if new.stock_location_id is null then
        raise exception 'The shop building does not have a configured default stock location';
      end if;

      return new;
    end;
    $$;
    create trigger shops_assign_stock_location
      before insert on public.shops
      for each row execute function public.assign_shop_stock_location();
  `);

  return db;
}

test('an imported building and its first shop receive an active default work-site', async (t) => {
  const db = await createDatabase(t);
  await db.exec(migration);

  await db.exec(`
    insert into public.buildings (code, name) values ('BB', 'ตึก B');
    insert into public.building_zones (building_id, code, name)
      select id, 'DOME-1', 'ซุ้มโดม 1' from public.buildings where code = 'BB';
    insert into public.shops (code, name, zone_id)
      select 'BB27', 'ร้านทดสอบ', id from public.building_zones where code = 'DOME-1';
  `);
  const locations = await db.query(`
    select location.code, location.name, location.kind,
           location.is_active, location.is_default_for_building
    from public.stock_locations location
    join public.shops shop on shop.stock_location_id = location.id
    where shop.code = 'BB27'
  `);

  assert.deepEqual(locations.rows, [{
    code: 'SITE-BB',
    name: 'ตึก B · จุดปฏิบัติงาน',
    kind: 'work_site',
    is_active: true,
    is_default_for_building: true,
  }]);
});

test('the migration repairs an inactive legacy SITE location', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    insert into public.buildings (code, name) values ('BB', 'ตึก B');
    insert into public.stock_locations (
      code, name, kind, building_id, is_active, is_default_for_building
    )
    select 'SITE-BB', 'จุดเก่า', 'work_site', id, false, false
    from public.buildings where code = 'BB';
  `);

  await db.exec(migration);
  const locations = await db.query(`
    select code, is_active, is_default_for_building
    from public.stock_locations
  `);

  assert.deepEqual(locations.rows, [{
    code: 'SITE-BB',
    is_active: true,
    is_default_for_building: true,
  }]);
});
