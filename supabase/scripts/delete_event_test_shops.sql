-- ============================================================
-- SCRIPT: ลบรายชื่อร้าน / บูธทดสอบในงานอีเวนต์ (DELETE EVENT TEST SHOPS)
--
-- วัตถุประสงค์:
--   ลบข้อมูลร้านค้าและบูธทดสอบของอีเวนต์ที่ระบุด้วย event_job_id เพียงงานเดียว
--
-- สิ่งที่สคริปต์นี้ทำ:
--   1. ลบรายการเข้าร่วมงานในอีเวนต์เป้าหมาย (public.event_participations)
--   2. ลบร้านค้าที่ถูกสร้างขึ้นสำหรับอีเวนต์นี้โดยเฉพาะ (public.shops ที่มี event_job_id ตรงกับงาน)
--      หากมี "ร้านค้าหลักเดิม" ที่ถูกดึงมาร่วมงาน สคริปต์จะแค่ถอดออกจากงาน
--      แต่จะไม่ลบร้านค้าหลักนั้นออกจาก public.shops
--   3. ลบ request ประวัติการสร้างบูธแบบกลุ่ม (public.event_shop_creation_requests)
--   4. ลบ settlement context / pilot ที่ผูกกับร้านในงาน (ถ้ามี)
--   5. ลบจุดส่ง (round_stops) และรายการส่ง/บิลทดสอบที่ผูกกับบูธของงานนี้ (ถ้ามี)
--   6. ลบโซนของอีเวนต์ที่ถูกสร้างอัตโนมัติ (หากไม่มีร้านอื่นใช้งานแล้ว)
--
-- ขอบเขตที่ตั้งใจเก็บไว้:
--   - event_jobs และ event_job_config_versions (เก็บโครงงานอีเวนต์ไว้)
--   - ร้านประจำ (shops.event_job_id IS NULL)
--   - Daily Close ที่ปิดแล้ว; หากพบ payment ของงานอยู่ใน Daily Close สคริปต์จะหยุด
--   - อาคาร/stock location ที่เคยสร้างให้งาน เพราะอาจมีประวัติสต๊อกอ้างอิงอยู่
--   - ไฟล์หลักฐานใน Storage; สคริปต์จะแสดง path ให้ลบผ่าน Storage API ภายหลัง
--
-- วิธีใช้งานใน Supabase SQL Editor:
--   1. รัน STEP 0.1 เพื่อหา event_job_id
--   2. ใส่ UUID ที่ STEP 0.2 (มีที่เดียว) แล้วรัน STEP 0.2 + STEP 1 เพื่อ Preview
--   3. ใน STEP 2 (DELETE TRANSACTION):
--      - เอาเครื่องหมาย -- หน้าบรรทัด SET LOCAL ออก เพื่อยืนยัน
--      - ครั้งแรกสามารถรันโดยคง ROLLBACK; ไว้ เพื่อดูผลลัพธ์การลบจำลอง
--      - เมื่อผลถูกต้อง ให้เปลี่ยน ROLLBACK; ท้ายไฟล์เป็น COMMIT; แล้วรันอีกครั้ง
-- ============================================================

-- STEP 0.1: LOOKUP (SELECT อย่างเดียว)
SELECT
  id AS event_job_id,
  name AS event_name,
  status AS event_status,
  start_date,
  end_date,
  location,
  contact_name,
  contact_phone,
  created_at
FROM public.event_jobs
ORDER BY created_at DESC;

-- STEP 0.2: TARGET
-- แทน UUID ศูนย์ด้านล่างด้วย event_job_id จาก STEP 0.1 แล้วรันไฟล์นี้ทั้งไฟล์
-- ใช้ transaction/session setting แทน temp table เพื่อให้ Supabase SQL Editor
-- รัน multi-statement selection ได้โดยไม่เจอ relation does not exist
SELECT set_config(
  'app.event_cleanup_target_id',
  '00000000-0000-0000-0000-000000000000', -- << เปลี่ยนเฉพาะค่านี้
  false
);

