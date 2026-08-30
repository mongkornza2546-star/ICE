# Event delivery implementation inventory — Slice A

สถานะ implementation: compatibility + core round-writer lock refactor + event lifecycle + event cards + destination sync เสร็จแล้ว; activation migration พร้อม แต่ event ice/tank writers ยังปิด

สถานะ deployment ที่ยืนยันล่าสุด: ใช้ถึง `0165`; ต้อง apply `0166` → deploy schema-v3 fallback-capable client → apply `0167` ก่อน event stops จึงจะเปิด

เอกสารนี้เป็น inventory ตาม Slice A ข้อ 1 ของแผนหลัก เพื่อระบุ code owner และ contract ที่ต้องคงไว้ก่อนเปิด event write

สถานะ contract ใช้คำต่อไปนี้:

- **fenced now** — migration `0157` บังคับแล้วและมี behavioral test
- **shared ledger** — ต้องรวม event เพราะเป็นยอดสต๊อก/การเงินจริงชุดเดียว
- **before event stops** — ต้องแก้ก่อน RPC ใดสร้าง event stop
- **before event charges** — ต้องแก้ก่อน RPC ใดสร้าง event delivery/charge/payment
- **Slice B** — แก้พร้อม `customer_kind = event_only`; ห้ามทำ nullable แยก release

