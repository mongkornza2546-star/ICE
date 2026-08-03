-- Keep immediate-payment item labels with the server-owned delivery result.

create or replace function public.delivery_financial_response(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'delivery_event_id', event.id,
    'round_stop_id', event.round_stop_id,
    'recorded_by', event.recorded_by,
    'recorded_at', event.recorded_at,
    'client_recorded_at', event.client_recorded_at,
    'note', event.note,
    'source_stock_location_id', event.source_stock_location_id,
    'charge_id', charge.id,
    'service_date', charge.service_date,
    'total_amount', charge.original_amount,
    'payment_term', charge.payment_term,
    'payment_status', case
      when charge.id is null then null
      when coalesce(allocation.allocated_amount, 0) <= 0 then 'unpaid'
      when allocation.allocated_amount < charge.original_amount then 'partial'
      else 'paid'
    end,
    'due_date', charge.due_date,
    'approval_id', charge.approval_request_id,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', item.ice_type_id,
        'name', ice.name,
        'unit', ice.unit,
        'quantity', item.quantity,
        'unit_price', item.unit_price,
        'line_total', item.line_total,
        'price_source', item.price_source,
        'price_source_id', item.price_source_id
      ) order by item.ice_type_id)
      from public.delivery_items item
      join public.ice_types ice on ice.id = item.ice_type_id
      where item.delivery_event_id = event.id
    ), '[]'::jsonb)
  )
  from public.delivery_events event
  left join public.delivery_charges charge
    on charge.delivery_event_id = event.id and charge.status = 'active'
  left join lateral (
    select coalesce(sum(allocation.amount), 0)::numeric(12,2) as allocated_amount
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = charge.id and payment.status = 'active'
  ) allocation on true
  where event.id = p_event_id;
$$;

revoke all on function public.delivery_financial_response(uuid) from public;

notify pgrst, 'reload schema';
