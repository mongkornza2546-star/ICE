import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0141_employee_withdrawn_balances.sql', import.meta.url),
  'utf8',
);

test('employee stock state separates gross withdrawals from the remaining balance', () => {
  assert.match(migration, /create or replace function public\.get_employee_stock_state\(p_round_id uuid\)/);
  assert.match(migration, /'withdrawn_balances'/);
  assert.match(migration, /source\.id = movement\.from_location_id/);
  assert.match(migration, /source\.kind = 'truck'/);
  assert.match(migration, /movement\.to_location_id = v_holding_location_id/);
  assert.match(migration, /movement\.status = 'active'/);
  assert.match(migration, /movement\.service_date = v_service_date/);
  assert.match(migration, /coalesce\(sum\(item\.quantity\), 0\)/);
});
