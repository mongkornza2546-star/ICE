-- Delivery slips are cancelled and re-entered instead of edited.
-- Preserve the existing atomic cancellation, stock, payment and audit implementation.

create or replace function public.get_delivery_correction_context(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_event public.delivery_events%rowtype;
  v_round public.delivery_rounds%rowtype;
  v_stop public.round_stops%rowtype;
  v_charge public.delivery_charges%rowtype;
  v_allocated numeric(12,2) := 0;
  v_is_latest boolean := false;
  v_day_closed boolean := false;
  v_can_correct boolean := false;
  v_can_cancel boolean := false;
  v_blocker text;
begin
  perform public.require_regular_delivery_event(p_event_id);
  if not public.is_active_user() then raise exception 'An active user is required'; end if;

  select event.* into v_event from public.delivery_events event where event.id = p_event_id;
  if v_event.id is null then raise exception 'The selected delivery event does not exist'; end if;
  select stop.* into v_stop from public.round_stops stop where stop.id = v_event.round_stop_id;
  select round.* into v_round from public.delivery_rounds round where round.id = v_stop.round_id;
  select charge.* into v_charge from public.delivery_charges charge where charge.delivery_event_id = v_event.id;

  select coalesce(sum(allocation.amount), 0)::numeric(12,2)
  into v_allocated
  from public.payment_allocations allocation
  join public.payments payment on payment.id = allocation.payment_id and payment.status = 'active'
  where allocation.charge_id = v_charge.id;

  select not exists (
    select 1 from public.delivery_events newer
    where newer.round_stop_id = v_event.round_stop_id and newer.status = 'active'
      and (newer.recorded_at, newer.id) > (v_event.recorded_at, v_event.id)
  ) into v_is_latest;
  select exists (
    select 1 from public.daily_stock_closures closure
    where closure.service_date = v_round.service_date and closure.status = 'closed'
  ) or exists (
    select 1 from public.daily_aggregate_stock_closures closure
    where closure.service_date = v_round.service_date and closure.status = 'closed'
  ) into v_day_closed;

  if v_event.status <> 'active' then v_blocker := 'รายการนี้ถูกยกเลิกหรือแทนที่แล้ว';
  elsif not v_is_latest then v_blocker := 'รายการนี้ไม่ใช่รายการล่าสุดของร้านในรอบ';
  elsif v_round.status <> 'open' then v_blocker := 'รอบส่งปิดแล้ว ไม่สามารถยกเลิกใบส่งได้';
  elsif v_day_closed then v_blocker := 'วันทำงานปิดแล้ว ไม่สามารถยกเลิกใบส่งได้';
  elsif v_charge.id is null then v_blocker := 'รายการเดิมนี้ไม่มีข้อมูลบิลและราคา';
  elsif public.current_app_role() = 'courier' and v_event.recorded_by <> auth.uid() then
    v_blocker := 'พนักงานยกเลิกได้เฉพาะรายการที่ตนเองบันทึก';
  elsif public.current_app_role() = 'courier' and v_allocated > 0 then
    v_blocker := 'บิลรับชำระแล้ว ต้องให้หัวหน้าหรือแอดมินยกเลิก';
  elsif public.current_app_role() = 'courier'
    and v_round.service_date <> (now() at time zone 'Asia/Bangkok')::date then
    v_blocker := 'พนักงานยกเลิกได้เฉพาะรายการของวันนี้';
  elsif public.current_app_role() not in ('courier', 'round_lead', 'admin') then
    v_blocker := 'ผู้ใช้ไม่มีสิทธิ์ยกเลิกใบส่ง';
  end if;

  v_can_correct := false;
  v_can_cancel := v_blocker is null;
  if not v_can_cancel
    and v_event.status = 'active'
    and v_is_latest
    and v_charge.payment_term = 'immediate'
    and public.current_app_role() in ('round_lead', 'admin')
    and not exists (
      select 1
      from public.payment_allocations allocation
      join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = v_charge.id and payment.status = 'active'
    ) then
    v_can_cancel := true;
    v_blocker := null;
  end if;

  return jsonb_build_object(
    'delivery_event_id', v_event.id,
    'round_stop_id', v_event.round_stop_id,
    'charge_id', v_charge.id,
    'charge_number', v_charge.charge_number,
    'shop_id', v_stop.shop_id,
    'shop_name', v_stop.shop_name_snapshot,
    'service_date', v_round.service_date,
    'round_status', v_round.status,
    'day_closed', v_day_closed,
    'is_latest', v_is_latest,
    'recorded_by', v_event.recorded_by,
    'payment_term', v_charge.payment_term,
    'due_date', v_charge.due_date,
    'note', v_event.note,
    'original_amount', v_charge.original_amount,
    'effective_amount', public.effective_delivery_charge_amount(v_charge.id),
    'allocated_amount', v_allocated,
    'can_correct', v_can_correct,
    'can_cancel', v_can_cancel,
    'blocker_reason', v_blocker,
    'ice_types', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', ice.id,
        'code', ice.code,
        'name', ice.name,
        'unit', ice.unit,
        'unit_price', coalesce(original_item.unit_price, resolved.unit_price)
      ) order by ice.code)
      from public.ice_types ice
      left join public.delivery_items original_item
        on original_item.delivery_event_id = v_event.id and original_item.ice_type_id = ice.id
      left join lateral public.resolve_delivery_price(v_stop.shop_id, ice.id, v_round.service_date) resolved on true
      where ice.is_active or original_item.delivery_event_id is not null
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', all_items.ice_type_id, 'name', ice.name, 'unit', ice.unit,
        'quantity', coalesce(original_item.quantity, 0) + coalesce(adjustments.quantity_delta, 0),
        'unit_price', coalesce(original_item.unit_price, resolved.unit_price)
      ) order by ice.code)
      from (
        select item.ice_type_id
        from public.delivery_items item where item.delivery_event_id = v_event.id
        union
        select adjustment_item.ice_type_id
        from public.delivery_charge_adjustments adjustment
        join public.delivery_adjustment_items adjustment_item
          on adjustment_item.adjustment_id = adjustment.idempotency_key
        where adjustment.charge_id = v_charge.id and adjustment.status = 'active'
      ) all_items
      join public.ice_types ice on ice.id = all_items.ice_type_id
      left join public.delivery_items original_item
        on original_item.delivery_event_id = v_event.id and original_item.ice_type_id = all_items.ice_type_id
      left join lateral (
        select coalesce(sum(adjustment_item.quantity_delta), 0)::numeric(12,1) as quantity_delta
        from public.delivery_charge_adjustments adjustment
        join public.delivery_adjustment_items adjustment_item
          on adjustment_item.adjustment_id = adjustment.idempotency_key
        where adjustment.charge_id = v_charge.id and adjustment.status = 'active'
          and adjustment_item.ice_type_id = all_items.ice_type_id
      ) adjustments on true
      left join lateral public.resolve_delivery_price(v_stop.shop_id, all_items.ice_type_id, v_round.service_date) resolved on true
    ), '[]'::jsonb)
  );
