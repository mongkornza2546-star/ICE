# การเงินสำหรับ Event Ice Delivery — Implementation record

สถานะ: **พัฒนาแล้วใน migration `0171`–`0172` และ client schema version 7; ผ่าน pilot acceptance บน PostgreSQL 16**

ไฟล์ที่ส่งมอบ:

- `supabase/migrations/0171_event_ice_delivery_financial_closeout.sql` — financial-ready dark install, schema version 7, pilot allowlist, event collection/payment/correction/refund/document/accounting contracts
- `supabase/migrations/0172_enable_event_ice_delivery.sql` — ติดตั้ง guarded admin activation/rollback RPC โดยไม่เปิด global flag ระหว่าง apply migration
- client ใช้ `queue_key`, route RPC ตาม destination, อ่าน payment history ผ่าน keyset RPC และแสดง event identity ในคิว/ประวัติ/คืนเงิน/บัญชี

หมายเหตุ rollout: apply migration ถึง `0172` แล้วระบบยัง dark อยู่ ต้อง deploy client, ผ่าน pilot acceptance และให้ admin เรียก `activate_event_ice_delivery()` แยกต่างหาก การ apply กับ production Supabase และ deploy client ไปยัง hosting เป็นขั้นตอนปฏิบัติการภายนอก repository และไม่ได้ถูกเรียกใช้จากการทดสอบท้องถิ่นนี้

ผลยืนยันวันที่ 3 กันยายน 2026:

- backend suite: 148 tests ผ่าน
- UI suite: 35 ไฟล์ / 193 tests ผ่าน
- PostgreSQL financial concurrency และ event destination concurrency ผ่าน
- PostgreSQL 16 apply ทุก migration ถึง `0172` แบบ dark install และ pilot/intake correction/v2 payment/deferred integrity/refund/document/accounting smoke ผ่าน
- production build ผ่าน

เอกสารนี้ต่อ Event Ice Delivery เข้ากับ ledger, เลขเอกสาร, payment allocation, correction/refund และ accounting เดิม โดยเพิ่ม settlement boundary ที่ฐานข้อมูลสำหรับอีเวนต์ และคงพฤติกรรม regular delivery เดิม

## 1. เป้าหมายและขอบเขต

Event charge และการรับเงินต้องแยกตาม canonical business identity ต่อไปนี้:

```text
shop_id + event_participation_id + service_date
```

Integrity boundary ที่ฐานข้อมูลใช้ `event_settlement_context_id` ซึ่งอ้างแถว immutable หนึ่งแถวต่อ `event_participation_id + service_date` แทนการ derive identity ผ่าน ancestry ทุกครั้ง

`settlement_policy_fingerprint` เป็น immutable attribute ของ settlement context ไม่ใช่ส่วนของ business identity ใช้เป็น request precondition, audit field ใน document snapshot และค่าที่ server ส่งให้ client ห้ามเก็บซ้ำบน `payments`

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
10. Idempotent replay ของ write ที่ commit แล้วต้องคืน resource IDs เดิมโดยไม่สร้าง side effect ซ้ำ แม้ run ปิด, วันธุรกิจเปลี่ยน, pilot หมดอายุ/ถูกถอด หรือ global flag ปิด; response อาจเป็น current representation ของ resource เดิม ไม่รับประกัน byte-identical response
11. Financial servicing ของ charge ที่เกิดแล้วใช้ historical settlement context และห้ามบังคับว่า event job/participation ยัง operational; สถานะ operational ใช้กับ intake ใหม่เท่านั้น
12. Security-definer read model ใหม่ต้องรักษา row-visibility contract เดิมอย่างชัดเจน ห้ามอาศัย RLS ของตารางต้นทางโดยปริยาย
13. Payment ที่สร้างก่อน `0171` คง fingerprint algorithm v1 ตลอดอายุ ห้ามคำนวณ v2 แล้วนำไปเทียบกับ hash v1
14. `0171` ห้ามเดาหรือเขียนทับประวัติการเงิน/เอกสารที่อาจเกิดจาก event writer ของ `0170`; ต้อง preflight และ abort พร้อมรายงานถ้าพบ

## 3. ทางเลือกที่เล็กกว่าและขอบเขตการแก้

ไม่ rewrite สูตรรวมของ `get_accounting_shop_summary`, `get_accounting_shop_daily_matrix` และยอดขายใน reconciliation เพียงเพื่อให้นับ event เพราะ query ปัจจุบันอ่าน active `delivery_charges` ทุกชนิดอยู่แล้ว

