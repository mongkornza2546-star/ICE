import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0010_shop_catalog_excel_import.sql', import.meta.url),
  'utf8',
);

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role authenticated;
    create schema auth;
    create type public.shop_status as enum ('active', 'inactive');
    create function public.is_active_user() returns boolean language sql stable as $$ select true $$;
    create function public.current_app_role() returns text language sql stable as $$ select 'admin'::text $$;

    create table public.buildings (
      id uuid primary key default gen_random_uuid(),
      code text not null unique,
      name text not null,
      is_active boolean not null default true
    );
    create table public.building_zones (
      id uuid primary key default gen_random_uuid(),
      building_id uuid not null references public.buildings(id),
      code text not null,
      name text not null,
      sort_order integer not null,
      is_active boolean not null default true,
      unique (building_id, code),
      unique (building_id, name),
      unique (building_id, sort_order)
    );
    create table public.shops (
      id uuid primary key default gen_random_uuid(),
      code text not null unique,
      name text not null,
      zone_id uuid not null references public.building_zones(id),
      contact_name text,
      contact_phone text,
      normal_rounds_per_day smallint not null,
      access_note text,
      status public.shop_status not null
    );
  `);
  await db.exec(migration);
  return db;
}

const row = ({
  buildingCode = 'BB',
  buildingName = 'B',
  zoneCode = 'DOME-1',
  zoneName = 'ซุ้มโดม 1',
  zoneSortOrder = 1,
  shopCode = 'BB27',
  governmentShopCode = '',
  shopName = 'ร้านเดิม',
  status = 'active',
} = {}) => ({
  building_code: buildingCode,
  building_name: buildingName,
  zone_code: zoneCode,
  zone_name: zoneName,
  zone_sort_order: zoneSortOrder,
  shop_code: shopCode,
  government_shop_code: governmentShopCode,
  shop_name: shopName,
  contact_name: '',
  contact_phone: '',
  normal_rounds_per_day: 1,
  access_note: '',
  status,
});

async function importRows(db, rows) {
  return db.query('select public.import_shop_catalog($1::jsonb) as result', [JSON.stringify(rows)]);
}

test('shop catalog import creates and then updates the hierarchy atomically', async (t) => {
  const db = await createDatabase(t);

  const first = await importRows(db, [row()]);
  assert.deepEqual(first.rows[0].result, {
    row_count: 1,
    created_shop_count: 1,
    updated_shop_count: 0,
  });

  const second = await importRows(db, [{
    ...row({ buildingName: 'อาคาร B', zoneName: 'ซุ้มโดมหนึ่ง', governmentShopCode: 'ศร. 027', shopName: 'ร้านแก้ไข', status: 'inactive' }),
    contact_name: 'สมชาย',
    contact_phone: '0812345678',
    normal_rounds_per_day: 2,
    access_note: 'ประตูข้าง',
  }]);
  assert.equal(second.rows[0].result.updated_shop_count, 1);

  const saved = await db.query(`
    select shop.name, shop.government_shop_code, shop.contact_phone, shop.normal_rounds_per_day, shop.status,
           zone.name as zone_name, building.name as building_name
    from public.shops shop
    join public.building_zones zone on zone.id = shop.zone_id
    join public.buildings building on building.id = zone.building_id
  `);
  assert.deepEqual(saved.rows[0], {
    name: 'ร้านแก้ไข',
    government_shop_code: 'ศร. 027',
    contact_phone: '0812345678',
    normal_rounds_per_day: 2,
    status: 'inactive',
    zone_name: 'ซุ้มโดมหนึ่ง',
    building_name: 'อาคาร B',
  });
});

test('save_shop stores an optional government shop code separately from the internal code', async (t) => {
  const db = await createDatabase(t);
  await importRows(db, [row()]);
  const zone = await db.query("select id from public.building_zones where code = 'DOME-1'");

  await db.query(
    "select public.save_shop(null::uuid, 'bb28'::text, 'ร้านใหม่'::text, $1::uuid, null::text, null::text, 1::smallint, null::text, 'active'::public.shop_status, 'ศร. 028'::text)",
    [zone.rows[0].id],
  );
  const saved = await db.query("select code, government_shop_code from public.shops where code = 'BB28'");

  assert.deepEqual(saved.rows[0], { code: 'BB28', government_shop_code: 'ศร. 028' });
});

test('code identity is case-insensitive and stored in canonical uppercase', async (t) => {
  const db = await createDatabase(t);
  await importRows(db, [row({ buildingCode: 'bb', zoneCode: 'dome-1', shopCode: 'bb27' })]);

  const result = await importRows(db, [row({
    buildingCode: 'BB',
    buildingName: 'อาคาร B',
    zoneCode: 'DOME-1',
    zoneName: 'ซุ้มโดมหนึ่ง',
    shopCode: 'BB27',
    shopName: 'ร้านแก้ไข',
  })]);
  const saved = await db.query(`
    select
      (select count(*) from public.buildings) as building_count,
      (select count(*) from public.building_zones) as zone_count,
      (select count(*) from public.shops) as shop_count,
      (select code from public.buildings) as building_code,
      (select code from public.building_zones) as zone_code,
      (select code from public.shops) as shop_code
  `);

  assert.equal(result.rows[0].result.updated_shop_count, 1);
  assert.deepEqual(saved.rows[0], {
    building_count: 1,
    zone_count: 1,
    shop_count: 1,
    building_code: 'BB',
    zone_code: 'DOME-1',
    shop_code: 'BB27',
  });
  await assert.rejects(
    db.exec(`
      insert into public.shops (
        code, name, zone_id, normal_rounds_per_day, status
      )
      select 'bb27', 'ร้านซ้ำ', id, 1, 'active'
      from public.building_zones
      limit 1
    `),
    /duplicate key/i,
  );
});

test('partial imports preserve the order of zones omitted from the file', async (t) => {
  const db = await createDatabase(t);
  await importRows(db, [
    row({ zoneCode: 'Z1', zoneName: 'โซน 1', zoneSortOrder: 1, shopCode: 'BB01' }),
    row({ zoneCode: 'Z2', zoneName: 'โซน 2', zoneSortOrder: 2, shopCode: 'BB02' }),
    row({ zoneCode: 'Z3', zoneName: 'โซน 3', zoneSortOrder: 3, shopCode: 'BB03' }),
  ]);

  await importRows(db, [
    row({ zoneCode: 'Z2', zoneName: 'โซนสอง', zoneSortOrder: 99, shopCode: 'BB02' }),
  ]);
  const zones = await db.query('select code, sort_order from public.building_zones order by sort_order');

  assert.deepEqual(zones.rows, [
    { code: 'Z1', sort_order: 1 },
    { code: 'Z2', sort_order: 2 },
    { code: 'Z3', sort_order: 3 },
  ]);
});

test('imports reject inactive existing buildings and zones without reactivating them', async (t) => {
  const db = await createDatabase(t);
  await importRows(db, [row()]);

  await db.exec("update public.buildings set is_active = false where code = 'BB'");
  await assert.rejects(importRows(db, [row({ shopCode: 'BB28' })]), /inactive building/i);
  let state = await db.query("select is_active from public.buildings where code = 'BB'");
  assert.equal(state.rows[0].is_active, false);

  await db.exec("update public.buildings set is_active = true where code = 'BB'; update public.building_zones set is_active = false where code = 'DOME-1'");
  await assert.rejects(importRows(db, [row({ shopCode: 'BB28' })]), /inactive zone/i);
  state = await db.query("select is_active from public.building_zones where code = 'DOME-1'");
  assert.equal(state.rows[0].is_active, false);

  const shops = await db.query('select count(*)::integer as count from public.shops');
  assert.equal(shops.rows[0].count, 1);
});
