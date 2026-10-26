-- Add receipt method splits and settled shop refunds for the combined receipt card.
-- Existing shop and casual totals retain their separate scopes and meanings.
-- The underlying shop reader validates permission/date range before any reads.
begin;

create or replace function public.get_accounting_shop_summary(
  p_from_date date,
  p_to_date date,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_building_id uuid := nullif(p_filters->>'building_id', '')::uuid;
  v_casual_sales numeric := 0;
  v_casual_received numeric := 0;
  v_casual_cash_received numeric := 0;
  v_casual_transfer_received numeric := 0;
  v_shop_refunded numeric := 0;
  v_casual_refunded numeric := 0;
  v_casual_free_count integer := 0;
begin
  v_result := public.get_accounting_shop_summary_without_casual(
    p_from_date, p_to_date, p_filters, p_limit, p_offset
  );
  select
    coalesce(sum(transaction.sale_amount) filter (
      where transaction.status = 'active' and transaction.transaction_kind = 'paid'
    ), 0)::numeric,
    count(*) filter (
      where transaction.status = 'active' and transaction.transaction_kind = 'free'
    )::integer
  into v_casual_sales, v_casual_free_count
  from public.casual_transactions transaction
  where transaction.service_date between p_from_date and p_to_date
    and (v_building_id is null or transaction.sale_building_id = v_building_id);
  select coalesce(sum(transaction.sale_amount), 0)::numeric,
    coalesce(sum(transaction.sale_amount) filter (where transaction.payment_method = 'cash'), 0)::numeric,
    coalesce(sum(transaction.sale_amount) filter (where transaction.payment_method in ('bank_transfer', 'qr')), 0)::numeric
  into v_casual_received, v_casual_cash_received, v_casual_transfer_received
  from public.casual_transactions transaction
  where transaction.transaction_kind = 'paid'
    and (v_building_id is null or transaction.sale_building_id = v_building_id)
    and transaction.recorded_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
    and transaction.recorded_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok';
  select coalesce(sum(confirmation.refunded_amount), 0)::numeric into v_casual_refunded
  from public.casual_refund_confirmations confirmation
  join public.casual_transactions transaction on transaction.id = confirmation.transaction_id
  where (v_building_id is null or transaction.sale_building_id = v_building_id)
    and confirmation.confirmed_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
    and confirmation.confirmed_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok';
  -- Settlements use the same current-shop search/area scope as shop receipts.
  -- Do not filter by payment/charge status: a voided sale can still be refunded.
  select coalesce(sum(settlement.amount), 0)::numeric into v_shop_refunded
  from public.refund_settlements settlement
  join public.refund_obligations obligation on obligation.id = settlement.obligation_id
  join public.payments payment on payment.id = obligation.payment_id
  join public.shops shop on shop.id = payment.shop_id
  where settlement.settled_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
    and settlement.settled_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok'
    and (nullif(trim(p_filters ->> 'shop_search'), '') is null
      or shop.code ilike '%' || trim(p_filters ->> 'shop_search') || '%'
      or shop.name ilike '%' || trim(p_filters ->> 'shop_search') || '%')
    and (nullif(p_filters ->> 'shop_id', '') is null or shop.id::text = p_filters ->> 'shop_id')
    and (v_building_id is null or shop.building_id = v_building_id)
    and (nullif(p_filters ->> 'zone_id', '') is null or shop.zone_id::text = p_filters ->> 'zone_id');
  v_result := jsonb_set(v_result, '{totals,shop_refunded_in_period}', to_jsonb(v_shop_refunded));
  v_result := jsonb_set(v_result, '{totals,casual_cash_received_amount}', to_jsonb(v_casual_cash_received));
  v_result := jsonb_set(v_result, '{totals,casual_transfer_received_amount}', to_jsonb(v_casual_transfer_received));
  v_result := jsonb_set(v_result, '{totals,casual_sales_amount}', to_jsonb(v_casual_sales));
  v_result := jsonb_set(v_result, '{totals,casual_received_amount}', to_jsonb(v_casual_received));
  v_result := jsonb_set(v_result, '{totals,casual_refunded_amount}', to_jsonb(v_casual_refunded));
  v_result := jsonb_set(v_result, '{totals,casual_net_cash}', to_jsonb(
    v_casual_received - v_casual_refunded
  ));
  v_result := jsonb_set(v_result, '{totals,casual_free_count}', to_jsonb(v_casual_free_count));
  return v_result;
end;
$$;

revoke all on function public.get_accounting_shop_summary(date,date,jsonb,integer,integer) from public, anon;
grant execute on function public.get_accounting_shop_summary(date,date,jsonb,integer,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
