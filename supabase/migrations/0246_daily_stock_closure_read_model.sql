-- Keep saved closing counts independent of later catalog activation changes.
-- Update the base read model; the 0179 wrapper still adds casual-sale totals.
create or replace function public.get_daily_aggregate_stock_summary_without_casual(
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
    (clock_timestamp() at time zone 'Asia/Bangkok')::date
  );
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  end if;

  return (
    with selected_ice_types as (
      -- Closed days use the saved membership, even for inactive products.
      select ice.*
      from public.daily_aggregate_stock_closure_items item
      join public.ice_types ice on ice.id = item.ice_type_id
      where item.service_date = v_service_date
      union all
      -- Open days continue to use the current active catalog.
      select ice.*
      from public.ice_types ice
      where ice.is_active
        and not exists (
          select 1 from public.daily_aggregate_stock_closures
          where service_date = v_service_date
        )
    )
    select jsonb_build_object(
    'service_date', v_service_date,
    'closed_at', (select closed_at from public.daily_aggregate_stock_closures where service_date = v_service_date),
    'status', case when exists (
      select 1 from public.daily_aggregate_stock_closures
      where service_date = v_service_date
    ) then 'closed' else 'open' end,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', ice.id,
        'code', ice.code,
        'name', ice.name,
        'unit', ice.unit,
        'ordered_quantity', totals.ordered_quantity,
        'sold_quantity', totals.sold_quantity,
        'refill_quantity', totals.refill_quantity,
        'damaged_quantity', totals.damaged_quantity,
        'returned_quantity', (
          totals.returned_quantity + coalesce(closure_item.actual_quantity, 0)
        )::numeric(12,1),
        'available_quantity', public.daily_aggregate_stock_balance_at(v_service_date, ice.id),
        'system_quantity', closure_item.system_quantity,
        'note', closure_item.note,
        'actual_quantity', closure_item.actual_quantity,
        'variance_quantity', closure_item.variance_quantity
      ) order by ice.code)
      from selected_ice_types ice
      cross join lateral (
        select
          (
            coalesce((
              select sum(item.quantity)
              from public.stock_movements movement
              join public.stock_movement_items item on item.movement_id = movement.id
              where movement.service_date = v_service_date
                and movement.status = 'active'
                and movement.kind = 'factory_order'
                and item.ice_type_id = ice.id
                and not exists (
                  select 1
                  from public.factory_receipts receipt
                  where receipt.factory_order_id = movement.id
                )
            ), 0)
            + coalesce((
              select sum(item.actual_quantity)
              from public.factory_receipts receipt
              join public.factory_receipt_items item
                on item.factory_receipt_id = receipt.id
              join public.stock_movements movement
                on movement.id = receipt.factory_order_id
              where receipt.service_date = v_service_date
                and movement.status = 'active'
                and item.ice_type_id = ice.id
            ), 0)
          )::numeric(12,1) as ordered_quantity,
          coalesce((
            select sum(item.quantity)
            from public.delivery_events event
            join public.delivery_items item on item.delivery_event_id = event.id
            join public.round_stops stop on stop.id = event.round_stop_id
            join public.delivery_rounds round on round.id = stop.round_id
            where round.service_date = v_service_date
              and event.status = 'active'
              and event.source_stock_location_id is not null
              and item.ice_type_id = ice.id
          ), 0)::numeric(12,1) as sold_quantity,
          coalesce((
            select sum(item.quantity)
            from public.daily_stock_uses usage
            join public.daily_stock_use_items item on item.use_id = usage.id
            where usage.service_date = v_service_date
              and usage.status = 'active'
              and item.ice_type_id = ice.id
          ), 0)::numeric(12,1) as refill_quantity,
          coalesce((
            select sum(item.quantity)
            from public.stock_movements movement
            join public.stock_movement_items item on item.movement_id = movement.id
            where movement.service_date = v_service_date
              and movement.status = 'active'
              and movement.kind = 'damage'
              and item.ice_type_id = ice.id
          ), 0)::numeric(12,1) as damaged_quantity,
          coalesce((
            select sum(item.quantity)
            from public.stock_movements movement
            join public.stock_movement_items item on item.movement_id = movement.id
            where movement.service_date = v_service_date
              and movement.status = 'active'
              and movement.kind = 'return_to_factory'
              and item.ice_type_id = ice.id
          ), 0)::numeric(12,1) as returned_quantity
      ) totals
      left join public.daily_aggregate_stock_closure_items closure_item
        on closure_item.service_date = v_service_date
       and closure_item.ice_type_id = ice.id
    ), '[]'::jsonb)
  ));
end;
$$;

revoke all on function public.get_daily_aggregate_stock_summary_without_casual(date) from public, anon, authenticated;