| พื้นที่ / symbol | Code owner ล่าสุด | Contract เมื่อมี event destination | สถานะ |
| --- | --- | --- | --- |
| `round_stops` columns, partial unique, destination CHECK | `supabase/migrations/0157_event_destination_compatibility_fence.sql` | stop เดิม backfill เป็น `regular`; event ต้องมี participation; event insert ผ่าน destination sync เท่านั้น | fenced; activation pending |
| `round_stops` destination/snapshot immutability | `0166_event_destination_sync_dark_launch.sql` | database `BEFORE UPDATE` trigger reject การเปลี่ยน destination identity และ shop/event snapshots ของ stop เดิม โดยยังอนุญาต workflow fields | enforced before activation |
| `event_jobs`, config versions, `event_participations`, lifecycle RPCs | `supabase/migrations/0163_event_lifecycle_foundation.sql` | ต้องผ่าน structural preflight ของ `0157` ก่อน; round lead/admin จัดการ metadata, participation, publish/cancel; admin จัดการ settlement config; cancellation lock job → participation; publish ตรวจ 2–50 ร้าน ข้อมูลติดต่อ ราคากลาง และ snapshot policy แบบ immutable | lifecycle complete; ice/tank flags off |
| `get_event_delivery_capability`, `get_event_delivery_cards` และ event feature settings | `0163_event_lifecycle_foundation.sql` → `0165_event_read_models_and_destination_counts.sql` → `0166`/`0167` | schema version 3 รองรับ destination sync; event cards ใช้ stop snapshot เมื่อมีและแยก today history ตาม participation/date; `0167` เปิดเฉพาะ event-stop flag ส่วน ice/tank ยังปิด | implementation ready; deployment pending |
| `round_stops` RLS, `is_round_member`, `is_delivery_event_visible` | `supabase/migrations/0001_phase_1_foundation.sql` | สมาชิกในรอบอ่าน row ได้; direct insert/update ไม่มี policy; destination sync ตรวจ active caller + admin/lead หรือ membership และ recheck lifecycle หลัง lock | stop authorization complete; delivery authorization next |
| `sync_daily_round_active_shops` | `0147_live_daily_round_shops.sql` → `0157_event_destination_compatibility_fence.sql` | เพิ่มเฉพาะ `regular`, ใช้ partial `ON CONFLICT`, lock service date → round | fenced now |
| `get_employee_active_session`, late-member bootstrap | `0042_daily_work_session_architecture.sql` → `0166_event_destination_sync_dark_launch.sql` | ใช้ service-date advisory lock → daily round row ก่อนเพิ่มเฉพาะ active caller role courier/round lead/admin แบบ idempotent แล้วจึง filter session; ไม่รับ round id จาก client | complete; close race tested |
| `sync_daily_round_destinations` | `0166_event_destination_sync_dark_launch.sql` → `0167_enable_event_destination_stops.sql` | service date → round → union ของ jobs/participations ที่ eligible หรือมี stop เดิม เรียง UUID; refresh roster + regular stops เสมอ; event mutation gated ที่ server; snapshot immutable; stale event stop เปลี่ยนเฉพาะ `is_operational` | ready; activation pending; two-connection races tested |
| `get_round_shop_cards` | `0129_effective_charge_projections.sql` → `0157_event_destination_compatibility_fence.sql` | cards, same-day history และ totals ต้องเป็น `regular` เท่านั้น | fenced now |
| `get_delivery_pos_context`, `record_delivery` | `0030_pos_delivery_transactions.sql`, dynamic patches `0107`, `0140`, `0148` → `0157` | ปฏิเสธ event stop; writer lock idempotency → service date → round | fenced now |
| `record_immediate_sale` | `0134_monthly_sales_documents_and_atomic_immediate_sales.sql` → `0157` | ปฏิเสธ event stop; event payment ใช้ RPC ใหม่ | fenced now |
| `get_delivery_correction_context`, `preview_delivery_correction`, `apply_open_delivery_correction`, `create_closed_delivery_adjustment` | `0128_delivery_corrections_refunds_and_adjustments.sql`, `0131_delivery_correction_hardening_and_refund_summary.sql` → `0157` | ปฏิเสธ event delivery; event correction ใช้ RPC ใหม่; writer ต้องเข้า global lock-order migration ก่อนเปิด event write | fenced now; lock refactor before event writes |
| `get_manager_delivery_events`, `revise_delivery_event` และ `ManagerDeliveryAdjustments.tsx` | `0008_complete_manager_operations.sql`, `0030_pos_delivery_transactions.sql`, `src/ManagerDeliveryAdjustments.tsx` → `0157` | legacy manager list เห็นเฉพาะ regular และ legacy revision ปฏิเสธ event; revision writer ต้องเข้า global lock-order migration | fenced now; lock refactor before event writes |
| `get_round_control_summary`, `close_delivery_round`, `round_close_summaries` | `0004_manager_round_control.sql`, `0026_round_stock_snapshots.sql` → `0157` → `0165` | close ยังคงไม่บล็อก pending event; live และ close snapshot แยก regular/event counts; trigger กลางครอบคลุม close writer เดิมทุกเส้นทาง; lock service date → round | count split complete before event stops |
| `delivery_round_cancellation_blockers`, `get_delivery_round_cancellation_state`, `cancel_delivery_round` | `0027_cancel_delivery_round.sql` → contract test `0165` | event delivery เป็น blocker ผ่าน shared delivery ledger; pending event stop ไม่เป็น blocker; ถังค้างไม่เป็น blocker | contract verified before event stops |
| `daily_work_session_cancellation_blockers`, `get_daily_work_dashboard`, `cancel_daily_work_session` | `0043_daily_work_dashboard_and_cancellation.sql` → `0165` | dashboard แยก regular shop กับ event participation counts แต่ sales รวม shared ledger; cancellation เห็น event delivery/non-pending stop และไม่ดูถังค้าง | count split + cancellation contract complete before event stops |
| `round_ice_reconciliation`, `stock_balance_at`, `stock_balance_at_moment` | `0001`, `0026`, `0103`, `0104`, `0107` | event ice movement รวมใน stock ledger เดิม; ห้าม filter destination ออกจากยอดสต๊อก | shared ledger |
| `daily_aggregate_stock_balance_at`, `get_daily_aggregate_stock_summary`, `close_daily_aggregate_stock` | `0107_daily_aggregate_stock.sql`, `0129`, `0154` | event ice รวมยอดขาย/คงเหลือ; close ใช้ idempotency → service date ก่อน update round และไม่ถูกถังค้างบล็อก | shared ledger; lock order verified |
| `reject_closed_service_day`, `enforce_admin_backdated_delivery` | `0008_complete_manager_operations.sql`, `0106_admin_backdated_billing.sql` | event delivery ต้องถูก closed-day/backdate rules เหมือน ice delivery ปกติ | reuse trigger; add event-writer tests |
| `delivery_financial_response`, `effective_delivery_charge_amount`, charge/allocation integrity triggers | `0030`, `0128`, `0129`, `0134` | ice event ใช้ charge ledger เดิม; tank ขยาย canonical source ภายหลังโดยไม่ปลอม delivery event | before event charges / Slice C |
| `record_payment`, `financial_payment_response`, payment allocation triggers | `0029_pos_financial_foundation.sql` ถึง `0134` | legacy payment reject event charge; event RPC derive participation/date/policy และ deferred check allocation context | before event charges |
| `get_collection_run_queue`, `get_today_collection_run_queue`, credit receivable RPCs | `0108`–`0129` | regular grouping เดิมคงไว้; event grouping ใช้ participation + service date และห้ามผสม context | before event charges |
| INV/REC builders และ snapshot readers (`build_delivery_charge_document_snapshot`, `build_payment_receipt_snapshot`, `get_payment_receipt_items`) | `0124`, `0134` | INV ต่อ charge; REC รวม event charges เฉพาะ participation/date เดียว; อ่าน normalized line model | before event charges; tank line ใน Slice C |
| `get_shop_purchase_history`, credit bill detail | `0119`, `0127`, `0129` | customer-wide history รวม event ได้แต่ต้องติด destination/participation label; regular card ห้าม reuse query นี้เป็น booth total | before event charges |
| accounting reconciliation/transactions/review | `0136_accounting_read_model.sql`, `0139_accounting_reconciliation_hardening.sql` | รวม event charges ใน shared ledger และ expose destination/charge kind | before event charges |
| accounting shop summary/daily matrix | `0143_accounting_shop_summary.sql`–`0146_accounting_shop_daily_matrix.sql` | regular และ event-only customer แยก location semantics; totals รวม charge จริง | ice event before charges; nullable location ใน Slice B |
| casual transaction stock projections | `0153_casual_transaction_foundation.sql`–`0155_casual_loose_transactions.sql` | event ice ต้องรวมใน available stock เหมือน delivery อื่น; casual RPC ไม่รับ event participation | shared ledger regression |
| `ensure_building_stock_location`, `assign_shop_stock_location`, `sync_shop_location_from_zone` | `0007`, `0016`, shop triggers | branch ตาม `customer_kind`; ห้ามสร้าง building stock location ให้ event-only | Slice B, migration เดียวกับ nullable location |
| `save_shop`, `import_shop_catalog`, `deactivate_shop` | `0006`, `0099`, `0135` | save/import ใช้ customer-kind-aware module; deactivate block เมื่อ event tank ค้าง | Slice B / Slice C |
| Employee regular client | `src/EmployeeDeliveryWorkspace.tsx` | schema version 3 ใช้ destination sync; schema version 2/error fallback ไป legacy sync; regular cards/POS ยังไม่เห็น event destination | rollout-safe caller; legacy reads fenced |
| Manager legacy correction client | `src/ManagerDeliveryAdjustments.tsx` | ใช้ legacy manager list/revision ต่อและไม่เห็นหรือแก้ event delivery | fenced now |
| Offline v1 contract and ledger | `0148_employee_offline_contract_v1.sql`, `0149_employee_offline_ledger_schema.sql`, `src/offline/contracts.ts` | ไม่เปลี่ยน command/signature/fingerprint; replay ที่รู้ event UUID ต้องถูก database fence ปฏิเสธ | fenced now; event offline เป็น v2 |

