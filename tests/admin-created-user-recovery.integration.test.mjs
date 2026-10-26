import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requestId = '11111111-1111-4111-8111-111111111111';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workSiteId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const migration = readFileSync(new URL('../supabase/migrations/0261_admin_created_user_recovery.sql', import.meta.url), 'utf8');

test('admin account recovery is read-only, scoped to the creation request, and service-only', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create role service_role;
    create table auth.users (id uuid primary key, email text unique, raw_app_meta_data jsonb, encrypted_password text);
    create table public.users (id uuid primary key references auth.users(id), display_name text, nickname text, is_active boolean);
    create table public.employee_work_site_assignments (user_id uuid references public.users(id), stock_location_id uuid);
  `);
  await db.exec(migration);
  await db.query('insert into auth.users values ($1, $2, $3::jsonb, $4)', [
    userId, actorId.replaceAll('-', '') + requestId.replaceAll('-', '') + '@staff.ice-delivery.invalid',
    JSON.stringify({ created_by_admin: actorId, creation_request_id: requestId }), 'secret-password-hash',
  ]);
  await db.query('insert into public.users values ($1, $2, null, false)', [userId, 'Pending employee']);
  const lookup = async (actor = actorId, request = requestId) => (
    await db.query('select public.get_admin_created_user($1::uuid, $2::uuid) as result', [actor, request])
  ).rows[0].result;

  await t.test('recovers an inactive account before its nickname has been saved', async () => {
    await db.exec('set role service_role');
    assert.deepEqual(await lookup(), {
      user: { id: userId, display_name: 'Pending employee', nickname: null, is_active: false }, work_site_ids: [],
    });
    await db.exec('reset role');
  });

  await t.test('returns current profile and assignments without exposing Auth credentials', async () => {
    await db.query("update public.users set display_name = 'Edited later', nickname = 'ree', is_active = true where id = $1", [userId]);
    await db.query('insert into public.employee_work_site_assignments values ($1, $2)', [userId, workSiteId]);
    await db.exec('set role service_role');
    const result = await lookup();
    assert.equal(result.user.display_name, 'Edited later');
    assert.deepEqual(result.work_site_ids, [workSiteId]);
    assert.equal(JSON.stringify(result).includes('secret-password-hash'), false);
    assert.equal('email' in result.user, false);
    await db.exec('reset role');
  });

  await t.test('cannot recover a different admin request or an unrelated account with the same email', async () => {
    assert.equal(await lookup(userId, requestId), null);
    assert.equal(await lookup(actorId, userId), null);
    await db.query("update auth.users set raw_app_meta_data = '{}'::jsonb where id = $1", [userId]);
    assert.equal(await lookup(), null);
  });

  await t.test('denies anonymous and authenticated callers even if they know both IDs', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(lookup(), /permission denied for function get_admin_created_user/);
      await db.exec('reset role');
    }
  });
});