DO $$
BEGIN
  IF current_setting('app.event_cleanup_target_id')::uuid
      = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'ยังไม่ได้ระบุ event_job_id ที่ STEP 0.2';
  END IF;
END;
$$;

-- ============================================================
-- STEP 1: PREVIEW (ปลอดภัย — SELECT ดูข้อมูลก่อน ไม่มีการลบข้อมูล)
-- ============================================================

-- 1.1 ตรวจสอบข้อมูลงานอีเวนต์เป้าหมาย
SELECT
  job.id AS event_job_id,
  job.name AS event_name,
  job.status AS event_status,
  job.start_date,
  job.end_date,
  job.location,
  job.contact_name,
  job.contact_phone,
  job.created_at
FROM public.event_jobs job
WHERE job.id = current_setting('app.event_cleanup_target_id')::uuid;


-- 1.2 สรุปจำนวนข้อมูลที่จะถูกลบ / ได้รับผลกระทบ
WITH target_event AS (
  SELECT job.id
  FROM public.event_jobs job
  WHERE job.id = current_setting('app.event_cleanup_target_id')::uuid
),
target_participations AS (
  SELECT p.id, p.shop_id
  FROM public.event_participations p
  JOIN target_event e ON e.id = p.event_job_id
),
target_event_shops AS (
  SELECT s.id
  FROM public.shops s
  JOIN target_event e ON e.id = s.event_job_id
)
SELECT '1. ร้าน/บูธในอีเวนต์ (event_participations)' AS data_group, count(*) AS row_count
FROM target_participations
UNION ALL
SELECT '2. ร้านค้าที่สร้างขึ้นเพื่ออีเวนต์นี้ (shops where event_job_id is set - จะถูกลบ)', count(*)
FROM target_event_shops
UNION ALL
SELECT '3. ร้านค้าหลักเดิมที่แค่ผูกร่วมงาน (จะไม่ถูกลบจาก shops)', count(*)
FROM target_participations p
LEFT JOIN target_event_shops tes ON tes.id = p.shop_id
WHERE tes.id IS NULL
UNION ALL
SELECT '4. ประวัติคำขอนำเข้าร้านแบบกลุ่ม (event_shop_creation_requests)', count(*)
FROM public.event_shop_creation_requests req
JOIN target_event e ON e.id = req.event_job_id
UNION ALL
SELECT '5. จุดส่งในรอบส่งที่ผูกกับบูธของอีเวนต์นี้ (round_stops)', count(*)
FROM public.round_stops rs
WHERE rs.event_participation_id IN (SELECT id FROM target_participations)
   OR rs.shop_id IN (SELECT id FROM target_event_shops)
UNION ALL
SELECT '6. รายการส่งน้ำแข็งทดสอบของอีเวนต์ (delivery_events)', count(*)
FROM public.delivery_events de
WHERE de.round_stop_id IN (
  SELECT id FROM public.round_stops
  WHERE event_participation_id IN (SELECT id FROM target_participations)
     OR shop_id IN (SELECT id FROM target_event_shops)
)
UNION ALL
SELECT '7. บิล/ค่าจัดส่งทดสอบของอีเวนต์ (delivery_charges)', count(*)
FROM public.delivery_charges dc
WHERE dc.shop_id IN (SELECT id FROM target_event_shops)
   OR dc.delivery_event_id IN (
     SELECT de.id FROM public.delivery_events de
     JOIN public.round_stops rs ON rs.id = de.round_stop_id
     WHERE rs.event_participation_id IN (SELECT id FROM target_participations)
        OR rs.shop_id IN (SELECT id FROM target_event_shops)
   )
ORDER BY data_group;


