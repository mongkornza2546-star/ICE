-- Keep walk-in stock and money visible alongside the shop matrix, without
-- inventing a shop identity or attributing walk-ins to a shop's current zone.
alter function public.get_accounting_shop_daily_matrix(date, date, uuid[])
  rename to get_accounting_shop_daily_matrix_without_casual;

create function public.get_accounting_shop_daily_matrix(
  p_from_date date, p_to_date date, p_shop_ids uuid[]
)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  v_result jsonb;
  v_days jsonb;
begin
  -- The original reader enforces role, date-range and page-size permissions.
  v_result := public.get_accounting_shop_daily_matrix_without_casual(
    p_from_date, p_to_date, p_shop_ids
  );
  with dates as (
    select value::date as service_date
    from generate_series(p_from_date, p_to_date, interval '1 day') value
  ), items as (
    select transaction.service_date, transaction.ice_type_id,
      coalesce(sum(transaction.quantity), 0) + coalesce((
        select sum(bucket.quantity) from public.casual_loose_stock_totals(transaction.service_date) bucket
        where bucket.ice_type_id = transaction.ice_type_id
      ), 0) as quantity,
      coalesce((select sum(bucket.quantity) from public.casual_loose_stock_totals(transaction.service_date) bucket
        where bucket.ice_type_id = transaction.ice_type_id), 0) as automatic_quantity,
      coalesce((select sum(bucket.remainder_amount) from public.casual_loose_stock_totals(transaction.service_date) bucket
        where bucket.ice_type_id = transaction.ice_type_id), 0) as remainder_amount,
      coalesce(sum(transaction.sale_amount) filter (
        where transaction.fulfillment_mode = 'loose' and not exists (
          select 1 from public.casual_loose_stock_prices price
          where price.service_date = transaction.service_date
            and price.source_stock_location_id = transaction.source_stock_location_id
            and price.ice_type_id = transaction.ice_type_id
        )
      ), 0) as unconverted_amount,
      coalesce(sum(transaction.quantity) filter (where transaction.transaction_kind = 'free'), 0) as free_quantity,
      count(*) filter (where transaction.fulfillment_mode = 'loose') as loose_count,
      coalesce(sum(transaction.sale_amount) filter (where transaction.fulfillment_mode = 'loose'), 0) as loose_sales_amount
    from public.casual_transactions transaction
    where transaction.status = 'active'
      and transaction.service_date between p_from_date and p_to_date
    group by transaction.service_date, transaction.ice_type_id
  ), sales as (
    select transaction.service_date, sum(transaction.sale_amount) as sales_amount,
      count(*) as transaction_count
    from public.casual_transactions transaction
    where transaction.status = 'active'
      and transaction.service_date between p_from_date and p_to_date
    group by transaction.service_date
  ), receipts as (
    select (transaction.recorded_at at time zone 'Asia/Bangkok')::date as service_date,
      sum(transaction.sale_amount) as cash_received
    from public.casual_transactions transaction
    where transaction.transaction_kind = 'paid'
      and transaction.recorded_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
      and transaction.recorded_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok'
    group by 1
  ), refunds as (
    select (confirmation.confirmed_at at time zone 'Asia/Bangkok')::date as service_date,
      sum(confirmation.refunded_amount) as cash_refunded
    from public.casual_refund_confirmations confirmation
    where confirmation.confirmed_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
      and confirmation.confirmed_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok'
    group by 1
  )
  select jsonb_agg(jsonb_build_object(
    'service_date', day.service_date,
    'items', coalesce((select jsonb_agg(to_jsonb(item) - 'service_date' order by item.ice_type_id)
      from items item where item.service_date = day.service_date), '[]'::jsonb),
    'sales_amount', coalesce(sales.sales_amount, 0),
    'transaction_count', coalesce(sales.transaction_count, 0),
    'cash_received', coalesce(receipts.cash_received, 0),
    'cash_refunded', coalesce(refunds.cash_refunded, 0)
  ) order by day.service_date) into v_days
  from dates day
  left join sales using (service_date)
  left join receipts using (service_date)
  left join refunds using (service_date);

  -- Include historical ice types used only by walk-ins as well.
  v_result := jsonb_set(v_result, '{ice_types}', (
    select coalesce(jsonb_agg(ice order by ice->>'code'), '[]'::jsonb)
    from (
      select value as ice from jsonb_array_elements(v_result->'ice_types')
      union
      select jsonb_build_object('ice_type_id', ice.id, 'code', ice.code, 'name', ice.name, 'unit', ice.unit)
      from public.ice_types ice
      where exists (select 1 from public.casual_transactions transaction
        where transaction.ice_type_id = ice.id and transaction.status = 'active'
          and transaction.service_date between p_from_date and p_to_date)
    ) visible
  ));
  return jsonb_set(v_result, '{casual_days}', coalesce(v_days, '[]'::jsonb));
end;
$$;

revoke all on function public.get_accounting_shop_daily_matrix_without_casual(date, date, uuid[]) from public, anon, authenticated;
revoke all on function public.get_accounting_shop_daily_matrix(date, date, uuid[]) from public, anon;
grant execute on function public.get_accounting_shop_daily_matrix(date, date, uuid[]) to authenticated;
notify pgrst, 'reload schema';
