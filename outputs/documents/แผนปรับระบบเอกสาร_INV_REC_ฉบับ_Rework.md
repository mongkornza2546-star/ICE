# แผนปรับระบบเอกสาร INV / REC

*ฉบับ Rework พร้อมส่งให้ทีมพัฒนา*

**โครงการ:** ระบบส่งน้ำแข็งและการรับชำระเงิน

**สถานะเอกสาร:** Decision-complete implementation plan

**วันที่จัดทำ:** 6 สิงหาคม 2026

**ขอบเขตหลัก:** เลขเอกสารรายเดือน · ขายสดแบบ Atomic · Snapshot · พิมพ์ซ้ำ · ยกเลิก

## บทสรุปสำหรับทีมพัฒนา

ระบบใหม่ใช้เลขเอกสาร INV และ REC แยกตัวนับตามเดือน การขายสดต้องสร้างรายการส่ง ตัดสต๊อก รับเงิน จัดสรรยอด และออก REC ใน transaction เดียว ส่วนเก็บท้ายวันและเครดิตออก INV ตอนส่ง และออก REC เมื่อรับเงินจริงภายหลัง

> **ข้อเสนอเชิงสถาปัตยกรรม** เพิ่ม RPC record_immediate_sale เป็น orchestration layer ที่เรียก record_delivery และ record_payment เดิมใน PostgreSQL transaction เดียว ไม่เพิ่ม payment parameters เข้า record_delivery และไม่สร้าง receipt snapshot ซ้ำกับโครงสร้างที่มีอยู่แล้ว

### ข้อยืนยันสุดท้าย

- เลขเอกสารใหม่คือ INVYYMM-00001 และ RECYYMM-00001 โดยลำดับมี 5 หลักคงที่
- ขายสดไม่มีเลข INV แต่ยังมี delivery_charge ภายใน และต้องรับเงินครบก่อน commit
- เงินสดรับเกินได้พร้อมเงินทอน ส่วนโอนและ QR ต้องเท่ายอดพอดี
- เก็บท้ายวันและเครดิตออก INV ตอนส่ง และ REC ตอนรับเงินจริง
- หนึ่ง REC รองรับหลาย INV ของร้านเดียวกันผ่าน payment_allocations เดิม
- เอกสารใหม่พิมพ์จาก snapshot; เอกสารที่ยกเลิกคงเลขเดิมและพิมพ์พร้อมสถานะยกเลิกได้
- ข้อมูล C และ R เดิมไม่ถูกแปลง ไม่ถูกลบ และไม่นำมานับต่อ

## 1. กฎเลขเอกสารและตัวนับรายเดือน

| **ประเภท** | **จังหวะออกเอกสาร** | **รูปแบบและหัวกระดาษ** |
| --- | --- | --- |
| **ขายสด** | รับเงินจริงพร้อมการส่ง | RECYYMM-xxxxx<br>ใบส่งของ / ใบเสร็จรับเงิน |
| **เก็บท้ายวัน** | ส่งสินค้า → รับเงินภายหลัง | INV: ใบส่งของ / ใบแจ้งหนี้<br>REC: ใบเสร็จรับเงิน |
| **เครดิต** | ส่งสินค้า → รับเงินตามกำหนด | INV: ใบส่งของ / ใบแจ้งหนี้<br>REC: ใบเสร็จรับเงิน |

### โครงสร้างฐานข้อมูล

```text
document_counters
- document_type   INV | REC
- period_month    date (วันแรกของเดือน)
- last_sequence   integer
PRIMARY KEY (document_type, period_month)
```

- เพิ่มเลขด้วย atomic upsert หรือ row lock ภายใน transaction ที่สร้างเอกสาร
- INV ใช้เดือนจาก service_date แม้บันทึกย้อนหลังในเดือนถัดไป
- REC ใช้ recorded_at จากเซิร์ฟเวอร์และเขตเวลา Asia/Bangkok
- เริ่ม 00001 และหยุดรายการพร้อมข้อผิดพลาดเมื่อเกิน 99999
- การ void ไม่ลดตัวนับและไม่นำเลขกลับมาใช้ใหม่

### การเปลี่ยน trigger

- delivery_charges ที่ payment_term = immediate กำหนด charge_number = null
- delivery_charges ที่เป็น end_of_day หรือ credit ใช้ INVYYMM-xxxxx
- payments ทุกประเภทใช้ RECYYMM-xxxxx
- ยกเลิกการใช้งาน sequence C/R เดิม โดยคงข้อมูลและเลขเดิมไว้
- คง unique index ของเลขเอกสาร; ค่า null หลายรายการสำหรับขายสดรองรับโดย PostgreSQL

