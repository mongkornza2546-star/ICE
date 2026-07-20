import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0029_pos_financial_foundation.sql', import.meta.url),
  'utf8',
);

test('financial foundation is additive and preserves legacy delivery rows', () => {
  assert.match(migration, /alter table public\.delivery_items[\s\S]*add column unit_price numeric\(12,2\)/);
  assert.match(migration, /unit_price is null and price_source is null and price_source_id is null/);
  assert.doesNotMatch(migration, /update public\.delivery_items[\s\S]*unit_price/i);
  assert.doesNotMatch(migration, /shops\.payment_status/);
});

test('effective prices reject overlapping active date ranges', () => {
  assert.match(
    migration,
    /create table public\.ice_type_prices[\s\S]*exclude using gist \([\s\S]*ice_type_id with =[\s\S]*daterange\([\s\S]*with &&[\s\S]*where \(is_active\)/,
  );
  assert.match(
    migration,
    /create table public\.shop_ice_type_prices[\s\S]*exclude using gist \([\s\S]*shop_id with =[\s\S]*ice_type_id with =[\s\S]*daterange\([\s\S]*with &&[\s\S]*where \(is_active\)/,
  );
});

test('payment profiles keep defaults valid and credit exclusive', () => {
  assert.match(migration, /default_payment_term = any\(allowed_payment_terms\)/);
  assert.match(migration, /default_payment_method = any\(allowed_payment_methods\)/);
  assert.match(migration, /when 'credit' = any\(allowed_payment_terms\)[\s\S]*cardinality\(allowed_payment_terms\) = 1/);
  assert.match(migration, /credit_due_rule = 'net_days' and credit_days > 0/);
  assert.match(migration, /credit_due_rule = 'end_of_month' and credit_days is null/);
});

test('financial status is derived from active allocations', () => {
  assert.match(migration, /create view public\.delivery_charge_balances/);
  assert.match(migration, /sum\(allocation\.amount\) filter \(where payment\.status = 'active'\)/);
  assert.match(migration, /then 'unpaid'::public\.financial_payment_status/);
  assert.match(migration, /then 'partial'::public\.financial_payment_status/);
  assert.match(migration, /else 'paid'::public\.financial_payment_status/);
});

test('all financial tables enable RLS with role-scoped visibility', () => {
  for (const table of [
    'ice_type_prices',
    'shop_ice_type_prices',
    'shop_payment_profiles',
    'financial_approval_requests',
    'delivery_charges',
    'collection_runs',
    'collection_run_members',
    'payments',
    'payment_allocations',
  ]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }

  assert.match(migration, /requested_by = auth\.uid\(\) or public\.current_app_role\(\) in \('admin', 'round_lead'\)/);
  assert.match(migration, /public\.is_collection_run_member\(id\)/);
  assert.match(migration, /public\.is_financial_charge_visible\(id\)/);
  assert.match(migration, /public\.is_payment_visible\(id\)/);
});

test('payment and delivery retries retain request fingerprints', () => {
  assert.match(migration, /alter table public\.delivery_events[\s\S]*add column request_fingerprint text/);
  assert.match(migration, /create table public\.payments[\s\S]*idempotency_key uuid not null unique[\s\S]*request_fingerprint text not null/);
  assert.match(migration, /financial_approval_requests[\s\S]*request_fingerprint text not null/);
});
