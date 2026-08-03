import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0121_disable_daily_stock_refill.sql', import.meta.url),
  'utf8',
);

test('new free-refill records are disabled without removing legacy recovery', () => {
  assert.match(
    migration,
    /revoke execute on function public\.record_daily_stock_refill\(date, jsonb, text, uuid\)\s+from public, anon, authenticated;/,
  );
  assert.doesNotMatch(migration, /revoke execute on function public\.get_daily_stock_refill_history/);
  assert.doesNotMatch(migration, /revoke execute on function public\.cancel_daily_stock_refill/);
});
