import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0143_accounting_shop_summary.sql', import.meta.url),
  'utf8',
);

test('shop summary attributes payments to selected-period invoices through active allocations', () => {
  assert.match(migration, /charge\.service_date between p_from_date and p_to_date/);
  assert.match(migration, /payment_allocation\.charge_id = charge\.id\s+and payment\.status = 'active'/);
  assert.match(migration, /sum\(charge\.paid_amount\)/);
});

test('cash received KPI follows receipt date independently of invoice service date', () => {
  assert.match(
    migration,
    /payment\.recorded_at >= p_from_date::timestamp at time zone 'Asia\/Bangkok'/,
  );
  assert.match(
    migration,
    /payment\.recorded_at < \(p_to_date \+ 1\)::timestamp at time zone 'Asia\/Bangkok'/,
  );
  assert.match(migration, /'cash_received_in_period'/);
  assert.doesNotMatch(
    migration.match(/received_in_period as \([\s\S]*?\n  \)\n  select/)?.[0] ?? '',
    /charge\.service_date between p_from_date and p_to_date/,
  );
});

test('shop status prioritizes overdue balances before outstanding and paid', () => {
  assert.match(migration, /when row\.overdue_amount > 0 then 'overdue'/);
  assert.match(migration, /when row\.outstanding_amount > 0 then 'outstanding'/);
  assert.match(migration, /else 'paid'/);
});

test('paged shop rows preserve business ordering inside the JSON aggregate', () => {
  assert.match(
    migration,
    /jsonb_agg\(to_jsonb\(row\) order by\s+case row\.payment_status[\s\S]*?row\.shop_id\s*\)/,
  );
});

test('building-filtered cash partitions immutable receipt snapshot allocations', () => {
  const received = migration.match(/received_in_period as \([\s\S]*?\n  \)\n  select/)?.[0] ?? '';

  assert.match(received, /public\.payment_receipt_snapshots/);
  assert.match(received, /jsonb_array_elements/);
  assert.match(
    received,
    /receipt_charge_record\.charge_number = receipt_charge\.value ->> 'charge_number'/,
  );
  assert.match(received, /receipt_stop\.building_id_snapshot::text/);
  assert.doesNotMatch(received, /receipt_charge_record\.(status|service_date|payment_term)/);
  assert.doesNotMatch(received, /receipt_event\.status/);
});

test('invoice detail filters the summary invoice cohort and returns correction evidence', () => {
  const detail = migration.match(
    /create or replace function public\.get_accounting_shop_invoice_detail[\s\S]*?\n\$\$;/,
  )?.[0] ?? '';

  assert.match(detail, /charge\.shop_id = p_shop_id/);
  assert.match(detail, /charge\.service_date between p_from_date and p_to_date/);
  assert.match(detail, /charge\.status = 'active'/);
  assert.match(detail, /event\.status = 'active'/);
  assert.match(detail, /charge\.payment_term::text = p_filters ->> 'payment_term'/);
  assert.match(detail, /stop\.building_id_snapshot::text = p_filters ->> 'building_id'/);
  assert.match(detail, /current_shop\.zone_id::text = p_filters ->> 'zone_id'/);
  assert.doesNotMatch(detail, /p_filters ->> 'payment_status'/);
  assert.match(detail, /adjustment\.status = 'active'/);
  assert.match(detail, /payment\.status = 'active'/);
  assert.match(detail, /invoice\.service_date desc, invoice\.recorded_at desc/);
});

test('summary exposes current and historical zone fields explicitly', () => {
  assert.match(migration, /current_shop\.zone_id as current_zone_id/);
  assert.match(migration, /current_zone\.name as current_zone_name/);
  assert.match(migration, /stop\.floor_or_zone_snapshot as historical_zone_name/);
  assert.match(migration, /row\.current_zone_id::text = p_filters ->> 'zone_id'/);
});

test('PostgREST reload follows both RPC definitions and grants', () => {
  const notifyAt = migration.lastIndexOf("notify pgrst, 'reload schema'");
  const detailDefinitionAt = migration.lastIndexOf(
    'create or replace function public.get_accounting_shop_invoice_detail',
  );
  const detailGrantAt = migration.lastIndexOf(
    'grant execute on function public.get_accounting_shop_invoice_detail',
  );

  assert.ok(detailDefinitionAt >= 0);
  assert.ok(detailGrantAt > detailDefinitionAt);
  assert.ok(notifyAt > detailGrantAt);
  assert.equal(migration.match(/notify pgrst, 'reload schema'/g)?.length, 1);
});
