-- Receipt details must be read through the payment scope, so collection staff can
-- reprint an older payment even when they were not on its original delivery round.
create function public.get_payment_receipt_items(p_payment_id uuid)
returns table (
  charge_number text,
  received_amount numeric(12,2),
  ice_type_name text,
  ice_type_unit text,
  quantity integer,
  line_total numeric(12,2)
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_payment_visible(p_payment_id) then
    raise exception 'This payment cannot be viewed by the current user';
  end if;

  return query
  select
    charge.charge_number,
    allocation.amount::numeric(12,2) as received_amount,
    ice.name as ice_type_name,
    ice.unit as ice_type_unit,
    item.quantity,
    item.line_total
  from public.payment_allocations allocation
  join public.delivery_charges charge on charge.id = allocation.charge_id
  join public.delivery_events event on event.id = charge.delivery_event_id
  join public.delivery_items item on item.delivery_event_id = event.id
  join public.ice_types ice on ice.id = item.ice_type_id
  where allocation.payment_id = p_payment_id
  order by charge.service_date, charge.created_at, charge.id, ice.code;
end;
$$;

revoke all on function public.get_payment_receipt_items(uuid) from public;
grant execute on function public.get_payment_receipt_items(uuid) to authenticated;
