# แผนรับเงินร้านค้าโดยไม่ต้องเปิดรอบ และแผนส่งมอบเงินสด

สถานะ: แผนฉบับ rework — ปิดช่องว่างด้านสิทธิ์ concurrency การนับเงินส่งมอบซ้ำ และกรณีพนักงานออกจากบทบาทแล้ว

## เป้าหมาย

ให้ผู้มีสิทธิ์เข้าคิวและรับชำระยอดที่ถึงกำหนดได้ทันทีระหว่างวันธุรกิจ โดยไม่ต้องรอหัวหน้าเปิดรอบหรือมอบหมายรายวัน พร้อมรักษาวันธุรกิจ ขอบเขตบิล การป้องกันรับเงินซ้ำ ความเป็นส่วนตัวของประวัติ และ audit trail ครบถ้วน

ระบบยังคงเก็บ `collection_runs` เป็น **daily collection context ภายใน** เพราะ `payments`, ใบเสร็จ, credit eligibility, daily close และ offline contract อ้างอิง context นี้อยู่ แต่ไม่แสดงเป็นงานที่ผู้ใช้ต้องเปิด ปิด หรือเลือกสมาชิกอีกต่อไป

งานแบ่งเป็น 2 เฟส:

1. ทำ daily collection context ให้อัตโนมัติ เพิ่มสิทธิ์ถาวรรายพนักงาน และรองรับการรับบางส่วนโดยยกยอดค้างอัตโนมัติ
2. เพิ่มกระบวนการพนักงานส่งมอบเงินสดและหัวหน้ายืนยัน

ใบเซ็นเครดิตรายวันไม่ใช่งานใหม่ งานนี้รักษาพฤติกรรมเดิมและเพิ่มเฉพาะ regression coverage

## กติกาหลักที่ล็อกแล้ว

- ยกเลิกเฉพาะการเปิด–ปิด **รอบเก็บเงิน** จากหน้าจอ ไม่เปลี่ยนรอบส่งสินค้า การควบคุมสต๊อก หรือ daily close
- active `admin` และ `round_lead` มีสิทธิ์รับเงินตามบทบาทเสมอ โดยไม่ต้องมีสิทธิ์รายคน
- active `courier` รับเงินร้านค้าได้เมื่อ `users.can_collect_shop_payments = true` เท่านั้น
- พนักงานเดิมทุกคนเริ่มต้นด้วยสิทธิ์ปิด (`false`) แอดมินต้องเปิดให้เป็นรายคน
- เมื่อเปลี่ยนบทบาทออกจาก `courier` ให้ล้าง `can_collect_shop_payments` เป็น `false`; ถ้าเปลี่ยนกลับเป็น courier ต้องเปิดสิทธิ์ใหม่
- กติกาล้างสิทธิ์ต้องบังคับด้วย database trigger/check ไม่พึ่ง frontend หรือ RPC wrapper เพียงชั้นเดียว
- สิทธิ์ตามบทบาทไม่ข้ามกติกาปิดวัน: เมื่อ daily close สำเร็จแล้ว ทุกบทบาทรับเงินในวันธุรกิจนั้นไม่ได้
- shared context สร้างได้เฉพาะ `p_service_date = (clock_timestamp() at time zone 'Asia/Bangkok')::date`; ห้ามเปิดอดีตหรืออนาคตผ่าน RPC นี้
- คิวรวมยอดค้างของ `immediate`, `end_of_day` และ `credit` ที่ `due_date <= service_date`; เครดิตอนาคตไม่เข้าคิว
- ไม่ใช้ `collection_run_credit_charges` เพื่อเลือกเครดิตเข้าคิวใหม่
- collection payment รับบางส่วนได้โดยไม่ขอ outstanding approval และยอดที่ยังไม่ได้รับคงเป็นยอดค้าง ห้ามแก้ยอดขายเดิม
- กติกา outstanding approval ของ immediate payment ระหว่างบันทึกการส่งสินค้า (`p_collection_run_id is null`) ยังคงเดิม
- `allocated_amount` ต้องอยู่ระหว่าง `0.01` ถึงยอดค้าง; `received_amount` มากกว่ายอดจัดสรรได้เฉพาะเงินสด โดยส่วนต่างเป็น `change_amount`; โอนและ QR ต้องมี `received_amount = allocated_amount`
- ผู้รับเงินมาจาก `auth.uid()` และบันทึกใน `payments.recorded_by` เท่านั้น ฝั่ง client ห้ามส่ง `employee_id` เพื่อระบุผู้รับเงิน
- เก็บ `payments.recorded_role` จาก server-side `current_app_role()` เป็น immutable snapshot พร้อม `recorded_by` เพื่อแยกเงินที่รับในบทบาท courier ออกจากเงินที่ manager รับเอง แม้บทบาทของผู้ใช้จะเปลี่ยนภายหลัง
- courier อ่านประวัติและใบเสร็จเฉพาะรายการที่ `recorded_by = auth.uid()`; manager อ่านได้ทั้งหมด
- การถอนสิทธิ์ courier มีผลกับ record, void collection payment และการขอเลื่อนกำหนดทันทีที่ server; ยัง ensure context, อ่านคิวและใบเสร็จเดิมของตนได้แต่แก้หรือยกเลิกไม่ได้
- เงินสดที่ต้องส่งมอบในเฟส 2 คือ `allocated_amount` ของ active cash payment ไม่ใช่ `received_amount` เพราะ `received_amount` รวมเงินทอน
- การส่งมอบเงินยึด payment แต่ละรายการเป็นหน่วยความถูกต้อง ไม่ใช้ช่วงเวลาอย่างเดียว; payment หนึ่งรายการอยู่ใน handover ที่ยัง active ได้เพียงหนึ่งรายการ

