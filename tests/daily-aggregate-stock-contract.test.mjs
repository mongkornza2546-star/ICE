import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0107_daily_aggregate_stock.sql', import.meta.url),
  'utf8',
);
const completionMigration = readFileSync(
  new URL('../supabase/migrations/0108_finish_daily_aggregate_workflow.sql', import.meta.url),
  'utf8',
);

test('POS and daily operations share one aggregate stock source', () => {
  assert.match(migration, /create or replace function public\.daily_aggregate_stock_balance_at/);
  assert.match(migration, /movement\.kind = 'factory_order'/);
  assert.match(migration, /movement\.kind in \('damage', 'return_to_factory'\)/);
  assert.match(migration, /event\.source_stock_location_id is not null/);
  assert.match(migration, /public\.daily_aggregate_stock_balance_at\(v_service_date, ice\.id\)/);
  assert.match(migration, /Daily aggregate stock is not sufficient/);
  assert.match(migration, /create or replace function public\.record_daily_stock_refill/);
  assert.match(migration, /create or replace function public\.close_daily_aggregate_stock/);
  assert.match(migration, /stock_movements_require_open_daily_aggregate_stock/);
  assert.match(migration, /before insert or update or delete on public\.stock_movements/);
  assert.match(migration, /mod\(item\.quantity, 0\.5\) <> 0/);
  assert.match(
    migration,
    /totals\.returned_quantity \+ coalesce\(closure_item\.actual_quantity, 0\)/,
  );
  assert.doesNotMatch(migration, /get_admin_delivery_truck_location_id/);
});

test('employee collection and legacy refill cancellation complete the daily workflow', () => {
  assert.match(completionMigration, /function public\.get_today_collection_run_queue/);
  assert.match(completionMigration, /charge\.service_date = v_service_date/);
  assert.match(
    completionMigration,
    /charge\.payment_term in \('immediate', 'end_of_day'\)/,
  );
  assert.match(completionMigration, /balance\.outstanding_amount > 0/);
  assert.match(
    completionMigration,
    /charge\.service_date is distinct from v_collection_service_date/,
  );
  assert.match(
    completionMigration,
    /Only a round lead or admin can view recovery collection balances/,
  );
  assert.match(completionMigration, /function public\.get_daily_stock_refill_history/);
  assert.match(completionMigration, /usage\.kind = 'refill'/);
  assert.match(completionMigration, /cancellation_reason/);
});
