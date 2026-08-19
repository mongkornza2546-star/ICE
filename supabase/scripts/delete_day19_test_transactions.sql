-- ============================================================
-- DELETE TEST TRANSACTIONS FOR 19 AUGUST 2026 (2026-08-19)
--
-- ลบเฉพาะข้อมูลธุรกรรมของ service_date วันที่ 19 สิงหาคม 2569
-- เก็บข้อมูล master/config เช่น users, shops, routes, ice_types,
-- prices, stock_locations และ assignments ไว้ทั้งหมด
--
-- วิธีใช้:
--   1. รัน STEP 1 เพื่อดูจำนวนรายการและ path ไฟล์หลักฐานก่อน
--   2. ใน STEP 2 เอา -- หน้า SET LOCAL ออก แล้วรันทั้ง transaction
--   3. รอบแรกคง ROLLBACK ไว้และตรวจ STEP 3
--   4. เมื่อผลถูกต้อง เปลี่ยน ROLLBACK ท้ายไฟล์เป็น COMMIT แล้วรันใหม่
--
-- หมายเหตุ: สคริปต์นี้ไม่ลบไฟล์จริงใน Supabase Storage
-- ============================================================

-- ============================================================
-- STEP 1: PREVIEW (safe, read-only)
-- ============================================================

select 'delivery rounds' as data_group, count(*) as row_count
from public.delivery_rounds where service_date = date '2026-08-19'
union all
select 'delivery events / sales', count(*)
from public.delivery_events event
join public.round_stops stop on stop.id = event.round_stop_id
join public.delivery_rounds round_ on round_.id = stop.round_id
where round_.service_date = date '2026-08-19'
union all
select 'delivery charges / bills', count(*)
from public.delivery_charges where service_date = date '2026-08-19'
union all
select 'collection runs', count(*)
from public.collection_runs where service_date = date '2026-08-19'
union all
select 'payments / receipts', count(*)
from public.payments payment
left join public.collection_runs run on run.id = payment.collection_run_id
where run.service_date = date '2026-08-19'
   or (
     payment.collection_run_id is null
     and exists (
       select 1
       from public.payment_allocations allocation
       join public.delivery_charges charge on charge.id = allocation.charge_id
       where allocation.payment_id = payment.id
         and charge.service_date = date '2026-08-19'
     )
   )
union all
select 'stock movements', count(*)
from public.stock_movements where service_date = date '2026-08-19'
union all
select 'factory receipts', count(*)
from public.factory_receipts where service_date = date '2026-08-19'
union all
select 'stock counts', count(*)
from public.stock_count_snapshots where service_date = date '2026-08-19'
union all
select 'daily aggregate stock uses', count(*)
from public.daily_stock_uses where service_date = date '2026-08-19'
union all
select 'daily credit acknowledgements', count(*)
from public.daily_credit_acknowledgements where service_date = date '2026-08-19'
union all
select 'offline commands', count(*)
from public.employee_offline_commands where service_date = date '2026-08-19'
union all
select 'offline sync issues', count(*)
from public.offline_sync_issues where service_date = date '2026-08-19'
order by data_group;

-- จด path เหล่านี้ไว้หากต้องการลบไฟล์หลักฐานออกจาก Storage ภายหลัง
select
  'credit-signoff-evidence' as bucket_id,
  evidence.storage_path
from public.daily_credit_acknowledgement_evidence evidence
join public.daily_credit_acknowledgements acknowledgement
  on acknowledgement.id = evidence.acknowledgement_id
where acknowledgement.service_date = date '2026-08-19'
union all
select
  'payment-evidence' as bucket_id,
  payment.evidence_path as storage_path
from public.payments payment
left join public.collection_runs run on run.id = payment.collection_run_id
where payment.evidence_path is not null
  and (
    run.service_date = date '2026-08-19'
    or (
      payment.collection_run_id is null
      and exists (
        select 1
        from public.payment_allocations allocation
        join public.delivery_charges charge on charge.id = allocation.charge_id
        where allocation.payment_id = payment.id
          and charge.service_date = date '2026-08-19'
      )
    )
  )
