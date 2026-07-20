import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0031_daily_stock_count_readiness.sql', import.meta.url),
  'utf8',
);

test('daily-close readiness covers every active location instead of the capped history feed', () => {
  const readinessFunction = migration.slice(
    migration.indexOf('create or replace function public.get_daily_stock_count_readiness('),
    migration.indexOf('create or replace function public.close_daily_stock_from_latest_counts('),
  );

  assert.match(readinessFunction, /from public\.stock_locations location/);
  assert.match(readinessFunction, /where location\.is_active/);
  assert.match(readinessFunction, /order by candidate\.counted_at desc, candidate\.id desc[\s\S]*limit 1/);
  assert.doesNotMatch(readinessFunction, /limit 20/);
});

test('a count becomes stale after a stock movement or delivery changes its location', () => {
  const freshnessFunction = migration.slice(
    migration.indexOf('create or replace function public.is_stock_count_snapshot_current('),
    migration.indexOf('create or replace function public.get_daily_stock_count_readiness('),
  );

  assert.match(freshnessFunction, /from public\.stock_movements movement/);
  assert.match(freshnessFunction, /coalesce\(movement\.cancelled_at, movement\.recorded_at\) > snapshot\.counted_at/);
  assert.match(freshnessFunction, /from public\.delivery_events event/);
  assert.match(freshnessFunction, /coalesce\(event\.cancelled_at, event\.recorded_at\) > snapshot\.counted_at/);
});

test('authenticated daily close derives counts under the service-date lock', () => {
  const closeFunction = migration.slice(
    migration.indexOf('create or replace function public.close_daily_stock_from_latest_counts('),
  );

  assert.match(closeFunction, /pg_advisory_xact_lock\(hashtextextended\(v_service_date::text, 0\)\)/);
  assert.match(closeFunction, /Count every active stock location again before closing daily stock/);
  assert.match(closeFunction, /public\.stock_balance_at\(v_service_date, location\.id, ice\.id\)/);
  assert.match(closeFunction, /return public\.close_daily_stock\(/);
  assert.match(migration, /revoke execute on function public\.close_daily_stock\(uuid, jsonb, text, uuid, date\) from authenticated/);
});
