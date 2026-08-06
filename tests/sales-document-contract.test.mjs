import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0134_monthly_sales_documents_and_atomic_immediate_sales.sql', import.meta.url),
  'utf8',
);
const workspace = readFileSync(new URL('../src/EmployeeDeliveryWorkspace.tsx', import.meta.url), 'utf8');
const deliveryState = readFileSync(
  new URL('../src/features/employee-delivery/useEmployeeDeliveryData.ts', import.meta.url),
  'utf8',
);
const printer = readFileSync(new URL('../src/lib/salesDocumentPrint.ts', import.meta.url), 'utf8');

test('monthly sales documents use independent locked INV and REC counters', () => {
  assert.match(migration, /create table public\.document_counters/);
  assert.match(migration, /primary key \(document_type, period_month\)/);
  assert.match(migration, /for update/);
  assert.match(migration, /v_sequence >= 99999/);
  assert.match(migration, /lpad\(v_sequence::text, 5, '0'\)/);
  assert.match(migration, /new\.payment_term = 'immediate'[\s\S]*new\.charge_number := null/);
  assert.match(migration, /'INV', date_trunc\('month', new\.service_date\)/);
  assert.match(migration, /'REC', date_trunc\('month', coalesce\(new\.recorded_at, now\(\)\) at time zone 'Asia\/Bangkok'\)/);
});

test('immediate sales are one RPC with one retry key and no partial-payment escape', () => {
  assert.match(migration, /create function public\.record_immediate_sale\(/);
  assert.match(migration, /p_expected_total numeric/);
  assert.match(migration, /p_expected_total::numeric\(12,2\) <> v_total/);
  assert.match(migration, /public\.record_delivery\([\s\S]*p_idempotency_key, 'immediate'/);
  assert.match(migration, /public\.record_payment\([\s\S]*p_idempotency_key/);
  assert.match(migration, /Cash received must cover the full immediate sale amount/);
  assert.match(migration, /Transfer and QR payments must equal the immediate sale amount/);
  assert.match(workspace, /supabase\.rpc\('record_immediate_sale'/);
  assert.match(deliveryState, /paymentTerm === 'immediate' && gateway\.recordImmediateSale/);
  assert.match(deliveryState, /const evidenceMetadata = paymentEvidence \? \{/);
  assert.match(deliveryState, /immediateSaleRetry\?\.evidencePath/);
  assert.match(deliveryState, /expectedTotal: paymentResult\.total_amount/);
  assert.doesNotMatch(deliveryState, /finishPaymentLater/);
});

test('closed-period corrections cannot mutate immediate sales in place', () => {
  assert.match(migration, /create function public\.reject_immediate_delivery_adjustment\(\)/);
  assert.match(migration, /Immediate sales cannot be adjusted in place/);
  assert.match(migration, /delivery_charge_adjustments_reject_immediate/);
  assert.match(migration, /allow_closed_immediate_receipt_void/);
  assert.match(migration, /allow_closed_immediate_delivery_cancel/);
  assert.match(migration, /target_payment\.status = 'voided'[\s\S]*charge\.payment_term = 'immediate'/);
});

test('INV and REC reprints use immutable snapshots and one shared 57mm renderer', () => {
  assert.match(migration, /create table public\.delivery_charge_document_snapshots/);
  assert.match(migration, /Delivery charge document snapshots are immutable/);
  assert.match(migration, /create function public\.get_charge_print_document/);
  assert.match(migration, /create or replace function public\.get_payment_receipt_snapshot/);
  assert.match(migration, /'status', v_payment\.status/);
  assert.match(printer, /export function printSalesDocument/);
  assert.match(printer, /@page \{ size: 57mm \$\{heightMm\}mm/);
  assert.match(printer, /payload\.documentType === 'INV'/);
});
