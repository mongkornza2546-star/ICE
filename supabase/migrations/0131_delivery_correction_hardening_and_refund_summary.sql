-- Keep courier corrections quantity-only and expose daily cash received/refunded/net totals.

create or replace function public.preview_delivery_correction(
  p_event_id uuid,
  p_action text,
  p_items jsonb,
  p_stop_status public.shop_round_status
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_context jsonb;
  v_shop_id uuid;
  v_service_date date;
  v_new_amount numeric(12,2) := 0;
  v_allocated numeric(12,2);
  v_charge_id uuid;
  v_payment_term public.payment_term;
  v_credit_limit numeric(12,2);
  v_credit_exposure numeric(12,2) := 0;
  v_approval_required boolean := false;
  v_item record;
  v_unit_price numeric(12,2);
begin
  v_context := public.get_delivery_correction_context(p_event_id);
  if p_action not in ('correct', 'cancel') then raise exception 'Correction action must be correct or cancel';
  elsif public.current_app_role() = 'courier'
    and (p_action <> 'correct' or p_stop_status <> 'delivered') then
    raise exception 'Couriers can only correct delivered quantities and cannot cancel sales';
  elsif p_action = 'correct' and not coalesce((v_context->>'can_correct')::boolean, false) then
    raise exception '%', coalesce(v_context->>'blocker_reason', 'This bill cannot be corrected');
  elsif p_action = 'cancel' and not coalesce((v_context->>'can_cancel')::boolean, false) then
    raise exception '%', coalesce(v_context->>'blocker_reason', 'This bill cannot be cancelled');
  end if;

  if p_action = 'correct' then
    if jsonb_typeof(p_items) <> 'array' then raise exception 'Correction items must be an array'; end if;
    if p_stop_status = 'pending' then raise exception 'A correction cannot reset a shop to pending';
    elsif p_stop_status = 'delivered' and jsonb_array_length(p_items) = 0 then
      raise exception 'A delivered correction requires at least one item';
    elsif p_stop_status <> 'delivered' and jsonb_array_length(p_items) > 0 then
      raise exception 'A non-delivery correction cannot contain items';
    end if;
    if exists (
      select 1 from jsonb_to_recordset(p_items) item(ice_type_id uuid, quantity numeric)
      where item.ice_type_id is null or item.quantity is null or item.quantity <= 0
        or item.quantity * 2 <> trunc(item.quantity * 2)
    ) or exists (
      select 1 from jsonb_to_recordset(p_items) item(ice_type_id uuid, quantity numeric)
      group by item.ice_type_id having count(*) > 1
    ) then raise exception 'Every item must be distinct and use a positive whole or half-bag quantity'; end if;

    v_shop_id := (v_context->>'shop_id')::uuid;
    v_service_date := (v_context->>'service_date')::date;
    for v_item in select * from jsonb_to_recordset(p_items) item(ice_type_id uuid, quantity numeric)
    loop
      select original_item.unit_price into v_unit_price
      from public.delivery_items original_item
      where original_item.delivery_event_id = p_event_id
        and original_item.ice_type_id = v_item.ice_type_id;
      if v_unit_price is null then
        select resolved.unit_price into v_unit_price
        from public.resolve_delivery_price(v_shop_id, v_item.ice_type_id, v_service_date) resolved;
      end if;
      if v_unit_price is null then raise exception 'An effective price is required for every corrected item'; end if;
      v_new_amount := v_new_amount + v_item.quantity * v_unit_price;
    end loop;
  end if;

  v_allocated := coalesce((v_context->>'allocated_amount')::numeric, 0);
  v_charge_id := (v_context->>'charge_id')::uuid;
  v_payment_term := (v_context->>'payment_term')::public.payment_term;
  if p_action = 'correct' and p_stop_status = 'delivered' and v_payment_term = 'credit' then
    select profile.credit_limit into v_credit_limit
    from public.shop_payment_profiles profile where profile.shop_id = v_shop_id;
    select coalesce(sum(greatest(
      public.effective_delivery_charge_amount(charge.id) - coalesce(allocation.amount, 0), 0
    )), 0)::numeric(12,2)
    into v_credit_exposure
    from public.delivery_charges charge
    left join lateral (
      select coalesce(sum(payment_allocation.amount), 0)::numeric(12,2) as amount
      from public.payment_allocations payment_allocation
      join public.payments payment on payment.id = payment_allocation.payment_id
      where payment_allocation.charge_id = charge.id and payment.status = 'active'
    ) allocation on true
    where charge.shop_id = v_shop_id and charge.payment_term = 'credit'
      and charge.status = 'active' and charge.id <> v_charge_id;
    v_approval_required := v_credit_limit is not null
      and v_credit_exposure + greatest(v_new_amount - v_allocated, 0) > v_credit_limit;
  end if;
  return v_context || jsonb_build_object(
    'action', p_action,
    'new_amount', v_new_amount,
    'new_outstanding_amount', greatest(v_new_amount - v_allocated, 0),
    'outstanding_amount', greatest(v_new_amount - v_allocated, 0),
    'refund_amount', greatest(v_allocated - v_new_amount, 0),
    'approval_required', v_approval_required,
    'amount_delta', v_new_amount - coalesce((v_context->>'effective_amount')::numeric, 0),
    'stock_deltas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', all_items.ice_type_id,
        'name', ice.name,
        'unit', ice.unit,
        'quantity_delta', coalesce(original_item.quantity, 0) - coalesce(corrected.quantity, 0)
      ) order by ice.code)
      from (
        select item.ice_type_id from public.delivery_items item where item.delivery_event_id = p_event_id
        union
        select input.ice_type_id from jsonb_to_recordset(p_items) input(ice_type_id uuid, quantity numeric)
      ) all_items
      join public.ice_types ice on ice.id = all_items.ice_type_id
      left join public.delivery_items original_item
        on original_item.delivery_event_id = p_event_id and original_item.ice_type_id = all_items.ice_type_id
      left join jsonb_to_recordset(p_items) corrected(ice_type_id uuid, quantity numeric)
        on corrected.ice_type_id = all_items.ice_type_id
    ), '[]'::jsonb)
  );
end;
$$;

create function public.get_financial_refund_summary(
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
  v_gross_received numeric(12,2);
  v_refunded_amount numeric(12,2);
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view the financial refund summary';
  end if;

  select coalesce(sum(payment.received_amount - payment.change_amount), 0)::numeric(12,2)
  into v_gross_received
  from public.payments payment
  where payment.status = 'active'
    and (payment.recorded_at at time zone 'Asia/Bangkok')::date = v_service_date;

  select coalesce(sum(settlement.amount), 0)::numeric(12,2)
  into v_refunded_amount
  from public.refund_settlements settlement
  where (settlement.settled_at at time zone 'Asia/Bangkok')::date = v_service_date;

  return jsonb_build_object(
    'service_date', v_service_date,
    'gross_received', v_gross_received,
    'refunded_amount', v_refunded_amount,
    'net_received', (v_gross_received - v_refunded_amount)::numeric(12,2)
  );
end;
$$;

revoke all on function public.get_financial_refund_summary(date) from public;
grant execute on function public.get_financial_refund_summary(date) to authenticated;

notify pgrst, 'reload schema';