-- 1.3 ตัวอย่างรายชื่อร้าน/บูธ 20 ร้านแรกในงานนี้
SELECT
  p.id AS participation_id,
  p.booth_number,
  p.event_zone,
  s.code AS shop_code,
  s.name AS shop_name,
  CASE
    WHEN s.event_job_id IS NOT NULL THEN 'ร้านสร้างเพื่ออีเวนต์ (จะถูกลบ)'
    ELSE 'ร้านค้าหลักเดิม (จะแค่ถอดออกจากงาน)'
  END AS shop_type,
  p.status AS participation_status
FROM public.event_participations p
JOIN public.shops s ON s.id = p.shop_id
WHERE p.event_job_id = current_setting('app.event_cleanup_target_id')::uuid
ORDER BY p.booth_number NULLS LAST, s.code
LIMIT 20;



-- ============================================================
-- STEP 2: DELETE TRANSACTION
-- ============================================================
-- คำแนะนำ:
--   1. นำเครื่องหมาย -- หน้า SET LOCAL ออก เพื่อยืนยันคำสั่งลบ
--   2. รันคำสั่งทั้งหมดตั้งแต่ BEGIN ถึง COMMIT/ROLLBACK
--   3. ครั้งแรกรันด้วย ROLLBACK; เพื่อตรวจดูยอดลบในตารางสรุป
--   4. เมื่อยอดถูกต้อง ให้เปลี่ยน ROLLBACK; บรรทัดสุดท้ายเป็น COMMIT; แล้วรันจริง
-- ============================================================

BEGIN;

-- ปลดคอมเมนต์บรรทัดนี้เพื่อยืนยันการลบ:
-- SET LOCAL app.confirm_delete_event_shops = 'DELETE EVENT TEST SHOPS';

DO $$
BEGIN
  IF current_setting('app.confirm_delete_event_shops', true) IS DISTINCT FROM 'DELETE EVENT TEST SHOPS' THEN
    RAISE EXCEPTION 'การลบถูกระงับ: กรุณาเอา -- หน้าคำสั่ง SET LOCAL app.confirm_delete_event_shops = ''DELETE EVENT TEST SHOPS''; ออกก่อนรัน';
  END IF;
END;
$$;

-- 1. ล็อกและเก็บ ID งานอีเวนต์เป้าหมาย
-- RPC สร้าง/แก้บูธล็อก event_jobs แถวเดียวกัน จึงไม่สามารถเพิ่มบูธกลาง transaction นี้ได้
CREATE TEMP TABLE _target_event ON COMMIT DROP AS
SELECT job.id, job.name, job.status
FROM public.event_jobs job
WHERE job.id = current_setting('app.event_cleanup_target_id')::uuid
FOR UPDATE;

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM _target_event;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'ไม่พบงานอีเวนต์ที่ระบุ กรุณาตรวจสอบชื่องานในสคริปต์';
  END IF;
END;
$$;

-- 2. เก็บ ID รายการที่เข้าร่วมในงาน (event_participations)
CREATE TEMP TABLE _target_participations ON COMMIT DROP AS
SELECT p.id, p.shop_id
FROM public.event_participations p
JOIN _target_event e ON e.id = p.event_job_id;
ALTER TABLE _target_participations ADD PRIMARY KEY (id);

-- 3. เก็บ ID ร้านค้าที่ถูกสร้างขึ้นเพื่ออีเวนต์นี้โดยเฉพาะ (shops.event_job_id)
CREATE TEMP TABLE _target_event_shops ON COMMIT DROP AS
SELECT s.id
FROM public.shops s
JOIN _target_event e ON e.id = s.event_job_id;
ALTER TABLE _target_event_shops ADD PRIMARY KEY (id);

-- 4. เก็บ ID จุดส่งในรอบส่งที่ผูกกับบูธของงานนี้ (ถ้ามี)
CREATE TEMP TABLE _target_round_stops ON COMMIT DROP AS
SELECT stop.id
FROM public.round_stops stop
WHERE stop.event_participation_id IN (SELECT id FROM _target_participations)
   OR stop.shop_id IN (SELECT id FROM _target_event_shops);
