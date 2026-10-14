-- Daily sales and delivered quantities for two-period comparisons. Keep the
-- existing month-bucketed trend and all existing summary contracts unchanged.
create or replace function public.executive_report_daily_trend(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = public as $$
  with days as materialized (
    select day::date as day from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') day
  ), sales as (
    select fact.day, sum(fact.amount) as amount
    from public.executive_report_facts(p_from, p_to) fact
    where fact.kind = 'sale' group by fact.day
  ), charges as materialized (
    select charge.id, charge.service_date as day, event.id as event_id, event.status as event_status
    from public.delivery_charges charge
    left join public.delivery_events event on event.id = charge.delivery_event_id
    where charge.status = 'active' and charge.service_date between p_from and p_to
  ), quantities as (
    select charge.day, item.ice_type_id, item.quantity
    from charges charge join public.delivery_items item on item.delivery_event_id = charge.event_id
    where charge.event_status = 'active'
    union all
    -- Corrections belong to the charge's service date, as in the summary.
    select charge.day, item.ice_type_id, item.quantity_delta
    from charges charge
    join public.delivery_charge_adjustments adjustment on adjustment.charge_id = charge.id
    join public.delivery_adjustment_items item on item.adjustment_id = adjustment.idempotency_key
    where adjustment.status = 'active'
    union all
    select casual.service_date, casual.ice_type_id, casual.quantity
    from public.casual_transactions casual
    where casual.transaction_kind = 'paid' and casual.status = 'active'
      and casual.service_date between p_from and p_to
    union all
    -- Preserve rounding per service day / holding location before summing.
    select days.day, bucket.ice_type_id, bucket.quantity
    from days cross join lateral public.casual_loose_stock_totals(days.day) bucket
  ), totals as (
    select day, ice_type_id, sum(quantity) as delivered from quantities group by day, ice_type_id
  ), products as (
    select totals.day, jsonb_agg(jsonb_build_object('id', ice.id, 'name', ice.name,
      'unit', ice.unit, 'delivered', totals.delivered) order by ice.name, ice.id) as items
    from totals join public.ice_types ice on ice.id = totals.ice_type_id group by totals.day
  )
  select coalesce(jsonb_agg(jsonb_build_object('date', days.day, 'sales', coalesce(sales.amount, 0),
    'products', coalesce(products.items, '[]'::jsonb)) order by days.day), '[]'::jsonb)
  from days left join sales on sales.day = days.day left join products on products.day = days.day;
$$;

-- Called only inside the date-validated, active-admin report endpoint.
revoke all on function public.executive_report_daily_trend(date, date) from public, anon, authenticated;

do $daily_comparison$
declare
  v_definition text := pg_get_functiondef('public.get_executive_report(date,date)'::regprocedure);
  v_old text := 'return v_result ||';
  v_new text := 'return v_result || jsonb_build_object(''dailyTrend'', public.executive_report_daily_trend(p_from, p_to)) ||';
begin
  if strpos(v_definition, v_new) > 0 then
    raise notice 'Daily comparison already installed';
  elsif strpos(v_definition, v_old) > 0 then
    execute replace(v_definition, v_old, v_new);
  else
    raise exception 'Cannot add daily comparison: executive report definition has changed';
  end if;
end;
$daily_comparison$;

notify pgrst, 'reload schema';
