import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../supabase/migrations/0127_credit_bill_delivery_details.sql', import.meta.url), 'utf8');

test('credit bill details expose the audited source delivery and ordered items', () => {
  assert.match(migration, /'delivery_event_id', delivery_event\.id/);
  assert.match(migration, /'round_status', delivery_round\.status/);
  assert.match(migration, /'items', coalesce\(\(/);
  assert.match(migration, /join public\.delivery_events delivery_event on delivery_event\.id = charge\.delivery_event_id/);
});

test('delivery revisions reconcile charge-scoped credit workflows', () => {
  assert.match(migration, /create or replace function public\.reconcile_credit_charge_revision_workflows\(\)/);
  assert.match(migration, /insert into public\.collection_run_credit_charges/);
  assert.match(migration, /update public\.credit_due_date_requests/);
  assert.match(migration, /after insert on public\.delivery_event_revisions/);
});
