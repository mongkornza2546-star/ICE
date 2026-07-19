import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0020_reset_application_data_except_users.sql', import.meta.url),
  'utf8',
);

test('test-data reset preserves users but clears application data and uploaded images', () => {
  assert.match(migration, /create or replace function public\.reset_application_data_except_users\(p_confirmation text\)/);
  assert.match(migration, /current_app_role\(\) <> 'admin'/);
  assert.match(migration, /p_confirmation <> 'RESET ALL TEST DATA'/);
  assert.match(migration, /delete from storage\.objects[\s\S]*bucket_id in \('shop-images', 'tank-images'\)/);
  assert.match(migration, /schemaname = 'public'[\s\S]*tablename <> 'users'/);
  assert.match(migration, /truncate table .* restart identity/);
  assert.match(migration, /grant execute on function public\.reset_application_data_except_users\(text\) to authenticated/);
  assert.doesNotMatch(migration, /delete from public\.users/);
  assert.doesNotMatch(migration, /delete from auth\.users/);
});
