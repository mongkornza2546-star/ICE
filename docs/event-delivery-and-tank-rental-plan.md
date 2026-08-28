# แผนระบบอีเวนต์ การส่งน้ำแข็ง และค่าเช่าถัง — ฉบับ Rework 2

สถานะ: พร้อมแตกงาน โดยรุ่นแรกใช้ INV หนึ่งฉบับต่อ charge ตามหัวข้อ 8.4
วันที่ปรับแผน: 2026-08-23

## 1. เป้าหมายและขอบเขต

เพิ่มงานอีเวนต์หลายวันซึ่งมีร้านเข้าร่วม 2–50 ร้าน รองรับหลายอีเวนต์พร้อมกัน และใช้ POS, สต๊อก, การเงิน และเอกสารชุดเดิมเป็นแกนหลัก

พนักงานต้องทำงานได้ดังนี้:

- เลือก “ร้านประจำ”, “อีเวนต์” หรือ “ลูกค้าขาจร”; การ “รับคืนถังค้าง” อยู่ภายในหน้าอีเวนต์
- เมื่อเลือกอีเวนต์ ให้เลือกงานก่อนเลือกร้าน
- ส่งน้ำแข็งให้ร้านเดิมหรือร้านที่มีเฉพาะประวัติอีเวนต์
- ส่งมอบและรับคืนถังเช่าแบบนับจำนวน ไม่มีรหัสรายใบ
- คิดค่าเช่าเมื่อส่งมอบจริง และรวมกับยอดน้ำแข็งของ participation เดียวกันในวันเดียวกันบนคิวเก็บเงิน ใบสรุปยอด และใบเสร็จ
- รับคืนถังได้หลังงานจบหรือยกเลิกจนกว่ายอดค้างเป็นศูนย์

ขอบเขตถัง:

- ค่าเช่าเริ่มต้น 100 บาทต่อถังที่ส่งมอบจริง
- ส่งมอบเพิ่มคิดเพิ่มตามจำนวน
- การคืนถังไม่คืนค่าเช่า
- ร้านที่ใช้ถังของตัวเองไม่มี movement, รูปหลักฐาน, สถานะ หรือค่าใช้จ่ายเกี่ยวกับถัง
- ระบบถังเช่าประจำร้านแบบมีรหัสเดิมยังคงแยกจากระบบนี้และต้องไม่ถูกแก้พฤติกรรม

ความหมายของ “รวมยอด” ในรุ่นแรก:

- ice delivery และ tank handoff แต่ละครั้งยังเป็น charge แยกเพื่อรักษา audit และ idempotency
- คิวเก็บเงิน ใบสรุปยอด และ REC รวมหลาย charge ของ `event_participation_id + service_date` ได้
- INV ยังคงออกหนึ่งฉบับต่อ charge ตามระบบเดิม ไม่สร้าง consolidated INV ในรุ่นแรก
- หากธุรกิจต้องการ INV เดียวต่อ participation ต่อวัน ต้องเพิ่ม billing-document header เป็นเฟสแยก ห้ามจำลองด้วยการแก้หรือรวม charge ย้อนหลัง

รุ่นแรกเป็น online-only สำหรับงานอีเวนต์และถังเช่า ส่วน offline เต็มรูปแบบเป็นเฟสแยกหลัง bundle, IndexedDB outbox และ typed sync adapters ของระบบหลักพร้อมใช้งาน

## 2. หลักสถาปัตยกรรม

### 2.1 ใช้ customer identity เดียว

`shops.id` ยังคงเป็นรหัสธุรกิจ/ลูกค้าที่เป็นเจ้าของประวัติการส่ง ราคา การเงิน การชำระ และถัง

เพิ่ม `shops.customer_kind`:

- `regular` — ร้านประจำ ใช้ตึก โซน จุดสต๊อก และขั้นตอนเดิม
- `event_only` — ลูกค้าที่รู้จักจากอีเวนต์ เก็บประวัติใช้ซ้ำในงานถัดไป แต่ไม่เข้ารอบร้านประจำและไม่แสดงในหน้าร้านประจำ

กติกา:

- ร้านเดิมที่ร่วมงานใช้ `shops.id` เดิม ห้ามสร้างลูกค้าซ้ำ
- ลูกค้าใหม่จากงานสร้างเป็น `shops.customer_kind = 'event_only'`
- รหัสร้าน/ลูกค้าต้องไม่ซ้ำทั้งระบบ เพื่อให้ Excel import และการค้นหา idempotent
- ข้อมูลผู้จัดงาน สถานที่ เลขบูธ โซนอีเวนต์ จุดสังเกต และช่วงวันที่อยู่ที่ participation เท่านั้น ห้ามเขียนทับข้อมูลร้านประจำ
- สำหรับ `event_only` ให้ปรับ field สถานที่ประจำซึ่งปัจจุบันบังคับกรอกเป็น nullable แบบมี CHECK ตาม `customer_kind`; query ร้านประจำทุกจุดต้องกรอง `customer_kind = 'regular'` ก่อน join ตึก/โซน/จุดสต๊อก
- migration เดียวกันต้องปรับ `sync_shop_location_from_zone`, `assign_shop_stock_location`, shop save/import writers และ trigger ที่สมมติว่า zone/stock location เป็น non-null ให้ branch ตาม `customer_kind`; ห้าม deploy nullable columns ก่อน compatibility writers พร้อม
- event delivery RPC ต้องกำหนด `source_stock_location_id` จากผู้ส่ง/กติกาสต๊อกโดยตรง ห้าม fallback ไปยัง `event_only.shop.stock_location_id`
- read model ร้านประจำใช้ inner join ตึก/โซนได้หลังกรอง `regular`; read model การเงินที่ต้องรวม `event_only` ต้องใช้ nullable location/left join และแสดง event snapshot แทน
- รายงานการเงินยังรวม `event_only` เมื่อมี charge แต่รายงานร้านประจำต้องแยกประเภทอย่างชัดเจน

### 2.2 หนึ่ง financial ledger

ห้ามสร้าง payment allocation ชุดที่สอง

ขยาย `delivery_charges` ให้เป็น canonical charge header โดยคงชื่อตารางและ signature เดิมไว้ในช่วง compatibility:

- เพิ่ม `charge_kind`: `ice_delivery` หรือ `tank_rental`
- `ice_delivery` ต้องมี `delivery_event_id` และไม่มี `event_tank_movement_id`
- `tank_rental` ต้องมี `event_tank_movement_id` และไม่มี `delivery_event_id`
- เพิ่ม CHECK ว่ามี source ถูกชนิดเพียงหนึ่งรายการ
- source แต่ละรายการสร้าง active charge ได้เพียงหนึ่งรายการ
- เพิ่ม `event_participation_id` เป็น settlement context สำหรับ charge ของอีเวนต์

