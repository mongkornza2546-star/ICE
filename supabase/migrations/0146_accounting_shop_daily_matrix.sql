-- Daily accounting matrix: shops are rows and service dates are column groups.
-- Sales stay tied to the invoice service date while receipts use the actual
-- Bangkok payment date, so credit collections do not distort daily sales.

create or replace function public.get_accounting_shop_daily_matrix(
  p_from_date date,
  p_to_date date,
  p_shop_ids uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view the accounting daily matrix';
  elsif p_from_date is null or p_to_date is null or p_to_date < p_from_date then
    raise exception 'A valid accounting date range is required';
  elsif p_to_date - p_from_date > 30 then
    raise exception 'Accounting date range cannot exceed 31 days';
  elsif coalesce(cardinality(p_shop_ids), 0) > 500 then
    raise exception 'Accounting daily matrix cannot exceed 500 shops';
  end if;

  with requested_shops as materialized (
    select requested.shop_id, min(requested.ordinality) as shop_position
    from unnest(coalesce(p_shop_ids, '{}'::uuid[]))
      with ordinality requested(shop_id, ordinality)
    group by requested.shop_id
  ), selected_shops as materialized (
    select shop.id as shop_id, requested.shop_position,
      case
        when profile.shop_id is null then 'ยังไม่ตั้งค่า'
        when cardinality(profile.allowed_payment_terms) > 1 then 'หลายเงื่อนไข'
        when profile.default_payment_term = 'immediate' then 'จ่ายทันที'
        when profile.default_payment_term = 'end_of_day' then 'เก็บท้ายวัน'
        when profile.credit_due_rule = 'weekly' then
          'เก็บทุกวัน' || (array['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'])[profile.credit_collection_weekday]
        when profile.credit_due_rule = 'end_of_month' then 'เก็บสิ้นเดือน'
        when profile.credit_due_rule = 'net_days' then 'เครดิต ' || profile.credit_days || ' วัน'
        else 'เครดิต'
      end as payment_condition
    from requested_shops requested
    join public.shops shop on shop.id = requested.shop_id and shop.status = 'active'
    left join public.shop_payment_profiles profile on profile.shop_id = shop.id
  ), service_dates as materialized (
    select generated.service_date::date
    from generate_series(p_from_date, p_to_date, interval '1 day') generated(service_date)
  ), stop_activity as materialized (
    select stop.shop_id, round.service_date,
      case
        when bool_or(stop.status = 'delivered') then 'recorded_no_sale'
        when bool_or(stop.status = 'closed_shop') then 'closed_shop'
        when bool_or(stop.status = 'full_bin') then 'no_purchase'
        when bool_or(stop.status in ('no_access', 'issue')) then 'skipped'
        else 'not_recorded'
      end as status
    from selected_shops shop
    join public.round_stops stop on stop.shop_id = shop.shop_id
    join public.delivery_rounds round on round.id = stop.round_id
    where round.service_date between p_from_date and p_to_date
      and round.cancelled_at is null
    group by stop.shop_id, round.service_date
  ), active_charges as materialized (
    select charge.id as charge_id, charge.shop_id, charge.service_date,
      charge.delivery_event_id, public.effective_delivery_charge_amount(charge.id) as sales_amount
    from selected_shops shop
    join public.delivery_charges charge on charge.shop_id = shop.shop_id
    join public.delivery_events event on event.id = charge.delivery_event_id
    where charge.service_date between p_from_date and p_to_date
      and charge.status = 'active' and event.status = 'active'
  ), charge_item_ids as materialized (
    select charge.charge_id, item.ice_type_id
    from active_charges charge
    join public.delivery_items item on item.delivery_event_id = charge.delivery_event_id
    union
    select charge.charge_id, adjustment_item.ice_type_id
    from active_charges charge
    join public.delivery_charge_adjustments adjustment
      on adjustment.charge_id = charge.charge_id and adjustment.status = 'active'
    join public.delivery_adjustment_items adjustment_item
      on adjustment_item.adjustment_id = adjustment.idempotency_key
  ), effective_items as materialized (
    select charge.charge_id, charge.shop_id, charge.service_date, item_id.ice_type_id,
      (coalesce(original.quantity, 0) + coalesce(adjustment.quantity_delta, 0))::numeric(12,1) as quantity
    from active_charges charge
    join charge_item_ids item_id on item_id.charge_id = charge.charge_id
    left join public.delivery_items original
      on original.delivery_event_id = charge.delivery_event_id
      and original.ice_type_id = item_id.ice_type_id
    left join lateral (
      select coalesce(sum(item.quantity_delta), 0)::numeric(12,1) as quantity_delta
      from public.delivery_charge_adjustments correction
      join public.delivery_adjustment_items item
        on item.adjustment_id = correction.idempotency_key
      where correction.charge_id = charge.charge_id and correction.status = 'active'
        and item.ice_type_id = item_id.ice_type_id
    ) adjustment on true
  ), daily_items as materialized (
    select item.shop_id, item.service_date, item.ice_type_id,
      sum(item.quantity)::numeric(12,1) as quantity
    from effective_items item
    where item.quantity > 0
    group by item.shop_id, item.service_date, item.ice_type_id
  ), daily_item_json as materialized (
    select item.shop_id, item.service_date,
      jsonb_agg(jsonb_build_object(
        'ice_type_id', item.ice_type_id,
        'quantity', item.quantity
      ) order by ice.code) as items
    from daily_items item
    join public.ice_types ice on ice.id = item.ice_type_id
    group by item.shop_id, item.service_date
  ), daily_sales as materialized (
    select charge.shop_id, charge.service_date,
      sum(charge.sales_amount)::numeric(12,2) as sales_amount,
      count(*)::integer as invoice_count
    from active_charges charge
    group by charge.shop_id, charge.service_date
  ), daily_payments as materialized (
    select payment.shop_id,
      (payment.recorded_at at time zone 'Asia/Bangkok')::date as service_date,
      sum(payment.allocated_amount)::numeric(12,2) as cash_received
    from selected_shops shop
    join public.payments payment on payment.shop_id = shop.shop_id
    where payment.status = 'active'
      and payment.recorded_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
      and payment.recorded_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok'
    group by payment.shop_id, (payment.recorded_at at time zone 'Asia/Bangkok')::date
  ), matrix_rows as materialized (
    select shop.shop_id, shop.shop_position, shop.payment_condition,
      jsonb_agg(jsonb_build_object(
        'service_date', day.service_date,
        'status', case
          when coalesce(sales.sales_amount, 0) > 0 then 'purchased'
          when activity.status is not null then activity.status
          when coalesce(sales.invoice_count, 0) > 0 then 'recorded_no_sale'
          else 'not_scheduled'
        end,
        'items', coalesce(item_json.items, '[]'::jsonb),
        'sales_amount', coalesce(sales.sales_amount, 0),
        'cash_received', coalesce(payment.cash_received, 0),
        'invoice_count', coalesce(sales.invoice_count, 0)
      ) order by day.service_date) as days
    from selected_shops shop
    cross join service_dates day
    left join stop_activity activity
      on activity.shop_id = shop.shop_id and activity.service_date = day.service_date
    left join daily_item_json item_json
      on item_json.shop_id = shop.shop_id and item_json.service_date = day.service_date
    left join daily_sales sales
      on sales.shop_id = shop.shop_id and sales.service_date = day.service_date
    left join daily_payments payment
      on payment.shop_id = shop.shop_id and payment.service_date = day.service_date
    group by shop.shop_id, shop.shop_position, shop.payment_condition
  ), visible_ice_types as materialized (
    select ice.id as ice_type_id, ice.code, ice.name, ice.unit
    from public.ice_types ice
    where ice.is_active or exists (
      select 1 from daily_items item where item.ice_type_id = ice.id
    )
  )
  select jsonb_build_object(
    'ice_types', coalesce((select jsonb_agg(to_jsonb(ice) order by ice.code)
      from visible_ice_types ice), '[]'::jsonb),
    'rows', coalesce((select jsonb_agg(
      jsonb_build_object(
        'shop_id', row.shop_id,
        'payment_condition', row.payment_condition,
        'days', row.days
      ) order by row.shop_position
    ) from matrix_rows row), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_accounting_shop_daily_matrix(date, date, uuid[]) from public;
grant execute on function public.get_accounting_shop_daily_matrix(date, date, uuid[]) to authenticated;

notify pgrst, 'reload schema';
