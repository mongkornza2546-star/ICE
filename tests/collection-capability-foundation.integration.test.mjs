import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0158_collection_capability_foundation.sql', import.meta.url),
  'utf8',
);

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create role authenticated;
    create type public.app_role as enum ('courier', 'round_lead', 'admin');

    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.test_user_id', true), '')::uuid
    $$;

    create table public.users (
      id uuid primary key,
      code text not null unique,
      display_name text not null,
      nickname text,
      avatar_path text,
      phone text,
      role public.app_role not null default 'courier',
      is_active boolean not null default false
    );

    create function public.current_app_role()
    returns public.app_role language sql stable security definer set search_path = public as $$
      select role from public.users where id = auth.uid() and is_active
    $$;

    create function public.is_active_user()
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from public.users where id = auth.uid() and is_active)
    $$;

    create function public.save_user_with_work_site_assignments(
      p_user_id uuid,
      p_display_name text,
      p_phone text,
      p_role public.app_role,
      p_is_active boolean,
      p_work_site_ids uuid[]
    ) returns jsonb language plpgsql security definer set search_path = public as $$
    declare v_saved public.users%rowtype;
    begin
      if not public.is_active_user() or public.current_app_role() <> 'admin' then
        raise exception 'Only an active admin can edit users and their work sites';
      end if;
      update public.users
      set display_name = trim(p_display_name), phone = p_phone, role = p_role, is_active = p_is_active
      where id = p_user_id returning * into v_saved;
      return jsonb_build_object('user', to_jsonb(v_saved), 'work_site_ids', to_jsonb(p_work_site_ids));
    end;
    $$;

    create function public.save_user_profile_with_work_site_assignments(
      uuid, text, text, public.app_role, boolean, uuid[], text, text
    ) returns jsonb language sql as $$ select '{}'::jsonb $$;

    create table public.payments (
      id uuid primary key,
      recorded_by uuid not null references public.users(id)
    );

    insert into public.users (id, code, display_name, role, is_active) values
      ('00000000-0000-0000-0000-000000000001', 'C01', 'Courier', 'courier', true),
      ('00000000-0000-0000-0000-000000000002', 'A01', 'Admin', 'admin', true),
      ('00000000-0000-0000-0000-000000000003', 'C02', 'Inactive', 'courier', false);
    insert into public.payments (id, recorded_by) values
      ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
  `);
  await db.exec(migration);
  return db;
}

test('collection capability is opt-in for couriers and enforced by role', async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());

  const initial = await db.query('select code, can_collect_shop_payments from public.users order by code');
  assert.deepEqual(initial.rows, [
    { code: 'A01', can_collect_shop_payments: false },
    { code: 'C01', can_collect_shop_payments: false },
    { code: 'C02', can_collect_shop_payments: false },
  ]);

  await db.exec("set app.test_user_id = '00000000-0000-0000-0000-000000000001'");
  assert.equal((await db.query('select public.can_collect_shop_payments() as allowed')).rows[0].allowed, false);

  await db.exec("update public.users set can_collect_shop_payments = true where code = 'C01'");
  assert.equal((await db.query('select public.can_collect_shop_payments() as allowed')).rows[0].allowed, true);

  await db.exec("update public.users set role = 'round_lead', can_collect_shop_payments = true where code = 'C01'");
  const promoted = (await db.query("select role, can_collect_shop_payments from public.users where code = 'C01'")).rows[0];
  assert.deepEqual(promoted, { role: 'round_lead', can_collect_shop_payments: false });
  assert.equal((await db.query('select public.can_collect_shop_payments() as allowed')).rows[0].allowed, true);

  await db.exec("update public.users set role = 'courier' where code = 'C01'");
  assert.equal((await db.query("select can_collect_shop_payments from public.users where code = 'C01'")).rows[0].can_collect_shop_payments, false);

  await db.exec("set app.test_user_id = '00000000-0000-0000-0000-000000000003'");
  await db.exec("update public.users set can_collect_shop_payments = true where code = 'C02'");
  assert.equal((await db.query('select public.can_collect_shop_payments() as allowed')).rows[0].allowed, false);
});

test('v2 saves capability atomically and the legacy wrapper preserves only courier capability', async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  await db.exec("set app.test_user_id = '00000000-0000-0000-0000-000000000002'");

  await db.query(`select public.save_user_profile_with_work_site_assignments_v2(
    '00000000-0000-0000-0000-000000000001', 'Courier v2', null, 'courier', true,
    '{}'::uuid[], null, null, true
  )`);
  assert.equal((await db.query("select can_collect_shop_payments from public.users where code = 'C01'")).rows[0].can_collect_shop_payments, true);

  await db.query(`select public.save_user_profile_with_work_site_assignments(
    '00000000-0000-0000-0000-000000000001', 'Courier legacy', null, 'courier', true,
    '{}'::uuid[], null, null
  )`);
  assert.equal((await db.query("select can_collect_shop_payments from public.users where code = 'C01'")).rows[0].can_collect_shop_payments, true);

  await db.query(`select public.save_user_profile_with_work_site_assignments(
    '00000000-0000-0000-0000-000000000001', 'Promoted', null, 'round_lead', true,
    '{}'::uuid[], null, null
  )`);
  const promoted = (await db.query("select role, can_collect_shop_payments from public.users where code = 'C01'")).rows[0];
  assert.deepEqual(promoted, { role: 'round_lead', can_collect_shop_payments: false });
});

test('payment role is backfilled, server-derived on insert, and immutable', async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());

  assert.equal(
    (await db.query("select recorded_role from public.payments where id = '10000000-0000-0000-0000-000000000001'")).rows[0].recorded_role,
    'admin',
  );

  await db.exec("set app.test_user_id = '00000000-0000-0000-0000-000000000001'");
  await db.exec(`insert into public.payments (id, recorded_by, recorded_role) values (
    '10000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'admin'
  )`);
  assert.equal(
    (await db.query("select recorded_role from public.payments where id = '10000000-0000-0000-0000-000000000002'")).rows[0].recorded_role,
    'courier',
  );

  await assert.rejects(
    db.exec("update public.payments set recorded_role = 'admin' where id = '10000000-0000-0000-0000-000000000002'"),
    /recorded payment role cannot be changed/i,
  );
});

test('migration closes the lower-level authenticated save path', () => {
  assert.match(migration, /revoke all on function public\.save_user_with_work_site_assignments[\s\S]*?from public, authenticated/);
});

test('authenticated cannot inherit the lower-level save path through PUBLIC', async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  const privilege = await db.query(`select has_function_privilege(
    'authenticated',
    'public.save_user_with_work_site_assignments(uuid,text,text,public.app_role,boolean,uuid[])',
    'execute'
  ) as allowed`);
  assert.equal(privilege.rows[0].allowed, false);
});
