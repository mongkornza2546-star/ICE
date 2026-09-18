-- Historical cash sales imported from the September government-complex workbook
-- kept the correct sale date on their charges, but record_payment stamped the
-- payment with the server insertion time. Move only those proven import
-- payments to the delivery's client-recorded time so daily cash reporting and
-- receipt details agree with the actual service date.

create temporary table imported_payment_recorded_at_repairs
on commit drop
as
select
  payment.id as payment_id,
  payment.recorded_by,
  payment.recorded_at as old_recorded_at,
  coalesce(
    min(event.client_recorded_at),
    (
      min(charge.service_date)
      + (payment.recorded_at at time zone 'Asia/Bangkok')::time
    ) at time zone 'Asia/Bangkok'
  ) as new_recorded_at,
  min(charge.service_date) as service_date
from public.payments payment
join public.payment_allocations allocation
  on allocation.payment_id = payment.id
join public.delivery_charges charge
  on charge.id = allocation.charge_id
join public.delivery_events event
  on event.id = charge.delivery_event_id
where payment.status = 'active'
  and event.note like 'นำเข้าจาก สรุปยอดขาย ศูนย์ราชการ ปี 69-3.xls%'
  and charge.service_date between date '2026-09-14' and date '2026-09-17'
group by payment.id, payment.recorded_by, payment.recorded_at
having count(distinct charge.service_date) = 1
  and (
    count(distinct event.client_recorded_at) = 1
    or count(event.client_recorded_at) = 0
  )
  and (payment.recorded_at at time zone 'Asia/Bangkok')::date
    is distinct from min(charge.service_date)
  and coalesce(
    (min(event.client_recorded_at) at time zone 'Asia/Bangkok')::date,
    min(charge.service_date)
  ) = min(charge.service_date);

do $$
begin
  if exists (
    select 1
    from imported_payment_recorded_at_repairs repair
    left join public.payment_receipt_snapshots snapshot
      on snapshot.payment_id = repair.payment_id
    where snapshot.payment_id is null
  ) then
    raise exception 'An imported payment is missing its immutable receipt snapshot';
  end if;
end;
$$;

insert into public.audit_logs (
  actor_id,
  entity_type,
  entity_id,
  action,
  before_value,
  after_value,
  reason
)
select
  repair.recorded_by,
  'payments',
  repair.payment_id,
  'imported_payment_recorded_at_corrected',
  jsonb_build_object('recorded_at', repair.old_recorded_at),
  jsonb_build_object(
    'recorded_at', repair.new_recorded_at,
    'service_date', repair.service_date
  ),
  'Correct historical Excel import payment date to the source sale date'
from imported_payment_recorded_at_repairs repair;

update public.payments payment
set recorded_at = repair.new_recorded_at
from imported_payment_recorded_at_repairs repair
where payment.id = repair.payment_id;

-- These snapshots intentionally resist ordinary edits. This is a bounded data
-- repair performed under the migration transaction and keeps reprints aligned
-- with the corrected payment row.
alter table public.payment_receipt_snapshots
  disable trigger payment_receipt_snapshots_immutable;

update public.payment_receipt_snapshots snapshot
set receipt_data = jsonb_set(
  snapshot.receipt_data,
  '{recorded_at}',
  to_jsonb(repair.new_recorded_at),
  true
)
from imported_payment_recorded_at_repairs repair
where snapshot.payment_id = repair.payment_id;

alter table public.payment_receipt_snapshots
  enable trigger payment_receipt_snapshots_immutable;

notify pgrst, 'reload schema';
