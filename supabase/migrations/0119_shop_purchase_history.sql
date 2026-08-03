-- Expose a manager-facing purchase history for one shop by combining delivery,
-- charge, item, and payment snapshots without duplicating financial data.

create function public.get_shop_purchase_history(
  p_shop_id uuid,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view shop purchase history';
  elsif p_shop_id is null or not exists (
    select 1 from public.shops shop where shop.id = p_shop_id
  ) then
    raise exception 'The shop does not exist';
  end if;

  return coalesce((
    select jsonb_agg(history.entry order by history.service_date desc, history.recorded_at desc)
    from (
      select jsonb_build_object(
        'delivery_event_id', event.id,
        'charge_id', charge.id,
        'charge_number', charge.charge_number,
        'service_date', round.service_date,
        'recorded_at', event.recorded_at,
        'recorded_by_name', recorder.display_name,
        'total_amount', charge.original_amount,
        'payment_term', charge.payment_term,
        'allocated_amount', coalesce(payment_summary.allocated_amount, 0),
        'outstanding_amount', case
          when charge.id is null then 0
          else greatest(charge.original_amount - coalesce(payment_summary.allocated_amount, 0), 0)
        end,
        'payment_status', case
          when charge.id is null then null
          when coalesce(payment_summary.allocated_amount, 0) <= 0 then 'unpaid'
          when payment_summary.allocated_amount < charge.original_amount then 'partial'
          else 'paid'
        end,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'ice_type_id', item.ice_type_id,
            'name', ice.name,
            'unit', ice.unit,
            'quantity', item.quantity,
            'unit_price', item.unit_price,
            'line_total', item.line_total
          ) order by ice.code)
          from public.delivery_items item
          join public.ice_types ice on ice.id = item.ice_type_id
          where item.delivery_event_id = event.id
        ), '[]'::jsonb),
        'payments', coalesce(payment_summary.payments, '[]'::jsonb)
      ) as entry,
      round.service_date,
      event.recorded_at
      from public.delivery_events event
      join public.round_stops stop on stop.id = event.round_stop_id
      join public.delivery_rounds round on round.id = stop.round_id
      join public.users recorder on recorder.id = event.recorded_by
      left join public.delivery_charges charge
        on charge.delivery_event_id = event.id and charge.status = 'active'
      left join lateral (
        select
          coalesce(sum(allocation.amount), 0)::numeric(12,2) as allocated_amount,
          jsonb_agg(jsonb_build_object(
            'payment_id', payment.id,
            'payment_method', payment.payment_method,
            'amount', allocation.amount,
            'recorded_at', payment.recorded_at
          ) order by payment.recorded_at) as payments
        from public.payment_allocations allocation
        join public.payments payment
          on payment.id = allocation.payment_id and payment.status = 'active'
        where allocation.charge_id = charge.id
      ) payment_summary on true
      where stop.shop_id = p_shop_id
        and event.status = 'active'
        and exists (
          select 1 from public.delivery_items item where item.delivery_event_id = event.id
        )
      order by round.service_date desc, event.recorded_at desc
      limit v_limit
      offset v_offset
    ) history
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_shop_purchase_history(uuid, integer, integer) from public;
grant execute on function public.get_shop_purchase_history(uuid, integer, integer) to authenticated;

notify pgrst, 'reload schema';