## เฟส 1: Daily collection context และสิทธิ์ถาวร

### 1. โมเดลสิทธิ์และ compatibility

1. เพิ่ม `public.users.can_collect_shop_payments boolean not null default false` โดยไม่ backfill พนักงานเดิมจาก `collection_run_members`
2. เพิ่ม helper `public.can_collect_shop_payments()` ที่คืน `true` เมื่อผู้ใช้ active และ:
   - role เป็น `admin` หรือ `round_lead`; หรือ
   - role เป็น `courier` และ `can_collect_shop_payments = true`
3. สร้าง RPC `save_user_profile_with_work_site_assignments_v2(...)` โดยเพิ่ม `p_can_collect_shop_payments boolean` และให้ admin frontend ใช้ v2
4. คง RPC ชื่อเดิมและ signature เดิมไว้เป็น compatibility wrapper สำหรับ PWA client รุ่นเก่า:
   - ถ้าเป้าหมายยังเป็น courier ให้คงค่าสิทธิ์เดิม
   - ถ้าเปลี่ยนออกจาก courier ให้บันทึกเป็น `false`
   - wrapper ยังต้องใช้ admin authorization และ atomic save เดิม
5. เพิ่ม `before insert or update of role, can_collect_shop_payments` trigger ให้:
   - ล้าง capability เมื่อ `old.role = 'courier'` และ `new.role <> 'courier'`
   - บังคับให้ non-courier เก็บค่า capability เป็น `false` เสมอ
   - ทำงานกับทุก write path รวมถึง direct table update และ RPC ชั้นล่าง
6. ถอน execute ของ `save_user_with_work_site_assignments(...)` จาก `authenticated`; ให้ v2 และ compatibility wrapper เป็น public save paths เท่านั้น โดย wrapper เรียก helper ภายในได้ในฐานะ function owner
7. ใส่ field ใหม่ใน `UserProfile`, `UserDraft`, `USER_FIELDS`, RoleRouter profile projection, admin settings projection และ test fixtures ที่เกี่ยวข้อง
8. bump local profile cache จาก `v1` เป็น `v2` และให้ validator บังคับ field ใหม่ เพื่อไม่ใช้ cache เก่าตัดสิทธิ์ UI

### 2. RPC สร้าง daily context

เพิ่ม `ensure_daily_collection_context(p_service_date date)` แบบ `security definer` และ idempotent:

1. ตรวจ `public.is_active_user()` ก่อนอ่านหรือสร้าง context; สิทธิ์ write ตรวจแยกใน RPC ที่เกิด mutation
2. บังคับ `p_service_date` เท่ากับวันปัจจุบันตาม `Asia/Bangkok`; ปฏิเสธอดีตและอนาคต
3. ใช้ exclusive transaction advisory lock ด้วย key `collection-run:<service_date>`
4. หลังได้ lock ให้ตรวจซ้ำว่าไม่มี `daily_aggregate_stock_closures` ของวันนั้น
5. คืน open `collection_runs` ที่มีอยู่ หรือสร้างหนึ่งรายการโดยใช้ `auth.uid()` เป็น `opened_by`
6. ไม่เพิ่มแถวใน `collection_run_members`
7. เขียน audit action `auto_opened` เฉพาะ transaction ที่สร้าง context ใหม่
8. คืน `{ collection_run_id, service_date, status: 'open' }`

ก่อน migration ต้อง preflight วัน Bangkok ปัจจุบัน: ถ้ามี closed `collection_runs` แต่ยังไม่มี daily aggregate closure ให้ migration หยุดพร้อมรายงาน run ID แทนการสร้าง context ที่สองของวันเงียบๆ; rollout ปกติต้องทำหลัง daily close หรือก่อนมี payment ของวันใหม่

### 3. Transaction boundary ระหว่าง ensure, payment และ daily close

ใช้ lock key `collection-run:<service_date>` เป็น boundary ด้านการเงิน โดยคง service-date lock เดิมของ stock/delivery ไว้:

- `ensure_daily_collection_context` ใช้ exclusive advisory lock ก่อนตรวจ closure และ insert
- collection branch ของ `record_payment` อ่าน service date ของ context, ได้ shared transaction advisory lock, แล้วตรวจซ้ำว่า context ยัง open, เป็นวัน Bangkok ปัจจุบัน และยังไม่มี daily closure
- collection branch ของ `void_payment` อ่าน shop/date เพื่อหา lock key โดยยังไม่ตัดสินสิทธิ์, ได้ `financial-shop` lock และ shared collection lock, จากนั้น `select ... for update` และตรวจ payment ownership, capability, context open/current-day และ closure ซ้ำก่อน void
- `close_daily_aggregate_stock` คง exclusive service-date lock เดิมเพื่อรอ stock/delivery mutation และได้ exclusive collection lock ก่อนปิด context เพื่อรอ payment/void ที่เริ่มแล้วให้จบก่อนปิดวัน
- ลำดับ lock ของ collection payment ให้คง `financial-shop:<shop_id>` ก่อน shared collection lock; daily close ไม่เข้า financial-shop lock จึงไม่เกิด lock cycle
- ลำดับที่ล็อกตายตัวคือ: idempotency lock (ถ้ามี) → financial-shop lock (ถ้ามี) → collection lock; daily close ใช้ idempotency lock → service-date lock → collection lock และทุก function ต้อง re-read แถวที่ใช้ตัดสินหลังได้ lock
- การปิด context, บันทึก `closed_by/closed_at` และ daily closure ต้องอยู่ใน transaction เดียวกัน
- retry daily close ด้วย idempotency key เดิมต้องไม่ปิดซ้ำหรือเขียน audit ซ้ำ

### 4. Queue, payment, receipt และ void authorization

1. ปรับ `get_collection_run_queue` ให้ active courier อ่าน open current-day context ได้โดยไม่ต้องมี `can_collect_shop_payments`; write RPC ยังตรวจ capability แยกต่างหาก
2. ปรับ `is_charge_collectible_in_run`:
   - active `immediate` และ `end_of_day` ที่ยังมียอดค้างเข้าคิว
   - active `credit` เข้าคิวเมื่อ `due_date <= run.service_date`
   - ไม่ตรวจ `collection_run_credit_charges`
3. คง `record_payment` เป็น canonical write path เพียงชุดเดียว ห้ามสร้าง RPC รับชำระชุดที่สอง
4. collection branch ต้องคง validation วิธีชำระ, evidence, idempotency, request fingerprint, financial-shop lock, expected outstanding, allocation integrity, oldest-first ของเครดิต และ audit เดิม
5. เงื่อนไข outstanding approval ของ immediate charge ให้ทำงานเฉพาะ `p_collection_run_id is null`; เมื่อเป็น collection payment ให้บันทึกบางส่วนและคงยอดที่เหลือได้
6. ปรับ `is_payment_visible` ให้ courier อ่านได้เฉพาะ `payment.recorded_by = auth.uid()` และลบกิ่ง `is_collection_run_member`; manager ยังอ่านได้ทั้งหมด
7. RLS ของ `payments`, `payment_allocations`, receipt snapshots และ receipt RPC ให้ใช้ `is_payment_visible` ที่แก้แล้ว
8. ปรับ `void_payment`:
   - manager void ได้ตามกติกาเดิม
   - courier void collection payment ของตนได้เฉพาะขณะยังมีสิทธิ์ถาวรและ context ยัง open
   - courier void immediate POS payment ของตนตามกติกาเดิม ไม่ผูกกับสิทธิ์เก็บเงิน
9. เพิ่ม `payments.recorded_role public.app_role`: migration backfill แถวเก่าจาก role ปัจจุบันของ `recorded_by` แล้วตั้ง `not null` เพื่อความเข้ากันได้ของข้อมูล แต่ถือว่าค่าก่อน cutover เป็น legacy approximation เท่านั้น; canonical payment write paths ทุกชุดตั้งค่าใหม่จาก server และ trigger ห้ามแก้ย้อนหลัง

### 5. Legacy RPC และข้อมูลเก่า

- ไม่ bulk-close รอบเก่า ไม่สร้าง `closed_by` ปลอม และไม่ลบ `collection_runs`, `collection_run_members` หรือ `collection_run_credit_charges`
- หลัง migration แถวสมาชิกเก่าไม่ให้สิทธิ์อ่าน payment ของผู้อื่น; อ่านประวัติได้ตาม manager หรือ `recorded_by` เท่านั้น
- เปลี่ยน `open_collection_run` เป็น compatibility wrapper ที่ยอมรับเฉพาะวัน Bangkok ปัจจุบัน, เรียก ensure และไม่เขียน `collection_run_members`; พารามิเตอร์สมาชิกมีไว้เฉพาะรองรับ client เก่า
- ปิดทางเรียก `close_collection_run` และ `set_credit_charge_collection_assignment` จาก authenticated client; การปิด shared context ทำได้เฉพาะภายใน `close_daily_aggregate_stock`
- ทำเครื่องหมาย RPC เก่าและตาราง assignment เป็น deprecated และห้ามมี call site ใหม่

### 6. Frontend

