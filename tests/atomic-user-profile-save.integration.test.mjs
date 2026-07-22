import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0048_atomic_user_profile_save.sql', import.meta.url),
  'utf8',
);

const USER_ID = '10000000-0000-4000-8000-000000000001';

test('profile fields and the existing user save roll back together', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role authenticated;
    create type public.app_role as enum ('courier', 'round_lead', 'admin');
    create table public.users (
      id uuid primary key,
      display_name text not null,
      nickname text check (nickname <> 'FAIL'),
      avatar_path text,
      phone text,
      role public.app_role not null,
      is_active boolean not null
    );
    create function public.save_user_with_work_site_assignments(
      p_user_id uuid,
      p_display_name text,
      p_phone text,
      p_role public.app_role,
      p_is_active boolean,
      p_work_site_ids uuid[]
    ) returns jsonb language plpgsql as $$
    declare v_saved public.users%rowtype;
    begin
      update public.users
      set display_name = p_display_name,
          phone = p_phone,
          role = p_role,
          is_active = p_is_active
      where id = p_user_id
      returning * into v_saved;
      return jsonb_build_object('user', to_jsonb(v_saved), 'work_site_ids', to_jsonb(p_work_site_ids));
    end;
    $$;
    insert into public.users values ('${USER_ID}', 'ชื่อเดิม', null, null, null, 'courier', true);
  `);

  await db.exec(migration);

  await assert.rejects(
    db.query(
      `select public.save_user_profile_with_work_site_assignments(
        $1, 'ชื่อใหม่', null, 'courier', true, '{}'::uuid[], 'FAIL', null
      )`,
      [USER_ID],
    ),
    /check constraint/,
  );

  const afterFailure = await db.query(`select display_name, nickname from public.users where id = $1`, [USER_ID]);
  assert.deepEqual(afterFailure.rows[0], { display_name: 'ชื่อเดิม', nickname: null });

  const saved = await db.query(
    `select public.save_user_profile_with_work_site_assignments(
      $1, 'ชื่อใหม่', null, 'courier', true, '{}'::uuid[], 'ใหม่', $2
    ) as result`,
    [USER_ID, `users/${USER_ID}/avatar.png`],
  );
  assert.equal(saved.rows[0].result.user.display_name, 'ชื่อใหม่');
  assert.equal(saved.rows[0].result.user.nickname, 'ใหม่');
  assert.equal(saved.rows[0].result.user.avatar_path, `users/${USER_ID}/avatar.png`);
});
