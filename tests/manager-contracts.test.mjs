import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('delivery writes lock the same round row used by close_delivery_round', () => {
  const migration = read('supabase/migrations/0007_daily_mobile_stock.sql');
  const deliveryMigration = migration.slice(
    migration.lastIndexOf('create or replace function public.record_delivery('),
  );
  const closeMigration = read('supabase/migrations/0004_manager_round_control.sql');

  assert.match(deliveryMigration, /where s\.id = p_round_stop_id\s+for update of r;/);
  assert.match(closeMigration, /where id = p_round_id\s+for update;/);
});

test('shop location is re-derived when any location column is written', () => {
  const migration = read('supabase/migrations/0005_building_zones.sql');

  assert.match(
    migration,
    /before insert or update of zone_id, building_id, floor_or_zone on public\.shops/,
  );
  assert.match(migration, /new\.building_id := v_building_id;/);
  assert.match(migration, /new\.floor_or_zone := v_zone_name;/);
});

test('new rounds and shop settings do not depend on routes', () => {
  const migration = read('supabase/migrations/0006_rounds_without_routes.sql');
  const component = read('src/ShopSettings.tsx');
  const app = read('src/App.tsx');

  assert.match(migration, /alter column route_id drop not null/);
  assert.match(migration, /from public\.shops s/);
  assert.match(migration, /create or replace function public\.save_shop\(/);
  assert.match(component, /supabase\.rpc\('save_shop'/);
  assert.doesNotMatch(component, /route_assignments|route_shops|save_shop_with_routes/);
  assert.doesNotMatch(app, /p_route_id|routeId|routesResponse/);
});

test('manager summary rejects stale round responses before close', () => {
  const component = read('src/ManagerRoundControl.tsx');

  assert.match(component, /requestId !== summaryRequestId\.current/);
  assert.match(component, /summaryRoundId !== round\.id/);
});

test('day-wide stock movements are serialized and idempotent', () => {
  const migration = read('supabase/migrations/0007_daily_mobile_stock.sql');

  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(p_idempotency_key::text, 0\)\)/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(v_service_date::text, 0\)\)/);
  assert.match(migration, /where movement\.idempotency_key = p_idempotency_key/);
  assert.match(migration, /The source location does not have enough stock/);
});

test('stock balance includes transfers and automatic delivery deductions', () => {
  const migration = read('supabase/migrations/0007_daily_mobile_stock.sql');

  assert.match(migration, /movement\.to_location_id = p_location_id/);
  assert.match(migration, /movement\.from_location_id = p_location_id/);
  assert.match(migration, /event\.source_stock_location_id = p_location_id/);
  assert.match(migration, /before insert on public\.delivery_events/);
  assert.match(migration, /before insert or update of zone_id, building_id, stock_location_id on public\.shops/);
});

test('stock UI reuses the retry key for the same movement payload', () => {
  const component = read('src/ManagerStockControl.tsx');

  assert.match(component, /pendingRequest\.current\?\.signature !== signature/);
  assert.match(component, /const submittedRequestKey = pendingRequest\.current\.key/);
  assert.match(component, /p_idempotency_key: submittedRequestKey/);
  assert.match(component, /supabase\.rpc\('get_stock_control_summary'/);
  assert.match(component, /supabase\.rpc\('record_stock_movement'/);
});

test('delivery writes share the day stock lock and reject insufficient stock', () => {
  const migration = read('supabase/migrations/0007_daily_mobile_stock.sql');
  const deliveryOverride = migration.slice(
    migration.lastIndexOf('create or replace function public.record_delivery('),
  );

  assert.match(deliveryOverride, /pg_advisory_xact_lock\(hashtextextended\(p_idempotency_key::text, 0\)\)/);
  assert.match(deliveryOverride, /pg_advisory_xact_lock\(hashtextextended\(v_service_date::text, 0\)\)/);
  assert.match(deliveryOverride, /public\.stock_balance_at\(v_service_date, v_source_location_id, v_item\.ice_type_id\)/);
  assert.match(deliveryOverride, /The source location does not have enough stock/);
});

test('stock ledger starts with new delivery events instead of rewriting history', () => {
  const migration = read('supabase/migrations/0007_daily_mobile_stock.sql');

  assert.doesNotMatch(migration, /update public\.delivery_events event\s+set source_stock_location_id/);
  assert.doesNotMatch(migration, /alter table public\.delivery_events alter column source_stock_location_id set not null/);
  assert.match(migration, /Existing delivery events intentionally remain outside the stock ledger/);
});

test('closed rounds still allow final day stock movements', () => {
  const migration = read('supabase/migrations/0007_daily_mobile_stock.sql');
  const component = read('src/ManagerStockControl.tsx');
  const stockMovement = migration.slice(
    migration.indexOf('create or replace function public.record_stock_movement('),
    migration.indexOf('create or replace function public.record_delivery('),
  );

  assert.match(stockMovement, /p_kind = 'factory_order' and not v_day_has_open_round/);
  assert.doesNotMatch(stockMovement, /v_round_status <> 'open'/);
  assert.doesNotMatch(component, /disabled=\{submitting \|\| round\.status === 'closed'\}/);
});

test('stock UI ignores a movement response after the selected round changes', () => {
  const component = read('src/ManagerStockControl.tsx');

  assert.match(component, /activeRoundId\.current !== submittedRoundId/);
  assert.match(component, /const submittedRoundId = round\.id/);
});
