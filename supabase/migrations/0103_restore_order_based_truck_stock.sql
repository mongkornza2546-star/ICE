-- Factory orders are the truck's opening stock. The end-of-day truck count,
-- together with recorded outgoing transfers, is the reconciliation point.
-- Keep legacy receipt rows for audit history, but retire the receipt workflow.

drop trigger if exists daily_stock_closures_require_factory_receipts
  on public.daily_stock_closures;
drop trigger if exists stock_movements_prevent_received_factory_order_cancellation
  on public.stock_movements;

drop function if exists public.record_factory_receipt(uuid, jsonb, text, uuid);
drop function if exists public.get_factory_receipt_summary(date, uuid);
drop function if exists public.prevent_daily_close_with_pending_factory_receipts();
drop function if exists public.prevent_received_factory_order_cancellation();

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
    + count_adjustment.quantity
  )::numeric(12, 1)
  from movement_totals, delivery_totals, count_adjustment;
$$;

comment on table public.factory_receipts is
  'Legacy factory receipt audit rows; the active stock flow uses factory orders and end-of-day counts.';
comment on table public.factory_receipt_items is
  'Legacy factory receipt item audit rows; excluded from active stock balances.';