## Milestone ที่ deploy ได้

- `round_stops` มี `destination_kind`, `event_participation_id`, operational flag และ event snapshot fields แบบ additive
- unique เดิม `(round_id, shop_id)` ถูกแทนด้วย partial unique ของ `regular` และ `event`
- legacy readers/writers มี database fence จึงไม่พึ่ง client ซ่อนข้อมูล
- sync, regular delivery และ round close ใช้ lock order `service date → round`; daily aggregate close ใช้ order นี้อยู่แล้ว; correction writers ถูกระบุเป็น gate แยกก่อน event writes
- มี `event_jobs`, immutable config versions, `event_participations`, lifecycle audit และ publish readiness แล้ว
- `get_employee_active_session` ปิด late-member discovery race ด้วย service-date → round lock ก่อน bootstrap membership
- `sync_daily_round_destinations` refresh roster/regular stops เสมอ และ mutate event stops เฉพาะเมื่อ server flag เปิด โดย lock union ของ eligible และ existing-stop lifecycle rows ตาม UUID
- `round_stops` บังคับ destination identity และ snapshot immutability ด้วย `BEFORE UPDATE` trigger; cancellation/date ineligibility เปลี่ยนเฉพาะ `is_operational`
- schema version 3 และ client caller rollout แบบ fallback พร้อมแล้ว; `0167` เปิดเฉพาะ event-stop flag ส่วน event ice/tank ยังปิด
- round control, round close snapshot และ daily dashboard แยกจำนวนร้านประจำกับ event participation โดยคง aggregate field เดิมเพื่อ compatibility
- `get_event_delivery_cards` เปิด read-only สำหรับสมาชิก daily round, ค้นหาแบบ normalize และใช้ `event_participation_id + service_date` แยก history/total; schema version 3 รองรับ destination sync และ `0167` จึงเปิด stops โดย ice/tank ยังปิด
- cancellation contract ยืนยันว่า event delivery/non-pending stop เป็น blocker ผ่าน ledger เดิม ส่วน pending event stop และถังค้างไม่ขวางการยกเลิกรอบ/วัน
- PostgreSQL จริงสอง connection โหลด function definitions จาก migration owners โดยตรงและครอบคลุม late-member bootstrap, sync vs round close/daily close, cancellation และ participation date expansion ทั้งสอง commit orders

## งานถัดไป

งานถัดไปคือเพิ่ม event-aware ice delivery writer/DTO โดย derive participation จาก `round_stop_id`, recheck round/job/participation หลัง lock, ใช้ standard price + shared stock/charge ledger และปิด correction/payment gaps ที่ inventory ระบุ ก่อนเปิด `event_ice_delivery_enabled`; ยังไม่เปิด tank writer
