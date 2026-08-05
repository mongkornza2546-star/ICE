import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const enumMigration = readFileSync(
  new URL('../supabase/migrations/0125_add_weekly_credit_due_rule.sql', import.meta.url),
  'utf8',
);
const cycleMigration = readFileSync(
  new URL('../supabase/migrations/0126_credit_collection_cycles.sql', import.meta.url),
  'utf8',
);

test('adds a weekly cycle without using a charge trigger', () => {
  assert.match(enumMigration, /alter type public\.credit_due_rule add value if not exists 'weekly'/);
  assert.match(cycleMigration, /credit_collection_weekday smallint/);
  assert.match(cycleMigration, /create or replace function public\.resolve_credit_due_date/);
  assert.match(cycleMigration, /v_due_date := public\.resolve_credit_due_date\(v_shop_id, v_service_date\)/);
  assert.doesNotMatch(cycleMigration, /create\s+trigger[\s\S]*delivery_charges/i);
});

test('serializes due-date resolution and collection close on the same cutoff key', () => {
  const lockPattern = /pg_advisory_xact_lock\([\s\S]{0,120}'collection-run:' \|\| v_[a-z_]+::text/g;
  assert.ok((cycleMigration.match(lockPattern) ?? []).length >= 2);
  assert.match(cycleMigration, /where run\.service_date = v_candidate and run\.status = 'closed'/);
});

test('requires atomic cycle updates and projects the cycle to clients', () => {
  assert.match(cycleMigration, /Credit collection cycle changes must include rule, days, and weekday/);
  assert.match(cycleMigration, /'credit_due_rule', profile\.credit_due_rule/);
  assert.match(cycleMigration, /'credit_collection_weekday', profile\.credit_collection_weekday/);
});