order by bucket_id, storage_path;


-- ============================================================
-- STEP 2: DELETE (ค่าเริ่มต้นยังไม่ยืนยันและจบด้วย ROLLBACK)
-- ============================================================

begin;

-- เอา -- ออกเพื่อยืนยันว่าตั้งใจลบเฉพาะวันที่นี้
-- set local app.confirm_delete_test_date = 'DELETE TEST DATA 2026-08-19';

do $$
begin
  if current_setting('app.confirm_delete_test_date', true)
      is distinct from 'DELETE TEST DATA 2026-08-19' then
    raise exception
      'Delete cancelled. Uncomment the SET LOCAL confirmation line first.';
  end if;
end;
$$;

-- เก็บ ID ก่อนลบ เพื่อใช้ไล่ FK และลบ audit log อย่างเจาะจง
create temp table _day19_rounds on commit drop as
select id from public.delivery_rounds
where service_date = date '2026-08-19';
alter table _day19_rounds add primary key (id);

create temp table _day19_stops on commit drop as
select stop.id
from public.round_stops stop
join _day19_rounds target on target.id = stop.round_id;
alter table _day19_stops add primary key (id);

create temp table _day19_events on commit drop as
select event.id
from public.delivery_events event
join _day19_stops target on target.id = event.round_stop_id;
alter table _day19_events add primary key (id);

create temp table _day19_charges on commit drop as
select charge.id
from public.delivery_charges charge
where charge.service_date = date '2026-08-19'
   or exists (
     select 1 from _day19_events target where target.id = charge.delivery_event_id
   );
alter table _day19_charges add primary key (id);

-- service_date ของ charge และรอบส่งต้องชี้มาที่วันเดียวกัน
do $$
begin
  if exists (
    select 1
    from public.delivery_charges charge
    join _day19_charges target on target.id = charge.id
    left join _day19_events event on event.id = charge.delivery_event_id
    where event.id is null
  ) then
    raise exception
      'Delete cancelled: a 2026-08-19 charge points to a delivery event outside the target date.';
  end if;
end;
$$;

create temp table _day19_collection_runs on commit drop as
select id from public.collection_runs
where service_date = date '2026-08-19';
alter table _day19_collection_runs add primary key (id);

-- Payment ของรอบเก็บเงินวันที่ 19 หรือ payment หน้างานที่เป็นส่วนหนึ่งของบิลวันที่ 19
create temp table _day19_payments on commit drop as
select distinct payment.id
from public.payments payment
left join _day19_collection_runs run on run.id = payment.collection_run_id
where run.id is not null
   or (
     payment.collection_run_id is null
     and exists (
       select 1
       from public.payment_allocations allocation
       join _day19_charges charge on charge.id = allocation.charge_id
       where allocation.payment_id = payment.id
     )
   );
alter table _day19_payments add primary key (id);

-- หยุดทันทีถ้าบิลวันที่ 19 ถูกจ่ายด้วย payment ของวันอื่น
-- เพื่อไม่ให้สคริปต์ขยายขอบเขตไปลบธุรกรรมข้ามวันโดยเงียบ ๆ
do $$
begin
  if exists (
    select 1
    from public.payment_allocations allocation
    join _day19_charges charge on charge.id = allocation.charge_id
    left join _day19_payments payment on payment.id = allocation.payment_id
    where payment.id is null
  ) then
    raise exception
      'Delete cancelled: a 2026-08-19 charge has a payment outside the target date.';
  end if;
end;
$$;

create temp table _day19_approvals on commit drop as
select approval.id
from public.financial_approval_requests approval
where exists (
    select 1 from _day19_stops target where target.id = approval.round_stop_id
  )
  or exists (
    select 1 from _day19_events target
    where target.id = approval.consumed_by_delivery_event_id
  )
  or exists (
    select 1 from _day19_payments target
    where target.id = approval.consumed_by_payment_id
  )
  or exists (
    select 1
    from public.delivery_charges charge
    join _day19_charges target on target.id = charge.id
    where charge.approval_request_id = approval.id
  )
  or exists (
    select 1
    from public.payments payment
    join _day19_payments target on target.id = payment.id
    where payment.approval_request_id = approval.id
  );