แก้เฉพาะส่วนที่ต้องรู้ destination context จริง:

- database integrity และ event writer
- collection queue grouping และ frozen payment profile
- event payment/correction RPC
- receipt, refund, transaction และ invoice-detail projections
- UI identity/routing/labels
- reconciliation contract และ tests โดยรักษาสูตร aggregate เดิมเท่าที่ทำได้

เพิ่ม `event_settlement_contexts` เป็นจุดเดียวที่ materialize identity และ frozen policy ของ participation/date เมื่อสร้าง event charge แรก จากนั้น charge, payment, correction, refund และ read model ใช้ context ID นี้โดยตรง ไม่ประกอบ identity จาก join chain ซ้ำในทุก RPC

ลดการทำ logic ซ้ำโดยคง public RPC แยก regular/event แต่ให้เรียก private primitives ร่วมกันสำหรับ:

- canonicalize allocation และ request fingerprint
- resolve/lock immutable settlement context
- evidence ownership และ payment-method validation
- allocation movement, refund obligation และ immutable document capture

Event adapter เป็นผู้เลือก frozen participation policy และ standard price ส่วน regular adapter ยังคงเลือก shop profile และกติกาเดิม ห้าม fork algorithm การเงินทั้งชุดเป็นสอง implementation ที่แก้แยกกัน

## 4. Rollout ที่ทดสอบ pilot ได้จริง

### 4.1 Migration `0171` — financial-ready dark install

- preflight ต้องยืนยันว่าไม่มี `delivery_events` บน event stop ที่ถูกสร้างด้วย writer ของ `0170` และไม่มี charge/payment/REC/INV ที่ต่อจากรายการนั้น
- ถ้าพบให้ abort ก่อน DDL พร้อมจำนวน/IDs ที่ต้อง remediation; ห้าม auto-backfill payment เพราะอาจเคยผสม regular/event และออกเอกสารด้วย shop policy ไปแล้ว
- เพิ่ม schema, constraints, indexes, RPCs และ read models ทั้งหมด
- ยก `event_delivery_feature_settings.schema_version` เป็น `7`
- คง `event_ice_delivery_enabled = false`
- เพิ่มตาราง internal-only `event_ice_delivery_pilots`:
  - `event_participation_id` เป็น primary key
  - `enabled_by`, `enabled_at`, `expires_at`
  - อ่าน/เขียนผ่าน security-definer RPC สำหรับ admin เท่านั้น
- เพิ่ม helper กลาง `is_event_ice_delivery_write_enabled(participation_id)` ซึ่งคืน true เมื่อ global flag เปิด หรือ participation อยู่ใน pilot allowlist ที่ยังไม่หมดอายุ
- `get_event_delivery_pos_context` และ event card projection ใช้ predicate เดียวกันแบบ read-only
- event writer ใช้ `lock_event_ice_delivery_write_eligibility(participation_id)` ซึ่ง lock settings row และ pilot row ก่อนประเมิน predicate เดียวกัน เพื่อ serialize กับ explicit enable/disable
- enable/disable pilot RPC และ global activation/rollback ต้องใช้ lock protocol เดียวกัน เพื่อให้เมื่อ disable RPC คืนผลแล้วจะไม่มี write ใหม่จาก eligibility เก่ามา commit ภายหลัง
- `expires_at` เป็น eligibility-check boundary: transaction ที่ผ่านการตรวจก่อนหมดอายุอาจ commit หลังเวลานั้นได้; ถ้าต้องการ hard transactional cutoff ต้องเรียก disable RPC และรอให้ commit
- cleanup แถว pilot ที่หมดอายุเป็น housekeeping เท่านั้น ไม่ใช่ integrity boundary
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

### 4.4 Migration `0172` — explicit global activation controls

- ตรวจ prerequisite ว่า `schema_version >= 7`
- การ apply migration ไม่เปลี่ยน `event_ice_delivery_enabled = false`
- ติดตั้ง admin-only `activate_event_ice_delivery()` ซึ่ง lock settings, เปิด global flag และล้าง pilot allowlist ใน transaction เดียว
- ติดตั้ง admin-only `deactivate_event_ice_delivery()` ซึ่ง lock settings, ปิด global flag และล้าง pilot allowlist ใน transaction เดียว
- เรียก activation RPC หลัง client schema 7 และ pilot acceptance ผ่านเท่านั้น
- ไม่เปลี่ยน schema contract หรือ function signature

