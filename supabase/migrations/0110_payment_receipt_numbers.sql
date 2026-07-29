-- Give each persisted payment an immutable, human-readable receipt number.
-- The trigger runs inside the same transaction that records the payment.

create sequence public.payment_receipt_number_seq;

alter table public.payments
  add column receipt_number text;

with numbered_payments as (
  select
    payment.id,
    row_number() over (
      order by payment.recorded_at, payment.id
    ) as sequence_no
  from public.payments payment
)
update public.payments payment
set receipt_number = 'R'
  || to_char(payment.recorded_at at time zone 'Asia/Bangkok', 'YYMMDD')
  || '-'
  || lpad(numbered.sequence_no::text, 6, '0')
from numbered_payments numbered
where numbered.id = payment.id;

-- The backfill can queue deferred payment integrity triggers. Run them now
-- before changing the table definition again.
set constraints all immediate;

do $receipt_sequence$
declare
  v_existing_count bigint;
begin
  select count(*) into v_existing_count
  from public.payments;

  if v_existing_count = 0 then
    perform setval('public.payment_receipt_number_seq', 1, false);
  else
    perform setval('public.payment_receipt_number_seq', v_existing_count, true);
  end if;
end;
$receipt_sequence$;

create function public.assign_payment_receipt_number()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.receipt_number is null then
    new.receipt_number := 'R'
      || to_char(coalesce(new.recorded_at, now()) at time zone 'Asia/Bangkok', 'YYMMDD')
      || '-'
      || lpad(nextval('public.payment_receipt_number_seq')::text, 6, '0');
  end if;
  return new;
end;
$$;

create trigger payments_assign_receipt_number
before insert on public.payments
for each row execute function public.assign_payment_receipt_number();

alter table public.payments
  alter column receipt_number set not null;

create unique index payments_receipt_number_idx
  on public.payments (receipt_number);

create or replace function public.financial_payment_response(p_payment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'payment_id', payment.id,
    'receipt_number', payment.receipt_number,
    'shop_id', payment.shop_id,
    'collection_run_id', payment.collection_run_id,
    'payment_method', payment.payment_method,
    'received_amount', payment.received_amount,
    'allocated_amount', payment.allocated_amount,
    'change_amount', payment.change_amount,
    'reference_number', payment.reference_number,
    'evidence_path', payment.evidence_path,
    'status', payment.status,
    'recorded_at', payment.recorded_at,
    'allocations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'charge_id', allocation.charge_id,
        'amount', allocation.amount
      ) order by charge.service_date, charge.created_at, charge.id)
      from public.payment_allocations allocation
      join public.delivery_charges charge on charge.id = allocation.charge_id
      where allocation.payment_id = payment.id
    ), '[]'::jsonb)
  )
  from public.payments payment
  where payment.id = p_payment_id;
$$;

revoke all on function public.assign_payment_receipt_number() from public;
revoke all on function public.financial_payment_response(uuid) from public;
