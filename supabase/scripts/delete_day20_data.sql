-- ============================================================
-- DELETE ข้อมูลสั่งน้ำแข็ง (factory_order), โอนย้ายน้ำแข็ง (transfer),
-- Snapshot นับสต็อก และ ประวัติเปิด/ปิดรอบ (delivery_rounds)
-- สำหรับวันที่ 20 กรกฎาคม 2569 (20/07/2026)
--
-- วิธีใช้:
--   1. รัน STEP 1 (SELECT) เพื่อดูข้อมูลก่อน
--   2. รัน STEP 2 ด้วย ROLLBACK ก่อน เพื่อทดสอบ
--   3. เมื่อมั่นใจแล้ว เปลี่ยน ROLLBACK เป็น COMMIT
-- ============================================================

-- ============================================================
-- STEP 1: ดูข้อมูลที่จะถูกลบก่อน (preview) — safe, read-only
-- ============================================================

-- 1A. รายการสั่งน้ำแข็งจากโรงงาน (factory_order)
SELECT
  m.id,
  m.kind,
  m.service_date,
  m.status,
  loc.name AS to_location,
  m.recorded_at,
  u.display_name AS recorded_by,
  (
    SELECT jsonb_agg(jsonb_build_object(
      'ice_type', ice.name,
      'quantity', item.quantity,
      'unit', ice.unit
    ) ORDER BY ice.code)
    FROM public.stock_movement_items item
    JOIN public.ice_types ice ON ice.id = item.ice_type_id
    WHERE item.movement_id = m.id
  ) AS items
FROM public.stock_movements m
LEFT JOIN public.stock_locations loc ON loc.id = m.to_location_id
LEFT JOIN public.users u ON u.id = m.recorded_by
WHERE m.service_date = '2026-07-20'
  AND m.kind = 'factory_order'
ORDER BY m.recorded_at;

-- 1B. รายการโอนย้ายน้ำแข็ง (transfer)
SELECT
  m.id,
  m.kind,
  m.service_date,
  m.status,
  from_loc.name AS from_location,
  to_loc.name   AS to_location,
  m.recorded_at,
  u.display_name AS recorded_by,
  (
    SELECT jsonb_agg(jsonb_build_object(
      'ice_type', ice.name,
      'quantity', item.quantity,
      'unit', ice.unit
    ) ORDER BY ice.code)
    FROM public.stock_movement_items item
    JOIN public.ice_types ice ON ice.id = item.ice_type_id
    WHERE item.movement_id = m.id
  ) AS items
FROM public.stock_movements m
LEFT JOIN public.stock_locations from_loc ON from_loc.id = m.from_location_id
LEFT JOIN public.stock_locations to_loc   ON to_loc.id  = m.to_location_id
LEFT JOIN public.users u ON u.id = m.recorded_by
WHERE m.service_date = '2026-07-20'
  AND m.kind = 'transfer'
ORDER BY m.recorded_at;

-- 1C. รายการ Snapshot นับสต็อก (stock_count_snapshots)
SELECT
  s.id,
  s.service_date,
  loc.name       AS location_name,
  u.display_name AS counted_by,
  s.counted_at,
  s.note,
  (
    SELECT jsonb_agg(jsonb_build_object(
      'ice_type',   ice.name,
      'system_qty', item.system_quantity,
      'actual_qty', item.actual_quantity,
      'variance',   item.variance_quantity,
      'unit',       ice.unit
    ) ORDER BY ice.code)
    FROM public.stock_count_snapshot_items item
    JOIN public.ice_types ice ON ice.id = item.ice_type_id
    WHERE item.snapshot_id = s.id
  ) AS items
FROM public.stock_count_snapshots s
JOIN public.stock_locations loc ON loc.id = s.location_id
JOIN public.users u ON u.id = s.counted_by
WHERE s.service_date = '2026-07-20'
ORDER BY s.counted_at;

-- 1D. รอบส่งที่เปิด/ปิดในวันนี้ (delivery_rounds)
SELECT
  r.id,
  r.name,
  r.service_date,
  r.status,
  r.opened_at,
  r.closed_at,
  opener.display_name AS opened_by,
  closer.display_name AS closed_by,
  (SELECT count(*) FROM public.round_stops rs WHERE rs.round_id = r.id) AS stop_count,
  (SELECT count(*) FROM public.delivery_events de
   JOIN public.round_stops rs ON rs.id = de.round_stop_id
   WHERE rs.round_id = r.id AND de.status = 'active') AS delivery_count
FROM public.delivery_rounds r
JOIN public.users opener ON opener.id = r.opened_by
LEFT JOIN public.users closer ON closer.id = r.closed_by
WHERE r.service_date = '2026-07-20'
ORDER BY r.opened_at;


-- ============================================================
-- STEP 2: DELETE — copy ไปรันแยกต่างหาก อย่ารันพร้อมกับ STEP 1
-- เริ่มด้วย ROLLBACK ก่อน เมื่อมั่นใจเปลี่ยนเป็น COMMIT
-- ============================================================

