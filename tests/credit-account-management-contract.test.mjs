import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0122_credit_account_management.sql', import.meta.url),
  'utf8',
);

test('projects lightweight store summaries and loads financial detail separately', () => {
  assert.match(migration, /account_balances as \([\s\S]*sum\(charge\.outstanding_amount\).*as outstanding_amount/);
  assert.match(migration, /sum\(case when charge\.due_date < p_as_of_date then charge\.outstanding_amount else 0 end\)/);
  assert.match(migration, /min\(charge\.due_date\) filter \(where charge\.outstanding_amount > 0\)/);
  assert.match(migration, /profile\.credit_limit - account\.outstanding_amount/);
  assert.match(migration, /'charges', '\[\]'::jsonb,[\s\S]*'payments', '\[\]'::jsonb/);
  assert.match(migration, /create or replace function public\.get_credit_receivable_detail/);
  assert.doesNotMatch(migration, /greatest\(profile\.credit_limit - account\.outstanding_amount/);
});

test('automatically makes due credit bills collectible while preserving advance planning', () => {
  const collectible = migration.slice(
    migration.indexOf('create or replace function public.is_charge_collectible_in_run'),
    migration.indexOf('create or replace function public.get_credit_receivables'),
  );
  assert.match(collectible, /charge\.due_date <= run\.service_date/);
  assert.match(collectible, /collection_run_credit_charges assignment/);
  assert.match(collectible, /charge\.due_date <= run\.service_date\s+or exists/s);
  assert.match(collectible, /if p_assigned and v_outstanding <= 0 then/);
  assert.doesNotMatch(collectible, /v_charge\.due_date > v_run\.service_date/);
});

test('audits admin credit-setting changes and blocks new credit while suspended', () => {
  assert.match(migration, /shop_payment_profiles_audit_update/);
  assert.match(migration, /execute function public\.audit_row_update/);
  assert.match(migration, /current_app_role\(\) <> 'admin'/);
  assert.match(migration, /Credit is suspended for this shop/);
  assert.match(migration, /credit_suspension_reason/);
});

test('returns receipt allocations without rewriting original credit sales', () => {
  assert.match(migration, /'allocations'.*payment_allocations allocation/s);
  assert.match(migration, /'charge_number', allocated_charge\.charge_number/);
  assert.match(migration, /'amount', allocation\.amount/);
  assert.doesNotMatch(migration, /update public\.delivery_charges\s+set original_amount/i);
});