ใช้ `payment_allocations`, `payments`, charge adjustments, refund obligations, receipt snapshots และเลขเอกสารชุดเดิมต่อไป

ขยาย payment context แบบ additive:

- `payments.event_participation_id`, `payments.settlement_service_date` และ `payments.settlement_policy_fingerprint` เป็น nullable สำหรับ payment เดิม แต่ต้อง non-null พร้อมกันสำหรับ event payment
- event-aware payment RPC รับ expected participation/date/policy fingerprint และ derive shop จาก charge ฝั่ง server
- deferred integrity check บังคับว่า allocation ทุก charge ของ event payment มี `shop_id`, `event_participation_id` และ `service_date` ตรงกับ payment context
- payment รุ่นแรกห้ามผสม event charge กับ regular charge หรือผสมคนละ participation/date แม้เป็น `shop_id` เดียวกัน
- legacy `record_payment` ต้อง reject event charge; ห้ามอาศัย client ซ่อนรายการเพียงอย่างเดียว

เพิ่ม `event_tank_rental_charge_details` แบบ 1:1 กับ charge เพื่อ snapshot:

- movement ต้นทาง
- จำนวน
- ราคาต่อใบ
- หน่วยและคำอธิบายเอกสาร
- ยอดรวม

เพิ่ม `event_tank_charge_adjustments` แบบ append-only สำหรับ correction โดยเก็บ:

- `event_tank_movement_correction_id` และ `charge_id` แบบ unique ตาม correction
- original/corrected quantity, unit-price snapshot, `amount_delta` และ corrected total
- reason, actor, timestamps, idempotency key และ request fingerprint

คง `delivery_charge_adjustments`/`delivery_adjustment_items` สำหรับ ice correction ตามเดิมและห้ามใส่ tank row ที่ปลอม `ice_type_id`; ขยาย `effective_delivery_charge_amount(charge_id)` โดยคง signature ให้รวม tank adjustment และเพิ่ม `financial_charge_adjustments_v` เพื่อ normalize adjustment ทั้งสองชนิดสำหรับ reader ใหม่

เพิ่ม read model `financial_charge_lines_v` ซึ่ง normalize:

- น้ำแข็งจาก `delivery_items`
- ค่าเช่าจาก `event_tank_rental_charge_details`
- effective amount/adjustment จาก `financial_charge_adjustments_v` โดยไม่แก้ original snapshot line

ใบสรุปยอด ใบแจ้งหนี้ ใบเสร็จ คิวเก็บเงิน รายงานบัญชี และ export ต้องอ่าน line model เดียวกัน

### 2.3 แยก destination occurrence ออกจาก customer

ขยาย `round_stops`:

- `destination_kind`: `regular` หรือ `event`
- `shop_id` ยังคง non-null เพื่อเป็น customer/financial owner
- `event_participation_id` non-null เฉพาะ `event`
- `is_operational` ใช้ปิดการส่งใหม่โดยไม่ลบ snapshot/history
- snapshot ชื่องาน สถานที่ เลขบูธ โซน จุดสังเกต และเบอร์ติดต่อ

แทน unique เดิมด้วย partial unique:

- ร้านประจำ: `(round_id, shop_id) WHERE destination_kind = 'regular'`
- ร้านอีเวนต์: `(round_id, event_participation_id) WHERE destination_kind = 'event'`

ผลคือร้านเดียวสามารถมีร้านประจำหนึ่ง stop และร่วมหลายอีเวนต์ในวันเดียวกันได้โดยไม่ชนกัน

ข้อกำหนด compatibility ของ unique index:

- migration ที่แทน unique เดิมต้องแก้ `ON CONFLICT (round_id, shop_id)` ใน RPC เก่าให้ระบุ predicate `WHERE destination_kind = 'regular'` ใน transaction เดียวกัน
- backfill stop เดิมเป็น `destination_kind = 'regular'` ก่อนสร้าง partial unique และก่อนเปิดให้ insert event stop

ประวัติและยอดบนบัตร:

- บัตรร้านประจำรวมตาม `shop_id + service_date` ตามพฤติกรรมเดิม
- บัตรอีเวนต์รวมตาม `event_participation_id + service_date`
- ยอดรวมทั้งลูกค้าในวันเดียวกันแสดงได้เป็นข้อมูลเสริม แต่ต้องติดป้ายว่า “รวมทุกจุด” และห้ามแทนยอดของบูธที่เลือก

### 2.4 Compatibility fence สำหรับ client รุ่นเก่า

ก่อนสร้าง event stop ใน production ต้องติดตั้ง fence ครบทุกข้อ:

- `sync_daily_round_active_shops` เพิ่มเฉพาะ `regular` และใช้ partial-conflict predicate ที่ถูกต้อง
- `get_round_shop_cards` signature เดิมคืนเฉพาะ `destination_kind = 'regular'`
- `get_delivery_pos_context`, `record_delivery`, immediate-sale RPC และ delivery-correction RPC signature เดิมต้อง reject event stop ที่ database boundary
- event UI ใช้ RPC/DTO รุ่นใหม่ซึ่ง derive `event_participation_id` จาก `round_stop_id`; ห้ามรับ participation จาก client แล้วเชื่อโดยไม่ cross-check
- เพิ่ม `get_event_delivery_capability()` เพื่อให้ client เปิด UI เฉพาะเมื่อ schema/RPC version และ feature flag พร้อม
- เครื่องที่ยังใช้ client รุ่นเก่าจะไม่เห็น event stop และไม่สามารถเขียน event delivery ได้ แม้รู้ UUID ของ stop

## 3. โมเดลอีเวนต์และ lifecycle

### 3.1 `event_jobs`

เก็บ:

- ชื่องาน ผู้จัด ผู้ติดต่อ และเบอร์โทร
- สถานที่ วันที่เริ่ม–สิ้นสุด และ timezone `Asia/Bangkok`
- หมายเหตุ
- `tank_rental_unit_price` ซึ่ง default 100 บาท
- event settlement policy: payment term `end_of_day`, วิธีรับเงิน และกติกา reference/evidence
- สถานะ `draft`, `published`, `cancelled`
- ผู้สร้าง ผู้เผยแพร่ ผู้ยกเลิก เวลา และเหตุผล

สถานะที่แสดงแก่ผู้ใช้:

- `upcoming`, `active` และ `ended` คำนวณจากวันที่ของ `published` job
- `cancelled` มีลำดับสูงสุดและเป็นสถานะปลายทาง
อนุญาต transition:

- `draft → published`
- `draft → cancelled`
- `published → cancelled`
- ห้ามย้อน `cancelled` หรือ `published` กลับเป็น `draft`

กติกาหลัง publish:

- `tank_rental_unit_price` และ settlement policy ของ job ถูก freeze สำหรับ participation ที่ publish แล้ว
- ตอน publish ให้ snapshot ราคาเช่าถังและ settlement policy ลง participation พร้อม fingerprint
- การเพิ่ม participation หลัง publish ผ่าน audited RPC จะ snapshot config เวอร์ชันปัจจุบัน แต่ห้ามเปลี่ยน snapshot ของ participation ที่มี delivery, movement, charge หรือ payment แล้ว
- การแก้ราคา/นโยบายสำหรับวันหรือ participation ถัดไปต้องสร้าง config version ใหม่ ไม่ UPDATE snapshot ที่ถูกใช้งานแล้ว

### 3.2 `event_participations`

เชื่อม `event_job_id` กับ `shop_id` และเก็บ:

- เลขบูธ โซนอีเวนต์ จุดสังเกต
- ผู้ติดต่อและโทรศัพท์สำหรับงานนี้
- วันที่เริ่ม–สิ้นสุดแบบ inclusive ซึ่งต้องอยู่ภายในช่วงงาน
- `rents_tank_from_us`
- settlement policy snapshot ที่ใช้กับ charge ของ participation นี้
- `tank_rental_unit_price_snapshot` และ `settlement_policy_fingerprint`
- สถานะ operational และ audit fields

ขอบเขตรุ่นแรก:

- ร้านหนึ่งมี participation เดียวต่อ event
- ร้านร่วมเฉพาะบางวันได้
- งานเดียวมี active participation 2–50 รายการตอน publish
- participation เดียวกันห้ามซ้ำจากการ import หรือ retry

กติกาแก้ไข:

- `rents_tank_from_us` แก้ได้ก่อนมี movement เท่านั้น
- settlement policy และราคาเช่าถัง snapshot แก้ได้ก่อนมี delivery, movement, charge หรือ payment เท่านั้น และทุกการแก้ต้องเปลี่ยน fingerprint
- ลดช่วงวันที่ไม่ได้หากมี delivery หรือ movement ในวันที่กำลังตัดออก
- snapshot ของ `round_stops` ที่สร้างแล้วห้ามแก้ย้อนหลัง
- การยกเลิก participation ปิด delivery/handoff ใหม่ แต่ไม่ลบประวัติ charge, payment, movement หรือ evidence และยังรับคืนถังได้

### 3.3 เงื่อนไข publish

RPC publish ต้อง lock job และตรวจทั้งหมดใน transaction เดียว:

- มี participation 2–50 รายการและไม่มีรายการซ้ำ
- ช่วง participation ถูกต้องและอยู่ในช่วง event
- customer identity, รหัส และข้อมูลติดต่อขั้นต่ำครบ
- ราคากลางครอบคลุมชนิดน้ำแข็งที่เปิดใช้งานสำหรับทุก service date ของงาน
- settlement policy เป็น `end_of_day` และมีวิธีรับเงินอย่างน้อยหนึ่งวิธี
- ค่าเช่าถังมากกว่า 0
- ไม่มี Excel import หรือการแก้ participation ที่ยังไม่จบ

หากชนิดน้ำแข็งใหม่ถูกเปิดใช้งานหลัง publish ต้องมีราคากลางของวันที่ส่งก่อนจึงจะแสดงใน POS อีเวนต์

## 4. การ sync เข้ารอบประจำวัน

เพิ่ม `sync_daily_round_destinations(round_id)` และให้ client รุ่นใหม่เรียกแทน `sync_daily_round_active_shops`

ก่อนเรียก sync ต้องแก้ membership discovery loop ของพนักงานที่เพิ่ง active หลังเปิดรอบแล้ว: `get_employee_active_session` ต้อง idempotently เพิ่มเฉพาะ `auth.uid()` ที่เป็น active `courier`/`round_lead`/`admin` เข้าเป็นสมาชิกของ open daily round ใน service date ที่กำลังค้นหา ก่อน filter session ตาม membership. การ bootstrap นี้ไม่รับ `round_id` จาก client และไม่ให้สิทธิ์กับ role อื่น ส่วน destination sync ยังคง refresh active roster ทั้งชุดเพื่อให้ `delivery_round_members` ครบสำหรับ reader/return queue อื่น

RPC ต้อง:

1. ใช้ global lock order ในหัวข้อ 6.3; migration ต้องแก้ sync, delivery, close-round และ daily-close เดิมให้ใช้ order เดียวกันก่อนเปิด event writes
2. ยืนยันว่า caller เป็น active user และเป็น admin/round lead หรือสมาชิกของรอบ จากนั้นยืนยันว่าเป็น daily round ที่เปิดอยู่
3. sync active courier/round lead/admin ที่เพิ่มภายหลังเข้า `delivery_round_members`
4. insert ร้าน `regular` ที่ active เป็น regular stops
5. อ่าน `event_stops_enabled` ที่ database boundary; เมื่อ flag เป็น `false` ห้าม insert/reactivate/deactivate event stop แม้ caller เรียก RPC โดยตรง แต่ regular/member sync ยังทำงานได้
6. เมื่อ flag เป็น `true` ให้ insert participation ของ published event ที่ครอบคลุม service date เป็น event stops
7. ไม่แก้ snapshot หรือ destination identity ของ stop ที่มีอยู่; migration เดียวกันต้องเพิ่ม `BEFORE UPDATE` trigger บังคับ immutability ของ `round_id`, `shop_id`, `destination_kind`, `event_participation_id`, shop/location snapshots และ event snapshots โดยยังอนุญาต workflow fields เช่น `sequence_no`, `status`, `note`, `is_operational`, `updated_by`, `updated_at`
8. เปลี่ยนเฉพาะ `is_operational = false` เมื่อ event/participation ถูกยกเลิกหรือไม่ควรรับงานใหม่ และ re-activate ได้เฉพาะ participation เดิมที่กลับมา eligible ตาม lifecycle ที่อนุญาต โดยห้ามเขียน snapshot ใหม่
9. ไม่ลบ stop ที่มีอยู่ ไม่ว่า stop นั้นจะมี delivery, movement, charge หรือ audit history แล้วหรือยัง

RPC บันทึก event ice delivery และ tank handoff ต้อง lock round/job/participation ตามลำดับและตรวจสถานะซ้ำภายใน transaction; ห้ามเชื่อ client card หรือ `is_operational` เพียงอย่างเดียว

client รุ่นเก่ายังเรียก `sync_daily_round_active_shops` ได้ในช่วง rollout แต่ RPC/read/write เดิมทั้งหมดต้องอยู่หลัง compatibility fence ในหัวข้อ 2.4

ผลต่อ round close/reporting:

- round close ยังคงปิดได้แม้ event stop เป็น pending หรือ `is_operational = false` ตามพฤติกรรมเดิมที่ snapshot จำนวนสถานะ ไม่ใช้ถังค้างเป็น blocker
- `round_close_summaries` และ dashboard ต้องแยกจำนวน `regular` กับ `event`; ห้ามรวม event participation แล้วแสดงเป็น “จำนวนร้านประจำ”
- event/participation ที่ถูกยกเลิกหลัง sync ให้ stop คงอยู่แต่ `is_operational = false`; ห้าม auto-mark เป็น delivered หรือ issue เพื่อแต่งตัวเลขสรุป

## 5. ขั้นตอนพนักงาน

หน้า POS มีเมนูหลัก:

1. ร้านประจำ
2. อีเวนต์
3. ลูกค้าขาจร

ภายในหน้า “อีเวนต์” แยกเป็นสองส่วน/แท็บ:

1. งานวันนี้
2. รับคืนถังค้าง

ห้ามแสดง “รับคืนถังค้าง” เป็นเมนูหลักระดับเดียวกับร้านประจำ อีเวนต์ และลูกค้าขาจร

### 5.1 หน้าอีเวนต์ — งานวันนี้

- แสดง published event ที่ active ตาม service date
- พนักงานทุกคนใน daily round เห็นทุก event โดยไม่มีการมอบหมาย event ล่วงหน้า
- เลือก event ก่อน participation
- ค้นหาจากรหัส ชื่อ เลขบูธ โซนอีเวนต์ ผู้ติดต่อ หรือโทรศัพท์แบบ normalize
- card แสดง event/venue/booth snapshot และประวัติเฉพาะ participation ของวัน
- ร้านเดียวรับน้ำแข็งหรือถังเพิ่มได้หลายครั้ง

### 5.2 ส่งน้ำแข็ง

- ใช้ชนิดน้ำแข็งที่เปิดใช้งานและมีราคากลางใน service date
- event delivery ใช้ราคากลางเท่านั้น ไม่ใช้ shop override ของร้านประจำ
- POS preview และ write RPC ต้องเรียก resolver event-aware ตัวเดียวกัน
- courier ใช้ assigned holding stock และ daily aggregate guard เดียวกับ POS ร้านประจำ
- ice charge ของ event ใช้ `payment_term = end_of_day` และ `event_participation_id` เป็น settlement context
- การส่งใหม่อนุญาตเฉพาะ published event และ participation ที่ active ใน service date

### 5.3 หน้าอีเวนต์ — รับคืนถังค้าง

แสดง participation ที่ยอดถังค้างมากกว่า 0 โดยไม่จำกัดว่างานยัง active หรือไม่:

- active, ended และ cancelled event แสดงได้
- ค้นหาจากร้าน งาน บูธ โซน หรือโทรศัพท์
- courier รับคืนได้จนยอดเป็นศูนย์
- ห้าม ice delivery หรือ tank handoff ใหม่จากหน้านี้
- เมื่อยอดเป็นศูนย์ รายการหายจากคิวหลัง refresh/realtime

ขอบเขตสิทธิ์ของ return queue:

- courier ต้องเป็น active user และเป็นสมาชิก daily round ที่เปิดอยู่ของวันที่ปัจจุบันตาม `Asia/Bangkok`; ไม่จำเป็นต้องเป็นสมาชิกของรอบเดิมที่ส่งมอบถัง
- courier ใน roster ปัจจุบันเห็นและรับคืนได้ทุก participation ที่มียอดค้างตามนโยบาย “ไม่มีการมอบหมาย event รายคน”
- หากไม่มี daily round เปิดอยู่ courier ห้ามเปิดคิว/รับคืน; round lead และ admin ยังทำได้
- event list, return queue, evidence signing และ return RPC ต้องเรียก authorization predicate เดียวกัน เพื่อไม่ให้ UI, signed URL และ write scope ต่างกัน
- การรู้ participation/movement UUID ไม่ให้สิทธิ์อ่านรูปหรือเขียน return

## 6. Tank movement ledger

### 6.1 ตาราง

เพิ่ม `event_tank_movements`:

- `id`
- `event_participation_id`
- `movement_kind`: `rental_handoff`, `rental_return`, `reversal`
- `billing_effect`: `create_charge` หรือ `none`
- `quantity` เป็นจำนวนเต็มมากกว่า 0
- `corrects_movement_id` non-null เฉพาะ reversal และ unique
- `recorded_by`, `recorded_at`, `client_recorded_at`
- `note`
- `idempotency_key` unique
- `request_fingerprint`

CHECK และ deferred constraint ต้องบังคับว่า:

- standalone `rental_handoff` ใช้ `billing_effect = 'create_charge'`
- `rental_return` และ `reversal` ใช้ `billing_effect = 'none'`
- replacement handoff ที่สร้างภายใน correction ใช้ `billing_effect = 'none'` และต้องถูกอ้างเป็น `replacement_movement_id` ของ correction เดียวเมื่อ commit

effect ต่อ balance:

- `rental_handoff = +quantity`
- `rental_return = -quantity`
- `reversal = -effect ของ movement ต้นทาง`

ห้าม reverse movement ที่เป็น reversal และห้าม reverse movement เดิมซ้ำ

เพิ่ม `event_tank_movement_corrections` เพื่อผูก:

- original movement
- reversal movement
- replacement movement ถ้ามี
- เหตุผล ผู้แก้ และเวลา
- idempotency/fingerprint ของ correction request

ตัวอย่างแก้ handoff 3 เป็น 2:

1. reverse handoff 3
2. สร้าง replacement handoff 2 ด้วย `billing_effect = 'none'`
3. คง charge เดิมเป็น canonical charge แล้ว append tank charge adjustment `-100` ให้ effective amount เป็น 200; ห้ามสร้าง charge ใหม่จาก replacement
4. หากจ่ายแล้ว ย้าย allocation เท่าที่ใช้ได้และสร้าง refund obligation 100 บาท

ตัวอย่างแก้ return 2 เป็น 1:

1. reverse return 2
2. สร้าง replacement return 1
3. ไม่สร้างหรือแก้ค่าเช่า

### 6.2 Invariants

- movement มีได้เฉพาะ participation ที่ `rents_tank_from_us = true`
- handoff ทำได้เฉพาะ published event, participation active, service date อยู่ในช่วง และ daily round ยังเปิด
- return ทำได้เมื่อมียอดค้าง แม้งานจบ ยกเลิก participation ยกเลิก event ปิดรอบ หรือปิดสต๊อกแล้ว
- balance หลัง transaction ต้องไม่ติดลบ
- replacement movement จาก correction ไม่สร้าง charge เอง; effective charge เปลี่ยนได้ผ่าน adjustment ที่ผูก correction เท่านั้น
- ห้ามแก้ balance โดยตรง
- ห้าม UPDATE/DELETE movement, evidence, correction และ charge history
- การปิดงาน/ปิดสต๊อกไม่ถูกบล็อกด้วยถังค้าง
- การ deactivate ลูกค้าที่มียอดถังอีเวนต์ค้างต้องถูกบล็อกจนคืนครบ

