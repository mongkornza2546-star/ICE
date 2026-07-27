-- New factory orders become available immediately at their ordered quantity.
-- Orders that already have a legacy receipt keep using the immutable actual
-- receipt quantity so this model change does not rewrite historical balances.

create or replace function public.stock_balance_at(
  p_service_date date,
  p_location_id uuid,
  p_ice_type_id uuid
)
returns numeric(12, 1)
language sql
stable
security definer
set search_path = public
as $$
  with movement_totals as (
    select
      coalesce(sum(item.quantity) filter (where movement.to_location_id = p_location_id), 0)
        - coalesce(sum(item.quantity) filter (where movement.from_location_id = p_location_id), 0)
        as quantity
    from public.stock_movements movement
    join public.stock_movement_items item on item.movement_id = movement.id
    where movement.service_date = p_service_date
      and movement.status = 'active'
      and (
        movement.kind <> 'factory_order'
        or not exists (
          select 1
          from public.factory_receipts receipt
          where receipt.factory_order_id = movement.id
        )
      )
      and item.ice_type_id = p_ice_type_id
      and (movement.from_location_id = p_location_id or movement.to_location_id = p_location_id)
  ), delivery_totals as (
    select coalesce(sum(item.quantity), 0) as quantity
    from public.delivery_events event
    join public.delivery_items item on item.delivery_event_id = event.id
    join public.round_stops stop on stop.id = event.round_stop_id
    join public.delivery_rounds round on round.id = stop.round_id
    where round.service_date = p_service_date
      and event.status = 'active'
      and event.source_stock_location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
  ), receipt_totals as (
    select coalesce(sum(item.actual_quantity), 0) as quantity
    from public.factory_receipts receipt
    join public.factory_receipt_items item on item.factory_receipt_id = receipt.id
    join public.stock_movements factory_order on factory_order.id = receipt.factory_order_id
    where receipt.service_date = p_service_date
      and receipt.truck_location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
      and factory_order.status = 'active'
  ), count_adjustment as (
    select coalesce(sum(item.variance_quantity), 0) as quantity
    from public.daily_stock_closure_items item
    join public.daily_stock_closures closure on closure.service_date = item.service_date
    where item.service_date = p_service_date
      and item.location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
      and closure.status in ('closing', 'closed')
  )
  select (
    movement_totals.quantity
    - delivery_totals.quantity
    + receipt_totals.quantity
    + count_adjustment.quantity
  )::numeric(12, 1)
  from movement_totals, delivery_totals, receipt_totals, count_adjustment;
$$;

-- Compatibility shims keep a stale pre-0103 browser tab from failing its
-- initial parallel RPC load. They do not restore the retired receipt workflow.
create or replace function public.get_factory_receipt_summary(
  p_service_date date,
  p_truck_location_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_truck_id uuid := p_truck_location_id;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view factory receipts';
  end if;

  if p_service_date is null then
    raise exception 'A factory receipt service date is required';
  end if;

  if v_truck_id is null then
    select location.id into v_truck_id
    from public.stock_locations location
    where location.kind = 'truck'
      and location.is_active
      and location.is_courier_source
    order by location.code
    limit 1;
  end if;

  return jsonb_build_object(
    'service_date', p_service_date,
    'truck_location_id', v_truck_id,
    'truck_location_name', (
      select location.name
      from public.stock_locations location
      where location.id = v_truck_id
    ),
    'receipts', '[]'::jsonb
  );
end;
$$;

create or replace function public.record_factory_receipt(
  p_factory_order_id uuid,
  p_items jsonb,
  p_note text default null,
  p_idempotency_key uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can record factory receipts';
  end if;

  raise exception 'Factory receipt workflow is retired; refresh the application';
end;
$$;

comment on function public.get_factory_receipt_summary(date, uuid) is
  'Deprecated compatibility shim for stale clients; always returns no pending receipts.';
comment on function public.record_factory_receipt(uuid, jsonb, text, uuid) is
  'Deprecated compatibility shim for stale clients; writes are rejected.';

revoke all on function public.get_factory_receipt_summary(date, uuid) from public;
grant execute on function public.get_factory_receipt_summary(date, uuid) to authenticated;
revoke all on function public.record_factory_receipt(uuid, jsonb, text, uuid) from public;
grant execute on function public.record_factory_receipt(uuid, jsonb, text, uuid) to authenticated;

notify pgrst, 'reload schema';
