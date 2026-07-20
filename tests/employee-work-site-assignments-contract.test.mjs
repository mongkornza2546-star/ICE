import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0032_employee_work_site_assignments.sql', import.meta.url),
  'utf8',
);

test('employee work-site assignments are many-to-many and separate from stock ownership', () => {
  assert.match(migration, /create table public\.employee_work_site_assignments/);
  assert.match(migration, /primary key \(user_id, stock_location_id\)/);
  assert.match(migration, /location\.kind = 'work_site'/);
  assert.doesNotMatch(migration, /update public\.stock_locations[\s\S]*assigned_user_id/);
});

test('saving a user and work sites is admin-only, validated, atomic, and audited', () => {
  assert.match(migration, /create or replace function public\.save_user_with_work_site_assignments/);
  assert.match(migration, /public\.current_app_role\(\) <> 'admin'/);
  assert.match(migration, /location\.kind = 'work_site'[\s\S]*location\.is_active/);
  assert.match(migration, /update public\.users[\s\S]*delete from public\.employee_work_site_assignments[\s\S]*insert into public\.employee_work_site_assignments/);
  assert.match(migration, /'employee_work_site_assignments'[\s\S]*v_before_assignments, v_after_assignments/);
  assert.match(migration, /grant execute on function public\.save_user_with_work_site_assignments/);
});
