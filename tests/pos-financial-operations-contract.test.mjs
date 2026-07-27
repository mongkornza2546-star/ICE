import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0059_pos_financial_operations.sql', import.meta.url),
  'utf8',
);

test('adds the complete operational finance RPC surface', () => {
  for (const rpc of [
    'record_payment',
    'void_payment',
    'open_collection_run',
    'get_collection_run_queue',
    'close_collection_run',
    'request_financial_approval',
    'decide_financial_approval',
    'get_credit_receivables',
  ]) {
    assert.match(migration, new RegExp(`function public\\.${rpc}\\(`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${rpc}\\(`));
  }
});

test('serializes payments per shop and rejects stale outstanding totals', () => {
  assert.match(
    migration,
    /pg_advisory_xact_lock\(hashtextextended\('financial-shop:' \|\| p_shop_id::text, 0\)\)/,
  );
  assert.match(migration, /p_expected_outstanding_amount/);
  assert.match(migration, /The outstanding amount changed; refresh before recording payment/);
  assert.match(migration, /idempotency_key = p_idempotency_key/);
  assert.match(migration, /v_existing_fingerprint is distinct from v_request_fingerprint/);
});

test('scopes payment recording to visible charges or the assigned collection run', () => {
  assert.match(migration, /public\.is_financial_charge_visible\(charge\.id\)/);
  assert.match(migration, /charge\.payment_term is distinct from 'immediate'/);
  assert.match(migration, /charge\.service_date is distinct from v_collection_service_date/);
  assert.match(migration, /charge\.payment_term is distinct from 'end_of_day'/);
  assert.match(migration, /The payment contains a charge outside the caller''s assigned scope/);
});

test('enforces method, reference, verified evidence, allocation, and outstanding policies', () => {
  assert.match(migration, /allowed_payment_methods/);
  assert.match(migration, /cash_reference_required/);
  assert.match(migration, /bank_transfer_evidence_required/);
  assert.match(migration, /from storage\.objects evidence/);
  assert.match(migration, /evidence\.bucket_id = 'payment-evidence'/);
  assert.match(migration, /\(storage\.foldername\(evidence\.name\)\)\[1\] = auth\.uid\(\)::text/);
  assert.match(migration, /Only cash payments can include change/);
  assert.match(migration, /An allocation cannot exceed the latest charge balance/);
  assert.match(migration, /does not allow an outstanding immediate balance/);
});

test('consumes a matching one-use approval for an outstanding immediate balance', () => {
  assert.match(
    migration,
    /p_expected_outstanding_amount numeric,\s+p_approval_id uuid,\s+p_idempotency_key uuid/,
  );
  assert.match(migration, /approval\.kind is distinct from 'outstanding_balance'/);
  assert.match(migration, /approval\.requested_amount is distinct from v_remaining_outstanding/);
  assert.match(migration, /consumed_by_payment_id = v_payment_id/);
  assert.match(migration, /approval_request_id[\s\S]*p_approval_id/);
});

test('collection queue derives current end-of-day balances across all deliveries', () => {
  assert.match(migration, /charge\.service_date = v_service_date/);
  assert.match(migration, /charge\.payment_term = 'end_of_day'/);
  assert.match(migration, /has_new_charges/);
  assert.match(migration, /queue\.latest_charge_at > queue\.latest_payment_at/);
  assert.match(migration, /'payment_profile', queue\.payment_profile/);
});

test('approval and receivable operations are audited and role restricted', () => {
  assert.match(migration, /Only a round lead or admin can decide financial approvals/);
  assert.match(migration, /public\.delivery_request_fingerprint/);
  assert.match(migration, /'financial_approval_requests'.*'decided'/s);
  assert.match(migration, /Only a round lead or admin can view credit receivables/);
  assert.match(migration, /charge\.payment_term = 'credit'/);
  assert.match(migration, /overdue_amount/);
});