## 2. ขายสดแบบ Atomic

เพิ่ม RPC ใหม่โดยไม่เปลี่ยน contract ของ record_delivery:

```text
record_immediate_sale(
  round_stop_id, items, note, client_recorded_at,
  payment_method, received_amount, reference_number,
  evidence_path, idempotency_key
) -> jsonb
```

### ลำดับการทำงานใน transaction

1. เรียก record_delivery ด้วยสถานะ delivered, payment_term = immediate และ idempotency key ที่รับมา
1. รับ charge_id และยอดจริงที่คำนวณจาก price snapshot ฝั่งเซิร์ฟเวอร์
1. ตรวจยอดรับ: เงินสดต้องไม่น้อยกว่ายอดจริง; โอนและ QR ต้องเท่ายอดจริง
1. เรียก record_payment ด้วย key เดียวกันและ allocation เต็มยอดของ charge
1. คืน delivery, payment, REC number และ print payload ใน response เดียว

> **Atomic guarantee** หาก delivery, stock, charge, payment, allocation, document counter หรือ REC ขั้นใดล้มเหลว PostgreSQL ต้อง rollback ทั้งชุด ไม่มีขายสดค้างโดยไม่มี REC

### Idempotency

- ใช้ key เดียวกันใน delivery_events และ payments ซึ่งมี unique constraint แยกตารางอยู่แล้ว
- record_delivery ตรวจ fingerprint ของรายการส่ง ส่วน record_payment ตรวจยอด วิธีชำระ reference หลักฐาน และ allocations
- double-click, timeout และ retry ต้องคืน event, payment และเลขเดิม
- frontend signature ต้องรวมรายการสินค้า วิธีชำระ ยอดรับ reference และ metadata ของหลักฐาน

## 3. Frontend ขายสด

- ขั้นแรกกรอกรายการและเลือกจ่ายทันที แต่ยังไม่เขียนฐานข้อมูล
- ขั้นที่สองแสดงหน้ารับเงินใน local state และเรียก record_immediate_sale เมื่อยืนยัน
- ตัดตัวเลือก “ยังไม่รับเงินตอนนี้” การรับบางส่วน และ approval ยอดค้างออกจากขายสด
- เปิดหน้าต่างพิมพ์เปล่าจาก user action ก่อนเริ่ม upload/RPC แล้วเติมเอกสารหลังสำเร็จ
- หากราคาฝั่งเซิร์ฟเวอร์เปลี่ยนจนยอดไม่ตรง ให้ rollback โหลดราคาใหม่ และขอให้ผู้ใช้ยืนยันอีกครั้ง
- คง pending draft และ idempotency key เดิมไว้สำหรับ retry

### หลักฐานการชำระ

Supabase Storage ไม่อยู่ใน PostgreSQL transaction จึงกำหนดขอบเขต atomic guarantee เฉพาะข้อมูลในฐานข้อมูล

- อัปโหลดไฟล์ด้วย path ที่สร้างจาก idempotency key และใช้ upsert
- เมื่อ RPC ล้มเหลวให้ retry ด้วย key/path เดิม ไม่สร้างไฟล์ซ้ำ
- เมื่อผู้ใช้ยกเลิก draft อย่างชัดเจน ให้ลบไฟล์ที่อัปโหลดแบบ best effort

## 4. เก็บท้ายวัน เครดิต และหลาย INV ต่อ REC

- ตอนส่งใช้ record_delivery เดิมและออก INV พร้อม print payload
- ตอนเก็บเงินจริงใช้ record_payment เดิมและออก REC
- หนึ่ง REC จัดสรรให้หลาย INV ได้ผ่าน payment_allocations
- INV ใน REC เดียวกันต้องเป็นร้านเดียวกันและยัง active
- allocation ต้องไม่เกินยอดค้างล่าสุดของแต่ละ INV
- REC แสดงเลข INV และยอดที่ตัดแต่ละใบตาม snapshot

## 5. Snapshot และการพิมพ์ซ้ำ

### REC: ใช้โครงสร้างที่มีอยู่

ใช้ payment_receipt_snapshots จาก migration 0124 ต่อไป และขยาย payload โดยไม่เพิ่ม snapshot ซ้ำใน payments

