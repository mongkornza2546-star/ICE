-- Any active employee may look up and reprint a receipt, even when someone
-- else collected the payment. History, receipt snapshots and payment RLS all
-- use this read boundary. Recording/voiding retain their own capability and
-- ownership checks.
create or replace function public.is_payment_visible(target_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user() and exists (
    select 1 from public.payments payment
    where payment.id = target_payment_id
  );
$$;

revoke all on function public.is_payment_visible(uuid) from public;
grant execute on function public.is_payment_visible(uuid) to authenticated;

notify pgrst, 'reload schema';
