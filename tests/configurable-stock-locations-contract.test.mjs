import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0016_configurable_stock_locations.sql', import.meta.url),
  'utf8',
);

test('configurable locations replace the legacy RPC and make sources explicit', () => {
  assert.match(migration, /drop function if exists public\.save_stock_location\([\s\S]*uuid, uuid, uuid, boolean/);
  assert.match(migration, /add column if not exists is_courier_source boolean not null default false/);
  assert.match(migration, /add column if not exists is_default_for_building boolean not null default false/);
  assert.match(migration, /create or replace function public\.get_employee_stock_state\(p_round_id uuid\)/);
  assert.match(migration, /location\.kind = 'truck' and location\.is_courier_source and location\.is_active/);
  assert.match(migration, /is_default_for_building\s+and is_active/);
});

test('location reassignment protects open balances and shops', () => {
  assert.match(migration, /select distinct round\.service_date[\s\S]*closure\.status = 'closed'/);
  assert.match(migration, /public\.shops shop where shop\.stock_location_id = p_location_id/);
  assert.match(migration, /cannot be deactivated or reassigned/);
});
