# แผนปิดระบบการเงินสำหรับ Event Ice Delivery — Reworked 2

สถานะ: **พร้อมใช้เป็น implementation plan หลัง migration `0170`; ยังไม่ได้พัฒนา `0171`–`0172`**

เอกสารนี้ต่อ Event Ice Delivery เข้ากับ ledger, เลขเอกสาร, payment allocation, correction/refund และ accounting เดิม โดยเพิ่ม settlement boundary ที่ฐานข้อมูลสำหรับอีเวนต์ และคงพฤติกรรม regular delivery เดิม

## 1. เป้าหมายและขอบเขต

Event charge และการรับเงินต้องแยกตามชุดข้อมูลต่อไปนี้:

```text
shop_id + event_participation_id + service_date + settlement_policy_fingerprint
```

การจัดกลุ่มใน UI ไม่ถือเป็น integrity boundary ฐานข้อมูลต้องปฏิเสธ payment, allocation, correction และ refund ที่ข้าม context แม้เขียนตรงหรือลูกค้าเก่าส่ง payload ผิด

รอบนี้รองรับเฉพาะน้ำแข็งและ `payment_term = end_of_day` ไม่รวม tank rental, event-only customer, offline v2, consolidated INV หรือเอกสารลดหนี้ทางการ

## 2. หลักการที่ตัดสินแล้ว

1. Regular payment หนึ่งรายการยังรวม charge ของร้านเดียวกันตามกติกาเดิมได้
2. Event payment หนึ่งรายการรวมหลาย charge ได้เฉพาะ participation, service date และ frozen policy เดียวกัน
3. Event settlement ใช้ policy snapshot ของ participation ห้ามใช้ shop payment profile
4. ใบส่งของ/INV ยังเป็นหนึ่งฉบับต่อ charge
5. REC รวมหลาย charge ได้เฉพาะ settlement context เดียวกัน
6. Receipt และ INV ที่ออกแล้วต้องอ่านจาก immutable snapshot ไม่อ่านชื่อสถานที่ปัจจุบันย้อนหลัง
7. การยกเลิก event job หรือ participation หยุดเฉพาะการส่งใหม่ ประวัติ charge, payment, receipt, refund และ accounting ยังคงอยู่
8. `event_ice_delivery_enabled = false` หมายถึง **หยุดสร้าง event delivery ใหม่** ไม่ใช่หยุดชำระหนี้หรือคืนเงินของรายการที่เกิดแล้ว
9. ไม่มี financial kill switch ที่ซ่อนยอดค้าง เพราะจะทำให้ภาระเงินจริงค้างโดยจัดการไม่ได้ หากต้องหยุด payment/refund ฉุกเฉินให้เป็น incident action แยกจาก feature flag นี้
10. Idempotent replay ของ write ที่ commit แล้วต้องคืนผลเดิมได้แม้ pilot หมดอายุ ถูกถอดออก หรือ global flag ถูกปิด; eligibility gate ใช้เฉพาะก่อนสร้าง write ใหม่
11. Financial servicing ของ charge ที่เกิดแล้วใช้ historical settlement context และห้ามบังคับว่า event job/participation ยัง operational; สถานะ operational ใช้กับ intake ใหม่เท่านั้น
12. Security-definer read model ใหม่ต้องรักษา row-visibility contract เดิมอย่างชัดเจน ห้ามอาศัย RLS ของตารางต้นทางโดยปริยาย

## 3. ทางเลือกที่เล็กกว่าและขอบเขตการแก้

ไม่ rewrite สูตรรวมของ `get_accounting_shop_summary`, `get_accounting_shop_daily_matrix` และยอดขายใน reconciliation เพียงเพื่อให้นับ event เพราะ query ปัจจุบันอ่าน active `delivery_charges` ทุกชนิดอยู่แล้ว

แก้เฉพาะส่วนที่ต้องรู้ destination context จริง:

- database integrity และ event writer
- collection queue grouping และ frozen payment profile
- event payment/correction RPC
- receipt, refund, transaction และ invoice-detail projections
- UI identity/routing/labels
- reconciliation contract และ tests โดยรักษาสูตร aggregate เดิมเท่าที่ทำได้

