import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const migration = read('supabase/migrations/0013_shop_rented_tanks.sql');
const ADMIN_ID = '10000000-0000-4000-8000-000000000001';
const FIRST_SHOP_ID = '20000000-0000-4000-8000-000000000001';
const SECOND_SHOP_ID = '20000000-0000-4000-8000-000000000002';

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role authenticated;
    create schema auth;
    create schema storage;
    create type public.app_role as enum ('courier', 'round_lead', 'admin');

    create function auth.uid() returns uuid language sql stable
    as $$ select '${ADMIN_ID}'::uuid $$;
    create function public.is_active_user() returns boolean language sql stable
    as $$ select true $$;
    create function public.current_app_role() returns public.app_role language sql stable
    as $$ select 'admin'::public.app_role $$;
    create function public.set_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at = now(); return new; end;
    $$;

    create table public.users (id uuid primary key);
    create table public.shops (id uuid primary key, name text not null);
    create table public.audit_logs (
      id uuid primary key default gen_random_uuid(),
      actor_id uuid not null,
      entity_type text not null,
      entity_id uuid not null,
      action text not null,
      before_value jsonb,
      after_value jsonb,
      reason text,
      occurred_at timestamptz not null default now()
    );
    create function public.audit_row_update() returns trigger language plpgsql as $$
    begin
      insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_value, after_value)
      values (auth.uid(), tg_table_name, new.id, 'updated', to_jsonb(old), to_jsonb(new));
      return new;
    end;
    $$;

    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null references storage.buckets(id),
      name text not null
    );

    insert into public.users (id) values ('${ADMIN_ID}');
    insert into public.shops (id, name) values
      ('${FIRST_SHOP_ID}', 'ร้านหนึ่ง'),
      ('${SECOND_SHOP_ID}', 'ร้านสอง');
  `);
  await db.exec(migration);
  return db;
}

test('rented tank quantity is derived from active code and photo records', () => {
  const migration = read('supabase/migrations/0013_shop_rented_tanks.sql');

  assert.match(migration, /create table public\.shop_rented_tanks/);
  assert.match(migration, /tank_code text not null/);
  assert.match(migration, /image_path text not null/);
  assert.match(migration, /where returned_at is null/);
  assert.match(migration, /unique index shop_rented_tanks_active_code_uidx/);
  assert.doesNotMatch(migration, /rented_tank_count|tank_quantity/);
});

test('only admins register or return tanks and return preserves history', () => {
  const migration = read('supabase/migrations/0013_shop_rented_tanks.sql');

  assert.match(migration, /create or replace function public\.register_shop_rented_tank/);
  assert.match(migration, /create or replace function public\.return_shop_rented_tank/);
  assert.match(migration, /current_app_role\(\) <> 'admin'/);
  assert.match(migration, /set returned_at = now\(\), returned_by = auth\.uid\(\)/);
  assert.doesNotMatch(migration, /delete from public\.shop_rented_tanks/);
});

test('shop settings requires a tank code and photo and shows the active count', () => {
  const component = read('src/ShopSettings.tsx');

  assert.match(component, /register_shop_rented_tank/);
  assert.match(component, /return_shop_rented_tank/);
  assert.match(component, /createSignedUrl\(tank\.image_path/);
  assert.match(component, /ถังเช่า \{activeShopTanks\.length\} ใบ/);
  assert.match(component, /กรุณาระบุรหัสถังและเลือกรูปถังให้ครบ/);
});

test('a returned code can be rented to another shop without deleting its history', async (t) => {
  const db = await createDatabase(t);
  const first = await db.query(
    'select public.register_shop_rented_tank($1::uuid, $2::text, $3::text) as id',
    [FIRST_SHOP_ID, 'tank-01', `${FIRST_SHOP_ID}/first.jpg`],
  );

  await assert.rejects(
    db.query(
      'select public.register_shop_rented_tank($1::uuid, $2::text, $3::text)',
      [SECOND_SHOP_ID, 'TANK-01', `${SECOND_SHOP_ID}/duplicate.jpg`],
    ),
  );

  await db.query('select public.return_shop_rented_tank($1::uuid)', [first.rows[0].id]);
  await db.query(
    'select public.register_shop_rented_tank($1::uuid, $2::text, $3::text)',
    [SECOND_SHOP_ID, 'tank-01', `${SECOND_SHOP_ID}/second.jpg`],
  );

  const rows = await db.query(`
    select shop_id, tank_code, returned_at is null as active
    from public.shop_rented_tanks
    order by created_at, shop_id
  `);
  assert.deepEqual(rows.rows, [
    { shop_id: FIRST_SHOP_ID, tank_code: 'TANK-01', active: false },
    { shop_id: SECOND_SHOP_ID, tank_code: 'TANK-01', active: true },
  ]);
});