### 6.3 Global lock order, transaction และ retry

ก่อนเปิด event write ต้อง refactor writer เดิมที่เกี่ยวข้องให้ใช้ลำดับเดียวกัน; คำว่า “เหมือนระบบเดิม” ไม่เพียงพอเพราะปัจจุบัน sync/close-round และ daily-close ใช้ลำดับ round/service-date ต่างกัน

ลำดับรวมจากนอกเข้าใน:

1. advisory lock จาก `idempotency_key` เมื่อ operation มี key
2. ตรวจ existing request; fingerprint ตรงให้คืนผลเดิม fingerprint ต่างให้ตอบ `IDEMPOTENCY_PAYLOAD_MISMATCH`
3. advisory lock `service-date:{date}` สำหรับ operation ที่ผูก open round หรือกระทบ stock
4. lock `delivery_rounds` row
5. lock `event_jobs` row
6. lock `event_participations` row
7. advisory lock `event-tank:{participation_id}`
8. advisory lock `financial-shop:{shop_id}`
9. lock movement/charge/payment/evidence-intent rows ที่เกี่ยวข้อง แล้วเขียน side effects

กติกาแต่ละ operation:

- event ice delivery และ standalone handoff ใช้ลำดับ service date → round → job → participation; ตรวจ round/job/participation อีกครั้งหลังได้ lock แล้วจึงเขียน
- return หลังงานจบไม่ lock service date หรือ original round; ใช้ participation → tank และ recheck balance/authorization เพราะ return ต้องทำได้หลังปิด stock
- correction ใช้ participation → tank → financial shop; movement, adjustment, allocation change และ refund obligation commit ใน transaction เดียว
- event/participation cancellation ใช้ job → participation และห้ามแก้ `round_stops` ใน transaction เดียว เพราะจะกลับลำดับไป lock round หลัง job; sync รอบถัดไปเป็นผู้เปลี่ยน `is_operational`
- payment ใช้ financial-shop lock และต้องไม่ย้อนกลับไป lock participation/tank; payment context ตรวจด้วย immutable charge fields/fingerprint
- writer ที่ต้อง lock หลาย participation/shop เรียง UUID แบบ byte order คงที่ก่อน lock
- migration ต้องแก้ `sync_daily_round_active_shops`, sync รุ่นใหม่, event/regular delivery, close-round และ daily-close ให้ใช้ service date → round เหมือนกัน พร้อม two-connection regression tests

หลังได้ lock ครบ RPC ต้องคำนวณ balance ใหม่จาก committed movements, ตรวจ state/role/quantity/evidence, เขียน movement/evidence/charge-or-adjustment/refund/audit และคืน response จากข้อมูลที่ commit แล้ว

fingerprint รวม:

- participation
- movement kind และ target movement
- quantity
- evidence checksum/path ที่เรียงลำดับคงที่
- note
- client timestamp ตาม contract

ผลตอบกลับประกอบด้วย:

- `movementId`
- `chargeId` ถ้ามี
- จำนวนส่งมอบสะสม
- จำนวนคืนสะสม
- จำนวนค้าง
- ค่าเช่าสะสม
- ยอด event ของ participation ใน service date

## 7. Evidence

เพิ่ม private namespace/bucket `event-tank-evidence`, ตาราง upload intent `event_tank_evidence_uploads` และ `event_tank_movement_evidence` แบบ 1:N

upload intent เก็บ owner, deterministic path, checksum, MIME, size, state `pending|referenced|expired`, `expires_at`, created/referenced timestamps และ idempotency key

ต่อ evidence เก็บ:

- movement
- path
- checksum
- MIME
- ขนาด
- ลำดับรูป
- uploader และเวลา

กติกา:

- handoff และ return ต้องมีรูปอย่างน้อยหนึ่งรูป
- reversal ใช้หลักฐานเดิมและเหตุผล correction; แนบรูปใหม่ได้แต่ไม่บังคับ
- รับ JPEG, PNG หรือ WebP
- client resize/compress เป้าหมายไม่เกิน 1 MB; server hard limit 5 MB
- path deterministic: `{ownerId}/r2/{idempotencyKey}-{checksum}.webp`
- upload R2 ก่อน แล้วสร้าง Supabase Storage marker ตาม pattern หลักฐานการชำระ
- upload/marker ต้องอ้าง active upload intent; RPC lock intent แล้วตรวจ marker, owner, checksum metadata, size, MIME และ path ก่อนอ้างอิง
- เมื่อสร้าง movement สำเร็จ RPC เปลี่ยน intent เป็น `referenced` ใน transaction เดียวกับ evidence reference
- upload ซ้ำด้วย path/checksum เดิมต้องไม่สร้าง object ซ้ำ
- ลบได้เฉพาะเมื่อ `can_delete_event_tank_evidence` ยืนยันว่าไม่มี movement อ้างอิง
- cleanup ลบได้เฉพาะ intent `pending` ที่หมดอายุเกิน safety TTL, ใช้ `FOR UPDATE SKIP LOCKED` และ recheck ว่าไม่มี evidence reference ก่อนลบ marker/R2 object; ห้ามพิจารณา object ใหม่ว่า orphan ทันที

ต้องเพิ่ม namespace และ policy ใน:

- browser R2 type union
- Edge Function namespace allowlist
- upload/sign/delete policy
- Supabase Storage bucket และ RLS

สิทธิ์:

- courier upload ได้เฉพาะ intent/path ของตนและต้องผ่าน return/event scope predicate ในหัวข้อ 5.3
- courier อ่าน/sign หลักฐานของ participation ที่ผ่าน predicate เดียวกับ event/return queue เท่านั้น
- round lead/admin อ่านทั้งหมด
- direct table writes ถูก revoke; เขียนผ่าน RPC เท่านั้น

## 8. การเงิน การเก็บเงิน และเอกสาร

### 8.1 การสร้าง charge

- standalone handoff ที่ `billing_effect = 'create_charge'` สร้าง `tank_rental` charge ใน transaction เดียว
- `original_amount = quantity × tank_rental_unit_price_snapshot`
- charge source movement เป็น unique
- return ไม่มีผลทางการเงิน
- retry handoff เดิมคืน charge เดิม
- standalone handoff เพิ่มสร้าง charge ใหม่
- reversal และ replacement movement จาก correction ไม่สร้าง charge ใหม่

### 8.2 Settlement

