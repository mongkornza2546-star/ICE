import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('moved-out shops are deactivated rather than hard-deleted', () => {
  const migration = read('supabase/migrations/0099_deactivate_moved_out_shops.sql');

  assert.match(migration, /create or replace function public\.deactivate_shop/);
  assert.match(migration, /current_app_role\(\) <> 'admin'/);
  assert.match(migration, /from public\.shop_rented_tanks[\s\S]*returned_at is null/);
  assert.match(migration, /create trigger shops_prevent_deactivation_with_active_tanks/);
  assert.match(migration, /set status = 'inactive'/);
  assert.doesNotMatch(migration, /delete from public\.shops/);
});

test('shop settings presents a safe moved-out action', () => {
  const component = read('src/ShopSettings.tsx');

  assert.match(component, /deactivate_shop/);
  assert.match(component, /ปิดร้าน \/ ย้ายออก/);
  assert.match(component, /รับคืนถังเช่า/);
  assert.match(component, /ประวัติการส่งจะยังคงอยู่/);
});