### 4.5 Rollback หลัง activation

- เรียก `deactivate_event_ice_delivery()`
- ผลที่ต้องเกิด: สร้าง event delivery ใหม่ไม่ได้ แต่ event charges เดิมยังปรากฏใน collection/accounting และยัง payment, correction, void ตามกติกาเดิม และ settle refund ได้
- ไม่ย้อน migration และไม่ลบข้อมูล

## 5. Database context และ invariants

### 5.1 `event_settlement_contexts`

เพิ่มตาราง internal-only:

```text
id uuid primary key
event_participation_id uuid not null references event_participations(id) on delete restrict
shop_id uuid not null references shops(id) on delete restrict
service_date date not null
config_version_id uuid not null references event_job_config_versions(id) on delete restrict
settlement_policy_fingerprint text not null
created_at timestamptz not null default now()
unique (event_participation_id, service_date)
```

แถวนี้สร้างด้วย private `get_or_create_event_settlement_context(participation_id, service_date)` ใน writer ใดก็ตามที่กำลังสร้าง event charge แรก รวม `record_event_ice_delivery` และ correction จาก issue/non-delivery ไปเป็น delivered กรณีหลังถือเป็น intake ใหม่และต้องผ่าน eligibility/operational checks ชุดเดียวกับ delivery writer ก่อนเรียก helper ถ้า conflict ที่ unique key ต้อง lock และยืนยันว่า shop/config/fingerprint ตรงทุก field

Insert guard ของ context ต้อง reject direct SQL เมื่อ participation ไม่มี frozen config, `shop_id` ไม่ตรง participation, config version ไม่ตรง participation/event job, fingerprint ไม่ตรง frozen snapshot หรือ service date อยู่นอกช่วง job/participation

`event_settlement_contexts` immutable หลัง insert และไม่มี direct table grants สำหรับ client การยกเลิก job/participation หรือการแก้ metadata จึงไม่เคลื่อน financial identity ย้อนหลัง

### 5.2 `delivery_charges` และ upstream identity

เพิ่ม `event_settlement_context_id uuid null references event_settlement_contexts(id) on delete restrict` และ index:

```text
(shop_id, event_settlement_context_id, service_date) WHERE status = 'active'
```

กติกาที่ฐานข้อมูลต้องบังคับตอน insert:

- regular stop → context ID เป็น null
- event stop → context ID ต้อง present และ context participation/shop/date ตรงกับ stop, charge และ round
- context ID, `charge.shop_id`, `charge.service_date` และ `delivery_event_id` เปลี่ยนไม่ได้หลัง insert
- direct insert/update ที่ไม่ตรงต้อง fail

Upstream operational identity ยังต้องถูกป้องกันแบบ immediate `BEFORE` trigger:

- `event_participations.event_job_id` immutable หลัง insert
- `event_participations.shop_id` immutable ทันทีที่มี frozen config, `round_stops` หรือ settlement context
- ทุก event stop ต้องมี `stop.shop_id = participation.shop_id`
- `delivery_events.round_stop_id` immutable หลัง insert
- `delivery_rounds.service_date` เปลี่ยนไม่ได้เมื่อรอบมี stop/event/financial history

Trigger เหล่านี้รักษา operational/history topology แต่ไม่ใช้เป็น transitive financial identity และไม่ queue deferred payment scan เมื่อแก้ booth/contact/status

### 5.3 `payments` และ fingerprint compatibility

เพิ่ม:

- `operation_kind text not null check (operation_kind in ('regular', 'event')) default 'regular'`
- `request_fingerprint_version smallint not null default 2 check (request_fingerprint_version in (1, 2))`
- `event_settlement_context_id uuid null references event_settlement_contexts(id) on delete restrict`

Migration ต้องเพิ่ม version column แบบ nullable/ยังไม่ตั้ง default, backfill payment เดิมเป็น `operation_kind = 'regular'`, `request_fingerprint_version = 1`, context ID = null โดยไม่คำนวณ hash ใหม่ แล้วจึง set `not null default 2`

New regular/event payment ใช้ version 2; event payment ต้องมี context ID และ regular payment ต้องเป็น null โดย context/kind/fingerprint version เปลี่ยนไม่ได้หลัง insert

Replay ต้องเลือก fingerprint algorithm จาก version ที่เก็บใน resource เดิม:

- v1 regular → คำนวณ canonical payload ตาม algorithm ของ `0130` แบบ byte-for-byte
- v2 regular/event → รวม operation kind, canonical allocations, expected context ID/identity, expected outstanding, method/amount/reference/evidence, run/approval
- ห้ามใช้ current allocations เพื่อสร้าง hash ใหม่ เพราะ correction อาจย้าย allocation แล้ว

### 5.4 Deferred integrity

ขยาย integrity function เดิมและติด constraint trigger แบบ deferred บนทุกตารางที่เปลี่ยน financial invariant โดยตรง:

- `payments`
- `payment_allocations`
- `delivery_charges`
- `refund_obligations`
- `delivery_charge_adjustments`
- `event_settlement_contexts`

ตรวจตอน commit ว่า:

1. `sum(current allocations) + sum(non-voided refund obligations) = payment.allocated_amount`
2. ทุก allocation/refund obligation ใช้ shop และ settlement context เดียวกับ payment
3. regular payment/context-null อ้างได้เฉพาะ regular charge/context-null
4. event payment อ้างได้เฉพาะ charge ที่มี context ID เดียวกันทุกแถว
5. payment/charge shop ตรง context shop และ charge service date ตรง context service date
6. active allocations รวมต่อ charge ไม่เกิน `effective_delivery_charge_amount(charge.id)` และ voided charge ไม่มี active allocation
7. correction ห้ามย้าย allocation ไป charge คนละ context

`delivery_charge_adjustments` ต้อง queue ตรวจ charge และ payments ที่เกี่ยวข้องทั้ง `OLD`/`NEW charge_id` เพราะ amount/status ของมันเปลี่ยน effective charge total โดยไม่แตะ allocation

Trigger dispatcher ต้องมี branch เฉพาะตาม schema ของแต่ละตารางและตรวจทั้ง `OLD`/`NEW` IDs; `refund_obligations` ใช้ `source_charge_id` และ `delivery_charge_adjustments` ใช้ `charge_id`

## 6. Writers และ authorization

### 6.0 Canonical settlement primitives

แยก private helper ตาม lock phase ชัดเจน ห้ามใช้ boolean `lock_rows` ที่ทำให้ caller ไม่รู้ว่า row lock เกิดตอนใด:

- `canonicalize_financial_allocations(allocations)` เป็น pure helper: normalize amount/order และ reject null, duplicate, non-positive
- `get_or_create_event_settlement_context(participation_id, service_date)` ใช้ได้เมื่อ caller ถือ eligibility/service-date/round/job/participation locks และผ่าน operational validation แล้วเท่านั้น
- `financial_payment_request_fingerprint_v1(canonical_payload)` รักษา algorithm ของ `0130` สำหรับ replay เท่านั้น
- `financial_payment_request_fingerprint_v2(operation_kind, canonical_payload)` เป็น pure helper; fingerprint รวม operation kind, canonical allocations, expected context ID/identity, expected outstanding, method/amount/reference/evidence, run/approval และห้ามอ่าน live business state
- `peek_charge_settlement_context(charge_ids)` เป็น read-only lookup จาก immutable `delivery_charges.event_settlement_context_id`; reject missing charge, mixed regular/event, mixed context ID และ shop ไม่ตรง context
- `lock_and_resolve_charge_settlement_context(charge_ids, expected_context_id)` lock context และ charge rows ตาม UUID หลัง caller ถือ advisory locks แล้ว จากนั้นตรวจว่า context ID/shop/date ตรง candidate และ expected ทุก field
- payment, correction, deferred integrity และ read projection ใช้ settlement-context resolver เดียวกัน ห้ามประกอบ financial identity จาก ancestry join คนละชุด
- validation method/reference/evidence รับ canonical payment profile เป็น input เพื่อ reuse algorithm เดียวกัน โดย caller regular/event เป็นผู้เลือก source ของ profile

Revoke `EXECUTE` ของ helper ทั้งหมดจาก `public`, `anon` และ `authenticated`; public RPC เท่านั้นที่เรียกได้

### 6.1 `record_event_ice_delivery`

Redefine ใน `0171` โดยไม่แก้ migration `0170` ที่ติดตั้งแล้ว:

- resolve participation จาก round stop ฝั่ง server
- หลังตรวจ active caller ให้ canonicalize payload แบบ pure, lock idempotency key และค้นหา existing delivery ก่อน live eligibility/operational/price validation
- หากพบ existing delivery และ caller มองเห็นได้พร้อม request fingerprint ตรง ให้คืน delivery event ID เดิมผ่าน current response projection โดยไม่ตรวจ global/pilot eligibility, status หรือ active ice/price ซ้ำ
- เฉพาะกรณีไม่พบ existing delivery จึง resolve participation และตรวจ write eligibility ผ่าน locking helper global/pilot
- หลัง lock/recheck operational ancestry ให้เรียก `get_or_create_event_settlement_context` และตรวจ shop/config/fingerprint ซ้ำ
- insert `delivery_charges.event_settlement_context_id` โดยตรง
- รักษา standard price ของ service date และ `end_of_day`
- response เพิ่ม destination/settlement context แบบ additive

### 6.2 `record_event_payment`

รับ:

- expected settlement context ID
- expected participation ID
- expected service date
- expected policy fingerprint
- allocations, payment method, received amount, reference, evidence
- collection run ID, expected group outstanding และ idempotency key

ไม่รับ `shop_id`; peek candidate context ID จาก charges เพื่อรับ service-date/shop advisory locks แล้ว lock context/charges และตรวจซ้ำ ห้าม derive context ใหม่จาก live job/participation status

RPC ต้องทำตามลำดับนี้:

1. ตรวจ active user และ `can_collect_shop_payments()` แล้ว canonicalize allocations/payload แบบ pure
2. รับ idempotency advisory lock และค้นหา payment เดิมก่อน live validation; ถ้าเป็น regular payment, caller มองไม่เห็น หรือ request fingerprint ไม่ตรงให้ reject; ถ้าตรงให้คืน payment ID เดิมผ่าน current response projection ทันที
3. เมื่อเป็น write ใหม่จึง `peek_charge_settlement_context`, reject mixed/incomplete context ID และเทียบ expected participation/date/fingerprint
4. รับ service-date advisory lock จาก immutable context และ lock context row โดยไม่ lock job/participation หรือใช้ operational status เป็น gate
5. รับ financial-shop advisory จาก context shop และ collection-run shared advisory จาก run service date
6. ตรวจ collection run เป็น current Bangkok business date, ยังเปิด และ caller มี scope
7. lock delivery event/charge/payment rows ตาม UUID, reject charge/event ที่ไม่ active และ reject ถ้า locked charge context ต่างจาก candidate/expected context
8. อ่าน allowed methods/default/reference/evidence จาก immutable context/config snapshot, ตรวจ evidence ownership และห้ามอ่าน shop profile
9. คำนวณ outstanding เฉพาะ final queue context, เทียบ expected outstanding และตรวจ partial/cash-change rules
10. insert payment ด้วย `operation_kind = 'event'`, fingerprint version 2 และ locked context ID พร้อม allocation, ออกเลข REC, capture immutable receipt snapshot และ audit ภายใน transaction เดียว

New-write path ห้ามอ่าน intake flag และห้ามบังคับ job=`published`, participation=`active` หรือ round stop=`is_operational`; charge ที่เกิดแล้วต้องชำระได้จาก immutable context แม้ event ถูกยกเลิกหรือจบแล้ว

### 6.3 `record_payment`

คง signature เดิมเพื่อ compatibility แต่เพิ่ม fail-fast guard หาก allocation ใดเป็น event charge ส่วน regular/immediate new-write behavior เดิมต้องไม่เปลี่ยน

Wrapper ต้อง canonicalize และตรวจ existing idempotency key ก่อน current-date/open-run gate เช่นเดียวกับ event RPC เพื่อให้ replay ของ regular payment ที่ commit แล้วยังคืน payment ID เดิมได้หลัง run ปิดหรือวันเปลี่ยน ตรวจ hash ด้วย v1/v2 ตาม stored version และ reject ถ้า key ชี้ event payment

New regular payment ต้อง insert `operation_kind = 'regular'`, fingerprint version 2 และ context ID = null อย่างชัดเจน

### 6.4 Lock order

ทุก event writer และ regular writer ที่แก้ financial rows ชุดเดียวกันต้องใช้ common locks ในลำดับเดียวกัน โดย payment/refund ข้าม operational ancestor locks ได้แต่ห้ามสลับลำดับ common locks:

```text
idempotency advisory
→ event-write eligibility lock (เฉพาะ writer ที่สร้าง delivery ใหม่ และหลัง existing replay miss)
→ service-date advisory
→ round row
→ event job row
→ participation row
→ event settlement context row
→ financial-shop advisory
→ collection-run shared advisory (เมื่อมี)
→ delivery event/charge/payment/refund rows ตาม UUID
```

