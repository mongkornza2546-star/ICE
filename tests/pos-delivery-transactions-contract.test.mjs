import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0030_pos_delivery_transactions.sql', import.meta.url),
  'utf8',
);
const readOnlyPriceResolution = readFileSync(
  new URL('../supabase/migrations/0132_read_only_delivery_price_resolution.sql', import.meta.url),
  'utf8',
);

test('POS context is scoped to the selected open stop and server-owned service date', () => {
  assert.match(migration, /create or replace function public\.get_delivery_pos_context\(p_round_stop_id uuid\)/);
  assert.match(migration, /round\.service_date/);
  assert.match(migration, /v_round_status <> 'open'/);
  assert.match(migration, /not public\.is_round_member\(v_round_id\)/);
  assert.match(migration, /public\.stock_balance_at\(v_service_date, v_source_location_id, ice\.id\)/);
});

test('record_delivery snapshots resolved prices and creates one idempotent charge', () => {
  assert.match(migration, /create function public\.delivery_request_fingerprint\(/);
  assert.doesNotMatch(migration, /drop function if exists public\.record_delivery\(/);
  assert.match(migration, /create function public\.record_delivery\([\s\S]*p_payment_term public\.payment_term,[\s\S]*p_approval_id uuid default null/);
  assert.match(migration, /v_existing_fingerprint is distinct from v_request_fingerprint/);
  assert.match(
    migration,
    /pg_advisory_xact_lock\(hashtextextended\(p_idempotency_key::text, 0\)\)[\s\S]*where event\.idempotency_key = p_idempotency_key/,
  );
  assert.match(migration, /from public\.shop_ice_type_prices[\s\S]*from public\.ice_type_prices/);
  assert.match(migration, /insert into public\.delivery_items[\s\S]*unit_price[\s\S]*price_source_id/);
  assert.match(migration, /insert into public\.delivery_charges/);
  assert.match(migration, /set status = 'consumed'/);
  assert.match(migration, /return public\.delivery_financial_response\(v_event_id\)/);
});

test('read-only price resolution skips locks while delivery writes retain both price-row locks', () => {
  const resolver = readOnlyPriceResolution.match(
    /create or replace function public\.resolve_delivery_price\([\s\S]*?\n\$\$;/,
  )?.[0];
  assert.ok(resolver);

  const writeBranchStart = resolver.indexOf('\n  end if;\n\n  return query');
  assert.notEqual(writeBranchStart, -1);
  const readOnlyBranch = resolver.slice(0, writeBranchStart);
  const writeBranch = resolver.slice(writeBranchStart);

  assert.match(readOnlyBranch, /current_setting\('transaction_read_only'\) = 'on'/);
  assert.doesNotMatch(readOnlyBranch, /for share;/);
  assert.match(
    writeBranch,
    /from public\.shop_ice_type_prices[\s\S]*for share;[\s\S]*from public\.ice_type_prices[\s\S]*for share;/,
  );
  assert.equal((writeBranch.match(/for share;/g) ?? []).length, 2);
});

test('financial-aware revisions preserve legacy exclusion and original-date pricing', () => {
  assert.match(migration, /create or replace function public\.protect_financial_delivery_revision\(\)/);
  const protection = migration.match(
    /create or replace function public\.protect_financial_delivery_revision\(\)[\s\S]*?\n\$\$;/,
  )?.[0];
  assert.ok(protection);
  assert.doesNotMatch(protection, /Financial delivery corrections require/);
  assert.match(migration, /drop function if exists public\.revise_delivery_event\(/);
  assert.match(migration, /create function public\.revise_delivery_event\([\s\S]*p_approval_id uuid default null/);
  assert.match(
    migration,
    /v_original_charge_id is not null[\s\S]*resolve_delivery_price\([\s\S]*v_service_date/,
  );
  assert.match(migration, /v_original_charge_id is null[\s\S]*v_unit_price := null/);
  assert.match(migration, /insert into public\.delivery_charges/);
  assert.match(migration, /with recursive event_lineage/);
  assert.match(migration, /v_existing_fingerprint is not null[\s\S]*v_existing_fingerprint is distinct from v_revision_fingerprint/);
  assert.equal((migration.match(/Financial approval has expired/g) ?? []).length, 2);
});
