# Handoff: ออกบิลค่าเช่าถังของ Event อัตโนมัติ & ปรับปรุง User Management Layout

**วันที่:** 21 กันยายน 2026  
**สถานะงาน:** เสร็จสมบูรณ์ พร้อมเทสต์และการตรวจสอบครบถ้วน (All tests pass & Build clean)

---

## 1. บริบทและสิ่งที่ทำเสร็จแล้ว (Context & Accomplished Scope)

งานในรอบนี้ครอบคลุม 2 ส่วนสำคัญของระบบ:

### 1. ระบบออกบิลค่าเช่าถังของ Event อัตโนมัติ (Automatic Event Tank Rental Billing)
เดิมทีเมื่อมีการบันทึกส่งมอบถังให้อีเวนต์ (`movement_kind = 'handoff'`) ระบบจะบันทึกเพียงประวัติการเคลื่อนไหวของถังและยอดค้างถัง แต่ยังไม่ได้สร้างบิลหนี้ค่าเช่าถัง (`delivery_charges`) ส่งผลให้ไม่มียอดหนี้ปรากฏในคิวจัดเก็บเงินของรอบส่งอีเวนต์ และไม่สามารถพิมพ์ใบแจ้งหนี้/ใบเสร็จได้

**สิ่งที่ได้ดำเนินการ:**
- **Auto-Billing on Handoff:** ปรับปรุงฟังก์ชัน `record_event_tank_movement` ให้ตรวจสอบอัตราค่าเช่าต่อถังของงานอีเวนต์ (`tank_rental_unit_price`) หากมากกว่า 0 ระบบจะสร้างรายการหนี้ใน `delivery_charges` โดยอัตโนมัติทันที
- **Settlement Context & Service Date:** กำหนดวันเริ่มคิดค่าเช่า (`rental_start_date = GREATEST(event_start_date, service_date)`) และเชื่อมโยงเข้ากับ `event_settlement_contexts` ของวันที่เริ่มคิดค่าเช่า พร้อมกำหนด `payment_term = 'end_of_day'`
- **Collection Run Queue Integration:** อัปเดต `is_charge_collectible_in_run` และ `get_collection_run_queue` ให้ดึงบิลค่าเช่าถังของอีเวนต์เข้าสู่คิวจัดเก็บเงินของพนักงานส่งในรอบส่งประจำวัน
- **Invoice & Receipt Printing:**
  - อัปเดต `charge_line_items` ให้แสดงชื่อรายการเป็น *"ค่าเช่าถัง Event ({quantity} ใบ × {unit_price} บาท)"*
  - อัปเดต `build_charge_print_document` (INV) ให้ดึงข้อมูลชื่องาน, สถานที่จัดงาน, บูธ และโซน สำหรับพิมพ์ใบแจ้งหนี้/ใบเสร็จได้ถูกต้อง
  - อัปเดต `build_payment_receipt_snapshot` (REC) เมื่อรับชำระเงินผ่าน `record_event_payment`
- **Accounting Ledger Integration:** อัปเดต `accounting_transaction_rows` ให้บันทึกบัญชีลูกหนี้การค้าและรายได้ค่าเช่าถังลงสมุดรายวัน โดยไม่กระทบยอดสต็อกน้ำแข็ง (`quantity_in = 0`, `quantity_out = 0`)
- **Event Management UI Updates:**
  - อัปเดต `EventPreparationPanel.tsx` ให้แสดงคำนวณยอดค่าเช่ารวม พร้อมข้อความแจ้งเตือนการสร้างบิลอัตโนมัติ
  - เพิ่มคอลัมน์ **"บิลค่าเช่า"** ในตารางประวัติส่งมอบ/คืนถัง แสดงเลขที่บิลและสถานะยอดค้างชำระ / ชำระแล้ว
  - เพิ่มคอลัมน์ **"การจัดการ"** พร้อมปุ่ม **"พิมพ์บิล"** สำหรับสั่งพิมพ์ใบแจ้งหนี้ค่าเช่าถังได้ทันทีทั้งบน Web popup และ Android thermal print

---

### 2. ปรับปรุง UI และ Layout การจัดการผู้ใช้งาน (User Management & Ice Type Layout)
- ปรับปรุง `UserEditor.tsx` และ `AdminReferenceSettings.tsx` ในการเลือกบทบาทและการจัดวางฟอร์มข้อมูลผู้ใช้งาน
- ปรับแต่ง `index.css` เพื่อให้การแสดงผลบนอุปกรณ์ต่าง ๆ (Desktop, Tablet, Mobile) มีความลื่นไหล รองรับ layout cards และปุ่มกดอย่างสวยงาม
- อัปเดต mock data และ router ใน `LocalDemoApp.tsx` เพื่อรองรับการทดสอบหน้าจอตั้งค่าผู้ใช้และประเภทน้ำแข็ง

---

## 2. การตัดสินใจเชิงเทคนิคที่สำคัญ (Key Architectural Decisions)

1. **การขยาย Schema ของ `delivery_charges` (`Migration 0189`):**
   - เพิ่มคอลัมน์ `event_tank_rental_id UUID REFERENCES public.event_tank_rentals(id) ON DELETE RESTRICT`
   - ปรับปรุง check constraint `delivery_charge_source_required` ให้ครอบคลุม:
     ```sql
     ((delivery_id IS NOT NULL)::integer + 
      (shop_tank_rental_id IS NOT NULL)::integer + 
      (event_tank_rental_id IS NOT NULL)::integer) = 1
     ```
   - ปรับปรุง trigger function `enforce_delivery_charge_settlement_context()` ให้ผูก `event_settlement_context_id` อัตโนมัติเมื่อเป็น `event_tank_rental_id`

