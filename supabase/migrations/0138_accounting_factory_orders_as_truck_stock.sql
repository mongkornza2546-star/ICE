-- Align accounting reconciliation with the order-based truck stock model.
-- New factory orders count immediately; legacy orders with receipts retain actual quantities.

create or replace function public.accounting_aggregate_reconciliation_rows(p_service_date date)
returns table (
  id uuid,
  code text,
  name text,
  unit text,
  factory_in numeric,
  sold numeric,
  damaged numeric,
  returned_to_factory numeric,
  expected numeric,
  actual numeric,
  variance numeric,
  count_status text
)
language sql
stable
security definer
set search_path = public
as $$
  with ice as materialized (
    select ice_type.id, ice_type.code, ice_type.name, ice_type.unit
    from public.ice_types ice_type
    where ice_type.is_active
  ), source_latest as (
    select greatest(
      coalesce((select max(receipt.recorded_at)
        from public.factory_receipts receipt
        join public.stock_movements factory_order on factory_order.id = receipt.factory_order_id
        where factory_order.service_date = p_service_date and factory_order.status = 'active'
          and factory_order.kind = 'factory_order'), '-infinity'),
      coalesce((select max(recorded_at) from public.stock_movements where service_date = p_service_date), '-infinity'),
      coalesce((select max(event.recorded_at) from public.delivery_events event
        join public.round_stops stop on stop.id = event.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        where round.service_date = p_service_date), '-infinity'),
      coalesce((select max(revision.revised_at) from public.delivery_event_revisions revision
        join public.delivery_events event on event.id = revision.original_event_id
        join public.round_stops stop on stop.id = event.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        where round.service_date = p_service_date), '-infinity'),
      coalesce((select max(adjustment.created_at) from public.delivery_charge_adjustments adjustment
        join public.delivery_charges charge on charge.id = adjustment.charge_id
        where charge.service_date = p_service_date), '-infinity')
    ) as recorded_at
  ), aggregate_values as materialized (
    select ice.*,
      (coalesce((select sum(item.quantity)
        from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'factory_order' and item.ice_type_id = ice.id
          and not exists (select 1 from public.factory_receipts receipt
            where receipt.factory_order_id = movement.id)), 0)
       + coalesce((select sum(item.actual_quantity)
        from public.factory_receipts receipt
        join public.factory_receipt_items item on item.factory_receipt_id = receipt.id
        join public.stock_movements movement on movement.id = receipt.factory_order_id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'factory_order' and item.ice_type_id = ice.id), 0))::numeric as factory_in,
      (coalesce((select sum(item.quantity)
        from public.delivery_events event
        join public.delivery_items item on item.delivery_event_id = event.id
        join public.round_stops stop on stop.id = event.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        where round.service_date = p_service_date and event.status = 'active'
          and item.ice_type_id = ice.id), 0)
       + coalesce((select sum(item.quantity_delta)
        from public.delivery_charge_adjustments adjustment
        join public.delivery_adjustment_items item on item.adjustment_id = adjustment.idempotency_key
        join public.delivery_charges charge on charge.id = adjustment.charge_id
        where charge.service_date = p_service_date and adjustment.status = 'active'
          and item.ice_type_id = ice.id), 0))::numeric as sold,
      coalesce((select sum(item.quantity) from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'damage' and item.ice_type_id = ice.id), 0)::numeric as damaged,
      coalesce((select sum(item.quantity) from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'return_to_factory' and item.ice_type_id = ice.id), 0)::numeric as returned_to_factory
    from ice
  )
  select value.*,
    value.factory_in - value.sold - value.damaged - value.returned_to_factory as expected,
    case when closure.service_date is not null
      and closure.closed_at >= latest.recorded_at
      and (select count(*) from public.daily_aggregate_stock_closure_items item
        where item.service_date = p_service_date) = (select count(*) from ice)
      then closure_item.actual_quantity end as actual,
    case when closure.service_date is not null
      and closure.closed_at >= latest.recorded_at
      and (select count(*) from public.daily_aggregate_stock_closure_items item
        where item.service_date = p_service_date) = (select count(*) from ice)
      then closure_item.actual_quantity
        - (value.factory_in - value.sold - value.damaged - value.returned_to_factory) end as variance,
    case
      when closure.service_date is null or (select count(*) from public.daily_aggregate_stock_closure_items item
        where item.service_date = p_service_date) <> (select count(*) from ice) then 'incomplete'
      when closure.closed_at < latest.recorded_at then 'stale'
      else 'complete'
    end as count_status
  from aggregate_values value
  cross join source_latest latest
  left join public.daily_aggregate_stock_closures closure on closure.service_date = p_service_date
  left join public.daily_aggregate_stock_closure_items closure_item
    on closure_item.service_date = p_service_date and closure_item.ice_type_id = value.id;
$$;

