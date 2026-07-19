-- Migration 0023: Add cancel_factory_order function

create or replace function public.cancel_factory_order(
  p_movement_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_movement public.stock_movements%rowtype;
  v_item record;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can cancel factory orders';
  end if;

  if p_movement_id is null then
    raise exception 'A movement ID is required';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A cancellation reason is required';
  end if;

  select * into v_movement
  from public.stock_movements
  where id = p_movement_id
  for update;

  if not found then
    raise exception 'The selected factory order does not exist';
  end if;

  if v_movement.kind <> 'factory_order' then
    raise exception 'Only factory orders can be cancelled';
  end if;

  if v_movement.status = 'cancelled' then
    raise exception 'The selected factory order is already cancelled';
  end if;

  -- Lock service date to prevent races with daily stock close or other movements
  perform pg_advisory_xact_lock(hashtextextended(v_movement.service_date::text, 0));

  if exists (
    select 1
    from public.daily_stock_closures closure
    where closure.service_date = v_movement.service_date
      and closure.status = 'closed'
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  for v_item in
    select item.ice_type_id, item.quantity
    from public.stock_movement_items item
    where item.movement_id = p_movement_id
  loop
    if public.stock_balance_at(
      v_movement.service_date,
      v_movement.to_location_id,
      v_item.ice_type_id
    ) < v_item.quantity then
      raise exception 'Cancelling this factory order would make truck stock negative';
    end if;
  end loop;

  update public.stock_movements
  set status = 'cancelled',
      cancelled_by = auth.uid(),
      cancelled_at = now(),
      cancellation_reason = trim(p_reason)
  where id = p_movement_id;

  insert into public.audit_logs (
    actor_id,
    entity_type,
    entity_id,
    action,
    after_value
  ) values (
    auth.uid(),
    'stock_movements',
    p_movement_id,
    'cancelled',
    jsonb_build_object(
      'status', 'cancelled',
      'cancellation_reason', trim(p_reason),
      'cancelled_by', auth.uid(),
      'cancelled_at', now()
    )
  );

  return public.get_factory_order_summary(
    v_movement.service_date,
    v_movement.to_location_id,
    50
  );
end;
$$;

grant execute on function public.cancel_factory_order(uuid, text) to authenticated;