ลดการทำ logic ซ้ำโดยคง public RPC แยก regular/event แต่ให้เรียก private primitives ร่วมกันสำหรับ:

- canonicalize allocation และ request fingerprint
- resolve/lock canonical charge settlement context
- evidence ownership และ payment-method validation
- allocation movement, refund obligation และ immutable document capture

Event adapter เป็นผู้เลือก frozen participation policy และ standard price ส่วน regular adapter ยังคงเลือก shop profile และกติกาเดิม ห้าม fork algorithm การเงินทั้งชุดเป็นสอง implementation ที่แก้แยกกัน

## 4. Rollout ที่ทดสอบ pilot ได้จริง

### 4.1 Migration `0171` — financial-ready dark install

- เพิ่ม schema, constraints, indexes, RPCs และ read models ทั้งหมด
- ยก `event_delivery_feature_settings.schema_version` เป็น `7`
- คง `event_ice_delivery_enabled = false`
- เพิ่มตาราง internal-only `event_ice_delivery_pilots`:
  - `event_participation_id` เป็น primary key
  - `enabled_by`, `enabled_at`, `expires_at`
  - อ่าน/เขียนผ่าน security-definer RPC สำหรับ admin เท่านั้น
- เพิ่ม helper กลาง `is_event_ice_delivery_write_enabled(participation_id)` ซึ่งคืน true เมื่อ global flag เปิด หรือ participation อยู่ใน pilot allowlist ที่ยังไม่หมดอายุ
- `get_event_delivery_pos_context` และ event card projection ใช้ predicate เดียวกันแบบ read-only
- event writer ใช้ `lock_event_ice_delivery_write_eligibility(participation_id)` ซึ่ง lock settings row และ pilot row ก่อนประเมิน predicate เดียวกัน เพื่อ serialize กับ enable/disable/expiry cleanup
- enable/disable pilot RPC และ global activation/rollback ต้องใช้ lock protocol เดียวกัน เพื่อให้เมื่อ disable RPC คืนผลแล้วจะไม่มี write ใหม่จาก eligibility เก่ามา commit ภายหลัง
- event card DTO ส่ง `event_delivery_enabled` ต่อ card จาก server; client ห้ามอนุมานจาก global flag เอง

### 4.2 Deploy client

Client ใหม่ต้อง:

- รองรับ contract เมื่อ `schema_version >= 7`
- ใช้ `event_delivery_enabled` จาก card
- ใช้ `queue_key` เป็น identity ทุกจุด
- route event payment/correction ไป RPC เฉพาะ event
- fallback เป็น read-only สำหรับ event เมื่อ schema ต่ำกว่า 7 หรือ card ไม่ได้รับอนุญาต

### 4.3 Pilot

1. Admin เลือกหนึ่ง participation และเปิดผ่าน `enable_event_ice_delivery_pilot(participation_id, expires_at)`
2. ทดสอบหนึ่ง service date และใช้ร้านที่มี regular charge ในวันเดียวกันด้วย
3. ตรวจ charge, allocation, INV, REC, refund, accounting และ reconciliation ตาม checklist ในหัวข้อ 12
4. หากไม่ผ่าน ให้เอา participation ออกจาก allowlist การส่งใหม่หยุดหลัง disable transaction commit แต่ยอดที่สร้างแล้วและ idempotent replay ของ write ที่ commit แล้วต้องยังทำงานได้ รวมถึงรับชำระ แก้ไข คืนเงิน และตรวจบัญชี

### 4.4 Migration `0172` — global activation

- ตรวจ prerequisite ว่า `schema_version >= 7`
- ตั้ง `event_ice_delivery_enabled = true`
- ล้าง pilot allowlist ที่หมดหน้าที่
- ไม่เปลี่ยน schema contract หรือ function signature

### 4.5 Rollback หลัง activation

- ตั้ง `event_ice_delivery_enabled = false`
- ผลที่ต้องเกิด: สร้าง event delivery ใหม่ไม่ได้ แต่ event charges เดิมยังปรากฏใน collection/accounting และยัง payment, correction, void ตามกติกาเดิม และ settle refund ได้
- ไม่ย้อน migration และไม่ลบข้อมูล