1. RoleRouter แสดงแท็บ “เก็บเงิน” ให้ courier ทุกคน; `can_collect_shop_payments = false` ยังดูคิวและรายละเอียดได้ แต่ UI รับเงินเป็น read-only รวมถึงไม่สามารถขอเลื่อนกำหนดชำระ; manager ใช้หน้าการเงินได้ตามบทบาทเดิม
2. ถ้า profile refresh พบว่าถูกถอนสิทธิ์ขณะอยู่หน้าเก็บเงิน ให้คงหน้าเดิมและเปลี่ยน action รับเงิน/ยกเลิกรับเงิน/ขอเลื่อนกำหนดเป็น read-only ทันที
3. server บังคับสิทธิ์ทันที; UI อัปเดตตาม profile revalidation เดิมทุก 5 นาที/เมื่อ focus หรือทันทีเมื่อ collection RPC คืน permission error แล้วสั่ง refresh profile
4. หน้าแอดมินแสดง checkbox “รับเงินร้านค้าได้” เมื่อแก้ courier; หัวหน้า/แอดมินแสดงข้อความอ่านอย่างเดียวว่ามีสิทธิ์ตามบทบาท
5. สร้าง `ensureCurrentCollectionContext(serviceDate)` เป็น client data boundary เดียว โดย cache เฉพาะ ID ของวันที่กำลังใช้ และ invalidate เมื่อวันเปลี่ยน, close, permission error หรือ stale-context error
   - หน้า queue ของ courier และ manager เรียก boundary นี้ก่อนโหลดคิว
   - action “บันทึกรับเงิน” จากหน้าลูกหนี้เรียก boundary นี้แบบ lazy เสมอ จึงไม่ต้องเข้าหน้าเก็บเงินก่อน
   - ห้ามอ่าน `collection_runs` โดยตรงจาก client เพื่อหา current context
6. ลบ `CollectionRunManager`, modal เลือกพนักงาน, ปุ่มเปิด/ปิดรอบ, collector/member state และข้อความที่บอกให้รอเปิดรอบ
7. รักษา search/building/zone queue ของพนักงานไว้ แต่เปลี่ยนหัวข้อเป็นคิวรับเงินและไม่ผูกการ render กับ manual `runId`
8. หน้า manager แสดง queue, auto-refresh และปุ่มรีเฟรชโดยไม่รอ manual run state
9. ลบ assign/unassign credit จากหน้าลูกหนี้; “บันทึกรับเงิน” ใช้ได้เฉพาะร้านที่มียอดถึงกำหนด และไม่ disabled ด้วย `runId`; action จะ ensure context เองก่อนเปิด payment modal
10. สถานะคิวของ credit ใช้ `due_date` คำนวณ “ถึงกำหนดวันนี้/เกินกำหนด X วัน”; immediate และ end-of-day ใช้ `service_date`
11. เปลี่ยน error copy จาก “รอบเก็บเงินปัจจุบัน” เป็นคิวหรือยอดล่าสุด
12. Demo mode สร้าง internal context ในหน่วยความจำอัตโนมัติ ไม่มี UI เปิด–ปิดรอบ และรักษา cash change/partial payment เหมือนระบบจริง

### 7. Offline scope ในเฟสนี้

- ไม่สร้าง offline sync adapter หรือ runtime ใหม่ในงานนี้ เพราะ repository ปัจจุบันมีเฉพาะ contract และ ledger foundation
- คง `CollectionPaymentPayload.collectionRunId` และ wire validation เดิม พร้อม regression test ว่า contract ไม่เปลี่ยน
- public adapter ในอนาคตต้องขอ internal context จาก ensure, ตรวจ `can_collect_shop_payments()` ตอน apply/retry และคืน conflict เมื่อ context ปิดหรือสิทธิ์ถูกถอน

## เฟส 2: ส่งมอบเงินสด

เริ่มเฟสนี้หลังเฟส 1 ผ่าน integration tests และเปรียบเทียบยอดรายวันเดิมกับยอดแยก `recorded_by` ได้ตรงกัน

เฟสนี้คือการส่งมอบเงินจาก courier ให้ manager เท่านั้น เงินสดที่ manager เป็นผู้รับเองปรากฏใน daily reconciliation ตาม `recorded_by` และ `recorded_role` แต่ไม่เข้า courier handover queue และ daily stock close ไม่บังคับให้ handover เสร็จก่อน เพราะสามารถส่งและตรวจย้อนหลังได้

ระบบเก็บ `cash_handover_cutover_at` เป็น Bangkok day boundary ที่ตั้งหลัง daily close; automated handover นับเฉพาะ payment ที่ `recorded_at >= cash_handover_cutover_at` เพื่อไม่เดาบทบาทของแถวเก่าที่ไม่มี role snapshot ที่เชื่อถือได้; ยอดก่อน cutover ปิดด้วยกระบวนการเดิม

### โมเดลข้อมูล

เพิ่ม `cash_handovers` แบบ append-oriented โดยมีข้อมูลอย่างน้อย:

- `id`, `service_date`, `employee_id`, `sequence`
- `submission_kind`: `employee`, `manager_offboarding` หรือ `manager_direct`
- `period_started_at`, `period_ended_at` เก็บเพื่อแสดงผลและ audit ไม่ใช่ boundary ป้องกันนับซ้ำ
- `expected_amount`, `submitted_amount`, `confirmed_amount`, `difference_amount`
- `source_fingerprint`
- `status`: `submitted`, `confirmed`, `rejected`
- `submitted_by`, `submitted_at`, `submission_note`
- `reviewed_by`, `reviewed_at`, `review_note`
- `idempotency_key`, `request_fingerprint`, `review_idempotency_key`, `review_request_fingerprint`, `created_at`