Payment/refund writer ที่ไม่รับ `shop_id` ทำ two-pass lookup เฉพาะ immutable context ID: peek context จาก charge, รับ service-date/context/shop locks, จึง lock charge และตรวจ context ID ซ้ำ ไม่ต้องล็อกหรือ derive ผ่าน live job/participation ancestry

Intake/correction writer ที่ต้อง round/job/participation locks ต้อง acquire แยก query ตามลำดับและ UUID ที่กำหนด ไม่พึ่งลำดับจาก multi-table `SELECT ... FOR UPDATE` ห้ามใช้ generic correction implementation ที่ล็อก event/round ก่อน service-date lock

## 7. Collection queue contract

`get_collection_run_queue` เป็น authoritative projection; `get_today_collection_run_queue` delegate มาที่เดียวกัน

Grouping:

```text
regular:${shop_id}
event:${event_settlement_context_id}
```

Business fields `shop_id`, participation และ service date ยังคืนใน DTO สำหรับ display/search/audit แต่ไม่นำมาประกอบ client identity ซ้ำ

DTO แต่ละ group เพิ่ม:

- `queue_key`
- `destination_kind`
- `event_settlement_context_id`
- `event_participation_id`
- `settlement_service_date`
- `settlement_policy_fingerprint`
- event name/location/zone/booth จาก immutable round-stop snapshot
- `payment_profile`

ที่มาของ `payment_profile`:

- regular → `shop_payment_profiles`
- event → immutable settlement context/config snapshot ที่ตรงกับ frozen fields บน `event_participations`

`outstanding_amount`, `charge_count`, `latest_payment_at` และ `has_new_charges` ต้องคำนวณต่อ `queue_key` ห้าม aggregate event กลับเข้ากลุ่ม regular แม้เป็นร้านเดียวกัน

## 8. Documents และ immutable history

### 8.1 INV

- หนึ่ง snapshot ต่อ charge เช่นเดิม
- event INV เพิ่ม `destination_kind`, settlement context ID, participation ID, policy fingerprint, event name, location, zone และ booth จาก immutable context/round-stop snapshot
- correction สร้าง replacement charge และ INV ใหม่; snapshot เดิมไม่เปลี่ยน

### 8.2 REC

- event REC รวมหลาย charge ได้เฉพาะ context เดียว
- root และแต่ละ charge item เก็บ settlement context ID, event destination snapshot และ policy fingerprint ที่ใช้ตอนออก REC
- regular receipt JSON keys เดิมคงอยู่
- snapshot ที่ออกแล้ว immutable แม้ participation metadata หรือ allocation เปลี่ยนภายหลัง

### 8.3 Payment history

เพิ่ม keyset-paginated read model แทนการ select ตาราง `payments` ตรงจาก client:

```text
get_payment_history(
  from_date,
  to_date,
  page_size default 50,
  before_recorded_at default null,
  before_id default null
)
```

Authorization และ range contract:

- ตรวจ active user ทุกครั้ง
- admin/round lead เห็นรายการตาม scope เดิม; courier เห็นเฉพาะ payment ที่ `is_payment_visible(payment.id)` คืน true
- ใช้ Bangkok half-open range `[from_date 00:00, to_date + 1 day 00:00)` และจำกัดช่วงไม่เกิน 31 วัน
- `page_size` ต้องอยู่ระหว่าง 1–100; query ใช้ keyset predicate `(recorded_at, id) < (before_recorded_at, before_id)` และ deterministic order `(recorded_at desc, id desc)`
- query ดึง `page_size + 1`; คืนเฉพาะ `page_size` items และสร้าง `next_cursor` จาก item สุดท้ายที่คืนเมื่อมี row เกินหน้า มิฉะนั้นคืน null
- cursor ต้อง null ทั้งคู่หรือ present ทั้งคู่; cursor ที่อยู่นอก requested Bangkok range ต้อง reject
- ห้าม security-definer function query แล้วคืนทุก payment โดยไม่ใส่ visibility predicate

Read model คืน object:

```text
{
  items: [...],
  next_cursor: { recorded_at, id } | null,
  range_summary: {
    visible_payment_count,
    active_payment_count,
    active_allocated_amount,
    active_cash_amount,
    active_non_cash_amount
  }
}
```

`range_summary` คำนวณจากทั้ง requested range ภายใต้ visibility เดียวกัน ไม่คำนวณจาก items เฉพาะหน้า; amount fields นับเฉพาะ active payments ขณะที่ `visible_payment_count` นับทั้ง active/voided สำหรับ history pagination

