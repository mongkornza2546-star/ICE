-- Couriers may correct their own payment-entry mistakes. Managers retain their
-- existing ability to void any payment. Every void still requires a reason and
-- is preserved in the payment row and audit log.

create or replace function public.void_payment(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid;
  v_recorded_by uuid;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A void reason is required';
  end if;

  select payment.shop_id, payment.recorded_by
  into v_shop_id, v_recorded_by
  from public.payments payment
  where payment.id = p_payment_id;

  if not found then
    raise exception 'The selected payment does not exist';
  elsif public.current_app_role() = 'courier' and v_recorded_by <> auth.uid() then
    raise exception 'Couriers can only void payments they recorded';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_shop_id::text, 0));

  update public.payments
  set status = 'voided', voided_by = auth.uid(), voided_at = now(),
      void_reason = trim(p_reason)
  where id = p_payment_id and status = 'active';

  if not found then
    raise exception 'The selected payment is already voided';
  end if;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'payments', p_payment_id, 'voided',
    jsonb_build_object('reason', trim(p_reason))
  );

  return public.financial_payment_response(p_payment_id);
end;
$$;

revoke all on function public.void_payment(uuid, text) from public;
grant execute on function public.void_payment(uuid, text) to authenticated;
