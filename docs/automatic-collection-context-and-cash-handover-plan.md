# แผนลดขั้นตอนรอบเก็บเงินและเพิ่มการส่งมอบเงินสด

สถานะ: แผนพร้อมนำไปพัฒนา

## เป้าหมาย

พนักงานต้องเข้าคิวและรับชำระได้ทันทีโดยไม่ต้องรอหัวหน้าเปิดรอบหรือเลือกสมาชิก แต่ระบบยังต้องมีวันธุรกิจ ขอบเขตบิล การป้องกันรับเงินซ้ำ ประวัติผู้รับเงิน และการตรวจส่งมอบเงินสดที่ตรวจสอบย้อนหลังได้

แนวทางคือเก็บ `collection_runs` ไว้เป็น **daily collection context ภายในระบบ** ไม่แสดงเป็นงานที่ผู้ใช้ต้องเปิดหรือปิดเอง และใช้ `payments.recorded_by` ซึ่งบันทึกจาก `auth.uid()` เป็นแหล่งข้อมูลผู้รับเงินจริง

งานแบ่งเป็น 2 เฟสเพื่อแยกความเสี่ยง:

1. ทำรอบเก็บเงินให้เป็นอัตโนมัติและเปิดคิวร่วมแก่พนักงานทุกคน
2. เพิ่มกระบวนการพนักงานส่งมอบเงินสดและหัวหน้ายืนยัน

ใบเซ็นเครดิตรายวันไม่ใช่งานใหม่ ระบบปัจจุบันรวมหลาย INV ต่อร้านต่อวัน รองรับการออกเวอร์ชันใหม่เมื่อยอดเปลี่ยน และแนบรูปใบเซ็นอยู่แล้ว งานนี้จะรักษาพฤติกรรมดังกล่าวและเพิ่มเฉพาะ regression coverage

## ขอบเขตและกติกาหลัก

- ยกเลิกเฉพาะการเปิด–ปิด **รอบเก็บเงิน** จากหน้าจอ ไม่เปลี่ยนรอบส่งสินค้า การควบคุมสต๊อก หรือการปิดวัน
- พนักงานส่งที่ active, หัวหน้ารอบ และแอดมินเห็นคิวร้านที่ถึงกำหนดเก็บร่วมกัน
- คิวรวมยอดค้างของ `immediate`, `end_of_day` และ `credit` ที่ `due_date <= service_date`; เครดิตอนาคตไม่เข้าคิว
- ไม่ใช้ `collection_run_credit_charges` เพื่อเลือกเครดิตเข้าคิวสำหรับรายการใหม่
- ผู้รับเงินจริงมาจาก `auth.uid()` เท่านั้น ฝั่ง client ส่ง `employee_id` เพื่อระบุผู้รับเงินไม่ได้
- ใช้ `collection_runs.service_date` เป็นวันธุรกิจของ collection payment ต่อไป จึงยังไม่เพิ่ม `payments.service_date` ในงานนี้
- ประวัติรับเงินของพนักงานแสดงเฉพาะรายการที่ตนบันทึก หัวหน้าและแอดมินเห็นรายการทั้งหมด
- เงินสดที่พนักงานต้องส่งคือ `allocated_amount` ของ cash payment ไม่ใช่ `received_amount` เพราะ `received_amount` รวมเงินทอน

## เฟส 1: Daily collection context อัตโนมัติ

### Backend และสิทธิ์

1. เพิ่ม RPC `ensure_daily_collection_context(p_service_date date)` แบบ `security definer` และ idempotent:
   - อนุญาตเฉพาะ active `courier`, `round_lead` และ `admin`
   - ตรวจว่า `p_service_date` เป็นวันที่อนุญาตให้ทำงานตามกติกาวันธุรกิจเดิม และปฏิเสธวันที่ `daily_aggregate_stock_closures` ปิดแล้ว
   - ใช้ advisory lock ตามวันที่เพื่อป้องกันการสร้างซ้ำ
   - คืนรอบสถานะ `open` ที่มีอยู่ หรือสร้าง `collection_runs` หนึ่งรายการสำหรับวันนั้น
   - ไม่เพิ่มสมาชิกใน `collection_run_members`; รอบนี้เป็น shared daily context ไม่ใช่การมอบหมายคน
   - บันทึก audit action `auto_opened` เฉพาะเมื่อสร้างรายการใหม่