- เพิ่ม payment_term, document_title, ราคาต่อหน่วย จุดส่ง และ charge_number แบบ nullable
- Snapshot เก่าไม่ถูกแก้; หากไม่มีฟิลด์ใหม่ให้ใช้หัว “ใบเสร็จรับเงิน” เป็น fallback
- ขายสดที่ charge_number เป็น null ต้องไม่แสดงคำว่า null หรือ “ไม่พบเลขที่บิล”
- สถานะ void ใช้ข้อมูลสดจาก payment มาผนวกตอนอ่าน โดยไม่แก้ snapshot ต้นฉบับ

### INV: เพิ่ม snapshot คู่ขนาน

```text
delivery_charge_document_snapshots
- charge_id      uuid PRIMARY KEY
- document_data  jsonb NOT NULL
- created_at     timestamptz
```

- สร้างเฉพาะ charge ที่มีเลข INV หลัง delivery items ถูกสร้างครบ
- เก็บร้าน จุดส่ง รายการ ชื่อ/หน่วย ราคา จำนวน ยอด วันที่ส่ง วันครบกำหนด และเลข INV
- ห้าม update/delete snapshot
- เพิ่ม get_charge_print_document(charge_id) และใช้ get_payment_receipt_snapshot(payment_id) เดิมสำหรับ REC

## 6. ตัวช่วยพิมพ์กลาง 57 มม.

สร้าง printSalesDocument(payload) และ refactor receipt printer เดิมให้ใช้ข้อมูลรูปแบบเดียวกัน

- แสดงประเภทและเลขเอกสาร ร้าน จุดส่ง วันที่ส่ง/รับเงิน เวลาออก รายการ จำนวน ราคาต่อหน่วย และยอดรวม
- REC แสดงวิธีชำระ ยอดรับ เงินทอน และ INV allocations
- INV แสดงช่องลายเซ็นผู้รับสินค้า
- voided document แสดง “ยกเลิก” เหตุผล ผู้ยกเลิก และเวลาอย่างชัดเจน
- หาก popup ถูกบล็อก ให้แสดงเลขที่ออกแล้วและปุ่มพิมพ์ซ้ำ โดยไม่สร้าง transaction ใหม่

## 7. การแก้ไขและยกเลิกเอกสาร

> **กฎขายสด** revise_delivery_event(action = correct) ต้องปฏิเสธรายการ immediate เพื่อไม่ให้สร้าง replacement charge ที่ไม่มี REC

### Workflow การแก้ขายสดในรุ่นแรก

1. Void REC เดิมจากหน้าธุรกรรมการเงิน
1. Cancel delivery เดิมเพื่อคืนผลทางสต๊อกและ void charge ภายใน
1. บันทึกขายสดใหม่ผ่าน record_immediate_sale และออก REC ใหม่

- เลขเดิมคงสถานะ voided และห้ามนำกลับมาใช้
- End-of-day/credit correction ใช้ revision เดิมและออก INV ใหม่
- Active payment ต้องถูก void ก่อน cancel INV ตาม integrity constraint เดิม
- หน้าประวัติต้องคืนและแสดง canceled event/voided charge แต่ยอดสรุปทางการเงินนับเฉพาะ active
- ปุ่มพิมพ์มีทั้ง active และ voided ส่วนปุ่มยกเลิกมีเฉพาะ active

## 8. API และ TypeScript contracts

```text
type SalesDocumentPayload = {
  documentType: 'INV' | 'REC';
  documentNumber: string;
  title: string;
  status: 'active' | 'voided';
  issuedAt: string;
  serviceDate: string | null;
  shop: { code: string; name: string; location: string | null };
  paymentTerm: PaymentTerm;
  items: SalesDocumentItem[];
  allocations: DocumentAllocation[];
  totals: { total: number; received: number | null; change: number | null };
  voidInfo: { voidedAt: string; reason: string } | null;
};
```

- ทุก contract ที่รับ charge_number ต้องเปลี่ยนเป็น string | null
- แสดงเลข INV เฉพาะเมื่อมีค่าจริง
- RPC ขายสดคืนทั้ง delivery/payment/receipt และ print document
- RPC พิมพ์ซ้ำตรวจ visibility เดิมก่อนคืน snapshot

## 9. Migration และ rollout