alter table _day19_approvals add primary key (id);

-- Approval เป้าหมายต้องไม่ถูกอ้างจาก charge/payment นอกวันที่ 19
do $$
begin
  if exists (
    select 1
    from public.delivery_charges charge
    join _day19_approvals approval on approval.id = charge.approval_request_id
    left join _day19_charges target on target.id = charge.id
    where target.id is null
  ) or exists (
    select 1
    from public.payments payment
    join _day19_approvals approval on approval.id = payment.approval_request_id
    left join _day19_payments target on target.id = payment.id
    where target.id is null
  ) then
    raise exception
      'Delete cancelled: a target approval is referenced outside 2026-08-19.';
  end if;
end;
$$;

create temp table _day19_movements on commit drop as
select movement.id
from public.stock_movements movement
where movement.service_date = date '2026-08-19'
   or exists (
     select 1 from _day19_rounds target where target.id = movement.round_id
   );
alter table _day19_movements add primary key (id);

create temp table _day19_receipts on commit drop as
select receipt.id
from public.factory_receipts receipt
where receipt.service_date = date '2026-08-19'
   or exists (
     select 1 from _day19_movements target
     where target.id = receipt.factory_order_id
   );
alter table _day19_receipts add primary key (id);

create temp table _day19_counts on commit drop as
select snapshot.id
from public.stock_count_snapshots snapshot
where snapshot.service_date = date '2026-08-19'
   or exists (
     select 1 from _day19_rounds target where target.id = snapshot.round_id
   );
alter table _day19_counts add primary key (id);

create temp table _day19_stock_uses on commit drop as
select id from public.daily_stock_uses
where service_date = date '2026-08-19';
alter table _day19_stock_uses add primary key (id);

create temp table _day19_acknowledgements on commit drop as
select id from public.daily_credit_acknowledgements
where service_date = date '2026-08-19';
alter table _day19_acknowledgements add primary key (id);

create temp table _day19_ack_evidence on commit drop as
select evidence.id
from public.daily_credit_acknowledgement_evidence evidence
join _day19_acknowledgements target
  on target.id = evidence.acknowledgement_id;
alter table _day19_ack_evidence add primary key (id);

create temp table _day19_offline_commands on commit drop as
select command_id as id from public.employee_offline_commands
where service_date = date '2026-08-19';
alter table _day19_offline_commands add primary key (id);

create temp table _day19_offline_issues on commit drop as
select issue.id
from public.offline_sync_issues issue
where issue.service_date = date '2026-08-19'
   or exists (
     select 1 from _day19_offline_commands target
     where target.id = issue.command_id
   );
alter table _day19_offline_issues add primary key (id);

-- ตาราง immutable/append-only ต้องปิดเฉพาะ application trigger ชั่วคราว
-- FK constraints ยังคงทำงานตามปกติ
alter table public.daily_credit_acknowledgement_evidence
  disable trigger daily_credit_acknowledgement_evidence_immutable;
alter table public.daily_credit_acknowledgements
  disable trigger daily_credit_acknowledgements_immutable;
alter table public.payment_receipt_snapshots
  disable trigger payment_receipt_snapshots_immutable;
alter table public.delivery_charge_document_snapshots
  disable trigger delivery_charge_document_snapshots_immutable;
alter table public.payment_allocation_changes
  disable trigger payment_allocation_changes_append_only;
alter table public.refund_settlements
  disable trigger refund_settlements_append_only;
alter table public.delivery_adjustment_items
  disable trigger delivery_adjustment_items_append_only;
alter table public.offline_sync_issue_decisions
  disable trigger offline_sync_issue_decisions_append_only;
alter table public.employee_offline_commands
  disable trigger employee_offline_commands_state_guard;

-- เอกสารรับทราบเครดิตรายวัน
delete from public.daily_credit_acknowledgement_evidence evidence
where exists (
  select 1 from _day19_acknowledgements target
  where target.id = evidence.acknowledgement_id
);

