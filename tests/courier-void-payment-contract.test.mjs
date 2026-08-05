import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0123_allow_couriers_to_void_own_payments.sql', import.meta.url),
  'utf8',
);

test('allows active couriers to void only payments they recorded', () => {
  assert.match(migration, /create or replace function public\.void_payment\(p_payment_id uuid, p_reason text\)/);
  assert.match(migration, /select payment\.shop_id, payment\.recorded_by/);
  assert.match(migration, /public\.current_app_role\(\) = 'courier' and v_recorded_by <> auth\.uid\(\)/);
  assert.match(migration, /Couriers can only void payments they recorded/);
});

test('keeps void reasons, audit logging, and authenticated RPC access', () => {
  assert.match(migration, /A void reason is required/);
  assert.match(migration, /set status = 'voided', voided_by = auth\.uid\(\), voided_at = now\(\)/);
  assert.match(migration, /'payments', p_payment_id, 'voided'/);
  assert.match(migration, /grant execute on function public\.void_payment\(uuid, text\) to authenticated/);
});
