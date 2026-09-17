-- Dashboard cards: today's cash and transfer collections, plus credit sales issued today.
create or replace function public.get_daily_payment_method_summary(
  p_service_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date := coalesce(
    p_service_date,
    (now() at time zone 'Asia/Bangkok')::date
  );
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view the daily payment summary';
  end if;

  return jsonb_build_object(
    'cashReceivedValue', coalesce((
      select sum(payment.allocated_amount)
      from public.payments payment
      where payment.status = 'active'
        and payment.payment_method = 'cash'
        and payment.recorded_at >= v_service_date::timestamp at time zone 'Asia/Bangkok'
        and payment.recorded_at < (v_service_date + 1)::timestamp at time zone 'Asia/Bangkok'
    ), 0),
    'transferReceivedValue', coalesce((
      select sum(payment.allocated_amount)
      from public.payments payment
      where payment.status = 'active'
        and payment.payment_method in ('bank_transfer', 'qr')
        and payment.recorded_at >= v_service_date::timestamp at time zone 'Asia/Bangkok'
        and payment.recorded_at < (v_service_date + 1)::timestamp at time zone 'Asia/Bangkok'
    ), 0),
    'creditSalesValue', coalesce((
      select sum(public.effective_delivery_charge_amount(charge.id))
      from public.delivery_charges charge
      where charge.status = 'active'
        and charge.service_date = v_service_date
        and charge.payment_term = 'credit'
    ), 0)
  );
end;
$$;

revoke all on function public.get_daily_payment_method_summary(date) from public;
grant execute on function public.get_daily_payment_method_summary(date) to authenticated;
notify pgrst, 'reload schema';
