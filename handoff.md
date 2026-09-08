# Handoff: Collection Queue Layout Fix & Payment History Location Filters + Shop Photos

**วันที่:** 8 กันยายน 2026
**สถานะงาน:** เสร็จสมบูรณ์ พร้อมเทสต์และการตรวจสอบครบถ้วน (All tests pass & Build clean)

---

## 1. บริบทและสิ่งที่ทำเสร็จแล้ว (Context & Accomplished Scope)

งานนี้เป็นการแก้ปัญหา 3 ส่วนหลักตามแผน:
1. **แก้ Layout หน้าคิวเก็บเงิน (Collection Queue):**
   - แก้ไขช่องค้นหา `.financial-ops__queue-search` ที่ไอคอนแว่นขยายหลุดบรรทัดไปอยู่เหนือ input ให้กลับมาเรียงแนวนอน ความสูง ~44px
   - จัดตัวเลือกตึกและโซนบน Mobile ให้อยู่ในแถวเดียวกัน (2 คอลัมน์)
   - จัดลูกศร `.financial-ops__shop-arrow` บนการ์ดร้านค้าให้อยู่กึ่งกลางแนวตั้ง (`top: 50%; transform: translateY(-50%)`)
   - ปรับ Desktop grid (900px+) ให้ทั้ง 3 controls (ค้นหา, ตึก, โซน) อยู่ในแถวเดียวกัน โดยช่องค้นหาขยายได้เกิน 450px
   - ที่ช่วง Tablet 760–899px ให้ช่องค้นหาเต็มแถวและวางตัวเลือกตึก/โซนในแถวถัดไป เพื่อไม่ให้ล้นเมื่อ sidebar ยังแสดงอยู่
2. **เพิ่มตัวกรองตึกและโซนในหน้าประวัติรับเงิน (Payment History Filters):**
   - ตัวกรองตึกเรียงตามอักษรไทย ดึงจากร้านประจำในวันที่เลือก
   - ตัวเลือกโซนขึ้นกับตึกที่เลือก (ปิด disabled ถ้ายังไม่เลือกตึก และล้างค่าโซนทันทีเมื่อเปลี่ยนตึก)
   - บิลอีเวนต์แสดงเมื่อเลือก "ทุกตึก / ทุกโซน" และค้นหาได้ด้วยข้อความ
   - มีข้อความกำกับ: `ตัวกรองตึก/โซนใช้กับร้านประจำ · ค้นหางานอีเวนต์ได้จากช่องค้นหา`
   - เมื่อเปลี่ยนวันที่ (`historyDate`) ตัวกรองจะถูกรีเซ็ตอัตโนมัติผ่าน `key={historyDate}`
   - ล้าง State ตึก/โซนจริงเมื่อข้อมูลรีเฟรชในวันเดียวกันแล้วตัวเลือกเดิมหายไป จึงไม่กลับมากรองเองเมื่อข้อมูลนั้นกลับมา
3. **แสดงรูปภาพร้านค้าในประวัติรับเงิน (Shop Photos / Thumbnails):**
   - ขยาย RPC `public.get_payment_history` ให้ join ตึก/โซน และดึง `image_path`
   - ใช้ `withPublicShopImages` ดึง Public Supabase/R2 storage URLs
   - แสดง Thumbnail 60×60px มุมโค้งมน พร้อม Storefront placeholder เมื่อร้านไม่มีรูป

---

## 2. การตัดสินใจเชิงเทคนิคที่สำคัญ (Key Architectural Decisions)

1. **ลำดับ Migration (`0182`):**
   - Migration เดิมใน repository มี `0181_live_shop_code_numeric_order.sql` อยู่ก่อนแล้ว จึงตั้งชื่อไฟล์ใหม่เป็น `supabase/migrations/0182_payment_history_shop_image_and_location.sql`
2. **RPC Projection (`get_payment_history`):**
   - ใช้ `payment.*` ร่วมกับ `returned.shop_id` โดยไม่เพิ่ม alias `shop.id AS shop_id` เพื่อป้องกัน ambiguity error
   - สำหรับร้านประจำ: คืนค่า `building_id`, `zone_id` พร้อมชื่อที่ join จากตาราง `buildings` / `building_zones`
   - สำหรับบิลอีเวนต์: คืนค่า `building_id = null`, `zone_id = null` และใช้ `event_location_snapshot`, `event_zone_snapshot` เป็นชื่อเพื่อแสดงผล
3. **การรีเซ็ตตัวกรองเมื่อเปลี่ยนวัน:**
   - ใช้ `key={historyDate}` ที่ `PaymentHistorySection` ใน `src/FinancialOperations.tsx` เพื่อให้ Component รีเซ็ต state ทั้งหมดอย่างเป็นธรรมชาติเมื่อเปลี่ยนวันที่ โดยไม่กระทบการรีเฟรชในวันเดิม
4. **Regression checks หลัง review:**
   - ใช้ `IS DISTINCT FROM` ใน PostgreSQL assertions เพื่อให้ key ที่หายหรือค่า `NULL` ผิดชนิดทำให้ test ล้มเหลวจริง
   - ค้นหา event fixture ด้วย `destination_kind` และ `event_name`; payment ID ที่สร้างโดย RPC ไม่เท่ากับ idempotency key

---

## 3. รายการไฟล์ที่เพิ่มและแก้ไข (Files Modified & Added)