Item แต่ละรายการต้องคืน:

- payment fields เดิม
- destination/settlement context
- event labels จาก immutable receipt snapshot หรือ original charge → round-stop snapshot
- void information

ห้าม join booth/zone จาก live participation สำหรับประวัติย้อนหลัง

`get_payment_correction_targets` ต้องเพิ่ม `destination_kind`, settlement context ID, participation ID และ service date เพื่อให้ client route correction ได้ถูก RPC

## 9. Event correction และ refund

เพิ่ม event-specific RPCs สำหรับ context, preview, open correction/cancellation และ closed-period adjustment ส่วน generic RPCs ยังคง reject event delivery

กติกา:

- ตรวจ event identity, permission และ historical settlement context ซ้ำบน server แต่ห้ามใช้ intake eligibility, live job status, live participation status หรือ `round_stops.is_operational` เป็นเงื่อนไขของ financial servicing
- ถ้าต้นทางยังไม่มี charge/context และ correction กำลังเปลี่ยนเป็น delivered ให้ถือว่าเป็น intake ใหม่: ตรวจ global/pilot eligibility และ live operational state ภายใต้ lock order เดียวกับ delivery writer แล้วจึงเรียก `get_or_create_event_settlement_context`
- ice type ที่มีในรายการเดิมรักษา unit-price snapshot
- ice type ใหม่ใช้ standard price ที่มีผล ณ service date เดิม ห้ามใช้ shop special price
- replacement event/charge รักษา `event_settlement_context_id` เดิม จึงได้ shop, participation, service date และ fingerprint เดิมโดยไม่ derive ซ้ำ
- allocation ย้ายได้เฉพาะภายใน context เดิม
- ส่วนที่รับเกินสร้าง non-voided refund obligation เพียงครั้งเดียวต่อ source/payment
- idempotent replay ต้องตรวจ visibility/authorization ก่อนคืน response
- closed-period adjustment ใช้ append-only adjustment เดิมและไม่แก้ stock snapshot ของวันที่ปิด

`DeliveryCorrectionDialog` เลือก RPC จาก `destination_kind` ไม่ใช่จากชื่อร้านหรือการมี participation field แบบเดาเอง

`get_refund_queue` เพิ่ม settlement context ID และ event identity จาก source charge → original round-stop snapshot และยังแสดงรายการเมื่อ intake flag ปิด

## 10. UI contract

ขยาย `QueueShop` แบบ additive แต่เปลี่ยน identity ทุกจุดเป็น `queue_key`:

- React keys
- selected row/card
- refresh/reselect หลัง payment
- pending-request signature
- modal lifecycle/focus effects
- collection desk row IDs/selected-state comparisons
- demo-data preferred selection และ deep-link/preferred queue selection

Event card, payment modal, payment history, receipt history และ refund queue แสดง badge งาน วันที่ settlement สถานที่ โซนและบูธ Search รวม event name/location/booth

Collection UI ต้องเรียก paginated `get_payment_history` ทั้ง history-date และ today summary path ห้าม select `payments` ตรง ตัวเลขบน summary cards ใช้ `range_summary` ไม่รวมจากเฉพาะ items ที่โหลดแล้ว