ALTER TABLE _target_round_stops ADD PRIMARY KEY (id);

-- 5. เก็บ ID รายการส่งน้ำแข็ง (delivery_events) ที่ผูกกับจุดส่งของงานนี้ (ถ้ามี)
CREATE TEMP TABLE _target_delivery_events ON COMMIT DROP AS
SELECT de.id
FROM public.delivery_events de
JOIN _target_round_stops rs ON rs.id = de.round_stop_id;
ALTER TABLE _target_delivery_events ADD PRIMARY KEY (id);

-- 6. เก็บ ID บิล/ค่าจัดส่ง (delivery_charges) ของร้านในงานนี้ (ถ้ามี)
CREATE TEMP TABLE _target_delivery_charges ON COMMIT DROP AS
SELECT DISTINCT dc.id
FROM public.delivery_charges dc
WHERE dc.shop_id IN (SELECT id FROM _target_event_shops)
   OR dc.delivery_event_id IN (SELECT id FROM _target_delivery_events);
ALTER TABLE _target_delivery_charges ADD PRIMARY KEY (id);

-- 7. เก็บ ID การรับชำระเงิน (payments) ที่ผูกกับบิลของงานนี้ (ถ้ามี)
CREATE TEMP TABLE _target_payments ON COMMIT DROP AS
SELECT DISTINCT p.id
FROM public.payments p
WHERE p.shop_id IN (SELECT id FROM _target_event_shops)
   OR EXISTS (
     SELECT 1 FROM public.payment_allocations pa
     JOIN _target_delivery_charges dc ON dc.id = pa.charge_id
     WHERE pa.payment_id = p.id
   );
ALTER TABLE _target_payments ADD PRIMARY KEY (id);

-- 8. เก็บ ID คำขออนุมัติทางการเงิน (approvals) ที่ผูกกับรายการของงานนี้ (ถ้ามี)
CREATE TEMP TABLE _target_approvals ON COMMIT DROP AS
SELECT DISTINCT a.id
FROM public.financial_approval_requests a
WHERE a.round_stop_id IN (SELECT id FROM _target_round_stops)
   OR a.consumed_by_delivery_event_id IN (SELECT id FROM _target_delivery_events)
   OR a.consumed_by_payment_id IN (SELECT id FROM _target_payments)
   OR EXISTS (
     SELECT 1 FROM public.delivery_charges dc
     JOIN _target_delivery_charges tdc ON tdc.id = dc.id
     WHERE dc.approval_request_id = a.id
   )
   OR EXISTS (
     SELECT 1 FROM public.payments p
     JOIN _target_payments tp ON tp.id = p.id
     WHERE p.approval_request_id = a.id
   );
ALTER TABLE _target_approvals ADD PRIMARY KEY (id);

-- 9. เก็บ ID เอกสารรับทราบเครดิตรายวัน (ถ้ามี)
CREATE TEMP TABLE _target_credit_acks ON COMMIT DROP AS
SELECT ack.id
FROM public.daily_credit_acknowledgements ack
WHERE ack.shop_id IN (SELECT id FROM _target_event_shops);
ALTER TABLE _target_credit_acks ADD PRIMARY KEY (id);

-- เก็บ path ของไฟล์ไว้แสดงหลัง dry run/ลบฐานข้อมูล
-- ต้องลบไฟล์จริงผ่าน Storage API หรือ Dashboard เท่านั้น
CREATE TEMP TABLE _target_storage_objects ON COMMIT DROP AS
SELECT DISTINCT
  'credit-signoff-evidence'::text AS bucket_id,
  evidence.storage_path
FROM public.daily_credit_acknowledgement_evidence evidence
WHERE evidence.acknowledgement_id IN (SELECT id FROM _target_credit_acks)
UNION
SELECT DISTINCT
  'payment-evidence'::text,
  payment.evidence_path