## 5. Database context และ invariants

### 5.1 `delivery_charges`

เพิ่ม `event_participation_id uuid null` และ index:

```text
(shop_id, event_participation_id, service_date) WHERE status = 'active'
```

Backfill จาก `delivery_charges → delivery_events → round_stops` ก่อน validate constraints

กติกาที่ฐานข้อมูลต้องบังคับ:

- regular stop → `event_participation_id is null`
- event stop → charge participation ต้องไม่เป็น null และตรงกับ stop
- `charge.shop_id` และ `charge.service_date` ต้องตรงกับ stop/round
- destination context เปลี่ยนไม่ได้หลัง insert
- direct insert/update ที่ไม่ตรงต้อง fail

Upstream identity ที่ charge อ้างถึงต้องถูกป้องกันด้วย:

- `delivery_events.round_stop_id` immutable หลัง insert
- `delivery_rounds.service_date` เปลี่ยนไม่ได้เมื่อรอบมี `round_stops`, delivery event หรือ financial history แล้ว
- direct update ที่พยายามย้าย event ไป stop อื่นหรือย้ายรอบไป service date อื่นต้อง fail แม้ไม่ได้แตะ `delivery_charges`

### 5.2 `payments`

เพิ่ม:

- `event_participation_id uuid null`
- `settlement_service_date date null`
- `settlement_policy_fingerprint text null`

Regular payment ต้อง all-null และ event payment ต้อง all-present ทั้งสามคอลัมน์ Context เปลี่ยนไม่ได้หลัง insert

### 5.3 Deferred integrity

ขยาย integrity function เดิมและติด constraint trigger แบบ deferred บนทุก mutation source:

- `payments`
- `payment_allocations`
- `delivery_charges`
- `refund_obligations`
- `delivery_events`
- `delivery_rounds`

ตรวจตอน commit ว่า:

1. `sum(current allocations) + sum(non-voided refund obligations) = payment.allocated_amount`
2. ทุก allocation/refund obligation ใช้ shop เดียวกับ payment
3. regular payment อ้างได้เฉพาะ regular charge
4. event payment อ้างได้เฉพาะ event chargeที่มี participation และ service date ตรง payment
5. event fingerprint ตรงกับ frozen participation policy
6. payment เดียวห้ามผสม regular/event, หลาย participation หรือหลาย service date
7. correction ห้ามย้าย allocation ไป charge คนละ context

Trigger dispatcher ต้องมี branch เฉพาะตาม schema ของแต่ละตารางและตรวจทั้ง `OLD` และ `NEW` IDs เมื่อ update/delete เพื่อไม่ให้การย้ายแถวหลุดการตรวจ โดย `refund_obligations` ใช้ `source_charge_id` ไม่ใช่ `charge_id`

## 6. Writers และ authorization

### 6.0 Canonical settlement primitives

เพิ่ม private helper ที่ authenticated เรียกตรงไม่ได้:

- `resolve_delivery_charge_settlement_context(charge_ids, lock_rows)` derive shop, destination kind, participation, service date และ fingerprint ผ่าน `delivery_charges → delivery_events → round_stops → delivery_rounds → event_participations`
- helper ต้อง reject charge ที่ context ไม่ครบ, mixed regular/event, mixed participation/date/policy และตรวจ duplicate charge ID
- payment, correction, deferred integrity และ read projection ใช้ derivation เดียวกัน ห้ามแต่ละ RPC ประกอบ context ด้วย join คนละชุด
- validation method/reference/evidence รับ canonical payment profile เป็น input เพื่อ reuse algorithm เดียวกัน โดย caller regular/event เป็นผู้เลือก source ของ profile

### 6.1 `record_event_ice_delivery`

Redefine ใน `0171` โดยไม่แก้ migration `0170` ที่ติดตั้งแล้ว:

- resolve participation จาก round stop ฝั่ง server
- หลังตรวจ active caller ให้ lock idempotency key และค้นหา existing delivery ก่อน; หากพบและ caller มองเห็นได้พร้อม fingerprint ตรง ให้คืน response เดิมโดยไม่ตรวจ global/pilot eligibility ซ้ำ
- เฉพาะกรณีไม่พบ existing delivery จึง resolve participation และตรวจ write eligibility ผ่าน locking helper global/pilot
- insert `delivery_charges.event_participation_id` โดยตรง
- รักษา standard price ของ service date และ `end_of_day`
- response เพิ่ม destination/settlement context แบบ additive

### 6.2 `record_event_payment`

รับ:

- expected participation ID
- expected service date
- expected policy fingerprint
- allocations, payment method, received amount, reference, evidence
- collection run ID, expected group outstanding และ idempotency key

ไม่รับ `shop_id`; derive จาก charges ที่ canonicalize และ lock แล้ว

RPC ต้อง:

1. ตรวจ active user และ `can_collect_shop_payments()`
2. canonicalize allocations และ reject duplicate/invalid amount
3. ตรวจ collection run เป็น current Bangkok business dateและยังเปิด
4. derive context จากทุก charge และเทียบ expected context
5. อ่าน allowed methods/default/reference/evidence จาก participation snapshot ไม่อ่าน shop profile
6. ตรวจ evidence ownership เช่นเดียวกับ regular payment
7. คำนวณ outstanding เฉพาะ queue context นี้
8. รองรับ partial payment, cash change และ idempotent replay
9. ใช้เลข REC และ immutable receipt snapshot ชุดเดิม
10. ปฏิเสธ idempotency key ที่เคยใช้กับ regular payment หรือ payload อื่นอย่างชัดเจน
11. ไม่อ่าน intake flag และไม่บังคับ job=`published`, participation=`active` หรือ round stop=`is_operational`; charge ที่เกิดแล้วต้องชำระได้จาก immutable context แม้ event ถูกยกเลิกหรือจบแล้ว

### 6.3 `record_payment`

คง signature เดิมเพื่อ compatibility แต่เพิ่ม fail-fast guard หาก allocation ใดเป็น event charge Regular/immediate behavior เดิมต้องไม่เปลี่ยน

### 6.4 Lock order

ทุก event financial writer ใช้ลำดับเดียวกัน:

```text
idempotency advisory
→ event-write eligibility lock (เฉพาะ writer ที่สร้าง delivery ใหม่ และหลัง existing replay miss)
→ service-date advisory
→ round row
→ event job row
→ participation row
→ financial-shop advisory
→ collection-run shared advisory (เมื่อมี)
→ delivery event/charge/payment rows ตาม UUID
```

อ่าน service date ครั้งแรกโดยไม่ถือ row lock จากนั้นรับ advisory lock แล้วอ่านซ้ำและตรวจว่าไม่เปลี่ยน Row locks ของ round/job/participation ต้อง acquire แยกตามลำดับที่กำหนด ไม่พึ่งลำดับจาก multi-table `SELECT ... FOR UPDATE` ห้ามใช้ generic correction implementation ที่ล็อก event/round ก่อน service-date lock

## 7. Collection queue contract

`get_collection_run_queue` เป็น authoritative projection; `get_today_collection_run_queue` delegate มาที่เดียวกัน

Grouping:

```text
regular:${shop_id}
event:${shop_id}:${event_participation_id}:${service_date}
```

DTO แต่ละ group เพิ่ม:

- `queue_key`
- `destination_kind`
- `event_participation_id`
- `settlement_service_date`
- `settlement_policy_fingerprint`
- event name/location/zone/booth จาก immutable round-stop snapshot
- `payment_profile`

ที่มาของ `payment_profile`:

- regular → `shop_payment_profiles`
- event → frozen fields บน `event_participations`

`outstanding_amount`, `charge_count`, `latest_payment_at` และ `has_new_charges` ต้องคำนวณต่อ `queue_key` ห้าม aggregate event กลับเข้ากลุ่ม regular แม้เป็นร้านเดียวกัน

## 8. Documents และ immutable history

### 8.1 INV

