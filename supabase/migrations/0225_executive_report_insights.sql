-- Executive insights: current debt aging, receipt mix and shops that stopped
-- ordering. Debt and quiet shops are current-state (Bangkok today), like the
-- existing outstanding/overdue totals; receipt mix follows the selected period.
create function public.executive_report_insights(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = public as $$
  with today as (
    select (now() at time zone 'Asia/Bangkok')::date as day
  ), balances as materialized (
    -- Same receivable projection as get_executive_report's charge_balances.
    select charge.shop_id, greatest(0,
      public.effective_delivery_charge_amount(charge.id) - coalesce((
        select sum(allocation.amount) from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id and payment.status = 'active'
      ), 0)) as outstanding,
      coalesce(charge.due_date, charge.service_date) as due_date
    from public.delivery_charges charge
    left join public.delivery_events event on event.id = charge.delivery_event_id
    where charge.status = 'active'
      and (event.status = 'active' or charge.tank_rental_id is not null or charge.event_tank_rental_id is not null)
  ), aged as (
    select balances.shop_id, balances.outstanding,
      case when balances.due_date >= today.day then 'notDue'
        when today.day - balances.due_date <= 7 then 'days1to7'
        when today.day - balances.due_date <= 30 then 'days8to30'
        else 'days31plus' end as bucket
    from balances cross join today
    where balances.outstanding > 0
  ), buckets(bucket, position) as (
    values ('notDue', 1), ('days1to7', 2), ('days8to30', 3), ('days31plus', 4)
  ), aging as (
    select buckets.bucket, buckets.position,
      coalesce(sum(aged.outstanding), 0) as amount,
      count(distinct aged.shop_id) as shops
    from buckets left join aged on aged.bucket = buckets.bucket
    group by buckets.bucket, buckets.position
  ), receipt_methods as (
    select coalesce(fact.method, 'other') as method, sum(fact.amount) as amount
    from public.executive_report_facts(p_from, p_to) fact
    where fact.kind = 'receipt'
    group by coalesce(fact.method, 'other')
  ), orders as materialized (
    -- Ice deliveries only; tank rentals are not a reorder signal.
    select charge.shop_id, charge.service_date,
      public.effective_delivery_charge_amount(charge.id) as amount
    from public.delivery_charges charge
    join public.delivery_events event on event.id = charge.delivery_event_id
    join public.shops shop on shop.id = charge.shop_id
    cross join today
    where charge.status = 'active' and event.status = 'active' and shop.status = 'active'
      and charge.service_date between today.day - 89 and today.day
  ), shop_orders as (
    select shop_id, count(distinct service_date) as order_days,
      min(service_date) as first_day, max(service_date) as last_day, sum(amount) as amount
    from orders group by shop_id
  ), quiet as (
    select shop_orders.*, today.day - shop_orders.last_day as days_since,
      greatest(1, round((shop_orders.last_day - shop_orders.first_day)::numeric
        / (shop_orders.order_days - 1), 1)) as usual_gap,
      round(shop_orders.amount * 30
        / greatest(1, shop_orders.last_day - shop_orders.first_day + 1), 2) as monthly_sales
    from shop_orders cross join today
    -- Enough history to know the shop's normal rhythm.
    where shop_orders.order_days >= 4
  ), flagged as (
    select quiet.*, shop.name, building.name as building_name
    from quiet
    join public.shops shop on shop.id = quiet.shop_id
    left join public.buildings building on building.id = shop.building_id
    -- Silent for at least a week and twice the shop's usual gap.
    where quiet.days_since >= greatest(7, ceil(quiet.usual_gap * 2))
  )
  select jsonb_build_object(
    'debtAging', (select jsonb_agg(jsonb_build_object('bucket', bucket,
      'amount', amount, 'shops', shops) order by position) from aging),
    'receiptMethods', coalesce((select jsonb_agg(jsonb_build_object('method', method,
      'amount', amount) order by amount desc, method) from receipt_methods), '[]'::jsonb),
    'quietShops', jsonb_build_object(
      'total', (select count(*) from flagged),
      'monthlySales', coalesce((select sum(monthly_sales) from flagged), 0),
      'rows', coalesce((select jsonb_agg(jsonb_build_object('id', shop_id, 'name', name,
        'building', building_name, 'lastOrder', last_day, 'daysSince', days_since,
        'usualGap', usual_gap, 'monthlySales', monthly_sales)
        order by monthly_sales desc, days_since desc, shop_id)
        from (select * from flagged order by monthly_sales desc, days_since desc, shop_id limit 10) page), '[]'::jsonb))
  );
$$;

-- Only the validated, admin-only report RPC may invoke this helper.
revoke all on function public.executive_report_insights(date, date) from public, anon, authenticated;

do $report_insights$
declare
  v_definition text := pg_get_functiondef('public.get_executive_report(date,date)'::regprocedure);
  v_old text := $old$return v_result || jsonb_build_object('volumeAreas', public.executive_report_volume_areas(p_from, p_to));$old$;
  v_new text := $new$return v_result || jsonb_build_object('volumeAreas', public.executive_report_volume_areas(p_from, p_to)) || public.executive_report_insights(p_from, p_to);$new$;
begin
  if strpos(v_definition, v_old) = 0 then
    raise exception 'Cannot add report insights: executive report definition has changed';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$report_insights$;

notify pgrst, 'reload schema';
