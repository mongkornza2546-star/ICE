import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0136_accounting_read_model.sql', import.meta.url),
  'utf8',
);

test('accounting exposes secured reconciliation, ledger, and derived review RPCs', () => {
  for (const name of [
    'get_accounting_reconciliation',
    'get_accounting_transactions',
    'get_accounting_review_queue',
  ]) {
    assert.match(migration, new RegExp(`create function public\\.${name}`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}`));
  }
  assert.match(migration, /security definer/g);
  assert.match(migration, /set search_path = public/g);
  assert.match(migration, /current_app_role\(\) not in \('admin', 'round_lead'\)/g);
  assert.match(migration, /p_to_date - p_from_date > 30/);
  assert.match(migration, /Unsupported accounting sort key/);
  assert.match(migration, /revoke all on function public\.accounting_transaction_rows\(date, date\) from authenticated/);
  assert.match(migration, /revoke all on function public\.accounting_aggregate_reconciliation_rows\(date\) from authenticated/);
});

test('canonical ledger contains every planned transaction type and immutable lineage', () => {
  for (const type of ['FACTORY', 'WITHDRAW', 'TRANSFER', 'SALE', 'INV', 'REC', 'ADJ', 'REF', 'DAMAGE', 'RETURN']) {
    assert.match(migration, new RegExp(`'${type}'`));
  }
  assert.match(migration, /source_table text/);
  assert.match(migration, /'idempotency_key'/);
  assert.match(migration, /receipt_snapshot/);
  assert.match(migration, /get_payment_correction_targets/);
  assert.match(migration, /charge\.status = 'voided' or event\.status = 'cancelled'/);
  assert.match(migration, /payment\.status = 'voided'/);
  assert.match(migration, /then payment\.allocated_amount else 0 end/);
});

test('review queue derives all seven issue families from source records', () => {
  for (const issue of [
    'STOCK_VARIANCE',
    'UNPAID_CHARGE',
    'PAID_INVOICE_REVISED',
    'PENDING_REFUND',
    'VOIDED_RECEIPT',
    'REPLACED_INVOICE',
    'MISSING_PAYMENT_EVIDENCE',
  ]) {
    assert.match(migration, new RegExp(`'${issue}'`));
  }
  assert.doesNotMatch(migration, /create table public\.accounting_issue/);
  assert.match(migration, /obligation\.status = 'pending'/);
  assert.match(migration, /payment\.evidence_path is null/);
  assert.match(migration, /accounting_aggregate_reconciliation_rows\(closure\.service_date\)/);
  assert.match(migration, /item\.count_status = 'complete' and item\.variance <> 0/);
});

test('count freshness includes open revisions as well as closed adjustments', () => {
  assert.match(migration, /max\(revision\.revised_at\)/);
  assert.match(migration, /replacement_event\.source_stock_location_id = location\.id/);
});

test('accounting date and status indexes keep the 31-day queries bounded', () => {
  assert.match(migration, /payments_recorded_status_idx/);
  assert.match(migration, /delivery_charges_service_status_idx/);
  assert.match(migration, /delivery_charge_adjustments_created_status_idx/);
  assert.match(migration, /refund_obligations_created_status_idx/);
  assert.match(migration, /refund_settlements_settled_at_idx/);
});
