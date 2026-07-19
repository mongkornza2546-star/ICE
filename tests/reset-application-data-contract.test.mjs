import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const resetMigration = readFileSync(
  new URL('../supabase/migrations/0020_reset_application_data_except_users.sql', import.meta.url),
  'utf8',
);
const storageFixMigration = readFileSync(
  new URL('../supabase/migrations/0021_fix_test_data_reset_storage.sql', import.meta.url),
  'utf8',
);

test('test-data reset preserves users and uses no direct Storage deletion', () => {
  assert.match(resetMigration, /grant execute on function public\.reset_application_data_except_users\(text\) to authenticated/);
  assert.match(storageFixMigration, /create or replace function public\.reset_application_data_except_users\(p_confirmation text\)/);
  assert.match(storageFixMigration, /current_app_role\(\) <> 'admin'/);
  assert.match(storageFixMigration, /p_confirmation <> 'RESET ALL TEST DATA'/);
  assert.match(storageFixMigration, /schemaname = 'public'[\s\S]*tablename <> 'users'/);
  assert.match(storageFixMigration, /truncate table .* restart identity/);
  assert.doesNotMatch(storageFixMigration, /storage\.objects/);
  assert.doesNotMatch(storageFixMigration, /delete from public\.users/);
  assert.doesNotMatch(storageFixMigration, /delete from auth\.users/);
});