delete from public.daily_credit_acknowledgements acknowledgement
where exists (
  select 1 from _day19_acknowledgements target
  where target.id = acknowledgement.id
);

-- Offline ledger มี FK วนระหว่าง command/issue จึงคืน command เป็น received
-- ชั่วคราวก่อนลบ ทั้งหมดนี้อยู่ใน transaction เดียวกัน
update public.employee_offline_commands command
set status = 'received',
    result = null,
    issue_id = null,
    resolution_version = 0,
    applied_at = null
where exists (
  select 1 from _day19_offline_commands target
  where target.id = command.command_id
);

delete from public.offline_sync_issue_decisions decision
where exists (
  select 1 from _day19_offline_issues target
  where target.id = decision.issue_id
);

delete from public.offline_sync_issues issue
where exists (
  select 1 from _day19_offline_issues target where target.id = issue.id
);

delete from public.employee_offline_commands command
where exists (
  select 1 from _day19_offline_commands target where target.id = command.command_id
);

-- ประวัติแก้ไขยอด การคืนเงิน และเอกสาร immutable
delete from public.delivery_adjustment_items item
where exists (
  select 1
  from public.delivery_charge_adjustments adjustment
  join _day19_charges charge on charge.id = adjustment.charge_id
  where adjustment.idempotency_key = item.adjustment_id
);

delete from public.payment_allocation_changes change
where exists (
    select 1 from _day19_payments target where target.id = change.payment_id
  )
  or exists (
    select 1 from _day19_charges target where target.id = change.from_charge_id
  )
  or exists (
    select 1 from _day19_charges target where target.id = change.to_charge_id
  );

delete from public.refund_settlements settlement
where exists (
  select 1
  from public.refund_obligations obligation
  where obligation.id = settlement.obligation_id
    and (
      exists (select 1 from _day19_payments target where target.id = obligation.payment_id)
      or exists (select 1 from _day19_charges target where target.id = obligation.source_charge_id)
    )
);

delete from public.refund_obligations obligation
where exists (
    select 1 from _day19_payments target where target.id = obligation.payment_id
  )
  or exists (
    select 1 from _day19_charges target where target.id = obligation.source_charge_id
  );

delete from public.delivery_charge_adjustments adjustment
where exists (
  select 1 from _day19_charges target where target.id = adjustment.charge_id
);

delete from public.payment_receipt_snapshots snapshot
where exists (
  select 1 from _day19_payments target where target.id = snapshot.payment_id
);

delete from public.delivery_charge_document_snapshots snapshot
where exists (
  select 1 from _day19_charges target where target.id = snapshot.charge_id
);

delete from public.credit_due_date_requests request
where exists (
  select 1 from _day19_charges target where target.id = request.charge_id
);

delete from public.collection_run_credit_charges assignment
where exists (
    select 1 from _day19_collection_runs target
    where target.id = assignment.collection_run_id
  )
  or exists (
    select 1 from _day19_charges target where target.id = assignment.charge_id
  );

delete from public.payment_allocations allocation
where exists (
    select 1 from _day19_payments target where target.id = allocation.payment_id
  )
  or exists (
    select 1 from _day19_charges target where target.id = allocation.charge_id
  );

-- คลาย FK วนของ approval ก่อนลบ payment/charge/event
update public.payments payment
set approval_request_id = null
where exists (
  select 1 from _day19_payments target where target.id = payment.id
);

update public.delivery_charges charge
set approval_request_id = null
where exists (
  select 1 from _day19_charges target where target.id = charge.id
);

-- เมื่อตัด FK ขาเข้าจาก payment/charge แล้ว สามารถลบ approval ได้โดยตรง
-- FK ขาออกจาก approval ไป event/payment ไม่ขวางการลบแถว approval เอง
delete from public.financial_approval_requests approval
where exists (
  select 1 from _day19_approvals target where target.id = approval.id
);

delete from public.payments payment
where exists (
  select 1 from _day19_payments target where target.id = payment.id
);