FROM public.payments payment
WHERE payment.id IN (SELECT id FROM _target_payments)
  AND payment.evidence_path IS NOT NULL;

-- ============================================================
-- ขอบเขตความปลอดภัย: หยุดแทนการลบข้อมูลที่อาจเป็นของร้านประจำ
-- ============================================================
DO $$
BEGIN
  -- ห้ามลบ payment ทั้งก้อน หากมีการจัดสรรไปยังบิลนอกอีเวนต์เป้าหมาย
  IF EXISTS (
    SELECT 1
    FROM public.payment_allocations allocation
    JOIN _target_payments payment ON payment.id = allocation.payment_id
    LEFT JOIN _target_delivery_charges charge ON charge.id = allocation.charge_id
    WHERE charge.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'การลบถูกระงับ: payment ของอีเวนต์มี allocation ไปยังบิล outside the target event';
  END IF;

  -- Daily Close เป็น snapshot รวมทั้งวัน การลบเฉพาะรายการอีเวนต์จะทำให้ยอดร้านประจำผิด
  IF EXISTS (
    SELECT 1
    FROM public.daily_close_payment_items item
    JOIN _target_payments payment ON payment.id = item.payment_id
  ) THEN
    RAISE EXCEPTION
      'การลบถูกระงับ: พบ payment ของอีเวนต์อยู่ใน Daily Close ที่ปิดแล้ว';
  END IF;

  -- เอกสารรับทราบเครดิตของร้านประจำอาจรวมยอดประจำและยอดอีเวนต์ไว้ด้วยกัน
  IF EXISTS (
    SELECT 1
    FROM public.daily_credit_acknowledgements acknowledgement
    JOIN public.delivery_charges charge
      ON charge.shop_id = acknowledgement.shop_id
      AND charge.service_date = acknowledgement.service_date
    JOIN _target_delivery_charges target_charge ON target_charge.id = charge.id
    LEFT JOIN _target_event_shops event_shop
      ON event_shop.id = acknowledgement.shop_id
    WHERE event_shop.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'การลบถูกระงับ: พบเอกสารรับทราบเครดิตของร้านประจำที่รวมข้อมูลอีเวนต์';
  END IF;

  -- Approval เดียวกันต้องไม่ถูกใช้โดย payment/charge นอกอีเวนต์เป้าหมาย
  IF EXISTS (
    SELECT 1
    FROM public.delivery_charges charge
    JOIN _target_approvals approval ON approval.id = charge.approval_request_id
    LEFT JOIN _target_delivery_charges target_charge ON target_charge.id = charge.id
    WHERE target_charge.id IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.payments payment
    JOIN _target_approvals approval ON approval.id = payment.approval_request_id
    LEFT JOIN _target_payments target_payment ON target_payment.id = payment.id
    WHERE target_payment.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'การลบถูกระงับ: approval ถูกใช้งานโดยข้อมูล outside the target event';
  END IF;

  -- Revision ต้องไม่เชื่อมรายการส่งของอีเวนต์นี้กับรายการส่งนอกขอบเขต
  IF EXISTS (
    SELECT 1
    FROM public.delivery_event_revisions revision
    LEFT JOIN _target_delivery_events original
      ON original.id = revision.original_event_id
    LEFT JOIN _target_delivery_events replacement
      ON replacement.id = revision.replacement_event_id
    WHERE (original.id IS NOT NULL OR replacement.id IS NOT NULL)
      AND (original.id IS NULL OR replacement.id IS NULL)
  ) THEN
    RAISE EXCEPTION
      'การลบถูกระงับ: delivery revision เชื่อมกับข้อมูล outside the target event';
  END IF;
END;
$$;


-- ปิด Trigger Append-Only ชั่วคราว (เพื่อล้างประวัติธุรกรรมทดสอบที่เกี่ยวข้องได้)
ALTER TABLE public.payment_allocation_changes
  DISABLE TRIGGER payment_allocation_changes_append_only;
ALTER TABLE public.refund_settlements
  DISABLE TRIGGER refund_settlements_append_only;
ALTER TABLE public.delivery_adjustment_items
  DISABLE TRIGGER delivery_adjustment_items_append_only;
ALTER TABLE public.daily_credit_acknowledgements
  DISABLE TRIGGER daily_credit_acknowledgements_immutable;
ALTER TABLE public.daily_credit_acknowledgement_evidence
  DISABLE TRIGGER daily_credit_acknowledgement_evidence_immutable;
ALTER TABLE public.payment_receipt_snapshots
  DISABLE TRIGGER payment_receipt_snapshots_immutable;
ALTER TABLE public.delivery_charge_document_snapshots
  DISABLE TRIGGER delivery_charge_document_snapshots_immutable;
ALTER TABLE public.event_settlement_contexts
  DISABLE TRIGGER event_settlement_contexts_immutable;


-- ============================================================
-- ดำเนินการลบตามลำดับ Foreign Key (Dependencies)
-- ============================================================

-- ลบข้อมูลรับทราบเครดิต
DELETE FROM public.daily_credit_acknowledgement_evidence
WHERE acknowledgement_id IN (SELECT id FROM _target_credit_acks);

DELETE FROM public.daily_credit_acknowledgements
WHERE id IN (SELECT id FROM _target_credit_acks);

-- ลบข้อมูลส่วนต่าง / settlement คืนเงิน
DELETE FROM public.refund_settlements
WHERE obligation_id IN (
  SELECT id FROM public.refund_obligations
  WHERE payment_id IN (SELECT id FROM _target_payments)
     OR source_charge_id IN (SELECT id FROM _target_delivery_charges)
);

DELETE FROM public.refund_obligations
WHERE payment_id IN (SELECT id FROM _target_payments)
   OR source_charge_id IN (SELECT id FROM _target_delivery_charges);

-- ลบรายการปรับยอดบิล
DELETE FROM public.delivery_adjustment_items item
WHERE EXISTS (
  SELECT 1
  FROM public.delivery_charge_adjustments adjustment
  WHERE adjustment.charge_id IN (SELECT id FROM _target_delivery_charges)
    AND adjustment.idempotency_key = item.adjustment_id
);

DELETE FROM public.delivery_charge_adjustments
WHERE charge_id IN (SELECT id FROM _target_delivery_charges);

-- ลบ snapshot เอกสารและใบเสร็จ
DELETE FROM public.payment_receipt_snapshots
WHERE payment_id IN (SELECT id FROM _target_payments);

DELETE FROM public.delivery_charge_document_snapshots
WHERE charge_id IN (SELECT id FROM _target_delivery_charges);

-- ลบคำขอขยาย Due Date และคิวเก็บเงินเครดิต
DELETE FROM public.credit_due_date_requests
WHERE charge_id IN (SELECT id FROM _target_delivery_charges)
   OR shop_id IN (SELECT id FROM _target_event_shops);

DELETE FROM public.collection_run_credit_charges
WHERE charge_id IN (SELECT id FROM _target_delivery_charges);

-- ลบการจัดสรรยอดชำระเงิน
DELETE FROM public.payment_allocation_changes change
WHERE change.payment_id IN (SELECT id FROM _target_payments)
   OR change.from_charge_id IN (SELECT id FROM _target_delivery_charges)
   OR change.to_charge_id IN (SELECT id FROM _target_delivery_charges);

DELETE FROM public.payment_allocations
WHERE payment_id IN (SELECT id FROM _target_payments)
   OR charge_id IN (SELECT id FROM _target_delivery_charges);

-- คลาย FK วนรอบของ Approval ก่อนลบ
UPDATE public.payments
SET approval_request_id = NULL
WHERE id IN (SELECT id FROM _target_payments);

UPDATE public.delivery_charges
SET approval_request_id = NULL
WHERE id IN (SELECT id FROM _target_delivery_charges);

-- ลบ Approvals
DELETE FROM public.financial_approval_requests
WHERE id IN (SELECT id FROM _target_approvals);

-- ลบ Payments & Charges
DELETE FROM public.payments
WHERE id IN (SELECT id FROM _target_payments);

DELETE FROM public.delivery_charges
WHERE id IN (SELECT id FROM _target_delivery_charges);

-- ลบรายการสินค้าที่ส่งและประวัติการแก้ไขบิลส่ง
DELETE FROM public.delivery_event_revisions
WHERE original_event_id IN (SELECT id FROM _target_delivery_events)
   OR replacement_event_id IN (SELECT id FROM _target_delivery_events);

DELETE FROM public.delivery_items
WHERE delivery_event_id IN (SELECT id FROM _target_delivery_events);

DELETE FROM public.delivery_events
WHERE id IN (SELECT id FROM _target_delivery_events);

-- ลบจุดส่ง (Round Stops) ของบูธงานนี้
DELETE FROM public.round_stops
WHERE id IN (SELECT id FROM _target_round_stops);

-- ลบ Settlement Contexts & Pilots ของอีเวนต์
DELETE FROM public.event_settlement_contexts
WHERE event_participation_id IN (SELECT id FROM _target_participations)
   OR shop_id IN (SELECT id FROM _target_event_shops);

DELETE FROM public.event_ice_delivery_pilots
WHERE event_participation_id IN (SELECT id FROM _target_participations);

-- ลบรายการเข้าร่วมงาน (Event Participations)
DELETE FROM public.event_participations
WHERE id IN (SELECT id FROM _target_participations);

-- ลบ Request นำเข้าบูธแบบกลุ่มของอีเวนต์นี้
DELETE FROM public.event_shop_creation_requests
WHERE event_job_id IN (SELECT id FROM _target_event);

-- ลบข้อมูลประกอบของร้านค้าที่สร้างขึ้นเพื่ออีเวนต์นี้โดยเฉพาะ
DELETE FROM public.shop_ice_type_prices
WHERE shop_id IN (SELECT id FROM _target_event_shops);

DELETE FROM public.shop_payment_profiles
WHERE shop_id IN (SELECT id FROM _target_event_shops);

DELETE FROM public.shop_rented_tanks
WHERE shop_id IN (SELECT id FROM _target_event_shops);

DELETE FROM public.route_shops
WHERE shop_id IN (SELECT id FROM _target_event_shops);

-- ลบร้านค้าที่สร้างขึ้นสำหรับอีเวนต์นี้ออกจาก public.shops (ร้านค้าหลักเดิมจะไม่ถูกลบ)
DELETE FROM public.shops
WHERE id IN (SELECT id FROM _target_event_shops);

-- ลบโซนอีเวนต์ที่ระบบสร้างให้อัตโนมัติ (หากไม่มีร้านอื่นใช้งานแล้ว)
DELETE FROM public.building_zones
WHERE code = 'EVENT-' || (SELECT id::text FROM _target_event)
  AND NOT EXISTS (
    SELECT 1 FROM public.shops
    WHERE zone_id = building_zones.id
  );

-- ลบ Audit Logs ที่ผูกกับ event_participation และร้านทดสอบของงานนี้
DELETE FROM public.audit_logs
WHERE (entity_type = 'event_participation' AND entity_id IN (SELECT id FROM _target_participations))
   OR (entity_type = 'shop' AND entity_id IN (SELECT id FROM _target_event_shops));


-- เปิด Trigger Append-Only คืนตามเดิม
ALTER TABLE public.payment_allocation_changes
  ENABLE TRIGGER payment_allocation_changes_append_only;
ALTER TABLE public.refund_settlements
  ENABLE TRIGGER refund_settlements_append_only;
ALTER TABLE public.delivery_adjustment_items
  ENABLE TRIGGER delivery_adjustment_items_append_only;
ALTER TABLE public.daily_credit_acknowledgements
  ENABLE TRIGGER daily_credit_acknowledgements_immutable;
ALTER TABLE public.daily_credit_acknowledgement_evidence
  ENABLE TRIGGER daily_credit_acknowledgement_evidence_immutable;
ALTER TABLE public.payment_receipt_snapshots
  ENABLE TRIGGER payment_receipt_snapshots_immutable;
ALTER TABLE public.delivery_charge_document_snapshots
  ENABLE TRIGGER delivery_charge_document_snapshots_immutable;
ALTER TABLE public.event_settlement_contexts
  ENABLE TRIGGER event_settlement_contexts_immutable;


-- ============================================================
-- STEP 3: ตรวจสอบผลลัพธ์การลบ (ต้องเป็น 0 ทั้งหมด)
-- ============================================================
SELECT
  'คงเหลือร้าน/บูธในอีเวนต์' AS check_item,
  count(*) AS remaining_count
FROM public.event_participations
WHERE event_job_id IN (SELECT id FROM _target_event)
UNION ALL
SELECT
  'คงเหลือร้านที่สร้างเพื่ออีเวนต์นี้ใน shops',
  count(*)
FROM public.shops
WHERE event_job_id IN (SELECT id FROM _target_event)
UNION ALL
SELECT
  'คงเหลือ request นำเข้าร้านแบบกลุ่ม',
  count(*)
FROM public.event_shop_creation_requests
WHERE event_job_id IN (SELECT id FROM _target_event)
UNION ALL
SELECT
  'คงเหลือจุดส่งของอีเวนต์',
  count(*)
FROM public.round_stops
WHERE id IN (SELECT id FROM _target_round_stops)
UNION ALL
SELECT
  'คงเหลือรายการส่งของอีเวนต์',
  count(*)
FROM public.delivery_events
WHERE id IN (SELECT id FROM _target_delivery_events)
UNION ALL
SELECT
  'คงเหลือบิลของอีเวนต์',
  count(*)
FROM public.delivery_charges
WHERE id IN (SELECT id FROM _target_delivery_charges)
UNION ALL
SELECT
  'คงเหลือ payment ของอีเวนต์',
  count(*)
FROM public.payments
WHERE id IN (SELECT id FROM _target_payments)
UNION ALL
SELECT
  'คงเหลือ settlement context ของอีเวนต์',
  count(*)
FROM public.event_settlement_contexts
WHERE event_participation_id IN (SELECT id FROM _target_participations)
UNION ALL
SELECT
  'ร้านประจำถูกลบโดยไม่ตั้งใจ (ต้องเป็น 0)',
  count(*)
FROM _target_participations participation
LEFT JOIN _target_event_shops event_shop ON event_shop.id = participation.shop_id
LEFT JOIN public.shops shop ON shop.id = participation.shop_id
WHERE event_shop.id IS NULL
  AND shop.id IS NULL
ORDER BY check_item;

-- SQL ไม่ลบไฟล์ใน Storage โดยตรง นำรายการนี้ไปลบผ่าน Storage API/Dashboard หลัง COMMIT
SELECT bucket_id, storage_path
FROM _target_storage_objects
ORDER BY bucket_id, storage_path;


-- ============================================================
-- ตัดสินใจบันทึกผล:
--   - ครั้งแรกที่รัน ให้คง ROLLBACK; ไว้ เพื่อดูผลใน STEP 3 ว่าลบได้ถูกต้อง
--   - เมื่อมั่นใจแล้ว ให้เปลี่ยน ROLLBACK; เป็น COMMIT; แล้วกดรันใหม่อีกครั้ง
-- ============================================================
ROLLBACK;
-- COMMIT;
