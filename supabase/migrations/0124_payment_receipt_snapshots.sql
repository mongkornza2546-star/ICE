-- Preserve the exact receipt content issued for every payment. Corrections may
-- move current allocations later, but reprinting must keep the original receipt.

create function public.build_payment_receipt_snapshot(p_payment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'payment_id', payment.id,
    'receipt_number', payment.receipt_number,
    'shop_code', shop.code,
    'shop_name', shop.name,
    'payment_method', payment.payment_method,
    'received_amount', payment.received_amount,
    'allocated_amount', payment.allocated_amount,
    'change_amount', payment.change_amount,
    'recorded_at', payment.recorded_at,
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'charge_number', charge.charge_number,
        'received_amount', allocation.amount,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'ice_type_name', ice.name,
            'ice_type_unit', ice.unit,
            'quantity', item.quantity,
            'line_total', item.line_total
          ) order by ice.code)
          from public.delivery_events event
          join public.delivery_items item on item.delivery_event_id = event.id
          join public.ice_types ice on ice.id = item.ice_type_id
          where event.id = charge.delivery_event_id
        ), '[]'::jsonb)
      ) order by charge.service_date, charge.created_at, charge.id)
      from public.payment_allocations allocation
      join public.delivery_charges charge on charge.id = allocation.charge_id
      where allocation.payment_id = payment.id
    ), '[]'::jsonb)
  )
  from public.payments payment
  join public.shops shop on shop.id = payment.shop_id
  where payment.id = p_payment_id;
$$;

create table public.payment_receipt_snapshots (
  payment_id uuid primary key references public.payments(id) on delete restrict,
  receipt_data jsonb not null check (jsonb_typeof(receipt_data) = 'object'),
  created_at timestamptz not null default now()
);

create function public.capture_payment_receipt_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.payment_receipt_snapshots (payment_id, receipt_data)
  values (new.id, public.build_payment_receipt_snapshot(new.id));
  return null;
end;
$$;

-- Allocations are inserted after the payment row by record_payment. Deferring
-- this trigger captures the complete receipt at transaction commit.
create constraint trigger payments_capture_receipt_snapshot
after insert on public.payments
deferrable initially deferred
for each row execute function public.capture_payment_receipt_snapshot();

insert into public.payment_receipt_snapshots (payment_id, receipt_data, created_at)
select
  payment.id,
  public.build_payment_receipt_snapshot(payment.id),
  payment.recorded_at
from public.payments payment;

create function public.protect_payment_receipt_snapshot()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Payment receipt snapshots are immutable';
end;
$$;

create trigger payment_receipt_snapshots_immutable
before update or delete on public.payment_receipt_snapshots
for each row execute function public.protect_payment_receipt_snapshot();

alter table public.payment_receipt_snapshots enable row level security;

create policy "assigned users read payment receipt snapshots"
on public.payment_receipt_snapshots for select
using (public.is_payment_visible(payment_id));

create function public.get_payment_receipt_snapshot(p_payment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_receipt jsonb;
begin
  if not public.is_payment_visible(p_payment_id) then
    raise exception 'This payment cannot be viewed by the current user';
  end if;

  select snapshot.receipt_data
  into v_receipt
  from public.payment_receipt_snapshots snapshot
  where snapshot.payment_id = p_payment_id;

  if v_receipt is null then
    raise exception 'The payment receipt snapshot does not exist';
  end if;

  return v_receipt;
end;
$$;

-- Keep the existing receipt-detail API for the history dialog, but source its
-- rows from the immutable snapshot instead of current allocations.
create or replace function public.get_payment_receipt_items(p_payment_id uuid)
returns table (
  charge_number text,
  received_amount numeric(12,2),
  ice_type_name text,
  ice_type_unit text,
  quantity numeric(12,1),
  line_total numeric(12,2)
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_payment_visible(p_payment_id) then
    raise exception 'This payment cannot be viewed by the current user';
  end if;

  return query
  select
    charge.value ->> 'charge_number',
    (charge.value ->> 'received_amount')::numeric(12,2),
    item.value ->> 'ice_type_name',
    item.value ->> 'ice_type_unit',
    (item.value ->> 'quantity')::numeric(12,1),
    (item.value ->> 'line_total')::numeric(12,2)
  from public.payment_receipt_snapshots snapshot
  cross join lateral jsonb_array_elements(snapshot.receipt_data -> 'charges')
    with ordinality charge(value, ordinality)
  cross join lateral jsonb_array_elements(charge.value -> 'items')
    with ordinality item(value, ordinality)
  where snapshot.payment_id = p_payment_id
  order by charge.ordinality, item.ordinality;
end;
$$;

revoke all on function public.build_payment_receipt_snapshot(uuid) from public;
revoke all on function public.capture_payment_receipt_snapshot() from public;
revoke all on function public.protect_payment_receipt_snapshot() from public;
revoke all on function public.build_payment_receipt_snapshot(uuid) from authenticated;
revoke all on function public.capture_payment_receipt_snapshot() from authenticated;
revoke all on function public.protect_payment_receipt_snapshot() from authenticated;
revoke all on function public.build_payment_receipt_snapshot(uuid) from anon;
revoke all on function public.capture_payment_receipt_snapshot() from anon;
revoke all on function public.protect_payment_receipt_snapshot() from anon;
revoke all on function public.get_payment_receipt_snapshot(uuid) from public;
revoke all on function public.get_payment_receipt_items(uuid) from public;
grant execute on function public.get_payment_receipt_snapshot(uuid) to authenticated;
grant execute on function public.get_payment_receipt_items(uuid) to authenticated;

notify pgrst, 'reload schema';
