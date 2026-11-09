-- One-off user-requested correction for REC2611-00192 and REC2611-00193.
-- recorded_at is the existing receipt-date source for accounting readers.
-- Preserve entry/issue timestamps, client timestamp, amounts, stock and identity.
-- Run with ROLLBACK for preflight; replace final ROLLBACK with COMMIT to apply.
begin;
set local lock_timeout = '5s';
lock table public.casual_transactions, public.casual_receipt_snapshots in access exclusive mode;

create temporary table receipt_date_repair_before on commit drop as
select t.id, to_jsonb(t) as transaction_before,
  s.receipt_data as receipt_before, t.recorded_at as old_recorded_at,
  t.recorded_at - interval '1 day' as corrected_recorded_at
from public.casual_transactions t
join public.casual_receipt_snapshots s on s.transaction_id = t.id
where (t.id, t.receipt_number, t.sale_amount, t.payment_method::text) in (
  ('0b6f13cb-b94d-40a3-8ae1-e31cdf86cad9'::uuid, 'REC2611-00192', 20, 'cash'),
  ('e4a5ae08-f12a-4dd3-a19d-5c73604e7737'::uuid, 'REC2611-00193', 120, 'bank_transfer')
)
and t.service_date = date '2026-11-03'
and t.recorded_at in ('2026-11-04T05:20:11.778555Z'::timestamptz,
  '2026-11-04T05:21:14.567063Z'::timestamptz)
and t.status = 'active' and t.transaction_kind = 'paid';

do $$ begin
  if (select count(*) from receipt_date_repair_before) <> 2 then
    raise exception 'Expected exactly two unchanged original receipts; aborting';
  end if;
  if exists (select 1 from public.daily_aggregate_stock_closures
    where service_date in ('2026-11-03','2026-11-04') and status = 'closed') then
    raise exception 'Affected day has been closed; aborting';
  end if;
end $$;

-- Exclusive locks prevent other sessions from writing during this exception.
-- Only the two immutable-history triggers are suspended, within this transaction.
alter table public.casual_transactions disable trigger casual_transactions_protect_history;
alter table public.casual_receipt_snapshots disable trigger casual_receipt_snapshots_immutable;

update public.casual_transactions t
set recorded_at = b.corrected_recorded_at
from receipt_date_repair_before b where t.id = b.id;

update public.casual_receipt_snapshots s
set receipt_data = s.receipt_data || jsonb_build_object(
  'recorded_at', b.corrected_recorded_at,
  'received_date_override', '2026-11-03',
  'entered_at', b.old_recorded_at
)
from receipt_date_repair_before b where s.transaction_id = b.id;

alter table public.casual_transactions enable trigger casual_transactions_protect_history;
alter table public.casual_receipt_snapshots enable trigger casual_receipt_snapshots_immutable;

insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_value, after_value, reason)
select t.recorded_by, 'casual_transaction', t.id, 'correct_received_date',
  jsonb_build_object('transaction', b.transaction_before, 'receipt', b.receipt_before),
  jsonb_build_object('transaction', to_jsonb(t), 'receipt', s.receipt_data),
  'Manual CLI correction by Codex at the account owner/original recorder request: only the two cash-sale receipts for 2026-11-03 count as received on 2026-11-03. Original entry and issue times preserved; no general date policy change.'
from receipt_date_repair_before b
join public.casual_transactions t on t.id = b.id
join public.casual_receipt_snapshots s on s.transaction_id = b.id;

do $$ begin
  if exists (select 1 from receipt_date_repair_before b
    join public.casual_transactions t on t.id=b.id
    where to_jsonb(t) - 'recorded_at' <> b.transaction_before - 'recorded_at'
      or (t.recorded_at at time zone 'Asia/Bangkok')::date <> date '2026-11-03') then
    raise exception 'Unexpected transaction change';
  end if;
  if exists (select 1 from receipt_date_repair_before b
    join public.casual_receipt_snapshots s on s.transaction_id=b.id
    where s.receipt_data - array['recorded_at','received_date_override','entered_at']
      <> b.receipt_before - array['recorded_at','received_date_override','entered_at']) then
    raise exception 'Unexpected receipt change';
  end if;
  if exists (select 1 from pg_trigger
    where tgname in ('casual_transactions_protect_history','casual_receipt_snapshots_immutable')
      and tgenabled <> 'O') then raise exception 'History guards not restored'; end if;
end $$;

select t.receipt_number, t.sale_amount, t.payment_method,
  (t.recorded_at at time zone 'Asia/Bangkok')::date as received_date,
  s.receipt_data->>'entered_at' as original_entry_time,
  s.receipt_data->>'issued_at' as original_issue_time
from receipt_date_repair_before b
join public.casual_transactions t on t.id=b.id
join public.casual_receipt_snapshots s on s.transaction_id=b.id
order by t.receipt_number;
rollback;