- หนึ่ง snapshot ต่อ charge เช่นเดิม
- event INV เพิ่ม `destination_kind`, participation ID, event name, location, zone และ booth จาก round-stop snapshot
- correction สร้าง replacement charge และ INV ใหม่; snapshot เดิมไม่เปลี่ยน

### 8.2 REC

- event REC รวมหลาย charge ได้เฉพาะ context เดียว
- root และแต่ละ charge item เก็บ event destination snapshot
- regular receipt JSON keys เดิมคงอยู่
- snapshot ที่ออกแล้ว immutable แม้ participation metadata หรือ allocation เปลี่ยนภายหลัง

### 8.3 Payment history

เพิ่ม `get_payment_history(from, to)` เป็น read model แทนการ select ตาราง `payments` ตรงจาก client

Authorization และ range contract:

- ตรวจ active user ทุกครั้ง
- admin/round lead เห็นรายการตาม scope เดิม; courier เห็นเฉพาะ payment ที่ `is_payment_visible(payment.id)` คืน true
- ใช้ Bangkok half-open range `[from_date 00:00, to_date + 1 day 00:00)` และจำกัดช่วงไม่เกิน 31 วัน
- รองรับ bounded pagination และ deterministic order `(recorded_at desc, id desc)`
- ห้าม security-definer function query แล้วคืนทุก payment โดยไม่ใส่ visibility predicate

Read model ต้องคืน:

- payment fields เดิม
- destination/settlement context
- event labels จาก immutable receipt snapshot หรือ original charge → round-stop snapshot
- void information

ห้าม join booth/zone จาก live participation สำหรับประวัติย้อนหลัง

`get_payment_correction_targets` ต้องเพิ่ม `destination_kind`, participation ID และ service date เพื่อให้ client route correction ได้ถูก RPC

## 9. Event correction และ refund

เพิ่ม event-specific RPCs สำหรับ context, preview, open correction/cancellation และ closed-period adjustment Generic RPCs ยังคง reject event delivery

กติกา:

- ตรวจ event identity, permission และ historical settlement context ซ้ำบน server แต่ห้ามใช้ intake eligibility, live job status, live participation status หรือ `round_stops.is_operational` เป็นเงื่อนไขของ financial servicing
- ice type ที่มีในรายการเดิมรักษา unit-price snapshot
- ice type ใหม่ใช้ standard price ที่มีผล ณ service date เดิม ห้ามใช้ shop special price
- replacement event/charge รักษา shop, participation, service date และ fingerprint เดิม
- allocation ย้ายได้เฉพาะภายใน context เดิม
- ส่วนที่รับเกินสร้าง non-voided refund obligation เพียงครั้งเดียวต่อ source/payment
- idempotent replay ต้องตรวจ visibility/authorization ก่อนคืน response
- closed-period adjustment ใช้ append-only adjustment เดิมและไม่แก้ stock snapshot ของวันที่ปิด

`DeliveryCorrectionDialog` เลือก RPC จาก `destination_kind` ไม่ใช่จากชื่อร้านหรือการมี participation fieldแบบเดาเอง

`get_refund_queue` เพิ่ม event identity จาก source charge → original round-stop snapshot และยังแสดงรายการเมื่อ intake flag ปิด

## 10. UI contract

ขยาย `QueueShop` แบบ additive แต่เปลี่ยน identity ทุกจุดเป็น `queue_key`:

- React keys
- selected row/card
- refresh/reselect หลัง payment
- pending-request signature
- modal lifecycle/focus effects

Event card, payment modal, payment history, receipt history และ refund queue แสดง badge งาน วันที่ settlement สถานที่ โซนและบูธ Search รวม event name/location/booth

Payment form ต้องใช้ frozen `payment_profile` จาก queue:

- แสดงเฉพาะ method ที่อนุญาต
- บังคับ reference/evidence ตาม flag ของ method นั้น
- เอา hard-coded `bank_transfer always requires evidence` ออก หรือเปลี่ยน event config validation ให้บังคับ true หากเป็น business rule จริง
- label ช่อง reference ต้องแสดง “บังคับ/ไม่บังคับ” ตาม policy ไม่เขียนว่าไม่บังคับเสมอ

