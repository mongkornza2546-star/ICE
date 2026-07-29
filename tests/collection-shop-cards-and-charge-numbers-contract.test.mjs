import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationPath = new URL(
  '../supabase/migrations/0109_collection_shop_cards_and_charge_numbers.sql',
  import.meta.url,
);

test('collection queues expose shop photos and human-readable charge references', async () => {
  const migration = await readFile(migrationPath, 'utf8');

  assert.match(migration, /add column charge_number text/);
  assert.match(migration, /C.*YYMMDD/i);
  assert.match(migration, /'image_path', queue\.image_path/);
  assert.match(migration, /'charge_number', charge\.charge_number/);
  assert.match(migration, /create or replace function public\.get_collection_run_queue/);
  assert.match(migration, /create or replace function public\.get_today_collection_run_queue/);
});