- ice และ tank rental ของ participation เดียวกันใช้ `end_of_day`
- คิวเก็บเงินรวม active charges ของ `shop_id + event_participation_id + service_date`
- payment หนึ่งรายการของรุ่นแรกห้ามผสม charge จากคนละ participation แม้เป็นร้านเดียวกัน
- payment context และ allocation integrity บังคับที่ database ตามหัวข้อ 2.2; UI grouping ไม่ถือเป็น invariant
- ผู้ส่งทุกคนเห็น event แต่รับชำระท้ายวันได้เฉพาะผู้เป็นสมาชิก collection run ตามกติกาเดิม
- payment method, reference และ payment evidence ตรวจจาก settlement policy snapshot ของ participation
- legacy payment RPC อ่าน `shop_payment_profiles` ต่อสำหรับ regular charge แต่ต้อง reject event charge; event payment RPC อ่าน participation snapshot เท่านั้น
- รองรับ cash, bank transfer และ QR

### 8.3 Correction และ refund

- return ปกติไม่ลดค่าเช่า
- correction ของ handoff ใช้ original charge เป็น canonical charge และ append tank charge adjustment เท่ากับ `(corrected quantity - original quantity) × unit price snapshot`
- replacement movement มีผลต่อ tank balance แต่ไม่มี billing effect; active effective charge รวมแล้วต้องเหลือยอด corrected เพียงครั้งเดียว
- หากมี active allocation เกินยอดใหม่ ต้องย้าย allocation และสร้าง refund obligation ตาม flow เดิม
- ห้ามลดยอด charge โดย UPDATE
- ขยาย adjustment/refund source kind และ effective-charge projection ให้รองรับ `event_tank_movement_correction`; ห้ามยัด tank correction ลง `delivery_adjustment_items` ที่ต้องมี `ice_type_id`
- immediate/closed-period guards เดิมต้องยังทำงานกับ ice charge; event charge ใช้ `end_of_day` เท่านั้น

### 8.4 เอกสารและรายงาน

ใบสรุป/INV/REC แสดง line เช่น:

`ค่าเช่าถังน้ำแข็ง 3 ใบ × 100 = 300 บาท`

document contract รุ่นแรก:

- INV หนึ่งฉบับต่อ charge ตาม trigger/numbering เดิม; tank charge มี INV ของตนเอง และ ice delivery แต่ละครั้งมี INV ของตนเอง
- ใบสรุปยอดและ collection card รวม effective charges ของ participation/date
- REC หนึ่งฉบับรวม allocation หลาย ice/tank charges ของ participation/date เดียวได้ และ snapshot ต้องเก็บ event/venue/booth context
- correction หลังออก INV ไม่แก้ immutable snapshot เดิม; statement/REC และ correction detail แสดง original, adjustment และ effective amount ส่วนเอกสารลดหนี้อย่างเป็นทางการอยู่นอกขอบเขตรุ่นแรก
- หากผู้ใช้ต้องการ consolidated INV ต้องหยุด rollout และออกแบบ `billing_documents`/document allocations แยก ห้ามเปลี่ยนความหมาย charge ให้เป็น invoice โดยปริยาย

ทุก read model ต้องแยก:

- ยอดน้ำแข็ง
- ค่าเช่าถัง
- ยอดขายรวม
- รับเงินจริง
- คืนเงินจริง
- ยอดค้าง

ต้องแก้:

- collection queue และ charge detail
- receipt/invoice snapshot builder
- write-time trigger เช่น charge-number assignment, immediate-receipt guard และ charge snapshot capture ซึ่งปัจจุบันสมมติว่า `delivery_event_id` non-null
- daily acknowledgement/statement ที่เกี่ยวข้อง
- shop summary และ daily matrix
- accounting reconciliation
- accounting export
- print DTO และ offline document DTO ในเฟส offline

ทดสอบทั้ง rental-only และ mixed ice+rental จาก SQL read model จริง ไม่ assert เฉพาะ intermediate tables

## 9. หน้าหัวหน้าและแอดมิน

เพิ่มเมนู “งานอีเวนต์”:

- สร้าง แก้ publish และ cancel event
- เพิ่ม participation ด้วยค้นหาร้านเดิม สร้าง event-only customer หรือ Excel
- แสดงหลาย event พร้อมกัน
- แสดง readiness ก่อน publish
- รายงานรายวัน: จำนวนร้าน น้ำแข็ง ค่าเช่า ยอดรวม รับแล้ว คืนเงิน และค้าง
- “ถังยังไม่คืน”: ร้าน งาน บูธ จำนวนค้าง วัน handoff รูปล่าสุด และเบอร์ติดต่อ
- ended/cancelled event ที่ยังมีถังค้างแสดง badge แต่ไม่บล็อกปิดงานหรือปิดสต๊อก
- correction แสดง original, reversal, replacement, ผลต่อ charge และ refund

สิทธิ์:

- admin จัดการ customer identity, import, ราคา และ settlement policy
- round lead/admin สร้าง แก้ publish/cancel event และ participation ที่อ้าง customer ซึ่งมีอยู่
- round lead/admin ดูรายงานและทำ correction พร้อมเหตุผล
- courier ที่อยู่ใน daily roster ปัจจุบันอ่าน published event และเขียน handoff/return ตาม shared scope ในหัวข้อ 5.3; ไม่จำกัดเฉพาะ movement ที่ตนเป็นผู้สร้าง
- ทุก security-definer RPC ตรวจ active user, role, event state และ target scope ภายใน function

audit log ต้องอ่านได้ผ่าน event summary RPC สำหรับ round lead; ห้ามพึ่ง generic `audit_logs` ซึ่งจำกัดเฉพาะ admin

## 10. Excel import

template มี:

- รหัสลูกค้า
- ชื่อร้าน
- ผู้ติดต่อและโทรศัพท์
- เลขบูธ โซน จุดสังเกต
- วันที่เริ่ม–สิ้นสุด
- หมายเหตุ
- เช่าถังจากเรา

กติกา:

- รหัสที่มีอยู่ต้อง match `shops` เดิม
- รหัสใหม่สร้าง `event_only` customer
- re-import ใช้ `event_job_id + customer_code` เป็น upsert key
- duplicate row, duplicate participation, วันที่ผิดช่วง, จำนวนเกิน 50 หรือข้อมูลสำคัญขาดต้องแสดง error พร้อมเลขแถว
- import มี preview/dry-run ก่อนยืนยัน
- commit customer และ participation ทั้งไฟล์แบบ all-or-nothing
- request มี idempotency key และ fingerprint ของ normalized rows
- published event รับ import เพิ่มผ่าน audited RPC เท่านั้น และห้ามลบ participation ที่มี activity
- import customer code lookup ใช้ canonical uppercase/trim rule เดียวกับ shop import เดิมและ lock identity ก่อน create; database unique index เป็นตัวตัดสินสุดท้าย ไม่ใช้ preview เป็น concurrency guard
- event-only rows ต้องผ่าน customer-kind-aware save/import module เดียวกัน ห้าม insert `shops` โดยตรงเพื่อหลบ location trigger

