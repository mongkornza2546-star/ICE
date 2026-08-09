import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../supabase/migrations/0142_employee_stock_damage.sql', import.meta.url), 'utf8');
const stylesheet = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const router = readFileSync(new URL('../src/RoleRouter.tsx', import.meta.url), 'utf8');
const workspace = readFileSync(new URL('../src/EmployeeDeliveryWorkspace.tsx', import.meta.url), 'utf8');

test('employee damage validates both holding and aggregate stock before writing the ledger', () => {
  const holdingCheck = migration.indexOf('public.stock_balance_at(v_service_date, v_holding_location_id, v_item.ice_type_id)');
  const aggregateCheck = migration.indexOf('public.daily_aggregate_stock_balance_at(v_service_date, v_item.ice_type_id)');
  const insert = migration.indexOf('insert into public.stock_movements');
  assert.ok(holdingCheck >= 0 && aggregateCheck > holdingCheck && insert > aggregateCheck);
});

test('all three employee stock modes fit one row and navigation advertises damage', () => {
  const modeRules = [...stylesheet.matchAll(/\.employee-workspace--withdrawal \.employee-stock-mode\s*\{([^}]*)\}/g)];
  assert.equal(modeRules.length, 2);
  for (const rule of modeRules) {
    assert.match(rule[1], /grid-template-columns:\s*repeat\(3,/);
  }
  assert.match(router, /เติม \/ คืน \/ ละลาย/);
  assert.match(workspace, /เติมจากรถ[\s\S]*บันทึกน้ำแข็งละลาย/);
});

test('mobile employee content clears the fixed task navigation', () => {
  assert.match(
    stylesheet,
    /@media \(max-width: 679px\)[\s\S]*?\.employee-main\s*\{[^}]*padding:\s*15px 12px calc\(86px \+ env\(safe-area-inset-bottom\)\)/,
  );
});
