import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0110_payment_receipt_numbers.sql', import.meta.url),
  'utf8',
);
const receiptItemsMigration = readFileSync(
  new URL('../supabase/migrations/0111_payment_receipt_items.sql', import.meta.url),
  'utf8',
);
const receiptSchemaReloadMigration = readFileSync(
  new URL('../supabase/migrations/0112_reload_payment_receipt_rpc_schema.sql', import.meta.url),
  'utf8',
);
const receiptQuantityTypeFixMigration = readFileSync(
  new URL('../supabase/migrations/0113_fix_payment_receipt_item_quantity_type.sql', import.meta.url),
  'utf8',
);
const financialOperations = readFileSync(
  new URL('../src/FinancialOperations.tsx', import.meta.url),
  'utf8',
);
const financialOperationsPanels = readFileSync(
  new URL('../src/features/financial-operations/components/FinancialOperationsPanels.tsx', import.meta.url),
  'utf8',
);
const globalStyles = readFileSync(
  new URL('../src/index.css', import.meta.url),
  'utf8',
);

test('receipt numbers are assigned in the payment transaction and returned by the payment RPC', () => {
  assert.match(migration, /set constraints all immediate/);
  assert.match(migration, /before insert on public\.payments/);
  assert.match(migration, /alter column receipt_number set not null/);
  assert.match(migration, /unique index payments_receipt_number_idx/);
  assert.match(migration, /'receipt_number', payment\.receipt_number/);
  assert.match(migration, /'recorded_at', payment\.recorded_at/);
});

test('receipt printing is isolated from the global application print stylesheet', () => {
  assert.match(financialOperations, /window\.open\('', '_blank'/);
  assert.match(financialOperations, /@page \{ size: 57mm \$\{receiptHeightMm\}mm; margin: 0; \}/);
  assert.match(financialOperations, /get_payment_receipt_items/);
  assert.doesNotMatch(globalStyles, /@page\s*\{\s*size:\s*57mm 30mm/);
  assert.doesNotMatch(globalStyles, /body \* \{ visibility: hidden; \}/);
});

test('payment history exposes persisted receipt numbers for reprinting', () => {
  assert.match(financialOperations, /select\('id, receipt_number,/);
  assert.match(financialOperations, /onPrintReceipt=\{printHistoryReceipt\}/);
  assert.match(financialOperationsPanels, /onClick=\{\(\) => onPrintReceipt\(payment\)\}/);
  assert.match(financialOperationsPanels, />พิมพ์ซ้ำ</);
});

test('receipt item details are scoped to a payment the caller can view', () => {
  assert.match(receiptItemsMigration, /create function public\.get_payment_receipt_items/);
  assert.match(receiptItemsMigration, /public\.is_payment_visible\(p_payment_id\)/);
  assert.match(receiptItemsMigration, /join public\.delivery_items item/);
  assert.match(receiptSchemaReloadMigration, /grant execute on function public\.get_payment_receipt_items\(uuid\) to authenticated/);
  assert.match(receiptSchemaReloadMigration, /notify pgrst, 'reload schema'/);
});

test('receipt item details preserve half-bag quantities', () => {
  assert.match(receiptQuantityTypeFixMigration, /drop function public\.get_payment_receipt_items\(uuid\)/);
  assert.match(receiptQuantityTypeFixMigration, /quantity numeric\(12,1\)/);
  assert.match(receiptQuantityTypeFixMigration, /item\.quantity/);
  assert.match(receiptQuantityTypeFixMigration, /notify pgrst, 'reload schema'/);
});