เพิ่ม `cash_handover_items` เพื่อ snapshot และ claim ต้นทางเงินสด:

- `handover_id`, `payment_id`, `accountable_amount`, `payment_fingerprint`
- `claim_status`: `submitted`, `confirmed`, `released`
- primary key `(handover_id, payment_id)`
- partial unique index บน `payment_id` เมื่อ `claim_status in ('submitted', 'confirmed')` เพื่อให้ payment หนึ่งรายการอยู่ใน active handover ได้เพียงครั้งเดียว

ข้อบังคับ:

- employee submission ต้องมี `employee_id = submitted_by = auth.uid()` และผู้ submit เป็น active courier; การถูกถอน `can_collect_shop_payments` ไม่ตัดสิทธิ์ส่งมอบเงินที่ตนรับไว้แล้ว
- manager-offboarding submission ใช้ได้เมื่อ `employee_id` ไม่ใช่ active courier แล้ว, `submitted_by = auth.uid()` เป็น manager และต้องมีเหตุผล
- manager-direct ใช้ได้กับพนักงานทุกสถานะ, ต้องมีเหตุผล และบันทึกเป็น confirmed ใน transaction เดียวโดย `submitted_by = reviewed_by = auth.uid()`
- `reviewed_by` ต้องเป็น active `round_lead` หรือ `admin`
- employee submission เท่านั้นที่บังคับ `reviewed_by <> submitted_by`; manager ที่ส่งแทนสามารถยืนยันรายการของตนเองได้
- `difference_amount = coalesce(confirmed_amount, submitted_amount) - expected_amount`
- หัวหน้าแก้ยอดรับจริงด้วย `confirmed_amount` โดยไม่แก้ทับ `submitted_amount`; ถ้ายอดที่แก้ต่างจากยอดพนักงานต้องมี `review_note`
- ถ้าส่วนต่างไม่เป็นศูนย์ต้องมี `submission_note`
- มี `submitted` ได้ไม่เกินหนึ่งรายการต่อพนักงานและวันธุรกิจ; จะ submit ครั้งถัดไปได้เมื่อรายการเดิม confirmed หรือ rejected แล้ว
- snapshot ของ `confirmed` และ `rejected` แก้ไขหรือลบไม่ได้; reject เปลี่ยนเฉพาะ item claim จาก `submitted` เป็น `released`
- `sequence` ไม่ซ้ำภายในพนักงานและวันธุรกิจ และรองรับการส่งเงินเพิ่มเติมหลายครั้งในวันเดียวกัน

ตารางทั้งสองไม่เปิด DML ให้ authenticated client; ทุก mutation ผ่าน security-definer RPC ที่ระบุไว้เท่านั้น และมี trigger ป้องกันการแก้ snapshot fields หรือ status transition นอกเส้นทาง `submitted → confirmed/rejected` และ `submitted claim → confirmed/released`

### การคำนวณยอด

- payment มี accountable service date เพียงวันเดียว:
  - collection payment ใช้ `collection_runs.service_date`
  - immediate payment ที่ `collection_run_id is null` ใช้ `(payments.recorded_at at time zone 'Asia/Bangkok')::date` เพราะเป็นวันที่พนักงานรับเงินสดจริง ไม่อนุมานจาก service date ของหลาย allocation
- `expected_amount` คือผลรวม `cash_handover_items.accountable_amount`; แต่ละ item snapshot จาก `payments.allocated_amount` ที่:
  - `payment_method = 'cash'`
  - `status = 'active'`
  - `recorded_by = employee_id`
  - `recorded_role = 'courier'`
  - `recorded_at >= cash_handover_cutover_at`
  - accountable service date ตรงกับ `service_date`
  - ยังไม่ถูก claim ใน handover item ที่มี status `submitted` หรือ `confirmed`
- เงินทอนไม่รวมในยอดส่ง เพราะอยู่ใน `change_amount`
- cash refund ที่หัวหน้าหรือแอดมินจ่ายให้อยู่ใน reconciliation ของผู้จ่ายคืน ไม่ย้อนไปลด handover ของพนักงาน
- `payment_fingerprint` ของ item สร้างจาก payment ID, status, method, allocated amount, recorded_by และ accountable service date โดย canonical ordering; `source_fingerprint` ของ handover สร้างจาก item fingerprints ที่เรียงตาม payment ID
- หาก item payment ถูก void หรือข้อมูลที่ fingerprint อ้างอิงเปลี่ยนก่อน confirm ห้ามยืนยัน; payment ใหม่ที่เกิดหลัง submit ไม่ทำให้ handover เดิม stale
- การ void หรือคืนเงินหลังยืนยันไม่แก้ snapshot handover เดิม ต้องปรากฏเป็น correction/refund แยกต่างหาก

### RPC และหน้าจอ

- `get_cash_handover_summary(p_service_date)`:
  - courier เห็นเฉพาะตนเอง
  - manager เห็นทุกพนักงานที่มี source payment ของวันนั้น รวมถึงผู้ที่ไม่ใช่ courier/ไม่ active แล้ว
  - แสดง `available_to_submit` จาก eligible payment ที่ยังไม่ถูก claim, `submitted`, `confirmed` และ history; ไม่คำนวณ remaining ด้วยการลบ aggregate snapshot เก่าออกจากยอด active ปัจจุบัน
