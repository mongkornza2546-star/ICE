-- Preserve all existing dashboard fields and delivery quantities while adding
-- measured paid casual sales and the existing per-location loose-sale conversion.
do $dashboard_casual$
declare
  v_definition text := pg_get_functiondef('public.get_daily_work_dashboard(date)'::regprocedure);
  v_old text := 'coalesce(sum(item.quantity) filter (where charge.id is not null), 0) as total_qty';
  v_new text := $quantity$coalesce(sum(item.quantity) filter (where charge.id is not null), 0)
      + coalesce((select sum(casual.quantity)
          from public.casual_transactions casual
          where casual.service_date = v_service_date
            and casual.ice_type_id = ice.id
            and casual.status = 'active'
            and casual.transaction_kind = 'paid'
            and casual.fulfillment_mode = 'measured'), 0)
      + coalesce((select sum(bucket.quantity)
          from public.casual_loose_stock_totals(v_service_date) bucket
          where bucket.ice_type_id = ice.id), 0) as total_qty$quantity$;
begin
  if strpos(v_definition, v_old) = 0 then
    raise exception 'Cannot include casual sales: dashboard quantity expression has changed';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$dashboard_casual$;

-- Include paid walk-up receipts on the same Bangkok recorded-day basis as shop payments.
-- sale_amount is the amount retained after cash change; voided/free entries are excluded.
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
    ), 0) + coalesce((
      select sum(casual.sale_amount)
      from public.casual_transactions casual
      where casual.status = 'active'
        and casual.transaction_kind = 'paid'
        and casual.payment_method = 'cash'
        and casual.recorded_at >= v_service_date::timestamp at time zone 'Asia/Bangkok'
        and casual.recorded_at < (v_service_date + 1)::timestamp at time zone 'Asia/Bangkok'
    ), 0),
    'transferReceivedValue', coalesce((
      select sum(payment.allocated_amount)
      from public.payments payment
      where payment.status = 'active'
        and payment.payment_method in ('bank_transfer', 'qr')
        and payment.recorded_at >= v_service_date::timestamp at time zone 'Asia/Bangkok'
        and payment.recorded_at < (v_service_date + 1)::timestamp at time zone 'Asia/Bangkok'
    ), 0) + coalesce((
      select sum(casual.sale_amount)
      from public.casual_transactions casual
      where casual.status = 'active'
        and casual.transaction_kind = 'paid'
        and casual.payment_method in ('bank_transfer', 'qr')
        and casual.recorded_at >= v_service_date::timestamp at time zone 'Asia/Bangkok'
        and casual.recorded_at < (v_service_date + 1)::timestamp at time zone 'Asia/Bangkok'
    ), 0),
    'creditSalesValue', coalesce((
      select sum(public.effective_delivery_charge_amount(charge.id))
      from public.delivery_charges charge
      where charge.status = 'active'
        and charge.service_date = v_service_date
        and charge.payment_term = 'credit'
    ), 0),
    'creditSalesSubtotalValue', coalesce((
      select sum((public.charge_vat_totals(charge.id)->>'subtotal_amount')::numeric)
      from public.delivery_charges charge
      where charge.status = 'active'
        and charge.service_date = v_service_date
        and charge.payment_term = 'credit'
    ), 0),
    'creditSalesVatValue', coalesce((
      select sum(charge.vat_amount)
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
