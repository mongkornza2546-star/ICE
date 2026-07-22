# Handoff: Daily Work Session Architecture (1 Work Session per `service_date`)

## Status
โค้ดปรับจาก **"รอบย่อยตามเวลา"** เป็น **"งานประจำวัน 1 งานต่อ 1 `service_date`"** แล้ว และผ่าน rework จาก end-to-end review เรียบร้อย; migration `0042` deploy ขึ้น production แล้ว
ผลยืนยันล่าสุด: 182 tests ผ่านทั้งหมด (Node Integration/Contract 128 + UI 54) และ `npm run build` ผ่าน

---

## สิ่งที่พัฒนาสำเร็จใน Phase นี้ (Implemented Features)

### 1. โครงสร้างฐานข้อมูลงานประจำวัน (Migration `0042_daily_work_session_architecture.sql`)
- **Upgrade-safe classification**: เพิ่ม `round_type` (`'daily'` | `'special'`) โดย backfill รอบเก่าทั้งหมดเป็น `special` ก่อนสร้าง `delivery_rounds_daily_unique_idx` จึงรองรับฐานข้อมูลเดิมที่มีหลายรอบต่อวัน
- **System-name invariant**: `daily` ต้องใช้ชื่อ `"งานประจำวัน"` เท่านั้น; `special` ยังต้องผ่าน configured-name validation
- **Internal auto-creation helper**: `ensure_daily_delivery_round(p_service_date)` ตรวจ active admin/round lead, idempotent ภายใต้ service-date lock และถูก revoke จาก anonymous/authenticated client
- **คำสั่งซื้อโรงงานครั้งแรกของวัน**: ปรับปรุง `record_factory_order` ให้เรียก `ensure_daily_delivery_round` อัตโนมัติเมื่อมีการสั่งน้ำแข็งจากโรงงานครั้งแรกของวัน
- **Read-only session resolution**: `get_employee_active_session(p_service_date)` ไม่สร้างงานเอง, กรองตามสมาชิก/สิทธิ์ และใช้วัน Asia/Bangkok

### 2. การปิดสต๊อกและปิดงานสิ้นวันแบบ Atomic Transaction
- ปรับปรุง `close_daily_stock_v2` ให้ทำการ:
  1. ค้นหางานประจำวันที่เปิดอยู่ของ `service_date`
  2. บันทึกผลนับจริงและ variance ที่อนุมัติใน `daily_stock_closures` / `daily_stock_closure_items`
  3. คำนวณสรุปผลและบันทึก `round_close_summaries`
  4. บันทึก Snapshot จากยอดนับจริงหลัง reconciliation
  5. อัปเดตสถานะงานประจำวันเป็น `'closed'`
  6. โอนสต๊อกนับจริงคงเหลือส่งคืนโรงงาน และปิด `daily_stock_closures`
  - **ทำทั้งหมดใน 1 SQL Transaction Block** หากขั้นตอนใดล้มเหลว ระบบจะ Rollback ทั้งหมดทันที

### 3. ปรับปรุง UX/UI หน้าจอพนักงานและผู้ดูแลระบบ
- **POS หน้าจอพนักงาน (`EmployeeDeliveryWorkspace.tsx`)**:
  - เชื่อมต่อ `get_employee_active_session` ดึงงานประจำวันอัตโนมัติ
  - ซ่อน Dropdown เลือกรอบในวันทำงานปกติ (กรณีมีงานเดียว)
  - แสดงป้ายสถานะอ่านอย่างเดียว: **`งานวันนี้: งานประจำวัน`** (`กำลังดำเนินการ`)
- **หน้าจอติดตามงาน (`AdminLayout.tsx`, `ManagerDashboard.tsx`)**:
  - เปลี่ยนชื่อเมนูและหัวข้อหน้าจอจาก **"ควบคุมรอบส่ง"** เป็น **"ติดตามงานวันนี้"**
  - นำฟอร์มเปิดรอบแบบเดิมออกจาก `RoundWorkspace`; งานประจำวันเปิดจาก factory order เท่านั้น
- **หน้าตั้งค่าแอดมิน (`AdminReferenceSettings.tsx`)**:
  - ซ่อนคอมโพเนนต์ตั้งค่าชื่อรอบย่อยตามเวลาออกจาก UX

---

## ข้อมูลทางเทคนิคและ Testing

- **Migrations**:
  - `supabase/migrations/0042_daily_work_session_architecture.sql`
- **Integration Test Suite**:
  - `tests/daily-work-session.integration.test.mjs` 10 tests: legacy multi-round upgrade, helper permissions, name invariant, idempotency, factory validation/auto-creation, read-only session resolution, actual-count snapshot และ atomic close
- **Verification Commands**:
  - Integration & UI Tests: `npm test` (128 Node tests + 54 Vitest UI tests passed)
  - TypeScript Build Check: `npm run build` (Passed cleanly, 0 compilation errors)

---

## แผนงานและขั้นตอนถัดไป (Next Steps)

1. **การปรับปรุงแดชบอร์ด "ติดตามงานวันนี้" (Phase 2 Dashboard)**
   - แสดงตัวเลขสรุปงานประจำวันอย่างละเอียด:
     - **พนักงานที่ได้รับมอบหมาย:** (สมาชิกทั้งหมดใน Session)
     - **พนักงานที่มีการเคลื่อนไหววันนี้:** (พนักงานที่มีการบันทึกส่งหรือโอนสต๊อกจริง)
     - **ยอดขายรวมและร้านค้าที่ส่งจริง** (ตัด KPI ร้านที่ไม่ซื้อออกจากงานค้าง)
     - **สต๊อกคงเหลือตามจุดถือครอง** และประวัติรายการล่าสุด

2. **การเปิดใช้งาน POS บนสภาพแวดล้อมจริง (Production Cutover & Usage)**
   - สั่งน้ำแข็งครั้งแรกของวันเพื่อทดสอบการเปิดงานประจำวันอัตโนมัติ
   - พนักงานเข้า POS บันทึกส่งและเติมสต๊อกต่อเนื่องได้ตลอดทั้งวัน
   - ตรวจนับสต๊อกสิ้นวันและปิดสต๊อกเพื่อปิดงานประจำวันและสร้าง Snapshot สต๊อกคงเหลือ
