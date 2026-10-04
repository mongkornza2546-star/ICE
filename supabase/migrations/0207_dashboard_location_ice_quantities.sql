-- The dashboard's per-destination panel is operational, so show the ice
-- delivered at each current destination rather than its sales value.
create or replace function public.daily_work_location_ice_quantities(p_service_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view daily location ice quantities';
  end if;

  with delivered_items as (
    select
      case when participation.event_job_id is not null then 'event' else 'building' end as kind,
      coalesce(participation.event_job_id, stop.building_id_snapshot, shop.building_id) as id,
      ice.id as ice_type_id,
      ice.name as ice_type_name,
      ice.unit,
      item.quantity
    from public.delivery_charges charge
    join public.delivery_events delivery on delivery.id = charge.delivery_event_id
    join public.delivery_items item on item.delivery_event_id = delivery.id
    join public.ice_types ice on ice.id = item.ice_type_id
    join public.shops shop on shop.id = charge.shop_id
    left join public.round_stops stop on stop.id = delivery.round_stop_id
    left join public.event_participations participation on participation.id = stop.event_participation_id
    where charge.service_date = p_service_date
      and charge.status = 'active'
  ), item_totals as (
    select kind, id, ice_type_id, ice_type_name, unit, sum(quantity) as quantity
    from delivered_items
    group by kind, id, ice_type_id, ice_type_name, unit
  ), quantity_totals as (
    select kind, id, jsonb_agg(jsonb_build_object(
      'ice_type_id', ice_type_id,
      'ice_type_name', ice_type_name,
      'unit', unit,
      'quantity', quantity
    ) order by ice_type_name, ice_type_id) as ice_totals
    from item_totals
    group by kind, id
  ), destinations as (
    select building.id, 'building'::text as kind, building.name, building.sort_order
    from public.buildings building
    where (building.is_active
      or exists (select 1 from quantity_totals where kind = 'building' and id = building.id))
      and not exists (
        select 1 from public.event_jobs job
        where upper(building.code) = upper('EVENT-' || job.id::text)
      )
    union all
    select job.id, 'event'::text, job.name, 0
    from public.event_jobs job
    where job.status = 'published'
      and p_service_date between coalesce(job.preparation_start_date, job.start_date) and job.end_date
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', destination.id,
    'kind', destination.kind,
    'name', destination.name,
    'iceTotals', coalesce(quantity_totals.ice_totals, '[]'::jsonb)
  ) order by destination.kind, destination.sort_order, destination.name, destination.id), '[]'::jsonb)
  into v_result
  from destinations destination
  left join quantity_totals on quantity_totals.kind = destination.kind and quantity_totals.id = destination.id;

  return v_result;
end;
$$;

revoke all on function public.daily_work_location_ice_quantities(date) from public;
grant execute on function public.daily_work_location_ice_quantities(date) to authenticated;

-- Event shop provisioning creates active EVENT-<job UUID> buildings. These
-- belong only in the date-scoped event list, not the regular-building list.
-- Apply the same exclusion to the existing sales read model.
do $dashboard_event_buildings$
declare
  v_definition text;
  v_old text := $old$    where building.is_active
      or exists (select 1 from totals where kind = 'building' and id = building.id)$old$;
  v_new text := $new$    where (building.is_active
      or exists (select 1 from totals where kind = 'building' and id = building.id))
      and not exists (
        select 1 from public.event_jobs job
        where upper(building.code) = upper('EVENT-' || job.id::text)
      )$new$;
begin
  select pg_get_functiondef('public.daily_work_location_sales(date)'::regprocedure)
  into v_definition;

  if strpos(v_definition, v_old) = 0 then
    raise exception 'Cannot exclude dashboard event buildings: location sales definition has changed';
  end if;

  execute replace(v_definition, v_old, v_new);
end;
$dashboard_event_buildings$;

-- Preserve the existing daily dashboard contract and append the new
-- destination quantity read model.
do $dashboard_location_ice_quantities$
declare
  v_definition text;
  v_old text := '''locationSales'', public.daily_work_location_sales(v_service_date)';
  v_new text := '''locationSales'', public.daily_work_location_sales(v_service_date), ''locationIceTotals'', public.daily_work_location_ice_quantities(v_service_date)';
begin
  select pg_get_functiondef('public.get_daily_work_dashboard(date)'::regprocedure)
  into v_definition;

  if strpos(v_definition, v_old) = 0 then
    raise exception 'Cannot add dashboard location ice quantities: dashboard definition has changed';
  end if;

  execute replace(v_definition, v_old, v_new);
end;
$dashboard_location_ice_quantities$;

notify pgrst, 'reload schema';
