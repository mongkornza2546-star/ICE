import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const activeShopsMigration = readFileSync(
  new URL('../supabase/migrations/0144_accounting_all_active_shops.sql', import.meta.url),
  'utf8',
);
const summaryDefinition = activeShopsMigration.match(
  /create or replace function public\.get_accounting_shop_summary[\s\S]*?\n\$\$;/,
)?.[0] ?? '';
const detailDefinition = activeShopsMigration.match(
  /create or replace function public\.get_accounting_shop_invoice_detail[\s\S]*?\n\$\$;/,
)?.[0] ?? '';

test('latest shop summary starts from the active registry without daily shop outcomes', () => {
  assert.match(summaryDefinition, /from public\.shops shop[\s\S]*?where shop\.status = 'active'/);
  assert.match(summaryDefinition, /left join charge_rows charge on charge\.shop_id = shop\.shop_id/);
  assert.doesNotMatch(summaryDefinition, /shop_daily_outcomes|no_purchase|not_recorded/);
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
  assert.match(activeShopsMigration, /charge\.service_date between p_from_date and p_to_date as is_period/);
  assert.match(activeShopsMigration, /payment_allocation\.charge_id = charge\.charge_id\s+and payment\.status = 'active'/);
  assert.match(activeShopsMigration, /sum\(charge\.paid_amount\) filter \(where charge\.is_period\)/);
});

test('cash received KPI follows receipt date independently of invoice service date', () => {
  assert.match(
    activeShopsMigration,
    /payment\.recorded_at >= p_from_date::timestamp at time zone 'Asia\/Bangkok'/,
  );
  assert.match(
    activeShopsMigration,
    /payment\.recorded_at < \(p_to_date \+ 1\)::timestamp at time zone 'Asia\/Bangkok'/,
  );
  const received = activeShopsMigration.match(
    /received_in_period as \([\s\S]*?\n  \)\n  select/,
  )?.[0] ?? '';
  assert.match(received, /join public\.shops shop on shop\.id = payment\.shop_id/);
  assert.doesNotMatch(received, /join base_shops/);
});

test('shop status prioritizes overdue balances before outstanding and paid', () => {
  assert.match(activeShopsMigration, /when row\.cumulative_overdue_amount > 0 then 'overdue'/);
  assert.match(activeShopsMigration, /when row\.cumulative_outstanding_amount > 0 then 'outstanding'/);
  assert.match(activeShopsMigration, /else 'paid'/);
});

test('paged shop rows preserve business ordering inside the JSON aggregate', () => {
  assert.match(
    activeShopsMigration,
    /jsonb_agg\(to_jsonb\(row\) order by\s+case row\.payment_status[\s\S]*?row\.shop_id\s*\)/,
  );
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