Submit routing:

- regular group → `record_payment`
- event group → `record_event_payment`

## 11. Accounting และ reconciliation

### 11.1 Aggregates และ location semantics

Shop summary และ daily matrix ใช้ arithmetic aggregate จาก active charges เดิม ซึ่งรวม regular และ event อยู่แล้ว จึงไม่ rewrite สูตรยอดขาย/รับชำระ แต่ต้องแก้ projection metadata ต่อไปนี้:

- response ระบุ `destination_scope = 'all'` และ UI แสดง “รวมทุกจุดส่ง”
- `building_id`/`zone_id` facets ของ shop summary หมายถึง **ที่ตั้ง customer master สำหรับเจ้าของบัญชี** ไม่ใช่จุดส่ง; query ต้องใช้ customer master ให้สอดคล้องกันทั้ง building และ zone และ response ระบุ `location_filter_basis = 'customer_profile'`
- event destination search/filter ใช้ destination fields ใน transaction/invoice-detail projection แยก ห้าม map event location text ไป building/zone ของร้าน
- daily matrix ห้ามแสดง shop payment profile เดี่ยวราวกับครอบ event sales: ถ้าช่วงนั้นมี event charge อย่างเดียวให้แสดง “เก็บท้ายวัน (อีเวนต์)”; ถ้ามี regular/event ที่เงื่อนไขต่างกันให้แสดง “หลายเงื่อนไข”; ถ้าไม่มี event จึงคง label เดิม

Daily matrix ยังคง:

- sales ตาม `charge.service_date`
- cash received ตาม Bangkok date ของ `payment.recorded_at`

### 11.2 Transaction/detail/export

เพิ่ม destination context ใน accounting transaction rows และ invoice detail หากมี table-returning helper หลายตัวใน `UNION ALL` ต้องขยาย signature ทุก branch โดย branch ที่ไม่เกี่ยวกับ delivery คืน null

Excel transaction export เพิ่ม:

- destination kind
- event name
- settlement service date
- location
- zone/booth
- participation ID

Daily export ใช้ยอดรวมร้านต่อวันเดิมและรวม event โดยไม่สร้างแถวซ้ำ

### 11.3 Reconciliation invariants

แยกสอง basis ชัดเจน:

```text
sales_difference(D)
  = effective_sales_for_charge_service_date(D)
  - active_allocations_to_those_charges
  - collectible_outstanding_for_those_charges
  - credit_outstanding_for_those_charges
  = 0
```

```text
net_cash(D)
  = active_payment_allocated_amount_recorded_on(D)
  - refund_settlements_recorded_on(D)
```

`pending_refunds` เป็น as-of balance และไม่ใช้บังคับ daily difference ให้เป็นศูนย์ หากต้องรายงานตาม `settlement_service_date` ให้เป็น projection แยก ไม่เปรียบกับเงินจริงที่รับตาม `recorded_at`

## 12. Test plan และ acceptance gates

### 12.1 SQL integration

- ร้านเดียวมี regular, หลาย participation และหลาย service date ได้คนละ `queue_key`
- event queue คืน frozen policy แม้ shop profile ขัดกัน
- event payment รับ/ปฏิเสธ method, reference และ evidence ตาม frozen policy
- direct insert/update บน payment/allocation/charge/refund ปฏิเสธ mixed context
- direct update `delivery_events.round_stop_id` และ `delivery_rounds.service_date` หลังมี history ถูกปฏิเสธ
- cross-RPC idempotency key reuse ถูกปฏิเสธ
- partial/full/cash-change/idempotent replay ถูกต้อง
- delivery idempotent replay ยังคืนผลเดิมหลัง pilot ถูกถอด/หมดอายุและหลัง global flag ปิด โดย key ใหม่ถูกปฏิเสธ
- INV แยกต่อ charge และ REC รวมได้เฉพาะ context เดียว
- ปิด intake flag แล้วรับชำระ/แก้ไข/คืนเงินรายการเดิมได้ แต่สร้าง delivery ใหม่ไม่ได้
- disable pilot แข่งกับ delivery write แบบสอง connection แล้วหลัง disable RPC commit ไม่มี write ใหม่จาก eligibility เก่ามา commit

