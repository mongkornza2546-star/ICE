import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0110_payment_receipt_numbers.sql', import.meta.url),
  'utf8',
);
const financialOperations = readFileSync(
  new URL('../src/FinancialOperations.tsx', import.meta.url),
  'utf8',
);
const globalStyles = readFileSync(
  new URL('../src/index.css', import.meta.url),
  'utf8',
);

test('receipt numbers are assigned in the payment transaction and returned by the payment RPC', () => {
  assert.match(migration, /before insert on public\.payments/);
  assert.match(migration, /alter column receipt_number set not null/);
  assert.match(migration, /unique index payments_receipt_number_idx/);
  assert.match(migration, /'receipt_number', payment\.receipt_number/);
  assert.match(migration, /'recorded_at', payment\.recorded_at/);
});

test('57 × 30 mm printing is isolated from the global application print stylesheet', () => {
  assert.match(financialOperations, /window\.open\('', '_blank'/);
  assert.match(financialOperations, /@page \{ size: 57mm 30mm; margin: 0; \}/);
  assert.doesNotMatch(globalStyles, /@page\s*\{\s*size:\s*57mm 30mm/);
  assert.doesNotMatch(globalStyles, /body \* \{ visibility: hidden; \}/);
});

test('payment history exposes persisted receipt numbers for reprinting', () => {
  assert.match(financialOperations, /select\('id, receipt_number,/);
  assert.match(financialOperations, /receiptFromHistory\(payment\)/);
  assert.match(financialOperations, />พิมพ์ซ้ำ</);
});
