import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('delivery writes lock the same round row used by close_delivery_round', () => {
  const migration = read('supabase/migrations/0007_daily_mobile_stock.sql');
  const deliveryMigration = migration.slice(
    migration.lastIndexOf('create or replace function public.record_delivery('),
  );
  const closeMigration = read('supabase/migrations/0004_manager_round_control.sql');

  assert.match(deliveryMigration, /where s\.id = p_round_stop_id\s+for update of r;/);
  assert.match(closeMigration, /where id = p_round_id\s+for update;/);
});

test('shop location is re-derived when any location column is written', () => {
  const migration = read('supabase/migrations/0005_building_zones.sql');

  assert.match(
    migration,
    /before insert or update of zone_id, building_id, floor_or_zone on public\.shops/,
  );
  assert.match(migration, /new\.building_id := v_building_id;/);
  assert.match(migration, /new\.floor_or_zone := v_zone_name;/);
});

test('Excel shop import is parsed client-side and committed through one admin RPC', () => {
  const migration = read('supabase/migrations/0010_shop_catalog_excel_import.sql');
  const component = read('src/ShopSettings.tsx');
  const parser = read('src/lib/shopImport.ts');

  assert.match(migration, /create or replace function public\.import_shop_catalog\(p_rows jsonb\)/);
  assert.match(migration, /Only an admin can import shop settings/);
  assert.match(migration, /buildings_code_ci_uidx/);
  assert.match(migration, /government_shop_code text/);
  assert.doesNotMatch(migration, /1000000/);
  assert.match(component, /parseShopImportFile/);
  assert.match(component, /supabase\.rpc\('import_shop_catalog'/);
  assert.match(component, /shop-import-template\.xlsx/);
  assert.match(component, /p_government_shop_code/);
  assert.match(parser, /readXlsxFile/);
  assert.match(parser, /รหัสตึก/);
  assert.match(parser, /รหัสศูนย์ราชการ/);
});

test('new rounds and shop settings do not depend on routes', () => {
  const migration = read('supabase/migrations/0006_rounds_without_routes.sql');
  const component = read('src/ShopSettings.tsx');
  const app = read('src/App.tsx');

  assert.match(migration, /alter column route_id drop not null/);
  assert.match(migration, /from public\.shops s/);
  assert.match(migration, /create or replace function public\.save_shop\(/);
  assert.match(component, /supabase\.rpc\('save_shop'/);
  assert.doesNotMatch(component, /route_assignments|route_shops|save_shop_with_routes/);
  assert.doesNotMatch(app, /p_route_id|routeId|routesResponse/);
});

test('manager summary rejects stale round responses before close', () => {
  const component = read('src/ManagerRoundControl.tsx');

  assert.match(component, /requestId !== summaryRequestId\.current/);
  assert.match(component, /summaryRoundId !== round\.id/);
});

test('round leads can cancel an unused open round with a required audit reason', () => {
  const migration = read('supabase/migrations/0027_cancel_delivery_round.sql');
  const component = read('src/ManagerRoundControl.tsx');
  const dashboard = read('src/ManagerDashboard.tsx');

  assert.match(migration, /create or replace function public\.delivery_round_cancellation_blockers\(/);
  assert.match(migration, /create or replace function public\.get_delivery_round_cancellation_state\(/);
  assert.match(migration, /create or replace function public\.cancel_delivery_round\(/);
  assert.match(migration, /current_app_role\(\) not in \('admin', 'round_lead'\)/);
  assert.match(migration, /A cancellation reason is required/);
  assert.match(migration, /from public\.delivery_events event/);
  assert.match(migration, /from public\.stock_movements movement/);
  assert.match(migration, /set status = 'closed'/);
  assert.match(migration, /cancellation_reason = trim\(p_reason\)/);
  assert.match(migration, /insert into public\.audit_logs/);
  assert.match(migration, /stock_movements_reject_cancelled_round/);
  assert.match(migration, /for key share/);
  assert.match(migration, /insert into public\.round_stock_snapshots/);
  assert.match(migration, /v_captured_at := clock_timestamp\(\)/);
  assert.match(component, /supabase\.rpc\('cancel_delivery_round'/);
  assert.match(component, /supabase\.rpc\('get_delivery_round_cancellation_state'/);
  assert.match(component, /ยกเลิกการเปิดรอบ/);
  assert.match(component, /ยืนยันยกเลิกรอบ/);
  assert.match(dashboard, /round\.cancelled_at \? \(/);
  assert.match(dashboard, /round\.cancellation_reason/);
  assert.match(dashboard, /ไม่นับรวมในงานค้าง/);
});

test('day-wide stock movements are serialized and idempotent', () => {
  const migration = read('supabase/migrations/0007_daily_mobile_stock.sql');

  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(p_idempotency_key::text, 0\)\)/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(v_service_date::text, 0\)\)/);
  assert.match(migration, /where movement\.idempotency_key = p_idempotency_key/);
  assert.match(migration, /The source location does not have enough stock/);
});

test('stock balance includes transfers and automatic delivery deductions', () => {
  const migration = read('supabase/migrations/0007_daily_mobile_stock.sql');

  assert.match(migration, /movement\.to_location_id = p_location_id/);
  assert.match(migration, /movement\.from_location_id = p_location_id/);
  assert.match(migration, /event\.source_stock_location_id = p_location_id/);
  assert.match(migration, /before insert on public\.delivery_events/);
  assert.match(migration, /before insert or update of zone_id, building_id, stock_location_id on public\.shops/);
});

test('stock UI reuses the retry key for the same movement payload', () => {
  const component = read('src/ManagerStockControl.tsx');

  assert.match(component, /pendingRequest\.current\?\.signature !== signature/);
  assert.match(component, /const submittedRequestKey = pendingRequest\.current\.key/);
  assert.match(component, /p_idempotency_key: submittedRequestKey/);
  assert.match(component, /supabase\.rpc\('get_stock_control_summary'/);
  assert.match(component, /supabase\.rpc\('record_stock_movement'/);
});

test('manager overview does not replace the operational manager workspace', () => {
  const app = read('src/App.tsx');

  assert.match(app, /useState<AdminView>\('manager_overview'\)/);
  assert.match(app, /currentView === 'manager_overview'[\s\S]*<ManagerDashboard[\s\S]*onNavigate=\{setActiveView\}/);
  assert.doesNotMatch(app, /currentView === 'manager'\s*\?\s*\(\s*<ManagerDashboard/);
  assert.match(app, /currentView === 'delivery'[\s\S]*<EmployeeDeliveryWorkspace onDraftStateChange=\{setDeliveryDraftState\} requestScope=\{profile\.id\} stockSourceLabel="จุดสต๊อกของร้าน" \/>/);
  assert.match(app, /<RoundWorkspace mode="manager" profile=\{profile\} \/>/);
});

test('couriers use the full-screen employee delivery workspace', () => {
  const app = read('src/App.tsx');
  const deliveryWorkspace = read('src/EmployeeDeliveryWorkspace.tsx');
  const employeeLayout = read('src/EmployeeLayout.tsx');

  assert.match(app, /profile\.role === 'courier'[\s\S]*<EmployeeLayout[\s\S]*signOutDisabled=\{deliveryDraftState\.submitting\}[\s\S]*<EmployeeDeliveryWorkspace enableAssignedStockFlow onDraftStateChange=\{setDeliveryDraftState\} requestScope=\{profile\.id\} \/>/);
  assert.match(app, /deliveryDraftState\.submitting[\s\S]*deliveryDraftState\.dirty[\s\S]*window\.confirm/);
  assert.match(employeeLayout, /disabled=\{signOutDisabled\}/);
  assert.match(app, /addEventListener\('beforeunload', handleBeforeUnload\)/);
  assert.match(app, /event\.preventDefault\(\)[\s\S]*event\.returnValue = ''/);
  assert.match(deliveryWorkspace, /supabase\.rpc\('get_employee_stock_state',[\s\S]*p_round_id: roundId/);
  assert.match(deliveryWorkspace, /supabase\.rpc\('record_employee_stock_transfer',[\s\S]*p_round_id: payload\.roundId[\s\S]*p_items: payload\.items[\s\S]*p_idempotency_key: payload\.idempotencyKey/);
});

test('manager dashboard is driven by live round, stock, and daily-close data', () => {
  const component = read('src/ManagerDashboard.tsx');

  assert.match(component, /\.from\('delivery_rounds'\)/);
  assert.match(component, /client\.rpc\('get_round_control_summary'/);
  assert.match(component, /client\.rpc\('get_stock_control_summary'/);
  assert.match(component, /client\.rpc\('get_daily_stock_close_state'/);
  assert.match(component, /p_service_date: serviceDate/);
  assert.doesNotMatch(component, /if \(rounds\.length === 0\)[\s\S]*stock: null/);
  assert.match(component, /currentRequest !== requestId\.current/);
  assert.doesNotMatch(component, /เครดิต|รับชำระ|ใบเสร็จ/);
});

test('stock operations stay separate while the router exposes combined location management', () => {
  const router = read('src/RoleRouter.tsx');
  const layout = read('src/AdminLayout.tsx');
  const workspace = read('src/RoundWorkspace.tsx');

  assert.match(layout, /stock_operations: \{ label: 'โอน \/ ตรวจ \/ ปิดสต๊อก'/);
  assert.match(layout, /location_management: \{ label: 'สถานที่และจุดถือครอง'/);
  assert.match(router, /currentView === 'stock_operations'[\s\S]*<RoundWorkspace mode="stock"/);
  assert.match(router, /currentView === 'location_management'[\s\S]*<LocationManagementSettings canManageBuildings=\{profile\.role === 'admin'\} \/>/);
  assert.match(workspace, /<ManagerStockControl[\s\S]*serviceDate=\{stockServiceDate\}/);
});

test('admin reference settings manage existing profiles and ice types without creating accounts', () => {
  const app = read('src/App.tsx');
  const component = read('src/AdminReferenceSettings.tsx');
  const reviewFixMigration = read('supabase/migrations/0009_phase_3_review_fixes.sql');

  assert.match(app, /profile\.role === 'admin'[\s\S]*'reference_settings'/);
  assert.match(app, /currentView === 'reference_settings'[\s\S]*<AdminReferenceSettings \/>/);
  assert.match(component, /profile\.role !== 'admin'/);
  assert.match(component, /\.from\('users'\)[\s\S]*\.update\(/);
  assert.doesNotMatch(component, /auth\.admin|signUp\(/);
  assert.match(component, /isCurrentUser \? original\.role : userDraft\.role/);
  assert.match(component, /client\.rpc\('save_ice_type'/);
  assert.match(reviewFixMigration, /An ice type with stock on an open service day cannot be deactivated/);
  assert.match(reviewFixMigration, /drop policy if exists "admins update ice types"/);
});

test('factory order persists by service date and active truck before reporting success', () => {
  const component = read('src/FactoryOrderPage.tsx');
  const migration = read('supabase/migrations/0011_round_independent_factory_orders.sql');

  assert.match(component, /client\.rpc\('get_factory_order_summary'/);
  assert.match(component, /supabase\.rpc\('record_factory_order'/);
  assert.match(component, /p_service_date: serviceDate/);
  assert.match(component, /p_truck_location_id: truckId/);
  assert.match(component, /p_idempotency_key: requestKey/);
  assert.match(component, /activeSelection\.current !== submittedSelection/);
  assert.match(component, /setSummary\(null\);[\s\S]*setQuantities\(\{\}\);/);
  assert.match(component, /if \(submitError\)[\s\S]*setError\(submitError\.message\)[\s\S]*else[\s\S]*setSuccess/);
  assert.doesNotMatch(component, /setConfirmed\(true\)/);
  assert.doesNotMatch(component, /\.from\('delivery_rounds'\)|p_round_id/);
  assert.match(migration, /alter column round_id drop not null/);
  assert.match(migration, /'order_count'[\s\S]*'ordered_totals'[\s\S]*'recent_movements'/);
  assert.match(migration, /p_service_date[\s\S]*p_truck_location_id[\s\S]*round_id,[\s\S]*null,[\s\S]*'factory_order'/);
});

test('delivery writes share the day stock lock and reject insufficient stock', () => {
  const migration = read('supabase/migrations/0007_daily_mobile_stock.sql');
  const deliveryOverride = migration.slice(
    migration.lastIndexOf('create or replace function public.record_delivery('),
  );

  assert.match(deliveryOverride, /pg_advisory_xact_lock\(hashtextextended\(p_idempotency_key::text, 0\)\)/);
  assert.match(deliveryOverride, /pg_advisory_xact_lock\(hashtextextended\(v_service_date::text, 0\)\)/);
  assert.match(deliveryOverride, /public\.stock_balance_at\(v_service_date, v_source_location_id, v_item\.ice_type_id\)/);
  assert.match(deliveryOverride, /The source location does not have enough stock/);
});

test('stock ledger starts with new delivery events instead of rewriting history', () => {
  const migration = read('supabase/migrations/0007_daily_mobile_stock.sql');

  assert.doesNotMatch(migration, /update public\.delivery_events event\s+set source_stock_location_id/);
  assert.doesNotMatch(migration, /alter table public\.delivery_events alter column source_stock_location_id set not null/);
  assert.match(migration, /Existing delivery events intentionally remain outside the stock ledger/);
});

test('closed rounds show a read-only stock snapshot while the day view stays live', () => {
  const migration = read('supabase/migrations/0007_daily_mobile_stock.sql');
  const snapshotMigration = read('supabase/migrations/0026_round_stock_snapshots.sql');
  const component = read('src/ManagerStockControl.tsx');
  const workspace = read('src/RoundWorkspace.tsx');
  const stockMovement = migration.slice(
    migration.indexOf('create or replace function public.record_stock_movement('),
    migration.indexOf('create or replace function public.record_delivery('),
  );

  assert.match(stockMovement, /p_kind = 'factory_order' and not v_day_has_open_round/);
  assert.doesNotMatch(stockMovement, /v_round_status <> 'open'/);
  assert.match(snapshotMigration, /create table public\.round_stock_snapshot_items/);
  assert.match(snapshotMigration, /insert into public\.round_stock_snapshot_items/);
  assert.match(snapshotMigration, /'is_snapshot', v_is_snapshot/);
  assert.match(snapshotMigration, /'snapshot_at', v_snapshot_at/);
  assert.match(component, /const isRoundSnapshot = round\?\.status === 'closed'/);
  assert.match(component, /สต๊อกทั้งวัน ณ เวลาปิดรอบ/);
  assert.match(component, /!isRoundSnapshot \? \(/);
  assert.match(workspace, /สต๊อกปัจจุบันของวัน/);
  assert.match(workspace, /stockRound\?\.status === 'open' \? stockRound : null/);
  assert.match(workspace, /selectedRound\?\.service_date === stockServiceDate && !selectedRound\.cancelled_at/);
  assert.match(snapshotMigration, /stock_movements_stamp_effective_time/);
  assert.match(snapshotMigration, /new\.recorded_at := clock_timestamp\(\)/);
});

test('recoverable auth session errors sign users out with actionable guidance', () => {
  const app = read('src/App.tsx');
  const authErrors = read('src/lib/authErrors.ts');

  assert.match(authErrors, /jwt issued at future/i);
  assert.match(authErrors, /เวลาในเครื่องหรือเซสชันไม่ตรงกับระบบ/);
  assert.match(authErrors, /เซสชันหมดอายุแล้ว/);
  assert.match(app, /const \[authNotice, setAuthNotice\] = useState<string \| null>\(null\)/);
  assert.match(app, /await supabase\?\.auth\.signOut\(\)/);
  assert.match(app, /<SignInPanel notice=\{authNotice\} \/>/);
  assert.match(app, /if \(await onRecoverableSessionError\(error\.message\)\)/);
});

test('stock UI ignores a movement response after the selected round changes', () => {
  const component = read('src/ManagerStockControl.tsx');

  assert.match(component, /activeRoundId\.current !== submittedRoundId/);
  assert.match(component, /const submittedRoundId = round\.id/);
});

test('round creation no longer treats round-loaded quantity as day stock', () => {
  const app = read('src/App.tsx');
  const roundControl = read('src/ManagerRoundControl.tsx');
  const managerMigration = read('supabase/migrations/0008_complete_manager_operations.sql');
  const finalRoundClose = managerMigration.slice(
    managerMigration.indexOf('create or replace function public.close_delivery_round('),
    managerMigration.indexOf('create or replace function public.revise_delivery_event('),
  );

  assert.doesNotMatch(app, /loadedQuantities|น้ำแข็งยกออกตั้งต้น/);
  assert.match(app, /quantity: 0/);
  assert.doesNotMatch(roundControl, /label="เติมเพิ่ม"|label="เหลือ"|label="เสียหาย"/);
  assert.match(roundControl, /รอบเป็นกลุ่มรายการขาย ไม่ใช่สต๊อก/);
  assert.match(finalRoundClose, /for update;/);
  assert.match(finalRoundClose, /insert into public\.round_close_summaries/);
  assert.doesNotMatch(finalRoundClose, /round_close_ice_summaries|update public\.round_ice_counts/);
});

test('operational stock locations are saved through a role-checked RPC', () => {
  const migration = read('supabase/migrations/0008_complete_manager_operations.sql');
  const component = read('src/StockLocationSettings.tsx');

  assert.match(migration, /create or replace function public\.save_stock_location\(/);
  assert.match(migration, /p_kind not in \('team', 'small_vehicle', 'reserve_bin', 'front_vehicle'\)/);
  assert.match(migration, /add column assigned_user_id uuid references public\.users\(id\)/);
  assert.match(migration, /An employee stock location must name its assigned user/);
  assert.match(migration, /A stock location with an open balance cannot be deactivated or reassigned/);
  assert.match(component, /supabase\.rpc\('save_stock_location'/);
  assert.match(component, /p_assigned_user_id: draft\.assignedUserId/);
});

test('returned-stock counts snapshot system, actual, and unexplained variance', () => {
  const migration = read('supabase/migrations/0008_complete_manager_operations.sql');
  const component = read('src/ManagerStockControl.tsx');
  const countFunction = migration.slice(
    migration.indexOf('create or replace function public.record_location_count('),
    migration.indexOf('create or replace function public.get_location_count_history('),
  );

  assert.match(migration, /create table public\.stock_count_snapshots/);
  assert.match(migration, /variance_quantity = actual_quantity - system_quantity/);
  assert.match(migration, /create or replace function public\.record_location_count\(/);
  assert.match(
    countFunction,
    /pg_advisory_xact_lock[\s\S]*where service_date = v_service_date and status = 'closed'/,
  );
  assert.match(component, /supabase\.rpc\('record_location_count'/);
  assert.match(component, /ไม่ปรับยอดอัตโนมัติ/);
});

test('returned-stock snapshots accept half-bag quantities', () => {
  const migration = read('supabase/migrations/0025_half_bag_location_counts.sql');
  const component = read('src/ManagerStockControl.tsx');

  assert.match(migration, /actual_quantity type numeric\(12, 1\)/);
  assert.match(migration, /actual_quantity numeric\(12, 1\)/);
  assert.match(migration, /whole or half-bag count/);
  assert.match(component, /step=\{0\.5\}/);
});

test('manager delivery corrections restore stock and require an audit reason', () => {
  const migration = read('supabase/migrations/0008_complete_manager_operations.sql');
  const component = read('src/ManagerDeliveryAdjustments.tsx');

  assert.match(migration, /create or replace function public\.revise_delivery_event\(/);
  assert.match(migration, /A revision reason is required/);
  assert.match(migration, /set status = 'cancelled'/);
  assert.match(migration, /corrects_event_id/);
  assert.match(migration, /stock_balance_at\(v_service_date, v_source_location_id, v_item\.ice_type_id\)/);
  assert.match(component, /supabase\.rpc\('revise_delivery_event'/);
  assert.match(component, /p_reason: reason\.trim\(\)/);
});

test('daily close counts every point, returns actual stock, and locks the service date', () => {
  const migration = read('supabase/migrations/0008_complete_manager_operations.sql');
  const component = read('src/ManagerStockControl.tsx');
  const roundGuard = migration.slice(
    migration.indexOf('create or replace function public.reject_round_on_closed_day()'),
    migration.indexOf('create trigger delivery_rounds_reject_closed_day'),
  );

  assert.match(migration, /create table public\.daily_stock_closures/);
  assert.match(migration, /perform pg_advisory_xact_lock\(hashtextextended\(v_service_date::text, 0\)\)/);
  assert.match(migration, /Close every delivery round before closing daily stock/);
  assert.match(migration, /'รวบรวมยอดนับจริงเพื่อส่งคืนโรงงาน'/);
  assert.match(migration, /'ส่งยอดน้ำแข็งนับจริงคงเหลือทั้งหมดกลับโรงงาน'/);
  assert.match(migration, /delivery_rounds_reject_closed_day/);
  assert.match(
    roundGuard,
    /pg_advisory_xact_lock[\s\S]*where service_date = new.service_date and status = 'closed'/,
  );
  assert.match(component, /supabase\.rpc\('close_daily_stock'/);
  assert.match(component, /ยืนยันยอดจริง ส่งคืนโรงงาน และปิดวัน/);
});