2. ปรับสิทธิ์ของ `get_collection_run_queue` และ collection branch ใน `record_payment`:
   - ยอมรับ shared context เมื่อผู้เรียกเป็น active `courier`, `round_lead` หรือ `admin`
   - ไม่ใช้ `is_collection_run_member` เป็นเงื่อนไขสำหรับ shared context
   - ไม่ขยาย RLS ของ `payments` ให้พนักงานอ่านรายการของคนอื่น; queue RPC เปิดเผยเฉพาะยอดค้างที่จำเป็น
   - manager ยังอ่าน payment ทั้งหมดได้ ส่วน courier อ่าน receipt และ history ของตนผ่าน `recorded_by`

3. ปรับ `is_charge_collectible_in_run`:
   - `immediate` และ `end_of_day` ที่ยังมียอดค้างเข้าคิวตามพฤติกรรมเดิม
   - `credit` เข้าได้เมื่อ `due_date <= collection_runs.service_date`
   - ตัดเงื่อนไขว่าต้องมีแถวใน `collection_run_credit_charges`
   - คงการจัดสรรเครดิตแบบ oldest-first ใน `record_payment`

4. ใช้ `record_payment` เดิมต่อไป:
   - ห้ามสร้าง RPC รับชำระชุดที่สอง
   - คง validation วิธีชำระ หลักฐาน approval, idempotency key, financial-shop lock, expected outstanding check, allocation integrity และ audit log เดิม
   - collection payment ส่ง internal `collection_run_id`; immediate payment ระหว่างส่งยังส่ง `null` ตามเดิม

5. ปรับ offline collection command ให้ใช้ internal `collectionRunId` ที่ได้จาก daily context ต่อไป เพื่อไม่เปลี่ยน contract และ recovery scope ของ offline ledger

### Frontend

1. เมื่อเข้าหน้าเก็บเงิน ให้เรียก `ensure_daily_collection_context(serviceDate)` ก่อนโหลด queue แล้วเก็บ ID ไว้เป็นข้อมูลภายใน
2. ลบ `CollectionRunManager`, modal เลือกพนักงาน ปุ่มเปิดรอบ ปุ่มปิดรอบ ข้อความเตือน และ state ที่มีไว้แก้รายชื่อสมาชิก
3. หน้าเก็บเงินต้องแสดง queue, auto-refresh และปุ่มรีเฟรชทันที โดยไม่ผูกการแสดงผลกับ `runId`
4. เปลี่ยนข้อความ error ที่กล่าวถึง “รอบเก็บเงินปัจจุบัน” เป็นข้อความเกี่ยวกับคิวหรือยอดล่าสุด
5. ลบการ assign/unassign เครดิตเข้ารอบจากหน้าจัดการเครดิต; ปุ่มเปิดเก็บเงินใช้งานได้เฉพาะหนี้ที่ถึงกำหนด หากยังไม่ถึงกำหนดให้แสดงวันครบกำหนดแทน
6. Demo mode ต้องสร้าง daily context ในหน่วยความจำอัตโนมัติและไม่มี UI เปิด–ปิดรอบเช่นเดียวกับระบบจริง

### การปิดและข้อมูลเก่า

- ไม่ bulk-close รอบเก่าระหว่าง migration และไม่สร้างข้อมูล `closed_by` ปลอม
- รอบเก่ากับ `collection_run_members` และ `collection_run_credit_charges` ยังอ่านประวัติได้ตามเดิม
- daily context ใหม่ไม่ต้องปิดด้วยมือ ระบบถือว่าเปลี่ยนบริบทเมื่อ `service_date` เปลี่ยน
- ปรับ `close_daily_aggregate_stock` ให้ปิด collection context ของวันเดียวกันใน transaction เดียวกัน โดยใช้ผู้ยืนยันปิดวันเป็น `closed_by`
- หาก daily close ถูกเรียกซ้ำ การปิด context ต้อง idempotent และไม่เขียน audit ซ้ำ
- ยังไม่ลบ RPC และตาราง legacy ใน release นี้; ทำเครื่องหมาย deprecated และห้ามมี call site ใหม่

