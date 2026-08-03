import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0120_credit_collections_and_due_date_extensions.sql', import.meta.url),
  'utf8',
);

test('adds only due, explicitly assigned credit balances to a collection run', () => {
  assert.match(migration, /create table public\.collection_run_credit_charges/);
  assert.match(migration, /function public\.is_charge_collectible_in_run/);
  assert.match(migration, /charge\.due_date <= run\.service_date/);
  assert.match(migration, /assignment\.collection_run_id = run\.id/);
  assert.match(migration, /is_charge_collectible_in_run\(charge\.id, p_collection_run_id\)/);
  assert.match(migration, /order by coalesce\(charge\.due_date, charge\.service_date\), charge\.created_at, charge\.id/);
  assert.match(migration, /Credit payments must be allocated to the oldest due balance first/);
  assert.match(migration, /pg_get_functiondef\(v_function\)/);
  assert.match(migration, /record_payment\(uuid,jsonb,public\.payment_method,numeric,text,text,uuid,numeric,uuid,uuid\)/);
});

test('serializes credit eligibility changes with collection payments', () => {
  const assignmentFunction = migration.slice(
    migration.indexOf('create or replace function public.set_credit_charge_collection_assignment'),
    migration.indexOf('create or replace function public.request_credit_due_date_change'),
  );
  const decisionFunction = migration.slice(
    migration.indexOf('create or replace function public.decide_credit_due_date_request'),
    migration.indexOf('create or replace function public.get_credit_receivables'),
  );
  for (const definition of [assignmentFunction, decisionFunction]) {
    assert.match(definition, /pg_advisory_xact_lock\(hashtextextended\('financial-shop:' \|\| .*shop_id::text, 0\)\)/);
    assert.ok(definition.indexOf('pg_advisory_xact_lock') < definition.indexOf('for update'));
  }
});

test('records due-date extensions as requests and prevents direct date overwrites', () => {
  assert.match(migration, /create table public\.credit_due_date_requests/);
  assert.match(migration, /original_due_date date not null/);
  assert.match(migration, /requested_due_date date not null/);
  assert.match(migration, /requested_due_date > original_due_date/);
  assert.match(migration, /Credit due dates can only change through an approved due-date request/);
  assert.match(migration, /function public\.request_credit_due_date_change/);
  assert.match(migration, /function public\.decide_credit_due_date_request/);
  assert.match(migration, /Only a round lead or admin can decide due-date requests/);
  assert.match(migration, /set_config\('app\.credit_due_date_change_approved', 'on', true\)/);
  assert.match(migration, /'credit_due_date_requests'.*'requested'/s);
  assert.match(migration, /'credit_due_date_requests'.*'decided'/s);
});

test('returns payment, due, overdue, and credit-limit state for every credit bill', () => {
  assert.match(migration, /'payment_status', case when balance\.outstanding_amount = 0 then 'paid'/);
  assert.match(migration, /'due_status', case when balance\.outstanding_amount = 0 then 'paid'/);
  assert.match(migration, /when charge\.due_date < p_as_of_date then 'overdue'/);
  assert.match(migration, /when charge\.due_date = p_as_of_date then 'due_today'/);
  assert.match(migration, /'days_overdue', greatest\(p_as_of_date - charge\.due_date, 0\)/);
  assert.match(migration, /'available_credit_amount', receivable\.available_credit_amount/);
  assert.match(migration, /case when profile\.credit_limit is null then null/);
  assert.match(migration, /'assigned_collection_run_id'/);
});