delete from public.delivery_charges charge
where exists (
  select 1 from _day19_charges target where target.id = charge.id
);

-- Delivery revisions / sales / rounds
delete from public.delivery_event_revisions revision
where exists (
    select 1 from _day19_events target where target.id = revision.original_event_id
  )
  or exists (
    select 1 from _day19_events target where target.id = revision.replacement_event_id
  );

delete from public.delivery_items item
where exists (
  select 1 from _day19_events target where target.id = item.delivery_event_id
);

delete from public.delivery_events event
where exists (
  select 1 from _day19_events target where target.id = event.id
);

-- ปิดวัน/นับสต็อก/รับจากโรงงาน ต้องลบก่อน stock movement
delete from public.daily_aggregate_stock_closure_items
where service_date = date '2026-08-19';
delete from public.daily_aggregate_stock_closures
where service_date = date '2026-08-19';

delete from public.daily_stock_closure_items
where service_date = date '2026-08-19';
delete from public.daily_stock_closures
where service_date = date '2026-08-19';

delete from public.stock_count_variance_reviews review
where review.service_date = date '2026-08-19'
   or exists (
     select 1 from _day19_counts target where target.id = review.snapshot_id
   );

delete from public.stock_count_snapshot_items item
where exists (
  select 1 from _day19_counts target where target.id = item.snapshot_id
);
delete from public.stock_count_snapshots snapshot
where exists (
  select 1 from _day19_counts target where target.id = snapshot.id
);

delete from public.daily_stock_use_items item
where exists (
  select 1 from _day19_stock_uses target where target.id = item.use_id
);
delete from public.daily_stock_uses use_
where exists (
  select 1 from _day19_stock_uses target where target.id = use_.id
);

delete from public.factory_receipt_items item
where exists (
  select 1 from _day19_receipts target where target.id = item.factory_receipt_id
);
delete from public.factory_receipts receipt
where exists (
  select 1 from _day19_receipts target where target.id = receipt.id
);

delete from public.stock_movement_items item
where exists (
  select 1 from _day19_movements target where target.id = item.movement_id
);
delete from public.stock_movements movement
where exists (
  select 1 from _day19_movements target where target.id = movement.id
);

delete from public.stock_cutover_runs
where service_date = date '2026-08-19';

-- Snapshot และ summary ของรอบ
delete from public.round_stock_snapshot_items item
where exists (
  select 1 from _day19_rounds target where target.id = item.round_id
);
delete from public.round_stock_snapshots snapshot
where exists (
  select 1 from _day19_rounds target where target.id = snapshot.round_id
);

delete from public.round_close_ice_summaries summary
where exists (
  select 1 from _day19_rounds target where target.id = summary.round_id
);
delete from public.round_close_summaries summary
where exists (
  select 1 from _day19_rounds target where target.id = summary.round_id
);

delete from public.round_ice_counts count_
where exists (
  select 1 from _day19_rounds target where target.id = count_.round_id
);
delete from public.delivery_round_members member
where exists (
  select 1 from _day19_rounds target where target.id = member.round_id
);

delete from public.round_stops stop
where exists (
  select 1 from _day19_stops target where target.id = stop.id
);
delete from public.delivery_rounds round_
where exists (
  select 1 from _day19_rounds target where target.id = round_.id
);

delete from public.collection_run_members member
where exists (
  select 1 from _day19_collection_runs target
  where target.id = member.collection_run_id
);
delete from public.collection_runs run
where exists (
  select 1 from _day19_collection_runs target where target.id = run.id
);