### Database Migration:
- `supabase/migrations/0182_payment_history_shop_image_and_location.sql` [NEW]
  - อัปเดต `get_payment_history(date, date, integer, timestamptz, uuid)` ให้ส่ง `shop_id`, `image_path`, `building_id`, `building_name`, `zone_id`, `zone_name`

### Frontend:
- `src/features/financial-operations/types.ts`
  - เพิ่มฟิลด์ใน `PaymentHistoryItem`: `shop_id?`, `image_path?`, `image_url?`, `building_id?`, `building_name?`, `zone_id?`, `zone_name?`
- `src/features/financial-operations/utils.ts`
  - ปรับปรุง `withPublicShopImages<T extends PublicImagePathItem>(items: T[]): Promise<T[]>` ให้รองรับทั้ง queue cards และ payment history items
- `src/FinancialOperations.tsx`
  - เรียก `withPublicShopImages` ใน `fetchAllPaymentHistory`
  - ใส่ `key={historyDate}` ที่ `PaymentHistorySection`
- `src/features/financial-operations/components/FinancialOperationsPanels.tsx`
  - เพิ่ม state `buildingId`, `zoneId`, `query`
  - เพิ่ม UI controls สำหรับตัวกรองและข้อความกำกับขอบเขต
  - เพิ่ม Thumbnail 60×60px (`.financial-ops__history-visual`) และ Info container (`.financial-ops__history-info`)
  - แยกข้อความ "ไม่มีรายการรับเงินในวันที่เลือก" ออกจาก "ไม่พบรายการตามตัวกรอง"
- `src/index.css`
  - แก้ไข `.financial-ops__queue-search` (`flex-direction: row; align-items: center;`)
  - จัด layout desktop (3 columns, search `max-width: none`) และ mobile (search 100%, building & zone 50%/50%)
  - จัดตำแหน่งลูกศรการ์ดให้อยู่กึ่งกลางแนวตั้ง
  - กำหนดสไตล์ Thumbnail 60×60px
- `src/LocalDemoApp.tsx`
  - อัปเดต fixtures `collectionPayments` ให้มีตึก/โซนหลากหลาย, มีรูปและไม่มีรูป, บิลอีเวนต์, และวันที่สองสำหรับทดสอบการสลับวัน

### Tests:
- `tests/payment-history-filters.test.tsx` [NEW]
  - ครอบคลุม 6 scenarios: กรองตึก/โซน, ค้นหาข้อความ/อีเวนต์, แสดงรูป/placeholder, เปลี่ยนวันแล้วรีเซ็ต, รีเฟรชแล้วเคลียร์ stale filter
- `tests/event-financial-foundation.postgres.mjs`
  - อัปเดตให้รัน migration ถึง `0182`
  - เพิ่ม assertion แบบ null-safe ตรวจสอบ `get_payment_history` กับ PostgreSQL 16 container จริง (projection, pagination across equal timestamps, visibility isolation)
- `tests/financial-ops-ipad-layout.test.mjs`
  - เพิ่ม regression assertion ว่า filter grid เปลี่ยนเป็นสองแถวในช่วง 760–899px

---

## 4. ผลการทดสอบ (Verification Status)

| Test Suite | คำสั่ง | ผลลัพธ์ |
|---|---|---|
| Vitest UI | `npm run test:ui` | **Passed** (42 test files, 239 tests passed) |
| Payment History Test | `npx vitest run tests/payment-history-filters.test.tsx` | **Passed** (6/6 tests passed) |
| Node Tests | `node --test tests/*.test.mjs` | **Passed** (156 top-level subtests, 161 tests passed) |
| PostgreSQL Integration | `npm run test:postgres-event-financial` | **Passed** (Tested on real PostgreSQL 16) |
| Production Build | `npm run build` | **Passed** (0 typescript errors, bundle built cleanly) |
| Browser verification | วัด DOM และตรวจภาพหน้า demo จริง | **Verified** (390×844 Mobile, 760×844 Tablet, 1280×800 Desktop; ที่ 760px `scrollWidth` เท่ากับ viewport 760px) |

---

## 5. สถานะ Git และสิ่งที่จะทำต่อในแชตใหม่ (Next Steps for Next Chat)

### Git Status ปัจจุบัน:
- มีไฟล์ที่แก้ไขและเพิ่มใหม่ใน working directory (ยังไม่ได้ commit)
- ไฟล์ที่เกี่ยวข้องโดยตรงกับงานนี้:
  - `supabase/migrations/0182_payment_history_shop_image_and_location.sql`
  - `src/features/financial-operations/types.ts`
  - `src/features/financial-operations/utils.ts`
  - `src/FinancialOperations.tsx`
  - `src/features/financial-operations/components/FinancialOperationsPanels.tsx`
  - `src/index.css`
  - `src/LocalDemoApp.tsx`
  - `tests/payment-history-filters.test.tsx`
  - `tests/event-financial-foundation.postgres.mjs`
  - `tests/financial-ops-ipad-layout.test.mjs`

### สิ่งที่สามารถทำต่อได้ทันที:
1. ตรวจสอบ `git diff` และทำ Git Commit / Push ขึ้น branch หรือ repository
2. Deploy Migration `0182` ไปยัง Supabase production เมื่อพร้อม deploy
3. หากมี feature อื่นๆ หรือข้อกำหนดเพิ่มเติมเกี่ยวกับหน้าคิวเก็บเงินหรือการเงิน สามารถแจ้งต่อได้เลย
