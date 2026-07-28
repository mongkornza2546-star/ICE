import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0106_admin_backdated_billing.sql', import.meta.url),
  'utf8',
);
const router = readFileSync(new URL('../src/RoleRouter.tsx', import.meta.url), 'utf8');

test('backdated sales are exposed only to admins and enforced by the database', () => {
  assert.match(
    router,
    /onServiceDateChange=\{profile\.role === 'admin' && currentView === 'delivery'/,
  );
  assert.match(
    router,
    /serviceDate=\{profile\.role === 'admin' \? billingServiceDate : undefined\}/,
  );
  assert.match(
    migration,
    /v_service_date < \(clock_timestamp\(\) at time zone 'Asia\/Bangkok'\)::date/,
  );
  assert.match(
    migration,
    /v_service_date > \(clock_timestamp\(\) at time zone 'Asia\/Bangkok'\)::date[\s\S]*raise exception 'A delivery cannot be recorded for a future service date'/,
  );
  assert.match(migration, /public\.current_app_role\(\) <> 'admin'/);
  assert.match(
    migration,
    /before insert on public\.delivery_events[\s\S]*enforce_admin_backdated_delivery/,
  );
  assert.match(router, /serviceDate > toBangkokDateString\(\)/);
});

test('every migration has a unique version', () => {
  const migrationNames = readdirSync(
    new URL('../supabase/migrations/', import.meta.url),
  ).filter((name) => name.endsWith('.sql'));
  const versions = migrationNames.map((name) => name.split('_', 1)[0]);

  assert.equal(new Set(versions).size, versions.length);
});
