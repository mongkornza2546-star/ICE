import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0133_payment_correction_targets.sql', import.meta.url),
  'utf8',
);

test('payment correction targets are manager-only current fully paid charges', () => {
  assert.match(migration, /create function public\.get_payment_correction_targets\(p_payment_id uuid\)/);
  assert.match(migration, /Only a round lead or admin can view payment correction targets/);
  assert.match(migration, /from public\.payment_allocations target_allocation/);
  assert.match(migration, /charge\.status = 'active'/);
  assert.match(migration, /event\.status = 'active'/);
  assert.match(migration, /newer\.round_stop_id = event\.round_stop_id and newer\.status = 'active'/);
  assert.match(migration, /balance\.allocated_amount >= public\.effective_delivery_charge_amount\(charge\.id\)/);
  assert.match(migration, /with recursive event_lineage/);
  assert.match(migration, /obligation\.status = 'pending'/);
  assert.match(migration, /grant execute on function public\.get_payment_correction_targets\(uuid\) to authenticated/);
});