## 11. Offline rollout

### Phase 1 — online-only

- event list, delivery, tank movement, evidence และ return queue ต้องตรวจ network ก่อน submit
- ห้ามแสดงว่า “พร้อมออฟไลน์” สำหรับ feature อีเวนต์
- draft form เก็บ local recovery ได้ แต่การบันทึกสำเร็จหมายถึง server commit แล้วเท่านั้น
- retry ใช้ idempotency key เดิม
- event screen เปิดได้เมื่อ capability RPC ยืนยัน version/feature flag; service worker/client เก่าที่ cache อยู่ต้องเห็นเฉพาะ regular flow ตาม compatibility fence

### Phase 2 — Employee Offline Contract v2

เริ่มหลัง bundle RPC, IndexedDB repositories, durable outbox, evidence state machine และ typed adapters ของคำสั่งเดิมเสร็จ

v2 เพิ่ม:

- event jobs/participations และ pending-return scope ใน bundle/delta
- `event_tank_handoff`
- `event_tank_return`
- evidence array ที่ non-empty
- expected balance, unit-price, event-state และ settlement-policy fingerprints
- applied result/error schema แบบปิด
- conflict resolution ของ round lead/admin

ห้ามเปลี่ยนความหมาย command v1; เครื่องที่มี v1 ค้างต้อง drain ต่อได้ระหว่าง rollout

## 12. แผนทดสอบ

### 12.1 Customer และ destination

- event-only customer ใช้ POS, charge, payment และประวัติได้ แต่ไม่เข้าร้านประจำ
- insert/update event-only customer ที่ location เป็น null ผ่าน save/import RPC ได้ แต่ direct write และ regular customer ที่ location ขาดถูกปฏิเสธ
- ร้านเดิมมี regular stop และ event stop ในวันเดียวกัน
- ร้านเดียวร่วมสอง event พร้อมกันโดย booth/history/totals ไม่ปะปน
- ยกเลิก event หลัง sync แล้ว stop เดิมยังอยู่เพื่อ audit แต่ submit ใหม่ถูกปฏิเสธ
- card search ครบ code/name/booth/zone/contact/phone
- courier ที่ถูกเพิ่มหลังเปิด daily round ค้นพบ round ได้จาก `get_employee_active_session` ก่อนมี `round_id` และเห็น event หลัง destination sync; role อื่น bootstrap membership เองไม่ได้
- client รุ่นเก่าเรียก sync/cards/POS context/record delivery แล้วไม่เห็นและไม่สามารถเขียน event stop
- legacy sync ยังทำงานหลังเปลี่ยนเป็น partial unique โดยไม่เกิด `ON CONFLICT` inference error
- เมื่อ `event_stops_enabled = false` การเรียก destination sync โดยตรงยัง sync member/regular stop ได้ แต่ไม่ insert/reactivate/deactivate event stop; เมื่อเปิด flag จึงเริ่ม event mutation
- direct UPDATE ที่แก้ destination identity หรือ snapshot ของ stop ถูก trigger ปฏิเสธ แต่ update `is_operational`/status/note/sequence ยังทำได้

### 12.2 ราคาและการเงิน

- event ใช้ standard price แม้ร้านมี shop override
- publish ปฏิเสธ price gap ในวันใดวันหนึ่งของ event
- handoff 3 สร้าง charge 300 เพียงครั้งเดียว
- ส่งเพิ่ม 2 ทำให้ค่าเช่าสะสม 500
- rental-only และ mixed ice+rental payment ออก receipt ถูกต้อง
- payment จากคนละ participation ถูกปฏิเสธในรุ่นแรก
- payment ที่ผสม event/regular หรือคนละ service date ถูกปฏิเสธทั้ง event RPC, legacy RPC และ deferred integrity trigger
- event payment ตรวจ method/reference/evidence จาก participation snapshot แม้ shop payment profile ให้ผลต่างกัน
- paid correction 300 → 200 สร้าง refund obligation 100
- correction handoff 3 → 2 เหลือ effective charge 200 เพียงยอดเดียว; replacement movement ไม่สร้าง charge 200 ซ้ำ
- หลาย delivery/handoff สร้างหลาย INV ตาม charge แต่ใบสรุปและ REC รวม participation/date ถูกต้อง
- accounting summary, daily matrix, reconciliation และ export แยกค่าเช่าถูกต้อง

### 12.3 Tank ledger และ concurrency

- return บางส่วนและครบไม่ลดค่าเช่า
- ปฏิเสธ return เกินค้าง จำนวนศูนย์ ติดลบ และทศนิยม
- same key/same payload คืน movement/charge/total เดิม
- same key/different payload ตอบ mismatch
- return สองคำขอคนละ key แข่งกันเมื่อค้าง 1 ต้องสำเร็จเพียงหนึ่ง
- handoff แข่งกับ cancellation หรือ rents-tank toggle ไม่สร้าง charge ผิด state
- handoff แข่งกับ close-round และ daily-close ไม่ commit หลังรอบ/stock ปิดและไม่ deadlock
- sync แข่งกับ close-round/daily-close ใช้ service-date → round order เดียวกันและจบได้ทั้งสอง commit orders
- sync แข่งกับ event/participation cancellation แล้ว recheck หลัง lock: ห้ามสร้าง operational stop จาก state เก่า และ stop เดิมต้องถูกปิดในการ sync ครั้งที่เห็น cancellation
- payment แข่งกับ tank correction ไม่ over-allocate, ไม่สร้าง refund ซ้ำ และไม่ deadlock
- correction handoff/return, double correction และ correction-of-reversal ถูกตรวจครบ
- direct UPDATE/DELETE movement/evidence/charge history ถูกปฏิเสธ

### 12.4 Lifecycle และ return queue

- หน้า POS ไม่มีเมนูหลัก “รับคืนถังค้าง”; เข้าคิวคืนถังได้จากส่วน/แท็บภายในหน้า “อีเวนต์” เท่านั้น
- สลับระหว่าง “งานวันนี้” และ “รับคืนถังค้าง” ในหน้าอีเวนต์แล้วคง search/filter/draft ของแต่ละส่วนแยกกัน
- handoff ทำได้เฉพาะ published active participation
- ended/cancelled event ที่ถังค้างยังแสดงแก่ courier
- courier ที่ไม่ได้อยู่ใน daily roster ปัจจุบันอ่าน return queue, sign evidence และ submit return ไม่ได้แม้รู้ UUID
- เมื่อไม่มี daily round เปิด courier ถูกปฏิเสธ แต่ round lead/admin ยังรับคืนได้
- หลัง end/cancel return สำเร็จ แต่ handoff/ice delivery ถูกปฏิเสธ
- คืนครบแล้วรายการหายจาก queue
- ปิดงาน ปิดรอบ และปิดสต๊อกได้แม้ถังค้าง
- deactivate customer ถูกบล็อกเมื่อยังมี event tank ค้าง