### 12.2 Correction/refund

- แก้เพิ่ม/ลด/ยกเลิกก่อนปิดรอบและ closed-period adjustment
- paid correction สร้าง refund obligation เท่าส่วนเกินเพียงครั้งเดียว
- replacement charge/allocation รักษา context
- ice type เดิมรักษาราคา; ice type ใหม่ใช้ standard price ไม่ใช้ shop special price
- void/refund/accounting rows แสดง immutable event identity
- หลัง cancel event job และหลัง cancel participation ยัง payment, void, open/closed correction และ settle refund ของรายการเดิมได้

### 12.3 PostgreSQL concurrency จริง

ใช้สอง connection อย่างน้อยสำหรับ:

- event payment แข่งกับ open correction
- event payment แข่งกับ closed adjustment
- payment แข่งกับ daily close
- delivery/correction แข่งกับ job หรือ participation cancellation
- retry ด้วย idempotency key เดียวกัน
- pilot disable/global rollback แข่งกับ new delivery และ idempotent replay
- payment/correction/refund แข่งกับ job หรือ participation cancellation โดย financial servicing ต้องไม่ถูกตัดหลัง charge เกิดแล้ว

ยืนยันว่าไม่ over-allocate, ไม่สร้าง refund ซ้ำ, ไม่มี lost update และไม่ deadlock พร้อมตั้ง statement timeout เพื่อให้ test fail แบบ bounded

เพิ่ม script `test:postgres-event-financial` และผูกเข้า `test:release`; ห้ามพึ่ง `npm test` เพราะ pattern ปัจจุบันไม่รันไฟล์ `.postgres.mjs`

### 12.4 UI

- identity/reselect ใช้ `queue_key` เมื่อร้านเดียวมีหลายกลุ่ม
- event search และ labels
- frozen methods/reference/evidence behavior
- payment RPC routing
- correction routing จาก queue และ payment history
- receipt/refund context
- export columns
- payment history visibility: courier A อ่าน payment ของ courier B ไม่ได้ แต่ manager ยังเห็นตาม contract เดิม
- accounting summary ระบุ customer-location filter basis และ daily matrix แสดง event-only/mixed payment condition ถูกต้อง

### 12.5 Regression และ release gate

ต้องผ่านทั้งหมด:

```text
npm test
npm run test:postgres-concurrency
npm run test:postgres-event-concurrency
npm run test:postgres-event-financial
npm run build
```

Pilot acceptance:

1. charge totals ตรง delivery items
2. payment allocations + non-voided refunds ตรง payment allocated amount
3. INV/REC identity ตรง round-stop snapshot
4. sales difference เป็นศูนย์
5. net cash ตรงเงินจริงตาม recorded date
6. regular queue/payment/correction/documents/accounting ไม่เปลี่ยนพฤติกรรม
7. หลัง disable/cancel แล้ว historical financial servicing และ committed idempotent replay ยังทำงาน แต่ write ใหม่ถูกปฏิเสธ

## 13. Definition of done

- ฐานข้อมูลปฏิเสธ mixed-context ทุก write path รวม direct SQL
- upstream identity (`delivery_events.round_stop_id`, `delivery_rounds.service_date`) เปลี่ยนจนทำให้ financial context เคลื่อนไม่ได้
- client ไม่มีจุดใดใช้ `shop_id` เป็น identity ของ collection group
- frozen event policy ถูกใช้ตรงกันใน queue, UI และ payment RPC
- receipt/history/refund/accounting ใช้ immutable destination identity
- pilot เปิดได้โดยไม่เปิดทั้งระบบและ rollback หยุดยอดใหม่โดยไม่ซ่อนภาระเดิม
- read models รักษา visibility เดิม และ cancellation/intake flags ไม่ตัด historical financial servicing
- accounting aggregate คงยอดเดิมแต่ระบุ customer-location และ mixed settlement semantics อย่างไม่กำกวม
- release suite รวม real PostgreSQL concurrency test ใหม่