- `submit_cash_handover(p_service_date, p_submitted_amount, p_note, p_idempotency_key)`:
  - อนุญาต active courier เท่านั้น
  - ยอมรับวันปัจจุบันหรืออดีต แต่ปฏิเสธวันอนาคต
  - ล็อกตามพนักงานและวัน, ปฏิเสธถ้ามี submitted handover รอตรวจอยู่
  - เลือกและ claim eligible payment ที่ยังไม่ถูก claim พร้อมกับสร้าง handover, items, fingerprint และ audit ใน transaction เดียว; ปฏิเสธเมื่อไม่มี payment ใหม่
  - retry ด้วย key เดิมและ request fingerprint เดิมคืนรายการเดิม
- `submit_offboarding_cash_handover(p_employee_id, p_service_date, p_submitted_amount, p_note, p_idempotency_key)`:
  - อนุญาต manager เท่านั้น และ target ต้องไม่ใช่ active courier แล้ว
  - บังคับ note และ audit action `submitted_for_offboarding`
  - ใช้ lock, eligibility, item claim, difference และ idempotency ชุดเดียวกับ employee submit
- `record_cash_handover_for_employee(p_employee_id, p_service_date, p_submitted_amount, p_note, p_idempotency_key)`:
  - อนุญาต manager บันทึกแทนพนักงานทุกสถานะและ confirm ทันที โดยไม่ต้องรอผู้ตรวจคนที่สอง
  - บังคับ note และ audit action `recorded_by_manager`
- `review_cash_handover_v2(p_handover_id, p_decision, p_confirmed_amount, p_note, p_idempotency_key)`:
  - อนุญาต manager เท่านั้น
  - รองรับ `confirm` และ `reject`
  - confirm แก้ยอดรับจริงได้ผ่าน `confirmed_amount` โดยเก็บยอดที่พนักงานส่งเดิมไว้; ถ้ายอดเปลี่ยนต้องมีเหตุผล
  - confirm ล็อก handover/items และ source payment rows ตาม payment ID, revalidate item fingerprint และเปลี่ยน claim เป็น `confirmed`; การล็อก payment rows ทำให้ confirm ที่แข่งกับ void มีลำดับผลชัดเจน
  - reject ต้องมีเหตุผล และเปลี่ยน item claim เป็น `released` เพื่อให้ submit รอบใหม่นำ payment เดิมกลับมาได้
  - retry ด้วย review key/fingerprint เดิมคืนผลเดิมโดยไม่เขียน audit ซ้ำ; key เดิมกับ decision/note ต่างกันถูกปฏิเสธ

หน้าพนักงานแสดงยอดที่ยังไม่ถูก claim, ยอดที่กรอก, ส่วนต่าง, เหตุผล และประวัติ handover ของวัน; หน้า manager แสดงสถานะรายพนักงาน, source payment count, แก้ยอดและยืนยันได้ทันที รวมถึงบันทึกรับเงินแทนพนักงานทุกสถานะ

## ใบเซ็นเครดิตรายวัน

รักษาพฤติกรรมปัจจุบันเป็นข้อกำหนด regression:

- หนึ่งร้านต่อหนึ่งวันธุรกิจรวมทุก INV เป็นใบเซ็นหนึ่งฉบับ
- เอกสารแจกแจงแต่ละ INV และแสดงยอดรวม
- ถ้ามีรายการส่งเพิ่มหลังพิมพ์ เอกสารเดิมเป็น stale และพิมพ์เวอร์ชันใหม่
- รูปใบเซ็นผูกกับ document version ที่พิมพ์จริง
- ใบเซ็นเครดิตเป็นหลักฐานรับรองยอดขาย ไม่ทำให้ invoice มีสถานะชำระแล้ว

## การทดสอบและเกณฑ์ยอมรับ

### เฟส 1

#### สิทธิ์และ compatibility

- active admin/round lead ผ่าน write helper โดยไม่อ่านค่าสิทธิ์รายคน
- active courier ทุกคนอ่าน current queue ได้; เฉพาะ courier ที่เปิดสิทธิ์เท่านั้นที่ผ่าน write helper; ทุกบทบาทที่ inactive ไม่ผ่านทั้ง read และ write
- migration ให้ courier เดิมทุกคนเป็น `false` สำหรับการบันทึกรับเงิน แต่ยังเปิดดูหน้าและคิวเก็บเงินได้
- v2 save RPC บันทึกสิทธิ์พร้อมโปรไฟล์แบบ atomic; compatibility wrapper เก็บค่าเดิมถูกต้อง
- direct `users` update และ RPC ชั้นล่างไม่สามารถทำให้ non-courier คง capability เป็น `true`; เปลี่ยน courier ออกจากบทบาทแล้วค่าถูกล้างใน transaction เดียวกัน
- profile cache v1 ถูก invalidate และ cache v2 ที่ขาด capability ไม่ผ่าน validator
- client เก่าเรียก save/open RPC ได้โดยไม่ข้ามสิทธิ์หรือเปิดวันอื่น
- payment write paths ทุกชุดบันทึก immutable `recorded_role` จาก server และ client ไม่สามารถปลอมค่านี้

