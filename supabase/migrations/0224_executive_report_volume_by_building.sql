-- Keep the overall volume contract and add a breakdown from the same sources.
-- Delivery quantities belong to destinations, not to the truck supplying them.
create function public.executive_report_volume_areas(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = public as $$
  with charges as materialized (
    select charge.id, event.id as event_id, event.status as event_status,
      case when coalesce(participation.event_job_id, synthetic_job.id) is not null then 'event'
        when coalesce(stop.building_id_snapshot, shop.building_id) is not null then 'building'
        else 'unknown' end as kind,
      coalesce(participation.event_job_id, synthetic_job.id, stop.building_id_snapshot, shop.building_id) as area_id,
      coalesce(job.name, synthetic_job.name, stop.building_name_snapshot, building.name, 'ไม่ระบุตึก') as area_name
    from public.delivery_charges charge
    left join public.delivery_events event on event.id = charge.delivery_event_id
    left join public.shops shop on shop.id = charge.shop_id
    left join public.round_stops stop on stop.id = event.round_stop_id
    left join public.buildings building on building.id = coalesce(stop.building_id_snapshot, shop.building_id)
    left join public.event_settlement_contexts context on context.id = charge.event_settlement_context_id
    left join public.event_participations participation
      on participation.id = coalesce(context.event_participation_id, stop.event_participation_id)
    left join public.event_jobs job on job.id = participation.event_job_id
    left join public.event_jobs synthetic_job on upper(building.code) = upper('EVENT-' || synthetic_job.id::text)
    where charge.status = 'active' and charge.service_date between p_from and p_to
  ), quantities as (
    select charge.kind, charge.area_id, charge.area_name, item.ice_type_id,
      item.quantity as delivered, 0::numeric as damaged
    from charges charge
    join public.delivery_items item on item.delivery_event_id = charge.event_id
    where charge.event_status = 'active'
    union all
    -- Match the existing report's active charge adjustment projection.
    select charge.kind, charge.area_id, charge.area_name, item.ice_type_id, item.quantity_delta, 0
    from charges charge
    join public.delivery_charge_adjustments adjustment on adjustment.charge_id = charge.id
    join public.delivery_adjustment_items item on item.adjustment_id = adjustment.idempotency_key
    where adjustment.status = 'active'
    union all
    -- A stock source is not proof of a delivery destination for a walk-up sale.
    select 'casual', null::uuid, 'ขายหน้ารถ', casual.ice_type_id, casual.quantity, 0
    from public.casual_transactions casual
    where casual.transaction_kind = 'paid' and casual.status = 'active'
      and casual.service_date between p_from and p_to
    union all
    -- Conversion must round per day and holding location before aggregation.
    select 'casual', null::uuid, 'ขายหน้ารถ', bucket.ice_type_id, bucket.quantity, 0
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') day(service_date)
    cross join lateral public.casual_loose_stock_totals(day.service_date::date) bucket
    union all
    select case when job.id is not null then 'event'
        when location.building_id is not null then 'building' else 'stock' end,
      coalesce(job.id, location.building_id, location.id),
      coalesce(job.name, building.name, location.name, 'ไม่ระบุจุดสต็อก'),
      item.ice_type_id, 0, item.quantity
    from public.stock_movements movement
    join public.stock_movement_items item on item.movement_id = movement.id
    left join public.stock_locations location on location.id = movement.from_location_id
    left join public.buildings building on building.id = location.building_id
    left join public.event_jobs job on upper(building.code) = upper('EVENT-' || job.id::text)
    where movement.kind = 'damage' and movement.status = 'active'
      and movement.service_date between p_from and p_to
  ), totals as (
    select kind, area_id, max(area_name) as area_name, ice_type_id,
      coalesce(sum(delivered), 0) as delivered, coalesce(sum(damaged), 0) as damaged
    from quantities group by kind, area_id, ice_type_id
  ), areas as (
    select totals.kind, totals.area_id, max(totals.area_name) as area_name,
      jsonb_agg(jsonb_build_object('id', ice.id, 'name', ice.name, 'unit', ice.unit,
        'delivered', totals.delivered, 'damaged', totals.damaged) order by ice.name, ice.id) as products
    from totals join public.ice_types ice on ice.id = totals.ice_type_id
    where totals.delivered <> 0 or totals.damaged <> 0
    group by totals.kind, totals.area_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'id', area_id,
    'name', area_name, 'products', products) order by kind, area_name, area_id), '[]'::jsonb) from areas;
$$;

-- Only the validated, admin-only report RPC may invoke this helper.
revoke all on function public.executive_report_volume_areas(date, date) from public, anon, authenticated;

do $report_volume_areas$
declare
  v_definition text := pg_get_functiondef('public.get_executive_report(date,date)'::regprocedure);
  v_old text := 'return v_result;';
  v_new text := 'return v_result || jsonb_build_object(''volumeAreas'', public.executive_report_volume_areas(p_from, p_to));';
begin
  if strpos(v_definition, v_old) = 0 then
    raise exception 'Cannot add report volume areas: executive report definition has changed';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$report_volume_areas$;

notify pgrst, 'reload schema';
