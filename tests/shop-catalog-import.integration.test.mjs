import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const catalogMigration = readFileSync(
  new URL('../supabase/migrations/0010_shop_catalog_excel_import.sql', import.meta.url),
  'utf8',
);
const stallMigration = readFileSync(
  new URL('../supabase/migrations/0135_active_shop_stall_code_uniqueness.sql', import.meta.url),
  'utf8',
);

async function createDatabase(t, { applyStallMigration = true } = {}) {
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
  await db.exec(catalogMigration);
  if (applyStallMigration) await db.exec(stallMigration);
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

test('stall migration rejects pre-existing normalized active duplicates without choosing a winner', async (t) => {
  const db = await createDatabase(t, { applyStallMigration: false });
  await importRows(db, [
    row({ shopCode: 'BB27', governmentShopCode: ' BMFD-0309 ' }),
    row({ shopCode: 'BB28', governmentShopCode: 'bmfd-0309' }),
  ]);

  await assert.rejects(db.exec(stallMigration), /Active shop stall codes must be resolved.*BMFD-0309.*BB27.*BB28/is);
  const indexes = await db.query(`
    select count(*)::integer as count
    from pg_indexes
    where schemaname = 'public' and indexname = 'shops_one_active_stall_code_uidx'
  `);
  assert.equal(indexes.rows[0].count, 0);
});

test('one active shop may use a normalized stall while inactive history remains reusable', async (t) => {
  const db = await createDatabase(t);
  await importRows(db, [row({ shopCode: 'BB27', governmentShopCode: 'BMFD-0309', status: 'inactive' })]);
  const zone = await db.query("select id from public.building_zones where code = 'DOME-1'");

  await db.query(
    "select public.save_shop(null::uuid, 'BB28'::text, 'ร้านใหม่'::text, $1::uuid, null::text, null::text, 1::smallint, null::text, 'active'::public.shop_status, ' bmfd-0309 '::text)",
    [zone.rows[0].id],
  );
  await db.query(
    "select public.save_shop(null::uuid, 'BB29'::text, 'ร้านประวัติ'::text, $1::uuid, null::text, null::text, 1::smallint, null::text, 'inactive'::public.shop_status, 'BMFD-0309'::text)",
    [zone.rows[0].id],
  );

  const shops = await db.query("select code, status from public.shops where upper(trim(government_shop_code)) = 'BMFD-0309' order by code");
  assert.deepEqual(shops.rows, [
    { code: 'BB27', status: 'inactive' },
    { code: 'BB28', status: 'active' },
    { code: 'BB29', status: 'inactive' },
  ]);

  await assert.rejects(
    db.query(
      "select public.save_shop(null::uuid, 'BB30'::text, 'ร้านซ้ำ'::text, $1::uuid, null::text, null::text, 1::smallint, null::text, 'active'::public.shop_status, 'BMFD-0309'::text)",
      [zone.rows[0].id],
    ),
    /รหัสล็อกนี้มีร้านที่ใช้งานอยู่แล้ว/,
  );
});

test('reactivating an old shop is rejected while the replacement occupies its stall', async (t) => {
  const db = await createDatabase(t);
  await importRows(db, [row({ shopCode: 'BB27', governmentShopCode: 'BMFD-0309', status: 'inactive' })]);
  const zone = await db.query("select id from public.building_zones where code = 'DOME-1'");
  const oldShop = await db.query("select id from public.shops where code = 'BB27'");
  await db.query(
    "select public.save_shop(null::uuid, 'BB28'::text, 'ร้านใหม่'::text, $1::uuid, null::text, null::text, 1::smallint, null::text, 'active'::public.shop_status, 'BMFD-0309'::text)",
    [zone.rows[0].id],
  );

  await assert.rejects(
    db.query(
      "select public.save_shop($1::uuid, 'BB27'::text, 'ร้านเดิม'::text, $2::uuid, null::text, null::text, 1::smallint, null::text, 'active'::public.shop_status, 'BMFD-0309'::text)",
      [oldShop.rows[0].id, zone.rows[0].id],
    ),
    /รหัสล็อกนี้มีร้านที่ใช้งานอยู่แล้ว/,
  );
});

test('direct writes remain protected while blank active stall codes stay optional', async (t) => {
  const db = await createDatabase(t);
  await importRows(db, [row({ shopCode: 'BB27', governmentShopCode: 'BMFD-0309' })]);
  const zone = await db.query("select id from public.building_zones where code = 'DOME-1'");

  await db.query(
    "insert into public.shops (code, name, zone_id, government_shop_code, normal_rounds_per_day, status) values ('BB28', 'ไม่มีรหัส', $1, null, 1, 'active'), ('BB29', 'รหัสว่าง', $1, '   ', 1, 'active')",
    [zone.rows[0].id],
  );
  await assert.rejects(
    db.query(
      "insert into public.shops (code, name, zone_id, government_shop_code, normal_rounds_per_day, status) values ('BB30', 'ร้านซ้ำ', $1, ' bmfd-0309 ', 1, 'active')",
      [zone.rows[0].id],
    ),
    /รหัสล็อกนี้มีร้านที่ใช้งานอยู่แล้ว|duplicate key/i,
  );
});

test('shop import rejects final active stall conflicts atomically', async (t) => {
  const db = await createDatabase(t);
  await importRows(db, [row({ shopCode: 'BB27', governmentShopCode: 'BMFD-0309' })]);

  await assert.rejects(importRows(db, [
    row({ shopCode: 'BB28', governmentShopCode: 'BMFD-0310', shopName: 'ร้านหนึ่ง' }),
    row({ shopCode: 'BB29', governmentShopCode: ' bmfd-0310 ', shopName: 'ร้านสอง' }),
  ]), /รหัสล็อก BMFD-0310 มีร้านที่ใช้งานอยู่แล้ว/);
  await assert.rejects(importRows(db, [
    row({ shopCode: 'BB28', governmentShopCode: 'BMFD-0309' }),
  ]), /รหัสล็อก BMFD-0309 มีร้านที่ใช้งานอยู่แล้ว/);

  const shops = await db.query('select code from public.shops order by code');
  assert.deepEqual(shops.rows, [{ code: 'BB27' }]);
});

test('shop import performs an inactive-to-active stall handover regardless of row order', async (t) => {
  const db = await createDatabase(t);
  await importRows(db, [row({ shopCode: 'BB27', governmentShopCode: 'BMFD-0309' })]);

  await importRows(db, [
    row({ shopCode: 'BB28', governmentShopCode: 'bmfd-0309', shopName: 'ร้านใหม่', status: 'active' }),
    row({ shopCode: 'BB27', governmentShopCode: 'BMFD-0309', shopName: 'ร้านเดิม', status: 'inactive' }),
  ]);

  const shops = await db.query("select code, status from public.shops where upper(trim(government_shop_code)) = 'BMFD-0309' order by code");
  assert.deepEqual(shops.rows, [
    { code: 'BB27', status: 'inactive' },
    { code: 'BB28', status: 'active' },
  ]);
});

test('shop import processes multi-stall handovers in a stable lock order', async (t) => {
  const db = await createDatabase(t);
  await importRows(db, [
    row({ shopCode: 'BB27', governmentShopCode: 'BMFD-0309' }),
    row({ shopCode: 'BB28', governmentShopCode: 'BMFD-0310' }),
  ]);
  await db.exec(`
    create table shop_write_order (
      sequence_no bigint generated always as identity primary key,
      shop_code text not null,
      shop_status public.shop_status not null
    );
    create function record_shop_write_order()
    returns trigger
    language plpgsql
    as $$
    begin
      insert into shop_write_order (shop_code, shop_status)
      values (new.code, new.status);
      return new;
    end;
    $$;
    create trigger shops_record_write_order
      after insert or update on public.shops
      for each row execute function record_shop_write_order();
  `);

  await importRows(db, [
    row({ shopCode: 'BB30', governmentShopCode: 'BMFD-0310', shopName: 'ร้านใหม่ Y', status: 'active' }),
    row({ shopCode: 'BB28', governmentShopCode: 'BMFD-0310', shopName: 'ร้านเดิม Y', status: 'inactive' }),
    row({ shopCode: 'BB29', governmentShopCode: 'BMFD-0309', shopName: 'ร้านใหม่ X', status: 'active' }),
    row({ shopCode: 'BB27', governmentShopCode: 'BMFD-0309', shopName: 'ร้านเดิม X', status: 'inactive' }),
  ]);

  const writes = await db.query(`
    select shop_code, shop_status as status
    from shop_write_order
    order by sequence_no
  `);
  assert.deepEqual(writes.rows, [
    { shop_code: 'BB27', status: 'inactive' },
    { shop_code: 'BB28', status: 'inactive' },
    { shop_code: 'BB29', status: 'active' },
    { shop_code: 'BB30', status: 'active' },
  ]);
});

test('a replacement shop receives a new identity without inheriting old shop settings', async (t) => {
  const db = await createDatabase(t);
  await importRows(db, [row({ shopCode: 'BB27', governmentShopCode: 'BMFD-0309', status: 'inactive' })]);
  await db.exec(`
    create table public.shop_payment_profiles (shop_id uuid primary key, profile text not null);
    create table public.shop_special_prices (shop_id uuid not null, price numeric not null);
    create table public.shop_rented_tanks (shop_id uuid not null, tank_code text not null);
    insert into public.shop_payment_profiles select id, 'credit' from public.shops where code = 'BB27';
    insert into public.shop_special_prices select id, 42 from public.shops where code = 'BB27';
    insert into public.shop_rented_tanks select id, 'T-OLD' from public.shops where code = 'BB27';
  `);
  const zone = await db.query("select id from public.building_zones where code = 'DOME-1'");
  const oldShop = await db.query("select id from public.shops where code = 'BB27'");

  const created = await db.query(
    "select public.save_shop(null::uuid, 'BB28'::text, 'ร้านใหม่'::text, $1::uuid, null::text, null::text, 1::smallint, null::text, 'active'::public.shop_status, 'BMFD-0309'::text) as id",
    [zone.rows[0].id],
  );
  assert.notEqual(created.rows[0].id, oldShop.rows[0].id);

  const inherited = await db.query(`
    select
      (select count(*)::integer from public.shop_payment_profiles where shop_id = $1) as payment_profiles,
      (select count(*)::integer from public.shop_special_prices where shop_id = $1) as special_prices,
      (select count(*)::integer from public.shop_rented_tanks where shop_id = $1) as rented_tanks
  `, [created.rows[0].id]);
  assert.deepEqual(inherited.rows[0], { payment_profiles: 0, special_prices: 0, rented_tanks: 0 });
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
