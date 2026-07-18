import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0015_employee_assigned_stock_flow.sql', import.meta.url),
  'utf8',
);

test('employee stock state exposes only the courier truck and assigned holding balances', () => {
  assert.match(
    migration,
    /create or replace function public\.get_employee_stock_state\(p_round_id uuid\)[\s\S]*returns jsonb[\s\S]*security definer/,
  );
  assert.match(migration, /public\.current_app_role\(\) <> 'courier'/);
  assert.match(migration, /not public\.is_round_member\(p_round_id\)/);
  assert.match(
    migration,
    /location\.code = 'TRUCK-MAIN'[\s\S]*location\.kind = 'truck'[\s\S]*location\.is_active/,
  );
  assert.match(
    migration,
    /location\.assigned_user_id = auth\.uid\(\)[\s\S]*location\.kind in \('team', 'small_vehicle'\)[\s\S]*location\.is_active/,
  );
  assert.match(migration, /v_active_holding_count = 0[\s\S]*none is configured/);
  assert.match(migration, /v_active_holding_count > 1[\s\S]*multiple are configured/);
  assert.match(migration, /'truck_location'[\s\S]*'holding_location'/);
  assert.match(migration, /public\.stock_balance_at\(v_service_date, truck\.id, ice\.id\)/);
  assert.match(migration, /public\.stock_balance_at\(v_service_date, holding\.id, ice\.id\)/);
});

test('employee transfer is a narrow payload-safe truck-to-own-holding transaction', () => {
  const transferStart = migration.indexOf(
    'create or replace function public.record_employee_stock_transfer(',
  );
  const deliveryStart = migration.indexOf('create or replace function public.record_delivery(');
  const transfer = migration.slice(transferStart, deliveryStart);

  assert.ok(transferStart >= 0);
  assert.ok(deliveryStart > transferStart);
  assert.match(transfer, /public\.current_app_role\(\) <> 'courier'/);
  assert.match(transfer, /jsonb_array_length\(p_items\) = 0/);
  assert.match(transfer, /having count\(\*\) > 1/);
  assert.match(transfer, /jsonb_agg\([\s\S]*order by item\.ice_type_id/);

  const keyLock = transfer.indexOf(
    'pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0))',
  );
  const replayLookup = transfer.indexOf(
    'where movement.idempotency_key = p_idempotency_key',
  );
  const dayLock = transfer.indexOf(
    'pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0))',
  );
  const balanceCheck = transfer.indexOf(
    'public.stock_balance_at(v_service_date, v_truck_location_id, v_item.ice_type_id)',
  );
  assert.ok(keyLock >= 0 && keyLock < replayLookup);
  assert.ok(dayLock > replayLookup && dayLock < balanceCheck);

  assert.match(transfer, /v_existing_recorded_by <> auth\.uid\(\)/);
  assert.match(transfer, /v_existing_round_id <> p_round_id/);
  assert.match(transfer, /v_existing_kind <> 'transfer'/);
  assert.match(transfer, /v_existing_from_location_id <> v_truck_location_id/);
  assert.match(transfer, /v_existing_to_location_id <> v_holding_location_id/);
  assert.match(transfer, /v_existing_items <> v_requested_items/);
  assert.match(transfer, /Every employee stock item must use an active ice type/);
  assert.match(transfer, /Stock for this service date is already closed/);
  assert.match(
    transfer,
    /insert into public\.stock_movements \([\s\S]*'transfer',[\s\S]*v_truck_location_id,[\s\S]*v_holding_location_id/,
  );
  assert.match(transfer, /insert into public\.stock_movement_items/);
  assert.match(transfer, /insert into public\.audit_logs/);
  assert.match(transfer, /return public\.get_employee_stock_state\(p_round_id\)/);
});

test('courier deliveries use assigned holding while managers retain the shop source', () => {
  const deliveryStart = migration.indexOf('create or replace function public.record_delivery(');
  const delivery = migration.slice(deliveryStart);

  assert.match(delivery, /if public\.current_app_role\(\) = 'courier' then/);
  assert.match(
    delivery,
    /location\.assigned_user_id = auth\.uid\(\)[\s\S]*location\.kind in \('team', 'small_vehicle'\)[\s\S]*location\.is_active/,
  );
  assert.match(
    delivery,
    /else\s+v_source_location_id := v_shop_source_location_id;\s+end if;/,
  );
  assert.match(
    delivery,
    /public\.stock_balance_at\(v_service_date, v_source_location_id, v_item\.ice_type_id\)/,
  );
  assert.match(
    delivery,
    /insert into public\.delivery_events[\s\S]*source_stock_location_id[\s\S]*v_source_location_id/,
  );
  assert.doesNotMatch(delivery, /location\.code = 'TRUCK-MAIN'/);
});

test('employee stock RPCs are callable only by authenticated users', () => {
  assert.match(
    migration,
    /revoke all on function public\.get_employee_stock_state\(uuid\) from public;/,
  );
  assert.match(
    migration,
    /revoke all on function public\.record_employee_stock_transfer\(uuid, jsonb, uuid\) from public;/,
  );
  assert.match(
    migration,
    /grant execute on function public\.get_employee_stock_state\(uuid\) to authenticated;/,
  );
  assert.match(
    migration,
    /grant execute on function public\.record_employee_stock_transfer\(uuid, jsonb, uuid\) to authenticated;/,
  );
});