-- ลบ audit log เฉพาะ entity เป้าหมาย หรือ log รายวันที่ระบุ service_date ตรงกัน
delete from public.audit_logs audit
where (audit.entity_type = 'delivery_rounds'
    and exists (select 1 from _day19_rounds target where target.id = audit.entity_id))
   or (audit.entity_type = 'round_stops'
    and exists (select 1 from _day19_stops target where target.id = audit.entity_id))
   or (audit.entity_type = 'delivery_events'
    and exists (select 1 from _day19_events target where target.id = audit.entity_id))
   or (audit.entity_type = 'delivery_charges'
    and exists (select 1 from _day19_charges target where target.id = audit.entity_id))
   or (audit.entity_type = 'collection_runs'
    and exists (select 1 from _day19_collection_runs target where target.id = audit.entity_id))
   or (audit.entity_type = 'payments'
    and exists (select 1 from _day19_payments target where target.id = audit.entity_id))
   or (audit.entity_type = 'financial_approval_requests'
    and exists (select 1 from _day19_approvals target where target.id = audit.entity_id))
   or (audit.entity_type = 'stock_movements'
    and exists (select 1 from _day19_movements target where target.id = audit.entity_id))
   or (audit.entity_type = 'factory_receipts'
    and exists (select 1 from _day19_receipts target where target.id = audit.entity_id))
   or (audit.entity_type = 'stock_count_snapshots'
    and exists (select 1 from _day19_counts target where target.id = audit.entity_id))
   or (audit.entity_type = 'daily_stock_uses'
    and exists (select 1 from _day19_stock_uses target where target.id = audit.entity_id))
   or (audit.entity_type = 'daily_credit_acknowledgements'
    and exists (select 1 from _day19_acknowledgements target where target.id = audit.entity_id))
   or (audit.entity_type = 'daily_credit_acknowledgement_evidence'
    and exists (select 1 from _day19_ack_evidence target where target.id = audit.entity_id))
   or (
     audit.entity_type in ('daily_stock_closures', 'daily_aggregate_stock_closures')
     and coalesce(audit.after_value->>'service_date', audit.before_value->>'service_date')
       = '2026-08-19'
   );

-- คืน trigger ทุกตัวก่อนจบ transaction
alter table public.employee_offline_commands
  enable trigger employee_offline_commands_state_guard;
alter table public.offline_sync_issue_decisions
  enable trigger offline_sync_issue_decisions_append_only;
alter table public.delivery_adjustment_items
  enable trigger delivery_adjustment_items_append_only;
alter table public.refund_settlements
  enable trigger refund_settlements_append_only;
alter table public.payment_allocation_changes
  enable trigger payment_allocation_changes_append_only;
alter table public.delivery_charge_document_snapshots
  enable trigger delivery_charge_document_snapshots_immutable;
alter table public.payment_receipt_snapshots
  enable trigger payment_receipt_snapshots_immutable;
alter table public.daily_credit_acknowledgements
  enable trigger daily_credit_acknowledgements_immutable;
alter table public.daily_credit_acknowledgement_evidence
  enable trigger daily_credit_acknowledgement_evidence_immutable;


-- ============================================================
-- STEP 3: VERIFY (ควรได้ 0 ทุกช่องภายใน transaction)
-- ============================================================

select
  (select count(*) from public.delivery_rounds
    where service_date = date '2026-08-19') as delivery_rounds,
  (select count(*) from public.delivery_charges
    where service_date = date '2026-08-19') as delivery_charges,
  (select count(*) from public.collection_runs
    where service_date = date '2026-08-19') as collection_runs,
  (select count(*) from public.stock_movements
    where service_date = date '2026-08-19') as stock_movements,
  (select count(*) from public.factory_receipts
    where service_date = date '2026-08-19') as factory_receipts,
  (select count(*) from public.stock_count_snapshots
    where service_date = date '2026-08-19') as stock_counts,
  (select count(*) from public.daily_stock_uses
    where service_date = date '2026-08-19') as daily_stock_uses,
  (select count(*) from public.daily_credit_acknowledgements
    where service_date = date '2026-08-19') as credit_acknowledgements,
  (select count(*) from public.employee_offline_commands
    where service_date = date '2026-08-19') as offline_commands,
  (select count(*) from public.offline_sync_issues
    where service_date = date '2026-08-19') as offline_sync_issues;

rollback;
-- เมื่อทดสอบและตรวจผลแล้ว เปลี่ยนบรรทัดด้านบนเป็น COMMIT เพื่อยืนยันการลบจริง
