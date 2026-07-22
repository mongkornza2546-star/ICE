import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0045_normalize_legacy_app_roles.sql', import.meta.url),
  'utf8',
);

test('normalizes Thai legacy role labels before current_app_role returns an enum', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create schema auth;
    create type public.app_role as enum ('courier', 'round_lead', 'admin');
    create table public.users (
      id uuid primary key,
      role text not null default 'courier',
      is_active boolean not null default true
    );
    insert into public.users (id, role) values
      ('10000000-0000-4000-8000-000000000001', 'หัวหน้างาน'),
      ('10000000-0000-4000-8000-000000000002', 'พนักงานส่งน้ำแข็ง'),
      ('10000000-0000-4000-8000-000000000003', 'ผู้ดูแลระบบ');
    create function auth.uid() returns uuid language sql stable as
      $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
  `);

  await db.exec(migration);

  const result = await db.query(`
    select
      public.current_app_role()::text as current_role,
      (select role::text from public.users where id = '10000000-0000-4000-8000-000000000002') as courier_role,
      (select role::text from public.users where id = '10000000-0000-4000-8000-000000000003') as admin_role,
      (select atttypid::regtype::text
       from pg_attribute
       where attrelid = 'public.users'::regclass and attname = 'role' and not attisdropped) as role_type;
  `);

  assert.deepEqual(result.rows[0], {
    current_role: 'round_lead',
    courier_role: 'courier',
    admin_role: 'admin',
    role_type: 'app_role',
  });
});