### 12.5 Evidence และสิทธิ์

- บังคับอย่างน้อยหนึ่งรูปสำหรับ handoff/return
- MIME, ขนาด, checksum, owner และ marker ถูกตรวจทั้ง client/Edge/RPC
- retry upload ไม่สร้าง object ซ้ำ
- orphan cleanup ไม่ลบ referenced evidence
- cleanup ที่แข่งกับ movement RPC ไม่ลบ pending upload intent/object ที่ยังอยู่ใน safety TTL หรือถูก lock เพื่อ reference
- ทดสอบ anon, inactive, courier, round lead และ admin ทั้ง direct table และ RPC
- ผู้ใช้ไม่มี scope อ่าน/sign รูปที่ไม่เกี่ยวข้องไม่ได้

### 12.6 Regression

- `shop_rented_tanks` แบบมีรหัสยัง unique และ admin-only เหมือนเดิม
- event movement ไม่ join, update หรือรวมยอดกับ `shop_rented_tanks`
- delivery/charge/payment/receipt ร้านประจำเดิมยังผ่าน
- direct insert tank charge ที่ไม่มี valid source/detail และ direct insert event payment ที่ allocation context ไม่ตรงถูกปฏิเสธเมื่อ commit
- charge-number, receipt requirement และ snapshot triggers รองรับ nullable `delivery_event_id` โดยไม่คืน null document หรือทำให้ tank charge rollback
- `npm test` และ `npm run build` ผ่าน
- migration concurrency tests ใช้ PostgreSQL จริงอย่างน้อยสอง connection (ไม่ใช้ regex/PGlite แทน) ตั้ง `lock_timeout` และทดสอบทั้งสอง commit orders สำหรับ sync vs close-round, sync vs daily-close และ sync vs event/participation cancellation
- realtime refresh ไม่เปลี่ยน draft ระหว่าง submit
- Phase 2 เพิ่ม offline v2 fixtures, replay, FIFO, conflict และ evidence recovery tests

## 13. ลำดับพัฒนาและ rollout

### Slice A — Compatibility และ event ice สำหรับร้านเดิม

1. ทำ inventory ของ RPC/view/trigger ที่อ้าง `round_stops`, `delivery_event_id`, `delivery_charges`, shop location และ payment profile; บันทึก owner และ expected event behavior ของทุกจุด
2. กำหนด global lock order แล้ว refactor sync, regular delivery, close-round และ daily-close พร้อม two-connection tests ก่อนเพิ่ม event writer
3. เพิ่ม destination columns/backfill/partial unique และติดตั้ง compatibility fence ทั้ง read/write รวมการแก้ legacy `ON CONFLICT`
4. เพิ่ม event schema, lifecycle, immutable config snapshots, capability RPC และ publish readiness
5. เพิ่ม event cards/search แบบ read-only สำหรับ existing regular shops; เปิดเฉพาะ read flag ภายในให้ตรวจ snapshot/history separation
6. แก้ late-member discovery ที่ session resolver, เพิ่ม `sync_daily_round_destinations`, server-side stop flag gate, immutable stop trigger และ real-PostgreSQL concurrency tests; เปิดเฉพาะ `event_stops_enabled` หลัง old-client isolation และ rollback checks ผ่าน
7. เพิ่ม event-aware ice delivery, payment context, collection grouping, REC/INV builders และ accounting projection สำหรับ ice-only
8. pilot หนึ่ง event/หนึ่งวัน/ร้านเดิมเท่านั้น ตรวจ stock, charge, INV, REC, accounting reconciliation, old-client isolation และ rollback

### Slice B — Event-only customer และ import

9. เพิ่ม `customer_kind`, conditional location constraints และแก้ shop/location/stock triggers กับ regular-only readers ใน migration เดียวกัน
10. เพิ่ม event-only save/search และ Excel preview/import แบบ all-or-nothing
11. pilot event-only customers โดยยังไม่เปิด tank; ตรวจว่าไม่เข้ารอบ/หน้าร้านประจำแต่ปรากฏใน financial reports

### Slice C — Tank rental

12. ขยาย canonical charge header และ normalized line/effective-adjustment projections พร้อม dual-read verification
13. เพิ่ม tank ledger, upload intents/evidence, authorization predicate, global-lock integration และ correction ที่ replacement ไม่มี billing effect
14. ปรับ collection, document triggers/snapshots, refund, manager reports, accounting และ export ให้รองรับ rental-only/mixed
15. เปิด tank feature flag ใน event ทดสอบหนึ่งงาน ตรวจ return หลัง event/round/stock close, orphan cleanup และ paid correction ก่อนขยาย

### Slice D — Scale และ offline

16. เปิดหลาย event พร้อมกันหลัง cross-event isolation และ payment-context tests ผ่าน
17. ทำ Employee Offline Contract v2 หลังระบบ offline หลักพร้อมและ v1 pending commands drain ได้ตามเดิม

ทุก migration เป็น additive ก่อน client cutover, คง RPC signature เดิมระหว่าง compatibility และห้าม drop/rename table หรือ field เดิมจนผ่านหนึ่ง verified release พร้อม rollback exercise

release gate ทุก slice:

- migration integration, unit/UI tests และ `npm run build` ผ่าน
- old client contract tests และ direct-RPC test ที่ยืนยัน server-side feature gate ผ่านก่อนเปิด feature flag
- late-member bootstrap test ยืนยันว่าพนักงานค้นพบรอบได้ก่อนมี `round_id` โดยไม่เปิดสิทธิ์ให้ role อื่นหรือ service date อื่น
- stop snapshot immutability ถูกบังคับด้วย database trigger ไม่ใช่เพียง convention ใน sync RPC
- reconciliation ระหว่าง source rows, effective charges, allocations, documents และ accounting ได้ศูนย์ต่าง
- rollback exercise ไม่ทำให้ event stop โผล่ใน regular client และไม่ทำให้ charge/payment history หาย
- metrics/alerts แยก event vs regular: RPC error code, idempotency mismatch, orphan upload intent, negative-balance rejection, document snapshot failure และ reconciliation delta

## 14. สิ่งที่อยู่นอกขอบเขตรุ่นแรก

- รหัสหรือทะเบียนถังรายใบสำหรับ event
- เงินประกันถัง
- การคิดค่าเช่าซ้ำอัตโนมัติทุกวัน
- การรวม payment ข้าม event participation
- ร้านเดียวหลาย booth ใน event เดียว
- การมอบหมาย courier ต่อ event
- offline event/tank ก่อน Employee Offline Contract v2
- การรวมระบบ event tank กับ `shop_rented_tanks` เดิม