#### Context และ concurrency

- ensure ที่เรียกพร้อมกันหลาย transaction สร้าง open context เพียงรายการเดียวและ audit `auto_opened` ครั้งเดียว
- ensure ปฏิเสธวันอดีต, วันอนาคต และวันปัจจุบันที่ปิดแล้ว
- migration preflight หยุดเมื่อพบ closed run ของวันปัจจุบันที่ยังไม่มี daily closure และไม่สร้าง context ที่สองเงียบๆ
- future-dated context ไม่สามารถใช้ทำให้เครดิตก่อนกำหนดเข้าคิวได้
- payment ที่แข่งกับ daily close ต้องมีผลแบบใดแบบหนึ่งเท่านั้น: payment commit ก่อนแล้ว close ตาม หรือ close ก่อนแล้ว payment ถูกปฏิเสธ; ห้ามมี payment หลัง close commit
- void collection payment ที่แข่งกับ daily close ต้อง commit ก่อน close หรือถูกปฏิเสธ; ห้าม void หลัง close commit
- delivery/stock mutation ที่แข่งกับ daily close ยังถูก serialize ด้วย service-date lock เดิม
- retry daily close ไม่เขียน audit ซ้ำ

#### Queue และ payment

- immediate/end-of-day ค้างเดิม และ credit ที่ถึง/เกินกำหนดเข้าคิวอัตโนมัติ; credit อนาคตไม่เข้าคิว
- สถานะ credit ใช้ due date คำนวณจำนวนวันเกินกำหนดถูกต้อง รวมถึงร้านที่มีบิลผสม
- รับบางส่วนหลายครั้งได้ แต่ละครั้งออก REC ตามยอดจัดสรร และยอดเหลือกลับเข้าคิว
- ร้าน `allow_outstanding = false` รับ collection payment บางส่วนได้โดยไม่ขอ approval; immediate POS ที่รับไม่ครบยังต้องใช้ approval เดิม
- เงินสดมากกว่ายอดค้างเกิดเงินทอนถูกต้อง; โอน/QR ที่มียอดเกินถูกปฏิเสธ
- บิลหลายใบของร้านเดียวจัดสรรตามลำดับที่ queue ส่งมา และ credit บังคับ oldest due first ที่ server
- payment สองรายการที่แข่งกันกับ expected outstanding เดียวกันสำเร็จเพียงรายการเดียว; อีกรายการได้ stale-outstanding error
- retry ด้วย idempotency key เดิมคืน payment เดิม ไม่สร้าง REC, allocation หรือ audit ซ้ำ

#### Privacy, revocation และ UI

- courier สองคนเห็น queue เดียวกันเมื่อทั้งคู่มีสิทธิ์ แต่อ่าน payment, receipt และ history ของกันและกันไม่ได้
- สมาชิกรอบเก่าไม่ทำให้อ่าน payment ของผู้อื่นได้
- ถอนสิทธิ์แล้ว queue, record และ void collection payment ถูกปฏิเสธทันทีที่ server แต่ยังอ่านใบเสร็จเก่าของตนได้
- ถอนสิทธิ์เก็บเงินไม่กระทบการ void immediate POS payment ของตน
- courier ที่ไม่มีสิทธิ์ไม่เห็นแท็บเก็บเงิน; manager เห็นหน้าตามบทบาท
- manager ที่เข้าหน้าลูกหนี้โดยไม่เคยเข้าหน้าเก็บเงินมาก่อน กดรับเงินแล้ว ensure context และบันทึก payment ได้
- ไม่มีข้อความ ปุ่ม หรือ modal เปิด–ปิด/มอบหมายรอบเก็บเงินเหลือใน manager, employee หรือ demo UI

#### Regression

- immediate payment, collection payment, evidence upload/ownership, approval, void, receipt snapshot/printing, correction/refund และ accounting reconciliation ทำงานตามกติกาที่ระบุ
- offline contract/fingerprint tests ผ่านโดยไม่เพิ่ม sync runtime
- ใบเซ็นเครดิตหลาย INV ยังรวมหนึ่งใบต่อร้านต่อวัน และออก version ใหม่เมื่อยอดเปลี่ยน
- รัน database integration tests, UI tests, `npm run test`, `npm run build` และ `npm run build:demo`

### เฟส 2

