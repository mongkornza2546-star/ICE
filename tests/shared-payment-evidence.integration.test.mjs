import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = (name) => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const collector = '00000000-0000-0000-0000-000000000001';
const printer = '00000000-0000-0000-0000-000000000002';
const legacy = `${collector}/legacy.pdf`;
const r2 = `${collector}/r2/transfer.webp`;
const unattached = `${collector}/r2/draft.webp`;

test('shared evidence follows payment RLS while preserving private drafts and write permissions', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role authenticated;
    create role anon;
    create schema auth;
    create schema storage;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('test.user_id', true), '')::uuid
    $$;
    create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1, '/') $$;
    create table public.users (id uuid primary key, role text, is_active boolean, can_collect_shop_payments boolean);
    insert into public.users values ('${collector}', 'courier', true, true), ('${printer}', 'courier', true, false);
    create function public.is_active_user() returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from users where id = auth.uid() and is_active)
    $$;
    create function public.current_app_role() returns text language sql stable security definer set search_path = public as $$
      select role from users where id = auth.uid() and is_active
    $$;
    create table public.payments (id uuid primary key, evidence_path text, recorded_by uuid, status text);
    insert into public.payments values
      ('10000000-0000-0000-0000-000000000001', '${legacy}', '${collector}', 'active'),
      ('10000000-0000-0000-0000-000000000002', '${r2}', '${collector}', 'voided');
    create table storage.objects (bucket_id text, name text);
    insert into storage.objects values
      ('payment-evidence', '${legacy}'), ('payment-evidence', '${r2}'),
      ('payment-evidence', '${unattached}'), ('other-bucket', '${legacy}');
    alter table public.payments enable row level security;
    alter table storage.objects enable row level security;
    grant usage on schema storage, auth to authenticated, anon;
    grant select on public.payments to authenticated;
    grant select, update, delete on storage.objects to authenticated, anon;
  `);
  await db.exec(migration('0232_shared_employee_payment_history'));
  const foundation = migration('0029_pos_financial_foundation');
  await db.exec(foundation.slice(foundation.indexOf('create policy "assigned users read payments"'),
    foundation.indexOf('create policy "assigned users read payment allocations"')));
  const storage = migration('0059_pos_financial_operations');
  await db.exec(storage.slice(storage.indexOf('create policy "payment recorders upload their evidence"'),
    storage.indexOf('alter table public.payments')));

  const files = async () => (await db.query('select name from storage.objects order by name')).rows.map(row => row.name);
  await db.exec(`set test.user_id = '${printer}'; set role authenticated;`);
  assert.deepEqual(await files(), [], 'previous storage policy hides another collector attachments');
  await db.exec('reset role');
  await db.exec(migration('0233_shared_payment_evidence'));
  await db.exec('set role authenticated');
  assert.deepEqual(await files(), [legacy, r2].sort(), 'includes voided receipts, excludes drafts and other buckets');
  assert.equal((await db.query('update storage.objects set name = name returning name')).rows.length, 0);
  assert.equal((await db.query('delete from storage.objects returning name')).rows.length, 0);

  await db.exec('reset role');
  await db.exec(`create or replace function public.is_payment_visible(target_payment_id uuid)
    returns boolean language sql stable security definer set search_path = public as $$
      select public.is_active_user() and target_payment_id = '10000000-0000-0000-0000-000000000001'::uuid
    $$; set role authenticated;`);
  assert.deepEqual(await files(), [legacy], 'a linked attachment is still hidden if its payment is not visible');
  await db.exec('reset role');
  await db.exec(migration('0232_shared_employee_payment_history'));
  await db.exec(`set test.user_id = '${collector}'; set role authenticated;`);
  assert.deepEqual(await files(), [legacy, r2, unattached].sort(), 'owners retain draft previews');
  await db.exec(`reset role; update public.users set is_active = false where id = '${collector}'; set role authenticated;`);
  assert.deepEqual(await files(), [], 'inactive owners cannot read even their own files');
  await db.exec("reset role; set test.user_id = ''; set role anon;");
  assert.deepEqual(await files(), [], 'anonymous readers cannot see evidence');
});
