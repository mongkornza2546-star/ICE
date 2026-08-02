import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0115_collection_carry_forward_balances.sql', import.meta.url),
  'utf8',
);

test('assigned collectors see and can settle prior balances together with today charges', () => {
  assert.match(migration, /function public\.get_collection_run_queue/);
  assert.match(migration, /public\.is_collection_run_member\(run\.id\)/);
  assert.match(migration, /where charge\.payment_term in \('immediate', 'end_of_day'\)/);
  assert.doesNotMatch(migration, /where charge\.service_date =/);
  assert.match(migration, /order by charge\.service_date, charge\.created_at, charge\.id/);
  assert.match(
    migration,
    /select public\.get_collection_run_queue\(p_collection_run_id\)/,
  );
  assert.match(migration, /replace\(v_definition, v_current_day_scope, v_all_dates_scope\)/);
  assert.match(
    migration,
    /replace\([\s\S]*v_allocated_charges_outstanding,[\s\S]*v_collection_scope_outstanding/,
  );
});