2. **Lifecycle Separation ระหว่างการส่งมอบกับการรับคืนถัง (Custody Returns):**
   - การรับคืนถัง (`movement_kind = 'return'`) เป็นเพียงการคืนสิทธิ์ครอบครองถัง (custody return) จะ **ไม่สร้างบิลใหม่** และ **ไม่ยกเลิก/ลดหย่อนบิลค่าเช่าเดิม** เพื่อให้ยอดค่าเช่าคงที่ตามสัญญาตั้งต้นของงานอีเวนต์

3. **Idempotency & Retry Safety:**
   - การเรียก `record_event_tank_movement` รองรับ `p_request_id` หากเกิดกรณีเน็ตเวิร์ก timeout หรือกดยืนยันซ้ำ ระบบจะตรวจจับ `request_id` ใน `event_tank_rentals` เดิม และส่งคืนผลลัพธ์เดิมโดยไม่สร้างบิลหนี้ซ้ำ

4. **Event Settlement Scope Protection:**
   - ใน `is_charge_collectible_in_run` เพิ่มเงื่อนไข `(charge.event_settlement_context_id IS NULL OR charge.service_date = run.service_date)` เพื่อป้องกันไม่ให้บิลค่าเช่าถังของวันถัดไป (เช่น ส่งมอบล่วงหน้าก่อนวันเปิดงาน) หลุดเข้ามาอยู่ในรอบเก็บเงินของวันนี้ ซึ่งจะทำให้การรับชำระเงินผิดพลาด

---

## 3. รายการไฟล์ที่เพิ่มและแก้ไข (Files Modified & Added)

### Database Migration:
- `supabase/migrations/0189_event_tank_rental_billing.sql` [NEW]
  - ขยายตาราง `delivery_charges` รองรับ `event_tank_rental_id`
  - ปรับปรุงฟังก์ชัน `enforce_delivery_charge_settlement_context`, `record_event_tank_movement`, `charge_line_items`, `is_charge_collectible_in_run`, `get_collection_run_queue`, `build_charge_print_document`, `build_payment_receipt_snapshot`, `accounting_transaction_rows`, และ `get_event_management_detail`

### Tests:
- `tests/event-tank-rental-billing.postgres.mjs` [NEW]
  - แบบทดสอบ End-to-End บน PostgreSQL 17 ครอบคลุม: การรัน Migration 0001–0189, การออกบิลอัตโนมัติ, Idempotency, คิวเก็บเงิน, การชำระเงิน, เอกสารใบเสร็จ, สมุดรายวันบัญชี, และการรับคืนถัง

### Frontend:
- `src/features/event-management/types.ts`
  - เพิ่มฟิลด์ `charge_id?`, `charge_number?`, และ `outstanding_amount?` ใน `EventTankMovement`
- `src/features/event-management/EventPreparationPanel.tsx`
  - เพิ่มฟังก์ชัน `printInvoice(chargeId)`
  - ปรับปรุงข้อความคำนวณราคาและแจ้งเตือนการสร้างบิลอัตโนมัติ
  - เพิ่มคอลัมน์ "บิลค่าเช่า" และ "การจัดการ (ปุ่มพิมพ์บิล)" ในตารางการเคลื่อนไหวของถัง
- `src/features/admin-reference-settings/components/UserEditor.tsx` & `src/AdminReferenceSettings.tsx`
  - ปรับปรุงโครงสร้างและ UI สำหรับจัดการข้อมูลและสิทธิ์ผู้ใช้งาน
- `src/index.css`
  - ปรับแต่งสไตล์และ Responsive layout ของระบบ
- `src/LocalDemoApp.tsx`
  - เพิ่ม mock routing และข้อมูลจำลองสำหรับทดสอบ User Management

---

## 4. ผลการทดสอบ (Verification Status)

| Test Suite | คำสั่ง | ผลลัพธ์ | รายละเอียด |
|---|---|---|---|
| Vitest Unit Tests | `npm test` | **Passed** | 47 test files passed (268/268 tests) |
| PostgreSQL Integration | `node tests/event-tank-rental-billing.postgres.mjs` | **Passed** | รัน Migration 0001–0189 สำเร็จ ทดสอบ lifecycle บิลค่าเช่าถังผ่าน 100% |
| Production Build | `npm run build` | **Passed** | TypeScript typecheck (`tsc -b`) & Vite build ผ่าน ไร้ข้อผิดพลาด |

---

## 5. สถานะ Git และสิ่งที่จะทำต่อในแชตใหม่ (Next Steps for Next Chat)

### Git Status ปัจจุบัน:
```bash
Untracked files:
  supabase/migrations/0189_event_tank_rental_billing.sql
  tests/event-tank-rental-billing.postgres.mjs

Modified files:
  src/AdminReferenceSettings.tsx
  src/LocalDemoApp.tsx
  src/features/admin-reference-settings/components/UserEditor.tsx
  src/features/event-management/EventPreparationPanel.tsx
  src/features/event-management/types.ts
  src/index.css
  HANDOFF.md
```

### ขั้นตอนถัดไปที่แนะนำ:
1. **Commit & Push Changes:**
   ```bash
   git add .
   git commit -m "feat(event): auto-billing for event tank rentals and update user layout"
   git push origin main
   ```
2. **Apply Migration to Supabase:**
   - รัน migration `0189_event_tank_rental_billing.sql` บน Supabase Production / Staging instance ผ่าน Supabase CLI หรือ Dashboard SQL Editor
3. **ทดสอบพิมพ์ใบแจ้งหนี้จริงบนอุปกรณ์ Android:**
   - ทดสอบสั่งพิมพ์บิลค่าเช่าถังอีเวนต์ผ่านเครื่องพิมพ์ความร้อน (Thermal Bluetooth/USB Printer) บนอุปกรณ์จริง