BEGIN;

  -- 2A. ลบ stock_movement_items (child ของ factory_order + transfer)
  DELETE FROM public.stock_movement_items
  WHERE movement_id IN (
    SELECT id
    FROM public.stock_movements
    WHERE service_date = '2026-07-20'
      AND kind IN ('factory_order', 'transfer', 'damage', 'return_to_factory')
  );

  -- 2B. ลบ Snapshot items ก่อน (child table)
  DELETE FROM public.stock_count_snapshot_items
  WHERE snapshot_id IN (
    SELECT id FROM public.stock_count_snapshots
    WHERE service_date = '2026-07-20'
  );

  -- 2C. ลบ Snapshot หลัก
  DELETE FROM public.stock_count_snapshots
  WHERE service_date = '2026-07-20';

  -- 2D. ลบ audit_logs ที่เกี่ยวข้องกับ stock_movements
  DELETE FROM public.audit_logs
  WHERE entity_type = 'stock_movements'
    AND entity_id IN (
      SELECT id
      FROM public.stock_movements
      WHERE service_date = '2026-07-20'
        AND kind IN ('factory_order', 'transfer', 'damage', 'return_to_factory')
    );

  -- 2E. ลบ stock_movements (ทุก kind ที่ไม่ใช่ delivery)
  DELETE FROM public.stock_movements
  WHERE service_date = '2026-07-20'
    AND kind IN ('factory_order', 'transfer', 'damage', 'return_to_factory');

  -- 2F. ลบรายการสินค้าที่ส่ง (delivery_items → child ของ delivery_events)
  DELETE FROM public.delivery_items
  WHERE delivery_event_id IN (
    SELECT de.id
    FROM public.delivery_events de
    JOIN public.round_stops rs ON rs.id = de.round_stop_id
    JOIN public.delivery_rounds r ON r.id = rs.round_id
    WHERE r.service_date = '2026-07-20'
  );

  -- 2G. ลบ delivery_event_revisions (cancel/correct history)
  DELETE FROM public.delivery_event_revisions
  WHERE original_event_id IN (
    SELECT de.id
    FROM public.delivery_events de
    JOIN public.round_stops rs ON rs.id = de.round_stop_id
    JOIN public.delivery_rounds r ON r.id = rs.round_id
    WHERE r.service_date = '2026-07-20'
  );

  -- 2H. ลบ delivery_events
  DELETE FROM public.delivery_events
  WHERE round_stop_id IN (
    SELECT rs.id
    FROM public.round_stops rs
    JOIN public.delivery_rounds r ON r.id = rs.round_id
    WHERE r.service_date = '2026-07-20'
  );

  -- 2I. ลบ round_stops
  DELETE FROM public.round_stops
  WHERE round_id IN (
    SELECT id FROM public.delivery_rounds
    WHERE service_date = '2026-07-20'
  );

  -- 2J. ลบ round_ice_counts
  DELETE FROM public.round_ice_counts
  WHERE round_id IN (
    SELECT id FROM public.delivery_rounds
    WHERE service_date = '2026-07-20'
  );

  -- 2K. ลบ round_close_ice_summaries → round_close_summaries
  DELETE FROM public.round_close_ice_summaries
  WHERE round_id IN (
    SELECT id FROM public.delivery_rounds
    WHERE service_date = '2026-07-20'
  );

  DELETE FROM public.round_close_summaries
  WHERE round_id IN (
    SELECT id FROM public.delivery_rounds
    WHERE service_date = '2026-07-20'
  );

  -- 2L. ลบ daily_stock_closure_items → daily_stock_closures
  -- (daily_stock_closures มี round_id NOT NULL FK ไปหา delivery_rounds)
  DELETE FROM public.daily_stock_closure_items
  WHERE service_date = '2026-07-20';

  DELETE FROM public.daily_stock_closures
  WHERE service_date = '2026-07-20';

  -- 2M. ลบ round_stock_snapshot_items → round_stock_snapshots
  DELETE FROM public.round_stock_snapshot_items
  WHERE round_id IN (
    SELECT id FROM public.delivery_rounds
    WHERE service_date = '2026-07-20'
  );

  DELETE FROM public.round_stock_snapshots
  WHERE round_id IN (
    SELECT id FROM public.delivery_rounds
    WHERE service_date = '2026-07-20'
  );

  -- 2M. ลบ delivery_round_members
  DELETE FROM public.delivery_round_members
  WHERE round_id IN (
    SELECT id FROM public.delivery_rounds
    WHERE service_date = '2026-07-20'
  );

  -- 2N. ลบ audit_logs ที่เกี่ยวข้องกับ delivery_rounds
  DELETE FROM public.audit_logs
  WHERE entity_type IN ('delivery_rounds', 'delivery_events', 'round_stops')
    AND entity_id IN (
      SELECT r.id FROM public.delivery_rounds r WHERE r.service_date = '2026-07-20'
      UNION
      SELECT rs.id FROM public.round_stops rs
      JOIN public.delivery_rounds r ON r.id = rs.round_id
      WHERE r.service_date = '2026-07-20'
    );

  -- 2O. ลบ delivery_rounds (สุดท้าย)
  DELETE FROM public.delivery_rounds
  WHERE service_date = '2026-07-20';

COMMIT;
-- ⚠️ เปลี่ยนเป็น ROLLBACK ถ้ายังไม่แน่ใจ