## เฟส 2: ส่งมอบเงินสด

เริ่มเฟสนี้หลังเฟส 1 ผ่าน integration tests และเปรียบเทียบยอดรายวันเดิมกับยอดแยก `recorded_by` ได้ตรงกัน

### โมเดลข้อมูล

เพิ่ม `cash_handovers` แบบ append-oriented โดยมีข้อมูลอย่างน้อย:

- `id`, `service_date`, `employee_id`, `sequence`
- `period_started_at`, `period_ended_at`
- `expected_amount`, `submitted_amount`, `difference_amount`
- `source_fingerprint`
- `status`: `submitted`, `confirmed`, `rejected`
- `submitted_by`, `submitted_at`, `submission_note`
- `reviewed_by`, `reviewed_at`, `review_note`
- `idempotency_key`, `created_at`

ข้อบังคับ:

- `submitted_by` ต้องเท่ากับ `employee_id` และมาจาก `auth.uid()`
- `reviewed_by` ต้องเป็น active `round_lead` หรือ `admin`
- `difference_amount = submitted_amount - expected_amount`
- ถ้าส่วนต่างไม่เป็นศูนย์ต้องมี `submission_note`
- รายการ `confirmed` และ `rejected` แก้ไขหรือลบไม่ได้
- `sequence` ไม่ซ้ำภายในพนักงานและวันธุรกิจ และรองรับการส่งเงินเพิ่มเติมหลายครั้งในวันเดียวกัน

### การคำนวณยอด

- `expected_amount` คือผลรวม `payments.allocated_amount` ที่:
  - `payment_method = 'cash'`
  - `status = 'active'`
  - `recorded_by = employee_id`
  - มีวันธุรกิจตรงกับ `service_date`: collection payment ใช้ `collection_runs.service_date`; immediate payment ที่ไม่ผูกรอบใช้ `delivery_charges.service_date` ผ่าน `payment_allocations`
  - อยู่หลังจุดสิ้นสุดของ handover ล่าสุดที่ `confirmed` และไม่เกิน `period_ended_at` ของรายการใหม่
- เงินทอนไม่รวมในยอดส่ง เพราะอยู่ใน `change_amount` แล้ว
- cash refund ที่หัวหน้าหรือแอดมินจ่ายให้อยู่ใน reconciliation ของผู้จ่ายคืน ไม่ย้อนกลับไปลด handover ของพนักงาน
- หาก payment ถูก void หรือแก้ไขก่อนยืนยันจน fingerprint เปลี่ยน ห้ามยืนยันและให้พนักงานส่งรายการใหม่
- การ void หรือคืนเงินหลังยืนยันไม่แก้ snapshot handover เดิม ต้องปรากฏเป็น correction/refund แยกต่างหาก

### RPC และหน้าจอ

- `get_cash_handover_summary(p_service_date)`:
  - courier เห็นเฉพาะตนเอง
  - manager เห็นทุกพนักงาน พร้อม expected, submitted, confirmed และ remaining
- `submit_cash_handover(p_service_date, p_submitted_amount, p_note, p_idempotency_key)`:
  - ล็อกตามพนักงานและวัน
  - คำนวณช่วงและยอดจาก server
  - เก็บ fingerprint และ audit log ใน transaction เดียว
- `review_cash_handover(p_handover_id, p_decision, p_note)`:
  - รองรับ `confirm` และ `reject`
  - revalidate fingerprint ก่อน confirm
  - การ reject ต้องมีเหตุผล

หน้าพนักงานแสดงยอดควรส่ง ยอดที่กรอก ส่วนต่าง เหตุผล และประวัติ handover ของวัน ส่วนหน้าหัวหน้าแสดงสถานะรายพนักงานและ action ยืนยัน/ปฏิเสธ

