-- payments.status is financial_record_status, while the original helper accepts
-- text. PostgreSQL does not implicitly cast enum arguments during function lookup.
-- Keep the original helper and its hashes intact for existing closed snapshots.
create or replace function public.daily_close_payment_fingerprint(
  p_payment_id uuid,
  p_status public.financial_record_status,
  p_payment_method public.payment_method,
  p_allocated_amount numeric,
  p_recorded_by uuid,
  p_recorded_role public.app_role,
  p_accountable_service_date date
)
returns text
language sql
stable
set search_path = public
as $$
  select public.daily_close_payment_fingerprint(
    p_payment_id, p_status::text, p_payment_method, p_allocated_amount,
    p_recorded_by, p_recorded_role, p_accountable_service_date
  );
$$;

-- This helper is only called inside the authorized daily-close RPC.
revoke all on function public.daily_close_payment_fingerprint(
  uuid, public.financial_record_status, public.payment_method, numeric,
  uuid, public.app_role, date
) from public, anon, authenticated;

notify pgrst, 'reload schema';
