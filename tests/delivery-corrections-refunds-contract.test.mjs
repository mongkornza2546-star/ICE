import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const correctionMigration = readFileSync(new URL('../supabase/migrations/0128_delivery_corrections_refunds_and_adjustments.sql', import.meta.url), 'utf8');
const projectionMigration = readFileSync(new URL('../supabase/migrations/0129_effective_charge_projections.sql', import.meta.url), 'utf8');
const paymentMigration = readFileSync(new URL('../supabase/migrations/0130_effective_charge_payments.sql', import.meta.url), 'utf8');
const correctionHardeningMigration = readFileSync(new URL('../supabase/migrations/0131_delivery_correction_hardening_and_refund_summary.sql', import.meta.url), 'utf8');
const purchaseHistory = readFileSync(new URL('../src/features/shop-settings/components/ShopPurchaseHistory.tsx', import.meta.url), 'utf8');

test('delivery corrections preserve payments and keep append-only refund and allocation history', () => {
  assert.match(correctionMigration, /create table public\.payment_allocation_changes/);
  assert.match(correctionMigration, /create table public\.refund_obligations/);
  assert.match(correctionMigration, /create table public\.refund_settlements/);
  assert.match(correctionMigration, /protect_append_only_financial_history/);
  assert.match(correctionMigration, /Payment allocations plus refund obligations must equal the allocated amount/);
  assert.match(correctionMigration, /A payment linked to a bill correction or refund cannot be voided/);
});

test('all correction writes are role-checked security-definer RPCs with authenticated execute grants', () => {
  for (const name of ['apply_open_delivery_correction', 'create_closed_delivery_adjustment', 'settle_refund']) {
    assert.match(correctionMigration, new RegExp(`create function public\\.${name}`));
  }
  assert.match(correctionMigration, /security definer/g);
  assert.match(correctionMigration, /Only an admin can create a closed-period delivery adjustment/);
  assert.match(correctionMigration, /grant execute on function public\.apply_open_delivery_correction/);
  assert.match(correctionMigration, /grant execute on function public\.settle_refund/);
});

test('effective charge amounts feed stock, history, collection, receivables, and payment validation', () => {
  assert.match(projectionMigration, /create or replace function public\.stock_balance_at/);
  assert.match(projectionMigration, /create or replace function public\.get_shop_purchase_history/);
  assert.match(projectionMigration, /create or replace function public\.get_collection_run_queue/);
  assert.match(projectionMigration, /create or replace function public\.get_credit_receivables/);
  assert.match(paymentMigration, /public\.effective_delivery_charge_amount\(charge\.id\)/);
  assert.doesNotMatch(paymentMigration, /pg_get_functiondef|replace\(v_definition/);
});

test('purchase-history adjustment fields match the SQL projection', () => {
  assert.match(projectionMigration, /'id', adjustment\.idempotency_key/);
  assert.match(projectionMigration, /'amount_delta', adjustment\.amount_delta/);
  assert.match(purchaseHistory, /adjustment\.id/);
  assert.match(purchaseHistory, /adjustment\.amount_delta/);
  assert.match(projectionMigration, /then 'replaced'/);
});

test('courier corrections stay quantity-only and refund reporting separates gross, refunded, and net cash', () => {
  assert.match(correctionHardeningMigration, /Couriers can only correct delivered quantities/);
  assert.match(correctionHardeningMigration, /create function public\.get_financial_refund_summary/);
  assert.match(correctionHardeningMigration, /'gross_received'/);
  assert.match(correctionHardeningMigration, /'refunded_amount'/);
  assert.match(correctionHardeningMigration, /'net_received'/);
  assert.match(correctionHardeningMigration, /grant execute on function public\.get_financial_refund_summary/);
});