## ใบเซ็นเครดิตรายวัน

รักษาพฤติกรรมปัจจุบันเป็นข้อกำหนด regression:

- หนึ่งร้านต่อหนึ่งวันธุรกิจรวมทุก INV เป็นใบเซ็นหนึ่งฉบับ
- เอกสารแจกแจงแต่ละ INV และแสดงยอดรวม
- ถ้ามีรายการส่งเพิ่มหลังพิมพ์ เอกสารเดิมเป็น stale และพิมพ์เวอร์ชันใหม่
- รูปใบเซ็นผูกกับ document version ที่พิมพ์จริง
- ใบเซ็นเครดิตเป็นหลักฐานรับรองยอดขาย ไม่ทำให้ invoice มีสถานะชำระแล้ว

## การทดสอบและเกณฑ์ยอมรับ

### เฟส 1

- ผู้ใช้สามบทบาทเข้าเก็บเงินได้โดยไม่มี action เปิดรอบ และการเข้าใช้งานพร้อมกันสร้าง context เพียงรายการเดียว
- courier ทุกคนเห็น queue เดียวกัน แต่ history และ receipt ของพนักงานอื่นยังอ่านไม่ได้
- เครดิตก่อนกำหนดไม่อยู่ในคิว; เครดิตครบกำหนดและเกินกำหนดอยู่ในคิวอัตโนมัติ
- บิลหลายใบของร้านเดียวจัดสรร oldest-first และการกดรับเงินพร้อมกันสำเร็จเพียงรายการเดียว
- retry ด้วย idempotency key เดิมคืน payment เดิมและไม่สร้าง receipt หรือ allocation ซ้ำ
- immediate payment, collection payment, evidence, approval, void, receipt printing และ offline recovery ยังทำงาน
- daily close ปิด context ของวันเดียวกันแบบ idempotent เมื่อเปิดใช้ integration นี้
- ไม่มีข้อความหรือปุ่มเปิด–ปิดรอบเก็บเงินเหลือใน manager, employee และ demo UI

### เฟส 2

- เงินสดที่มีเงินทอนใช้ `allocated_amount` เป็นยอดควรส่ง
- เงินโอนและ QR ไม่รวมใน handover; cash payment ของพนักงานอื่นไม่ถูกรวม
- พนักงานส่งได้หลายครั้งต่อวันโดยไม่มี payment ถูกนับซ้ำ
- ส่วนต่างที่ไม่มีเหตุผลถูกปฏิเสธ
- manager confirm/reject ได้; courier ทำไม่ได้
- payment เปลี่ยนก่อน confirm ทำให้รายการ stale และยืนยันไม่ได้
- confirmed handover ยังคง snapshot เดิมเมื่อเกิด void/refund ภายหลัง
- retry การ submit และ review ไม่สร้างรายการหรือ audit ซ้ำ

### Regression และ verification

- ใบเซ็นเครดิตหลาย INV ยังคงรวมหนึ่งใบต่อร้านต่อวันและ version ใหม่เมื่อยอดเปลี่ยน
- รัน database integration tests, offline ledger tests, UI tests, `npm run build` และ `npm run build:demo`
- ก่อนเปิดเฟส 2 เปรียบเทียบยอด cash payment แยก `recorded_by` กับ dashboard เดิมสำหรับข้อมูลทดสอบอย่างน้อยหนึ่งวัน โดยผลต่างต้องเป็นศูนย์

## สิ่งที่ไม่ทำในงานนี้

- ไม่ลบรอบส่งสินค้า รอบสต๊อก หรือ daily close
- ไม่เชื่อมตรวจสอบยอดโอนกับธนาคารหรือ Dynamic QR
- ไม่ลบตารางและคอลัมน์ legacy ที่อ้างถึง `collection_runs`
- ไม่เปลี่ยนใบเซ็นเครดิตให้เป็นใบเสร็จหรือหลักฐานชำระเงิน
- ไม่เปิดให้ client เลือกหรือแก้ผู้รับเงินจริงย้อนหลัง