เมื่อร้านเดียวมีหลาย `queue_key` ให้ปรับคำว่า “ร้าน” ใน queue counts/stats เป็น “กลุ่มยอดค้าง” หรือแสดงทั้ง unique shop count และ group count แยกกัน ห้ามแสดง `queue.length` เป็นจำนวนร้าน

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
- settlement context ID
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
- `0171` preflight abort พร้อม diagnostic IDs เมื่อพบ event delivery/charge/payment/document ที่เกิดภายใต้ `0170`
- direct insert/update บน payment/allocation/charge/refund/settlement context ปฏิเสธ mixed context
- direct insert/update/status change บน `delivery_charge_adjustments` ที่ทำให้ allocation เกิน effective charge ถูกปฏิเสธตอน commit
- direct update `event_participations.event_job_id`, published/history-bearing `event_participations.shop_id`, `delivery_events.round_stop_id` และ `delivery_rounds.service_date` ถูกปฏิเสธ
- direct insert event stop ที่ `stop.shop_id <> participation.shop_id` ถูกปฏิเสธ
- settlement context create-once และ immutable; concurrent delivery ของ participation/date เดียวกันได้ context ID เดียว
- cross-RPC idempotency key reuse ถูกปฏิเสธ
- partial/full/cash-change/idempotent replay ถูกต้อง
- regular payment v1 ที่สร้างก่อน `0171` replay ด้วย payload เดิมได้ และ payload ต่างถูกปฏิเสธ
- delivery replay ยังคืน delivery event ID เดิมหลัง pilot ถูกถอด/หมดอายุ, global flag ปิด, ice type/price เปลี่ยน และหลัง correction โดยไม่สร้าง side effect ซ้ำ; key ใหม่ถูกปฏิเสธ
- event และ regular payment replay ยังคืน payment ID เดิมหลัง collection run ปิด, Bangkok business date เปลี่ยน และ allocation ถูก correction โดยไม่สร้าง REC/allocation ซ้ำ
- payment history pagination ไม่ซ้ำ/ไม่ข้าม row เมื่อ `(recorded_at, id)` ซ้ำเวลากัน, reject malformed/out-of-range cursor และ `range_summary` ไม่เปลี่ยนตาม page size
- INV แยกต่อ charge และ REC รวมได้เฉพาะ context เดียว
- ปิด intake flag แล้วรับชำระ/แก้ไข/คืนเงินรายการเดิมได้ แต่สร้าง delivery ใหม่ไม่ได้
- ปิด intake flag แล้ว correction ของ event ที่มี charge/context เดิมยังทำได้ แต่ correction จาก issue/non-delivery ที่จะสร้าง charge แรกถูกปฏิเสธเหมือน intake ใหม่
- disable pilot แข่งกับ delivery write แบบสอง connection แล้วหลัง disable RPC commit ไม่มี write ใหม่จาก eligibility เก่ามา commit
- expiry test ยืนยัน check-time semantics: request ที่ตรวจหลัง `expires_at` ถูกปฏิเสธ แต่ request ที่ถือ eligibility lock และผ่านก่อนหมดอายุสามารถ commit หลังเวลาได้

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
- event payment context peek แข่งกับ charge correction โดย final locked context ID ต้องตรง candidate หรือ abort/retry โดยไม่ commit บน context ผิด
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
- payment history โหลดหน้าถัดไปได้, รักษา order และใช้ full-range summary บน cards
- queue counts แสดง group count/unique shop count ถูกต้องเมื่อร้านเดียวมีหลาย `queue_key`
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
3. INV/REC settlement context ID และ identity ตรง immutable context/round-stop snapshot
4. sales difference เป็นศูนย์
5. net cash ตรงเงินจริงตาม recorded date
6. regular queue/payment/correction/documents/accounting ไม่เปลี่ยนพฤติกรรม
7. หลัง disable/cancel แล้ว historical financial servicing และ committed idempotent replay ยังทำงาน แต่ write ใหม่ถูกปฏิเสธ

## 13. Definition of done

- ฐานข้อมูลปฏิเสธ mixed-context และ over-allocation ทุก write path รวม direct SQL/adjustment mutation
- `event_settlement_contexts` เป็น immutable source of truth; charge/payment/correction/refund อ้าง context ID เดียวกันโดยไม่ derive financial identity จาก live ancestry
- upstream operational identity (`event_participations.event_job_id/shop_id`, `delivery_events.round_stop_id`, `delivery_rounds.service_date`) ยังเปลี่ยนจนทำให้ topology/history ขัดกันไม่ได้
- writer ที่ไม่รับ `shop_id` ตรวจ final locked context ID ก่อน mutate
- client ไม่มีจุดใดใช้ `shop_id` เป็น identity ของ collection group
- frozen event policy ถูกใช้ตรงกันใน queue, UI และ payment RPC
- receipt/history/refund/accounting ใช้ immutable destination identity
- pilot เปิดได้โดยไม่เปิดทั้งระบบและ rollback หยุดยอดใหม่โดยไม่ซ่อนภาระเดิม
- `expires_at` มี check-time semantics ชัดเจน และ explicit disable RPC เป็น hard transactional cutoff
- payment v1 ก่อน `0171` replay ได้ด้วย algorithm เดิม; v2 ใช้เฉพาะ resource ใหม่
- read models รักษา visibility เดิม และ cancellation/intake flags ไม่ตัด historical financial servicing
- payment history มี keyset pagination/summary contract ที่ครบ และ client ไม่ select `payments` ตรง
- accounting aggregate คงยอดเดิมแต่ระบุ customer-location และ mixed settlement semantics อย่างไม่กำกวม
- release suite รวม real PostgreSQL concurrency test ใหม่