create or replace function public.get_accounting_reconciliation(p_service_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view accounting reconciliation';
  elsif p_service_date is null then
    raise exception 'An accounting service date is required';
  end if;

  with ice as materialized (
    select id, code, name, unit from public.ice_types where is_active
  ), aggregate_rows as materialized (
    select * from public.accounting_aggregate_reconciliation_rows(p_service_date)
  ), locations as materialized (
    select location.* from public.stock_locations location
    where location.holds_inventory and location.is_active
  ), latest_counts as materialized (
    select distinct on (snapshot.location_id)
      snapshot.location_id, snapshot.id, snapshot.counted_at
    from public.stock_count_snapshots snapshot
    where snapshot.service_date = p_service_date
    order by snapshot.location_id, snapshot.counted_at desc, snapshot.id desc
  ), holder_rows as materialized (
    select location.id location_id, location.name location_name, location.kind::text location_kind,
      assigned.display_name employee_name, ice.id ice_type_id, ice.name ice_type_name, ice.unit,
      (coalesce((select sum(item.quantity)
        from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'factory_order' and movement.to_location_id = location.id
          and item.ice_type_id = ice.id
          and not exists (select 1 from public.factory_receipts receipt
            where receipt.factory_order_id = movement.id)), 0)
       + coalesce((select sum(item.actual_quantity) from public.factory_receipts receipt
        join public.factory_receipt_items item on item.factory_receipt_id = receipt.id
        join public.stock_movements factory_order on factory_order.id = receipt.factory_order_id
        where factory_order.service_date = p_service_date and factory_order.status = 'active'
          and factory_order.kind = 'factory_order' and factory_order.to_location_id = location.id
          and item.ice_type_id = ice.id), 0))::numeric factory_in,
      (coalesce((select sum(item.quantity) from public.delivery_events event
        join public.delivery_items item on item.delivery_event_id = event.id
        join public.round_stops stop on stop.id = event.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        where round.service_date = p_service_date and event.status = 'active'
          and event.source_stock_location_id = location.id and item.ice_type_id = ice.id), 0)
       + coalesce((select sum(item.quantity_delta)
        from public.delivery_charge_adjustments adjustment
        join public.delivery_adjustment_items item on item.adjustment_id = adjustment.idempotency_key
        join public.delivery_charges charge on charge.id = adjustment.charge_id
        join public.delivery_events event on event.id = charge.delivery_event_id
        where charge.service_date = p_service_date and adjustment.status = 'active'
          and event.source_stock_location_id = location.id and item.ice_type_id = ice.id), 0))::numeric sold,
      coalesce((select sum(item.quantity) from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'damage' and movement.from_location_id = location.id
          and item.ice_type_id = ice.id), 0)::numeric damaged,
      coalesce((select sum(item.quantity) from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'return_to_factory' and movement.from_location_id = location.id
          and item.ice_type_id = ice.id), 0)::numeric returned_to_factory,
      (coalesce((select sum(item.quantity) from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'transfer' and movement.to_location_id = location.id
          and item.ice_type_id = ice.id), 0)
       - coalesce((select sum(item.quantity) from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'transfer' and movement.from_location_id = location.id
          and item.ice_type_id = ice.id), 0))::numeric transfer_net,
      count_item.actual_quantity::numeric actual_raw,
      latest_count.counted_at,
      (select count(*) from public.stock_count_snapshot_items item
        where item.snapshot_id = latest_count.id) = (select count(*) from ice) count_complete,
      greatest(
        coalesce((select max(movement.recorded_at) from public.stock_movements movement
          where movement.service_date = p_service_date
            and (movement.from_location_id = location.id or movement.to_location_id = location.id)), '-infinity'),
        coalesce((select max(receipt.recorded_at) from public.factory_receipts receipt
          join public.stock_movements factory_order on factory_order.id = receipt.factory_order_id
          where factory_order.service_date = p_service_date and factory_order.status = 'active'
            and factory_order.kind = 'factory_order'
            and factory_order.to_location_id = location.id), '-infinity'),
        coalesce((select max(event.recorded_at) from public.delivery_events event
          join public.round_stops stop on stop.id = event.round_stop_id
          join public.delivery_rounds round on round.id = stop.round_id
          where round.service_date = p_service_date and event.source_stock_location_id = location.id), '-infinity'),
        coalesce((select max(revision.revised_at)
          from public.delivery_event_revisions revision
          join public.delivery_events original_event on original_event.id = revision.original_event_id
          left join public.delivery_events replacement_event on replacement_event.id = revision.replacement_event_id
          join public.round_stops stop on stop.id = original_event.round_stop_id
          join public.delivery_rounds round on round.id = stop.round_id
          where round.service_date = p_service_date and (
            original_event.source_stock_location_id = location.id
            or replacement_event.source_stock_location_id = location.id
          )), '-infinity'),
        coalesce((select max(adjustment.created_at)
          from public.delivery_charge_adjustments adjustment
          join public.delivery_charges charge on charge.id = adjustment.charge_id
          join public.delivery_events event on event.id = charge.delivery_event_id
          where charge.service_date = p_service_date
            and event.source_stock_location_id = location.id), '-infinity')
      ) source_recorded_at
    from locations location
    cross join ice
    left join public.users assigned on assigned.id = location.assigned_user_id
    left join latest_counts latest_count on latest_count.location_id = location.id
    left join public.stock_count_snapshot_items count_item
      on count_item.snapshot_id = latest_count.id and count_item.ice_type_id = ice.id
  ), holder_json as (
    select location_id, min(location_name) location_name, min(location_kind) location_kind,
      min(employee_name) employee_name,
      jsonb_agg(jsonb_build_object(
        'ice_type_id', ice_type_id, 'ice_type_name', ice_type_name, 'unit', unit,
        'factory_in', factory_in, 'sold', sold, 'damaged', damaged,
        'returned_to_factory', returned_to_factory,
        'expected', factory_in + transfer_net - sold - damaged - returned_to_factory,
        'actual', case when count_complete and counted_at >= source_recorded_at then actual_raw end,
        'variance', case when count_complete and counted_at >= source_recorded_at then
          actual_raw - (factory_in + transfer_net - sold - damaged - returned_to_factory) end,
        'count_status', case when not coalesce(count_complete, false) then 'incomplete'
          when counted_at < source_recorded_at then 'stale' else 'complete' end
      ) order by ice_type_name) items
    from holder_rows
    group by location_id
  ), financial as (
    select
      coalesce((select sum(public.effective_delivery_charge_amount(charge.id))
        from public.delivery_charges charge
        where charge.service_date = p_service_date and charge.status = 'active'), 0)::numeric effective_sales,
      coalesce((select sum(allocation.amount) from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id and payment.status = 'active'
        join public.delivery_charges charge on charge.id = allocation.charge_id
        where charge.service_date = p_service_date and charge.status = 'active'), 0)::numeric allocated_to_sales,
      coalesce((select sum(greatest(public.effective_delivery_charge_amount(charge.id)
          - coalesce(allocated.amount, 0), 0)) from public.delivery_charges charge
        left join lateral (select sum(allocation.amount) amount from public.payment_allocations allocation
          join public.payments payment on payment.id = allocation.payment_id
          where allocation.charge_id = charge.id and payment.status = 'active') allocated on true
        where charge.service_date = p_service_date and charge.status = 'active'
          and charge.payment_term <> 'credit'), 0)::numeric outstanding_collectible,
      coalesce((select sum(greatest(public.effective_delivery_charge_amount(charge.id)
          - coalesce(allocated.amount, 0), 0)) from public.delivery_charges charge
        left join lateral (select sum(allocation.amount) amount from public.payment_allocations allocation
          join public.payments payment on payment.id = allocation.payment_id
          where allocation.charge_id = charge.id and payment.status = 'active') allocated on true
        where charge.service_date = p_service_date and charge.status = 'active'
          and charge.payment_term = 'credit'), 0)::numeric outstanding_credit,
      coalesce((select sum(payment.allocated_amount) from public.payments payment
        where payment.status = 'active'
          and (payment.recorded_at at time zone 'Asia/Bangkok')::date = p_service_date), 0)::numeric cash_received,
      coalesce((select sum(settlement.amount) from public.refund_settlements settlement
        where (settlement.settled_at at time zone 'Asia/Bangkok')::date = p_service_date), 0)::numeric cash_refunded,
      coalesce((select sum(obligation.amount) from public.refund_obligations obligation
        where obligation.status = 'pending'), 0)::numeric pending_refunds
  )
  select jsonb_build_object(
    'service_date', p_service_date,
    'aggregate', coalesce((select jsonb_agg(jsonb_build_object(
      'ice_type_id', id, 'ice_type_name', name, 'unit', unit,
      'factory_in', factory_in, 'sold', sold, 'damaged', damaged,
      'returned_to_factory', returned_to_factory, 'expected', expected,
      'actual', actual, 'variance', variance, 'count_status', count_status
    ) order by code) from aggregate_rows), '[]'::jsonb),
    'holders', coalesce((select jsonb_agg(jsonb_build_object(
      'location_id', location_id, 'location_name', location_name,
      'location_kind', location_kind, 'employee_name', employee_name, 'items', items
    ) order by location_name) from holder_json), '[]'::jsonb),
    'financial', (select jsonb_build_object(
      'effective_sales', effective_sales, 'allocated_to_sales', allocated_to_sales,
      'outstanding_collectible', outstanding_collectible, 'outstanding_credit', outstanding_credit,
      'cash_received', cash_received, 'cash_refunded', cash_refunded,
      'net_cash', cash_received - cash_refunded, 'pending_refunds', pending_refunds
    ) from financial)
  ) into v_result;
  return v_result;
end;
$$;

notify pgrst, 'reload schema';
