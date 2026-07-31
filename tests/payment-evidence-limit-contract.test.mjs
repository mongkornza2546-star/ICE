import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0114_limit_payment_evidence_to_5mb.sql', import.meta.url),
  'utf8',
);

test('payment evidence storage enforces the 5 MB UI limit', () => {
  assert.match(migration, /file_size_limit = 5242880/);
  assert.match(migration, /where id = 'payment-evidence'/);
});
