create or replace function public.get_active_allocated_amount(target_charge_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0)::numeric(12,2)
  from public.payment_allocations allocation
  join public.payments payment on payment.id = allocation.payment_id
  where allocation.charge_id = target_charge_id;
$$;

drop view if exists public.delivery_charge_balances;
create view public.delivery_charge_balances
with (security_invoker = true, security_barrier = true)
as
select
  charge.id as charge_id,
  charge.delivery_event_id,
  charge.shop_id,
  charge.service_date,
  charge.payment_term,
  charge.original_amount,
  alloc.amt as allocated_amount,
  greatest(charge.original_amount - alloc.amt, 0)::numeric(12,2) as outstanding_amount,
  case
    when alloc.amt <= 0 then 'unpaid'::public.financial_payment_status
    when alloc.amt < charge.original_amount then 'partial'::public.financial_payment_status
    else 'paid'::public.financial_payment_status
  end as payment_status,
  charge.due_date,
  charge.created_at
from public.delivery_charges charge
cross join lateral (
  select public.get_active_allocated_amount(charge.id) as amt
) alloc
where charge.status = 'active'
  and public.is_financial_charge_visible(charge.id);

grant execute on function public.get_active_allocated_amount(uuid) to authenticated;
revoke all on function public.get_active_allocated_amount(uuid) from public;
