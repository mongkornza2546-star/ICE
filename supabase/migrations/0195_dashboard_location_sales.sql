-- Aggregate each active charge once, retaining the event destination even when
-- the same shop also buys at its regular building on the same day.
create or replace function public.daily_work_location_sales(p_service_date date)
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
    raise exception 'Only a round lead or admin can view daily location sales';
  end if;

  with sales as (
    select
      case when participation.event_job_id is not null then 'event' else 'building' end as kind,
      coalesce(participation.event_job_id, stop.building_id_snapshot, shop.building_id) as id,
      public.effective_delivery_charge_amount(charge.id) as amount
    from public.delivery_charges charge
    join public.shops shop on shop.id = charge.shop_id
    left join public.delivery_events delivery on delivery.id = charge.delivery_event_id
    left join public.round_stops stop on stop.id = delivery.round_stop_id
    left join public.event_settlement_contexts context on context.id = charge.event_settlement_context_id
    left join public.event_participations participation
      on participation.id = coalesce(context.event_participation_id, stop.event_participation_id)
    where charge.service_date = p_service_date and charge.status = 'active'
  ), totals as (
    select kind, id, sum(amount) as amount, count(*) as sale_count
    from sales group by kind, id
  ), destinations as (
    select building.id, 'building'::text as kind, building.name, building.sort_order
    from public.buildings building
    where building.is_active
      or exists (select 1 from totals where kind = 'building' and id = building.id)
    union all
    select job.id, 'event'::text, job.name, 0
    from public.event_jobs job
    where (job.status = 'published'
        and p_service_date between coalesce(job.preparation_start_date, job.start_date) and job.end_date)
      or exists (select 1 from totals where kind = 'event' and id = job.id)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', destination.id,
    'kind', destination.kind,
    'name', destination.name,
    'netSalesValue', coalesce(totals.amount, 0),
    'saleCount', coalesce(totals.sale_count, 0)
  ) order by destination.kind, destination.sort_order, destination.name, destination.id), '[]'::jsonb)
  into v_result
  from destinations destination
  left join totals on totals.kind = destination.kind and totals.id = destination.id;

  return v_result;
end;
$$;

revoke all on function public.daily_work_location_sales(date) from public;
grant execute on function public.daily_work_location_sales(date) to authenticated;

-- Keep the dashboard's existing access checks and other summary calculations.
do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.get_daily_work_dashboard(date)'::regprocedure)
  into v_definition;
  if strpos(v_definition, '''iceTypeSales'', v_ice_type_sales') = 0 then
    raise exception 'The dashboard sales summary does not match the expected contract';
  end if;
  v_definition := replace(v_definition,
    '''iceTypeSales'', v_ice_type_sales',
    '''iceTypeSales'', v_ice_type_sales, ''locationSales'', public.daily_work_location_sales(v_service_date)');
  execute v_definition;
end;
$migration$;
