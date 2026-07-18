import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0014_employee_truck_delivery_source.sql', import.meta.url),
  'utf8',
);

test('courier delivery source requires one configured active truck', () => {
  assert.match(migration, /if public\.current_app_role\(\) = 'courier' then/);
  assert.match(
    migration,
    /where location\.kind = 'truck'\s+and location\.is_active/,
  );
  assert.match(
    migration,
    /select count\(\*\)::integer into v_active_truck_count[\s\S]*where location\.kind = 'truck'\s+and location\.is_active/,
  );
  assert.match(migration, /if v_active_truck_count <> 1 then[\s\S]*exactly one active truck configured in stock locations/);
  assert.doesNotMatch(migration, /location\.code = 'TRUCK-MAIN'/);
  assert.match(
    migration,
    /select location\.id into v_source_location_id\s+from public\.stock_locations location\s+where location\.kind = 'truck'\s+and location\.is_active/,
  );
});

test('manager delivery source remains the source configured for the shop', () => {
  assert.match(
    migration,
    /shop\.stock_location_id\s+into v_round_id, v_round_status, v_service_date, v_shop_source_location_id/,
  );
  assert.match(
    migration,
    /else\s+v_source_location_id := v_shop_source_location_id;\s+end if;/,
  );
});

test('source resolution preserves the existing delivery transaction contract', () => {
  const membershipCheck = migration.indexOf("if public.current_app_role() not in ('admin', 'round_lead')");
  const closedRoundCheck = migration.indexOf("if v_round_status <> 'open'");
  const courierResolution = migration.indexOf("if public.current_app_role() = 'courier'");
  const activeSourceCheck = migration.indexOf('if not exists (', courierResolution);
  const serviceDateLock = migration.indexOf(
    'pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0))',
  );

  assert.ok(membershipCheck >= 0 && membershipCheck < closedRoundCheck);
  assert.ok(closedRoundCheck < courierResolution);
  assert.ok(courierResolution < activeSourceCheck);
  assert.ok(activeSourceCheck < serviceDateLock);

  assert.match(migration, /if not public\.is_active_user\(\) then/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(p_idempotency_key::text, 0\)\)/);
  assert.match(migration, /where e\.idempotency_key = p_idempotency_key/);
  assert.match(migration, /if not public\.is_delivery_event_visible\(v_existing_event_id\) then/);
  assert.match(migration, /where s\.id = p_round_stop_id\s+for update of r;/);
  assert.match(migration, /and not public\.is_round_member\(v_round_id\) then/);
  assert.match(migration, /A delivered shop requires at least one ice item/);
  assert.match(migration, /A non-delivery status requires a note and cannot include ice items/);
  assert.match(migration, /Every delivery item must use a distinct active ice type and a positive quantity/);
  assert.match(
    migration,
    /public\.stock_balance_at\(v_service_date, v_source_location_id, v_item\.ice_type_id\)[\s\S]*The source location does not have enough stock/,
  );
  assert.match(
    migration,
    /insert into public\.delivery_events[\s\S]*source_stock_location_id[\s\S]*v_source_location_id[\s\S]*on conflict \(idempotency_key\) do nothing/,
  );
  assert.match(migration, /insert into public\.delivery_items/);
  assert.match(migration, /update public\.round_stops/);
  assert.match(
    migration,
    /insert into public\.audit_logs[\s\S]*'source_stock_location_id', v_source_location_id/,
  );
  assert.match(migration, /return public\.delivery_event_response\(v_event_id\);\s+end;\s+\$\$;/);
});
