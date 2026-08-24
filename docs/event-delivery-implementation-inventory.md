# Event delivery implementation inventory — Slice A

สถานะ: compatibility + core round-writer lock refactor เสร็จแล้ว; ยังไม่มี event job, participation หรือ event stop ที่ใช้งานได้

เอกสารนี้เป็น inventory ตาม Slice A ข้อ 1 ของแผนหลัก เพื่อระบุ code owner และ contract ที่ต้องคงไว้ก่อนเปิด event write

สถานะ contract ใช้คำต่อไปนี้:

- **fenced now** — migration `0157` บังคับแล้วและมี behavioral test
- **shared ledger** — ต้องรวม event เพราะเป็นยอดสต๊อก/การเงินจริงชุดเดียว
- **before event stops** — ต้องแก้ก่อน RPC ใดสร้าง event stop
- **before event charges** — ต้องแก้ก่อน RPC ใดสร้าง event delivery/charge/payment
- **Slice B** — แก้พร้อม `customer_kind = event_only`; ห้ามทำ nullable แยก release

| พื้นที่ / symbol | Code owner ล่าสุด | Contract เมื่อมี event destination | สถานะ |
| --- | --- | --- | --- |
| `round_stops` columns, partial unique, destination CHECK | `supabase/migrations/0157_event_destination_compatibility_fence.sql` | stop เดิม backfill เป็น `regular`; event ต้องมี participation; ยังไม่อนุญาต lifecycle write | fenced now |
| `round_stops` RLS, `is_round_member`, `is_delivery_event_visible` | `supabase/migrations/0001_phase_1_foundation.sql` | สมาชิกในรอบอ่าน row ได้; direct insert/update ไม่มี policy; event RPC ต้องตรวจ lifecycle เพิ่มเอง | ตรวจแล้ว; เพิ่ม event authorization ก่อน event stops |
| `sync_daily_round_active_shops` | `0147_live_daily_round_shops.sql` → `0157_event_destination_compatibility_fence.sql` | เพิ่มเฉพาะ `regular`, ใช้ partial `ON CONFLICT`, lock service date → round | fenced now |
| `get_round_shop_cards` | `0129_effective_charge_projections.sql` → `0157_event_destination_compatibility_fence.sql` | cards, same-day history และ totals ต้องเป็น `regular` เท่านั้น | fenced now |
| `get_delivery_pos_context`, `record_delivery` | `0030_pos_delivery_transactions.sql`, dynamic patches `0107`, `0140`, `0148` → `0157` | ปฏิเสธ event stop; writer lock idempotency → service date → round | fenced now |
| `record_immediate_sale` | `0134_monthly_sales_documents_and_atomic_immediate_sales.sql` → `0157` | ปฏิเสธ event stop; event payment ใช้ RPC ใหม่ | fenced now |
| `get_delivery_correction_context`, `preview_delivery_correction`, `apply_open_delivery_correction`, `create_closed_delivery_adjustment` | `0128_delivery_corrections_refunds_and_adjustments.sql`, `0131_delivery_correction_hardening_and_refund_summary.sql` → `0157` | ปฏิเสธ event delivery; event correction ใช้ RPC ใหม่; writer ต้องเข้า global lock-order migration ก่อนเปิด event write | fenced now; lock refactor before event writes |
| `get_manager_delivery_events`, `revise_delivery_event` และ `ManagerDeliveryAdjustments.tsx` | `0008_complete_manager_operations.sql`, `0030_pos_delivery_transactions.sql`, `src/ManagerDeliveryAdjustments.tsx` → `0157` | legacy manager list เห็นเฉพาะ regular และ legacy revision ปฏิเสธ event; revision writer ต้องเข้า global lock-order migration | fenced now; lock refactor before event writes |
| `get_round_control_summary`, `close_delivery_round`, `round_close_summaries` | `0004_manager_round_control.sql`, `0026_round_stock_snapshots.sql` → `0157` | close ยังคงไม่บล็อก pending event; ต้องแยก regular/event counts ก่อนสร้าง event stop; lock service date → round | lock fenced now; count split before event stops |
| `delivery_round_cancellation_blockers`, `get_delivery_round_cancellation_state`, `cancel_delivery_round` | `0027_cancel_delivery_round.sql` | event delivery/charge เป็น blocker ตาม ledger เดิม; tank ค้างไม่เป็น blocker | ตรวจ logic ก่อน event stops |
| `daily_work_session_cancellation_blockers`, `get_daily_work_dashboard`, `cancel_daily_work_session` | `0043_daily_work_dashboard_and_cancellation.sql` | dashboard ต้องแยก regular/event counts แต่ sales รวม shared ledger; cancellation เห็น event activity เป็น blocker | before event stops / charges |
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
| Employee regular client | `src/EmployeeDeliveryWorkspace.tsx` | ใช้ legacy sync/cards/POS ต่อและไม่เห็น event destination | fenced now |
| Manager legacy correction client | `src/ManagerDeliveryAdjustments.tsx` | ใช้ legacy manager list/revision ต่อและไม่เห็นหรือแก้ event delivery | fenced now |
| Offline v1 contract and ledger | `0148_employee_offline_contract_v1.sql`, `0149_employee_offline_ledger_schema.sql`, `src/offline/contracts.ts` | ไม่เปลี่ยน command/signature/fingerprint; replay ที่รู้ event UUID ต้องถูก database fence ปฏิเสธ | fenced now; event offline เป็น v2 |

## Milestone ที่ deploy ได้

- `round_stops` มี `destination_kind`, `event_participation_id`, operational flag และ event snapshot fields แบบ additive
- unique เดิม `(round_id, shop_id)` ถูกแทนด้วย partial unique ของ `regular` และ `event`
- legacy readers/writers มี database fence จึงไม่พึ่ง client ซ่อนข้อมูล
- sync, regular delivery และ round close ใช้ lock order `service date → round`; daily aggregate close ใช้ order นี้อยู่แล้ว; correction writers ถูกระบุเป็น gate แยกก่อน event writes
- ยังไม่สร้าง foreign key จาก `event_participation_id` เพราะ lifecycle schema จะถูกเพิ่มใน migration ถัดไปใน transaction เดียวกัน

## งานถัดไป

ก่อนสร้าง event stop ให้ปิดรายการสถานะ **before event stops** ด้านบน โดยเฉพาะ count split ของ round/dashboard จากนั้นเพิ่ม `event_jobs`/`event_participations`, lifecycle + publish validation, capability RPC และ event read model โดยรักษา fence นี้ไว้ตลอด rollout
