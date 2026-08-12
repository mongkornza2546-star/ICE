-- ============================================================
-- RESET ALL TEST TRANSACTIONS
--
-- ล้างข้อมูลทดสอบทั้งหมดของ:
--   - รอบส่ง / ประวัติส่งน้ำแข็ง / รับน้ำแข็งจากโรงงาน
--   - การส่งของ ยอดขาย รายการขาย และบิล
--   - การชำระเงิน รอบเก็บเงิน และคำขออนุมัติ
--   - การโอน/นับ/ปิดสต๊อก และ audit log ทดสอบ
--   - คิวคำสั่งออฟไลน์ ปัญหา sync และประวัติการตัดสินใจ
--
-- เก็บไว้:
--   users, shops, buildings, zones, routes, ice_types, prices,
--   payment profiles, stock locations, assignments และถังเช่า
--
-- ควร backup ฐานข้อมูลก่อนรัน เพราะ COMMIT แล้วย้อนกลับไม่ได้
-- ============================================================

-- STEP 1: PREVIEW (รันส่วนนี้ก่อน ไม่ลบข้อมูล)
select 'factory orders / stock movements' as data_group, count(*) as row_count
from public.stock_movements
union all
select 'delivery rounds', count(*) from public.delivery_rounds
union all
select 'delivery events / sales', count(*) from public.delivery_events
union all
select 'delivery charges / bills', count(*) from public.delivery_charges
union all
select 'payments / receipts', count(*) from public.payments
union all
select 'payment allocation changes', count(*) from public.payment_allocation_changes
union all
select 'refund obligations / settlements',
  (select count(*) from public.refund_obligations)
  + (select count(*) from public.refund_settlements)
union all
select 'delivery charge adjustments', count(*) from public.delivery_charge_adjustments
union all
select 'payment receipt snapshots', count(*) from public.payment_receipt_snapshots
union all
select 'delivery document snapshots', count(*) from public.delivery_charge_document_snapshots
union all
select 'document counters', count(*) from public.document_counters
union all
select 'collection runs', count(*) from public.collection_runs
union all
select 'offline commands', count(*) from public.employee_offline_commands
union all
select 'offline sync issues', count(*) from public.offline_sync_issues
union all
select 'offline sync issue decisions', count(*) from public.offline_sync_issue_decisions
union all
select 'credit due-date requests', count(*) from public.credit_due_date_requests
union all
select 'collection credit assignments', count(*) from public.collection_run_credit_charges
union all
select 'stock counts', count(*) from public.stock_count_snapshots
union all
select 'daily aggregate stock uses', count(*) from public.daily_stock_uses
union all
select 'audit logs', count(*) from public.audit_logs
order by data_group;


-- STEP 2: DELETE
-- 1) เลือกและรันตั้งแต่ BEGIN ถึง COMMIT ทั้งก้อน
-- 2) เอา -- หน้า SET LOCAL ออกเพื่อยืนยันการลบจริง
begin;

-- SET LOCAL app.confirm_reset_test_transactions = 'DELETE ALL TEST TRANSACTIONS';

do $$
begin
  if current_setting('app.confirm_reset_test_transactions', true)
      is distinct from 'DELETE ALL TEST TRANSACTIONS' then
    raise exception
      'Reset cancelled. Uncomment the SET LOCAL confirmation line first.';
  end if;
end;
$$;

-- ใช้ TRUNCATE ครั้งเดียวเพื่อรองรับ FK ที่เชื่อมกันแบบ RESTRICT/วนกลับ
-- ไม่ใช้ CASCADE เพื่อป้องกันไม่ให้ตาราง master/config ถูกล้างตามไป
truncate table
  public.offline_sync_issue_decisions,
  public.offline_sync_issues,
  public.employee_offline_commands,
  public.delivery_adjustment_items,
  public.delivery_charge_adjustments,
  public.refund_settlements,
  public.refund_obligations,
  public.payment_allocation_changes,
  public.payment_allocations,
  public.payment_receipt_snapshots,
  public.delivery_charge_document_snapshots,
  public.payments,
  public.collection_run_members,
  public.collection_run_credit_charges,
  public.collection_runs,
  public.credit_due_date_requests,
  public.delivery_charges,
  public.financial_approval_requests,
  public.factory_receipt_items,
  public.factory_receipts,
  public.daily_stock_use_items,
  public.daily_stock_uses,
  public.daily_aggregate_stock_closure_items,
  public.daily_aggregate_stock_closures,
  public.stock_count_variance_reviews,
  public.stock_count_snapshot_items,
  public.stock_count_snapshots,
  public.daily_stock_closure_items,
  public.daily_stock_closures,
  public.round_stock_snapshot_items,
  public.round_stock_snapshots,
  public.delivery_event_revisions,
  public.delivery_items,
  public.delivery_events,
  public.round_close_ice_summaries,
  public.round_close_summaries,
  public.round_ice_counts,
  public.round_stops,
  public.delivery_round_members,
  public.stock_movement_items,
  public.stock_movements,
  public.delivery_rounds,
  public.stock_cutover_runs,
  public.audit_logs
restart identity;

truncate table public.document_counters;

-- เลขที่ใบเสร็จถูกสร้างจาก sequence แยก จึงต้อง reset เอง
alter sequence if exists public.payment_receipt_number_seq restart with 1;
alter sequence if exists public.delivery_charge_number_seq restart with 1;
alter sequence if exists public.employee_offline_resolution_version_seq restart with 1;

commit;


-- STEP 3: VERIFY (ควรได้ 0 ทุกช่อง)
select
  (select count(*) from public.stock_movements) as stock_movements,
  (select count(*) from public.delivery_rounds) as delivery_rounds,
  (select count(*) from public.delivery_events) as sales,
  (select count(*) from public.delivery_charges) as bills,
  (select count(*) from public.payments) as payments,
  (select count(*) from public.payment_allocation_changes) as payment_allocation_changes,
  (select count(*) from public.refund_obligations) as refund_obligations,
  (select count(*) from public.refund_settlements) as refund_settlements,
  (select count(*) from public.delivery_charge_adjustments) as delivery_charge_adjustments,
  (select count(*) from public.delivery_adjustment_items) as delivery_adjustment_items,
  (select count(*) from public.payment_receipt_snapshots) as receipt_snapshots,
  (select count(*) from public.delivery_charge_document_snapshots) as delivery_document_snapshots,
  (select count(*) from public.document_counters) as document_counters,
  (select count(*) from public.credit_due_date_requests) as credit_due_date_requests,
  (select count(*) from public.collection_run_credit_charges) as credit_assignments,
  (select count(*) from public.employee_offline_commands) as offline_commands,
  (select count(*) from public.offline_sync_issues) as offline_sync_issues,
  (select count(*) from public.offline_sync_issue_decisions) as offline_sync_issue_decisions,
  (select count(*) from public.audit_logs) as audit_logs;

-- หมายเหตุ: evidence_path ใน payments ถูกล้างแล้ว แต่ไฟล์หลักฐานใน Supabase Storage
-- bucket "payment-evidence" ต้องลบผ่าน Storage API/Dashboard เท่านั้น ห้าม DELETE storage.objects ตรงๆ