- เงินสดที่มีเงินทอนใช้ `allocated_amount` เป็นยอดควรส่ง
- เงินโอนและ QR ไม่รวมใน handover; cash payment ของพนักงานอื่นไม่ถูกรวม
- cash payment ที่ manager เป็นผู้รับไม่เข้า courier handover queue แต่ยังอยู่ใน daily reconciliation
- ผู้ใช้ที่รับเงินขณะ `recorded_role = 'courier'` แล้วถูกเปลี่ยนบทบาทหรือ deactivate ยังมียอดใน offboarding handover ถูกคน ขณะที่ payment ซึ่งรับในบทบาท manager ไม่เข้าคิว
- immediate payment ที่แบ่ง allocation ไปหลาย delivery service date ถูกจัด accountable date ตาม Bangkok `recorded_at` เพียงวันเดียวและไม่ถูกนับเต็มยอดซ้ำข้ามวัน
- submit พร้อมกันสอง transaction ไม่สร้าง pending handover สองรายการและไม่ claim payment ซ้ำ
- ขณะมี submitted handover รอตรวจ การ submit ซ้ำถูกปฏิเสธ; หลัง confirm ส่ง payment ชุดใหม่ได้ และหลัง reject payment ชุดเดิมถูก release ให้ส่งใหม่ได้
- ส่วนต่างที่ไม่มีเหตุผลถูกปฏิเสธ
- manager confirm/reject ได้; courier ทำไม่ได้
- manager แก้ `confirmed_amount` และยืนยันได้โดยไม่ต้อง reject กลับให้พนักงาน โดยยอดเดิมยังอยู่ใน `submitted_amount`
- manager ส่งมอบแทนพนักงานทุกสถานะและบันทึก confirmed ได้ใน transaction เดียว
- offboarding flow ส่งมอบยอดของผู้ที่ inactive หรือออกจาก courier แล้วได้ บังคับเหตุผล และผู้ submit ไม่สามารถ review รายการเดียวกัน
- item payment เปลี่ยนก่อน confirm ทำให้รายการ stale และยืนยันไม่ได้; payment ใหม่ที่เข้าหลัง submit ไม่ทำให้ handover เดิม stale
- confirm ที่แข่งกับ void มีผลได้เพียงสองแบบ: void มาก่อนแล้ว confirm ถูกปฏิเสธเพราะ stale หรือ confirm มาก่อนแล้ว void ปรากฏเป็น post-confirm correction
- confirmed handover คง snapshot เดิมเมื่อเกิด void/refund ภายหลัง
- retry submit/review ด้วย key/fingerprint เดิมไม่สร้างรายการหรือ audit ซ้ำ; key เดิมกับ payload ต่างกันถูกปฏิเสธ
- ส่ง/review หลัง daily stock close ได้สำหรับวันปัจจุบันหรืออดีต; วันอนาคตถูกปฏิเสธ
- ก่อนเปิดเฟส 2 รันคำนวณแบบ dark-launch ด้วย candidate day boundary แยก `recorded_by` + `recorded_role` เทียบ dashboard เดิมอย่างน้อยหนึ่งวันเต็ม โดยผลต่างต้องเป็นศูนย์; หลังตั้ง cutover จริงแล้วไม่มี payment ก่อน cutover เข้า automated handover

## ลำดับการ rollout

1. รัน preflight และ deploy migration หลัง daily close หรือก่อนมี collection payment ของวันใหม่; ออก migration สิทธิ์/helper/context/authorization/lock พร้อม database integration tests
2. deploy frontend ที่ใช้ profile cache v2, admin permission editor และ automatic context UI
3. ยืนยันว่า client เก่าไม่สามารถข้ามสิทธิ์, เปิด context วันอื่น หรือปิด shared context ก่อน daily close
4. เปิดสิทธิ์บันทึกรับเงินให้ courier ที่ได้รับมอบหมายหลัง admin ตรวจรายชื่อ; courier ที่ยังไม่เปิดสิทธิ์ยังเข้าดูหน้าและคิวได้
5. ออกเฟส 2 แบบ dark launch: deploy schema และ read-only validation query/summary ที่รับ candidate day boundary แต่ยังไม่ตั้ง live cutover หรือเปิด submit/review UI; เปรียบเทียบยอดแยก `recorded_by` + `recorded_role` กับ dashboard อย่างน้อยหนึ่งวันเต็ม
6. เมื่อ dark-launch delta เป็นศูนย์ ให้ปิดยอดก่อนเฟส 2 ด้วยกระบวนการเดิมหลัง daily close, ตั้ง `cash_handover_cutover_at` เป็นเวลาเริ่มวัน Bangkok ถัดไป และบันทึกค่า/audit ใน migration/config
7. เปิด submit/review UI เมื่อเฟส 1 ผ่านเกณฑ์ยอมรับ, dark-launch delta เป็นศูนย์ และ concurrency/offboarding tests ผ่าน

## สิ่งที่ไม่ทำในงานนี้

- ไม่ลบรอบส่งสินค้า รอบสต๊อก daily close หรือ internal `collection_runs`
- ไม่เปิดให้รับชำระย้อนหลังหรือล่วงหน้าผ่าน shared-context RPC; หากต้องการในอนาคตให้ออก admin-only flow แยกพร้อม audit และ reconciliation policy
- ไม่เชื่อมตรวจสอบยอดโอนกับธนาคารหรือ Dynamic QR
- ไม่ลบตารางและคอลัมน์ legacy ที่อ้างถึง `collection_runs`
- ไม่เปลี่ยนใบเซ็นเครดิตให้เป็นใบเสร็จหรือหลักฐานชำระเงิน
- ไม่เปิดให้ client เลือกหรือแก้ผู้รับเงินย้อนหลัง
- ไม่สร้าง offline runtime/adapter ใหม่ในเฟส 1