end;
$$;

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
  v_allocated numeric(12,2);
begin
  perform public.require_regular_delivery_event(p_event_id);
  if p_action is distinct from 'cancel' then
    raise exception 'Delivery slips can only be cancelled; record a new delivery instead';
  end if;
  if p_items is distinct from '[]'::jsonb then
    raise exception 'A cancellation cannot contain replacement items';
  end if;
  v_context := public.get_delivery_correction_context(p_event_id);
  if not coalesce((v_context->>'can_cancel')::boolean, false) then
    raise exception '%', coalesce(v_context->>'blocker_reason', 'This bill cannot be cancelled');
  end if;
  v_allocated := coalesce((v_context->>'allocated_amount')::numeric, 0);
  return v_context || jsonb_build_object(
    'action', 'cancel', 'new_amount', 0,
    'new_outstanding_amount', 0, 'outstanding_amount', 0,
    'refund_amount', v_allocated, 'approval_required', false,
    'amount_delta', -coalesce((v_context->>'effective_amount')::numeric, 0),
    'stock_deltas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', item.ice_type_id, 'name', ice.name,
        'unit', ice.unit, 'quantity_delta', item.quantity
      ) order by ice.code)
      from public.delivery_items item
      join public.ice_types ice on ice.id = item.ice_type_id
      where item.delivery_event_id = p_event_id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.apply_open_event_delivery_correction(
  p_event_id uuid,
  p_action text,
  p_items jsonb,
  p_stop_status public.shop_round_status,
  p_note text,
  p_reason text,
  p_idempotency_key uuid,
  p_approval_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_approval_id is not null then
    raise exception 'Event end-of-day corrections do not use shop financial approvals';
  end if;
  if p_action is distinct from 'cancel' then
    raise exception 'Delivery slips can only be cancelled; record a new delivery instead';
  end if;
  perform public.get_event_delivery_correction_context(p_event_id);
  perform set_config('app.event_correction_id', p_event_id::text, true);
  return public.apply_open_delivery_correction(
    p_event_id, p_action, p_items, p_stop_status, p_note, p_reason,
    p_idempotency_key, null
  );
end;
$$;

create or replace function public.create_closed_delivery_adjustment(
  p_event_id uuid,
  p_items jsonb,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Delivery slips cannot be edited after closing';
end;
$$;

-- The older manager revision RPC is still executable by authenticated users.
-- Fence it too, including calls from clients that predate the cancel-only UI.
do $cancel_only_legacy_revision$
declare
  v_definition text;
  v_updated text;
  v_marker text := $marker$  elsif p_action not in ('cancel', 'correct') then
    raise exception 'The revision action must be cancel or correct';$marker$;
begin
  select pg_get_functiondef(
    'public.revise_delivery_event(uuid,text,jsonb,public.shop_round_status,text,text,uuid,uuid)'::regprocedure
  ) into v_definition;
  if position(v_marker in v_definition) = 0 then
    raise exception 'revise_delivery_event does not contain the expected action guard';
  end if;
  v_updated := replace(v_definition, v_marker,
    $replacement$  elsif p_action is distinct from 'cancel' then
    raise exception 'Delivery slips can only be cancelled; record a new delivery instead';$replacement$
  );
  execute v_updated;
end;
$cancel_only_legacy_revision$;

-- Give event history the same server-side eligibility as the cancel dialog.
do $event_history_cancellation$
declare
  v_definition text;
  v_marker text := $marker$          'delivery_event_id', delivery.id,
          'recorded_at', delivery.recorded_at,$marker$;
begin
  select pg_get_functiondef('public.get_event_delivery_cards(uuid,uuid,text)'::regprocedure)
  into v_definition;
  if position(v_marker in v_definition) = 0 then
    raise exception 'get_event_delivery_cards does not contain the expected history fields';
  end if;
  execute replace(v_definition, v_marker,
    $replacement$          'delivery_event_id', delivery.id,
          'can_cancel', (public.get_event_delivery_correction_context(delivery.id)->>'can_cancel')::boolean,
          'recorded_at', delivery.recorded_at,$replacement$
  );
end;
$event_history_cancellation$;

notify pgrst, 'reload schema';
