import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0060_recoverable_collection_balances.sql', import.meta.url),
  'utf8',
);

test('collection runs can recover active immediate and end-of-day balances from prior service dates', () => {
  assert.match(migration, /charge\.payment_term not in \('immediate', 'end_of_day'\)/);
  assert.match(migration, /where charge\.payment_term in \('immediate', 'end_of_day'\)/);
  assert.doesNotMatch(migration, /charge\.service_date = v_collection_service_date/);
  assert.match(migration, /'service_date', charge\.service_date/);
  assert.match(migration, /'payment_term', charge\.payment_term/);
});

test('collection access remains limited to an assigned, open collection run', () => {
  assert.match(migration, /run\.status = 'open'/);
  assert.match(migration, /public\.is_collection_run_member\(run\.id\)/);
  assert.match(migration, /outside the caller''s assigned collection scope/);
});
