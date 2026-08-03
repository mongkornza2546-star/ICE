import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0117_collection_queue_charge_items.sql', import.meta.url),
  'utf8',
);

test('collection queue returns item quantities grouped under every bill', () => {
  assert.match(migration, /function public\.get_collection_run_queue/);
  assert.match(migration, /'items', coalesce/);
  assert.match(migration, /where item\.delivery_event_id = charge\.delivery_event_id/);
  assert.match(migration, /'quantity', item\.quantity/);
  assert.match(migration, /order by charge\.service_date, charge\.created_at, charge\.id/);
});
