import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const resetScript = readFileSync(
  new URL('../supabase/scripts/reset_all_test_transactions.sql', import.meta.url),
  'utf8',
);

test('transaction reset follows the implemented daily-close schema', () => {
  assert.doesNotMatch(resetScript, /public\.cash_handovers\b/);
  assert.doesNotMatch(resetScript, /public\.cash_handover_items\b/);

  for (const table of [
    'daily_close_reconciliation_requests',
    'daily_close_employee_snapshots',
    'daily_close_payment_items',
    'daily_close_reconciliation_issues',
  ]) {
    assert.equal(
      [...resetScript.matchAll(new RegExp(`public\\.${table}\\b`, 'g'))].length,
      3,
      `${table} must be covered by preview, truncate, and verification`,
    );
  }
});
