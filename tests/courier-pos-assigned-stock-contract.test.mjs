import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0140_courier_pos_consumes_assigned_stock.sql', import.meta.url),
  'utf8',
);
const stockTransfer = readFileSync(
  new URL('../src/features/employee-delivery/EmployeeStockTransferSection.tsx', import.meta.url),
  'utf8',
);

test('courier POS uses assigned stock while retaining the daily aggregate guard', () => {
  assert.match(migration, /public\.current_app_role\(\) = 'courier'/);
  assert.match(migration, /public\.stock_balance_at\(v_service_date, v_source_location_id, ice\.id\)/);
  assert.match(migration, /public\.daily_aggregate_stock_balance_at\(v_service_date, ice\.id\)/);
  assert.match(migration, /Employee holding does not have enough stock/);
  assert.match(migration, /Daily aggregate stock is not sufficient/);
  assert.match(migration, /public\.apply_open_delivery_correction/);
  assert.match(migration, /v_event\.source_stock_location_id/);
});

test('employee withdrawal UI does not show the truck balance after a transfer', () => {
  assert.doesNotMatch(stockTransfer, /รถหลัง/);
});