| **ลำดับ** | **งาน** | **ผลลัพธ์** |
| --- | --- | --- |
| **1** | เพิ่ม document_counters และฟังก์ชันออกเลข | รองรับ INV/REC แยกเดือนและ overflow guard |
| **2** | แทน trigger เลข C/R และปลด NOT NULL ของ charge_number | ข้อมูลใหม่ใช้ INV/REC; ข้อมูลเก่าคงเดิม |
| **3** | เพิ่ม record_immediate_sale และ revision guard | ขายสด atomic และ correction ไม่หลุด invariant |
| **4** | ขยาย receipt snapshot และเพิ่ม INV snapshot | พิมพ์ซ้ำจากข้อมูล ณ เวลาออกเอกสาร |
| **5** | ปรับ history/RPC grants และ reload schema | ดูและพิมพ์ active/voided ได้ |
| **6** | ปรับ frontend/types/tests/demo/reset script | รองรับ workflow และเอกสารใหม่ครบเส้นทาง |

### ข้อกำหนด rollout

- Migration ใหม่ไม่เปลี่ยน ไม่ลบ และไม่นำเลข C/R เดิมมานับต่อ
- Snapshot legacy ที่ migration 0124 สร้างไว้แล้วคงเดิมและใช้ fallback schema
- Reset document_counters และ snapshot tables เฉพาะ test/development
- Production ไม่ต้องมี cron หรือคำสั่ง reset รายเดือน

## 10. แผนทดสอบและเกณฑ์รับงาน

### Database และ idempotency

- INV/REC รายการแรกของเดือนเป็น 00001 และตัวนับแยกประเภท
- เดือนใหม่เริ่ม 00001; รายการ 100000 ถูกปฏิเสธ
- INV ย้อนหลังใช้ service_date; REC ใช้ขอบเวลา Bangkok 23:59:59/00:00:00
- double-click, timeout และ retry คืน record/เลขเดิม
- ความล้มเหลวระหว่าง payment ทำให้ขายสด rollback ทั้ง transaction

### Business flow

- เงินสดเท่ายอดและเกินยอดผ่าน พร้อมเงินทอน; เงินสดขาดถูกปฏิเสธ
- โอนและ QR ต้องเท่ายอดพอดี
- ขายสดไม่มี INV และออกเฉพาะ REC หัว “ใบส่งของ / ใบเสร็จรับเงิน”
- End-of-day/credit ออก INV ตอนส่งและ REC ตอนรับเงิน
- REC เดียวรับชำระหลาย INV ร้านเดียว และปฏิเสธต่างร้าน/voided/เกินยอดค้าง
- Immediate correction ถูกปฏิเสธและ workflow void/cancel/re-entry ทำงานครบ

### Snapshot และ UI

- แก้ชื่อร้าน สินค้า หรือราคาแล้วเอกสารใหม่ที่พิมพ์ซ้ำยังเหมือนฉบับออกครั้งแรก
- voided document พิมพ์พร้อม watermark และเหตุผล
- popup blocked แล้วยังพิมพ์ซ้ำเลขเดิมได้โดยไม่สร้างรายการใหม่
- Legacy C/R ยังเปิดดูได้และไม่กระทบตัวนับใหม่
- รัน npm test และ npm run build จนผ่าน

### Concurrency จริง

เพิ่ม integration test แบบ opt-in ด้วย PostgreSQL อย่างน้อยสอง connections ผ่าน TEST_DATABASE_URL เพื่อสร้าง INV และ REC พร้อมกัน ตรวจว่าเลขไม่ซ้ำและตัวนับไม่รบกวนกัน PGlite ใช้ตรวจ format, overflow, rollback และ idempotency แต่ไม่ถือว่าพิสูจน์ row locking จริง

## 11. สิ่งที่ไม่รวมในงานนี้

- ไม่เพิ่ม enum credit_cycle; ใช้ due_date, credit_due_rule และ credit_days เดิม
- ไม่เพิ่ม ESLint configuration เนื่องจาก repository ยังไม่มี lint setup
- ไม่แปลงเลข C/R เดิมเป็น INV/REC
- ไม่รับประกัน transaction ครอบคลุม Supabase Storage
- ไม่อนุญาตแก้ขายสดแบบ in-place ในรุ่นแรก

## Definition of Done

- Migration ใช้งานได้ทั้งฐานข้อมูลใหม่และฐานข้อมูลที่มีเอกสาร legacy
- ขายสดไม่มีช่วงเวลาที่ commit delivery แล้วแต่ไม่มี REC
- เลขเอกสารถูกต้องภายใต้ retry, overflow, ขอบเดือน และ concurrent callers
- เอกสาร active/voided พิมพ์จาก snapshot เดิมได้ทุกจุดที่กำหนด
- ชุดทดสอบอัตโนมัติ build และ concurrency verification ผ่านก่อน deploy
