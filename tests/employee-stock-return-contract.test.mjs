import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0137_employee_stock_returns.sql', import.meta.url),
  'utf8',
);

test('employee stock return is restricted and reverses the assigned-stock endpoints', () => {
  assert.match(migration, /create or replace function public\.record_employee_stock_return\(/);
  assert.match(migration, /public\.current_app_role\(\) <> 'courier'/);
  assert.match(migration, /v_state := public\.get_employee_stock_state\(p_round_id\)/);
  assert.match(migration, /jsonb_array_length\(p_items\) = 0/);
  assert.match(migration, /having count\(\*\) > 1/);
  assert.match(migration, /item\.quantity \* 2 <> trunc\(item\.quantity \* 2\)/);
  assert.doesNotMatch(migration, /quantity integer/);
  assert.match(migration, /public\.stock_balance_at\(v_service_date, v_holding_location_id, v_item\.ice_type_id\)/);
  assert.match(
    migration,
    /insert into public\.stock_movements \([\s\S]*'transfer',[\s\S]*v_holding_location_id,[\s\S]*v_truck_location_id/,
  );
  assert.match(migration, /'purpose', 'employee_return'/);
  assert.match(migration, /return public\.get_employee_stock_state\(p_round_id\)/);
});

test('employee stock return is idempotent and callable only by authenticated users', () => {
  const keyLock = migration.indexOf(
    'pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0))',
  );
  const replayLookup = migration.indexOf(
    'where movement.idempotency_key = p_idempotency_key',
  );
  const dayLock = migration.indexOf(
    'pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0))',
  );
  assert.ok(keyLock >= 0 && keyLock < replayLookup);
  assert.ok(dayLock > replayLookup);
  assert.match(migration, /v_existing_recorded_by <> auth\.uid\(\)/);
  assert.match(migration, /'operation', 'employee_stock_return'/);
  assert.match(migration, /v_existing_request_fingerprint is distinct from v_request_fingerprint/);
  assert.doesNotMatch(migration, /v_existing_(?:from|to)_location_id/);
  assert.match(
    migration,
    /revoke all on function public\.record_employee_stock_return\(uuid, jsonb, uuid\) from public/,
  );
  assert.match(
    migration,
    /grant execute on function public\.record_employee_stock_return\(uuid, jsonb, uuid\) to authenticated/,
  );
});
