import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const activeShopsMigration = readFileSync(
  new URL('../supabase/migrations/0144_accounting_all_active_shops.sql', import.meta.url),
  'utf8',
);
const areaGroupsMigration = readFileSync(
  new URL('../supabase/migrations/0145_accounting_shop_summary_area_groups.sql', import.meta.url),
  'utf8',
);
const summaryDefinition = areaGroupsMigration.match(
  /create or replace function public\.get_accounting_shop_summary[\s\S]*?\n\$\$;/,
)?.[0] ?? '';
const detailDefinition = activeShopsMigration.match(
  /create or replace function public\.get_accounting_shop_invoice_detail[\s\S]*?\n\$\$;/,
)?.[0] ?? '';

test('latest shop summary starts from the active registry without daily shop outcomes', () => {
  assert.match(summaryDefinition, /from public\.shops shop[\s\S]*?where shop\.status = 'active'/);
  assert.match(summaryDefinition, /left join charge_rows charge on charge\.shop_id = shop\.shop_id/);
  assert.doesNotMatch(summaryDefinition, /shop_daily_outcomes|no_purchase/);
});

test('latest shop summary uses current locations and cumulative financial status', () => {
  assert.match(summaryDefinition, /shop\.building_id/);
  assert.match(summaryDefinition, /shop\.zone_id as current_zone_id/);
  assert.match(summaryDefinition, /cumulative_outstanding_amount/);
  assert.match(summaryDefinition, /cumulative_overdue_amount/);
  assert.match(summaryDefinition, /oldest_outstanding_due_date/);
  assert.match(summaryDefinition, /when row\.cumulative_overdue_amount > 0 then 'overdue'/);
  assert.doesNotMatch(summaryDefinition, /building_id_snapshot::text = p_filters/);
});

test('shop summary attributes payments to selected-period invoices through active allocations', () => {
  assert.match(areaGroupsMigration, /charge\.service_date between p_from_date and p_to_date as is_period/);
  assert.match(areaGroupsMigration, /payment_allocation\.charge_id = charge\.charge_id\s+and payment\.status = 'active'/);
  assert.match(areaGroupsMigration, /sum\(charge\.paid_amount\) filter \(where charge\.is_period\)/);
});

test('cash received KPI follows receipt date independently of invoice service date', () => {
  assert.match(
    areaGroupsMigration,
    /payment\.recorded_at >= p_from_date::timestamp at time zone 'Asia\/Bangkok'/,
  );
  assert.match(
    areaGroupsMigration,
    /payment\.recorded_at < \(p_to_date \+ 1\)::timestamp at time zone 'Asia\/Bangkok'/,
  );
  const received = areaGroupsMigration.match(
    /received_in_period as \([\s\S]*?\n  \)\n  select/,
  )?.[0] ?? '';
  assert.match(received, /join public\.shops shop on shop\.id = payment\.shop_id/);
  assert.doesNotMatch(received, /join base_shops/);
});

test('shop status still derives from cumulative financial state', () => {
  assert.match(activeShopsMigration, /when row\.cumulative_overdue_amount > 0 then 'overdue'/);
  assert.match(activeShopsMigration, /when row\.cumulative_outstanding_amount > 0 then 'outstanding'/);
  assert.match(activeShopsMigration, /else 'paid'/);
});

test('default shop ordering follows configured area and delivery sequence', () => {
  assert.match(summaryDefinition, /v_shop_sort text := coalesce[\s\S]*?'area'/);
  assert.match(summaryDefinition, /shop\.delivery_sequence/);
  assert.match(summaryDefinition, /row\.building_sort_order[\s\S]*?row\.zone_sort_order[\s\S]*?row\.delivery_sequence end nulls last[\s\S]*?row\.shop_code/);
  assert.match(summaryDefinition, /to_jsonb\(row\) - 'sort_position'[\s\S]*?order by row\.sort_position/);
  assert.match(areaGroupsMigration, /create unique index if not exists shops_active_zone_delivery_sequence_uidx/);
  assert.match(areaGroupsMigration, /ensure_daily_delivery_round_before_area_order[\s\S]*?shop\.delivery_sequence nulls last/);
});

test('shop summary exposes complete grouped totals and validates alternate sorts', () => {
  assert.match(summaryDefinition, /v_shop_sort not in \('area', 'outstanding', 'overdue', 'sales', 'name', 'code'\)/);
  assert.match(summaryDefinition, /'groups'[\s\S]*?total_shop_count[\s\S]*?purchased_shop_count[\s\S]*?not_recorded_shop_count/);
  assert.match(summaryDefinition, /period_activity_status/);
});

test('building order is configurable and new buildings append by default', () => {
  assert.match(areaGroupsMigration, /add column if not exists sort_order integer/);
  assert.match(areaGroupsMigration, /next_building_sort_order/);
  assert.match(areaGroupsMigration, /set default public\.next_building_sort_order\(\)/);
  assert.match(areaGroupsMigration, /buildings_sort_order_unique[\s\S]*?deferrable initially immediate/);
  assert.match(areaGroupsMigration, /save_building_settings[\s\S]*?pg_advisory_xact_lock[\s\S]*?set constraints buildings_sort_order_unique deferred/);
});

test('zone facets are unambiguous globally and scoped after choosing a building', () => {
  assert.match(summaryDefinition, /then concat_ws\(' \/ ', building_name, zone_name\)/);
  assert.match(
    summaryDefinition,
    /where nullif\(p_filters ->> 'building_id', ''\) is null\s+or building_id::text = p_filters ->> 'building_id'/,
  );
});

test('invoice detail includes period invoices and open invoices outside the period', () => {
  assert.match(detailDefinition, /charge\.shop_id = p_shop_id/);
  assert.match(detailDefinition, /charge\.status = 'active'/);
  assert.match(detailDefinition, /event\.status = 'active'/);
  assert.match(detailDefinition, /invoice\.service_date between p_from_date and p_to_date\s+or invoice\.total_amount > invoice\.allocated_amount/);
  assert.match(detailDefinition, /adjustment\.status = 'active'/);
  assert.match(detailDefinition, /payment\.status = 'active'/);
  assert.match(detailDefinition, /stop\.building_name_snapshot as building_name/);
  assert.match(detailDefinition, /stop\.floor_or_zone_snapshot as historical_zone_name/);
});

test('PostgREST reload follows both RPC definitions and grants', () => {
  const summaryDefinitionAt = activeShopsMigration.lastIndexOf(
    'create or replace function public.get_accounting_shop_summary',
  );
  const summaryGrantAt = activeShopsMigration.lastIndexOf(
    'grant execute on function public.get_accounting_shop_summary',
  );
  const detailDefinitionAt = activeShopsMigration.lastIndexOf(
    'create or replace function public.get_accounting_shop_invoice_detail',
  );
  const detailGrantAt = activeShopsMigration.lastIndexOf(
    'grant execute on function public.get_accounting_shop_invoice_detail',
  );
  const notifyAt = activeShopsMigration.lastIndexOf("notify pgrst, 'reload schema'");

  assert.ok(summaryDefinitionAt >= 0);
  assert.ok(summaryGrantAt > summaryDefinitionAt);
  assert.ok(detailDefinitionAt > summaryGrantAt);
  assert.ok(detailGrantAt > detailDefinitionAt);
  assert.ok(notifyAt > detailGrantAt);
  assert.equal(activeShopsMigration.match(/notify pgrst, 'reload schema'/g)?.length, 1);
});
