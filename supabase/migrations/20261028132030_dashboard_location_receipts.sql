-- Receipts follow the Bangkok recorded day, including payments against older
-- bills. Keep locationSales unchanged: it is a sales contract, not cash received.
create or replace function public.daily_work_location_receipts(p_service_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not coalesce(public.is_active_user(), false)
    or coalesce(public.current_app_role(), '') not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view daily location receipts';
  end if;

  with receipts as (
    -- Allocate a payment across its actual destinations once, rather than
    -- repeating the payment's full value for every bill or delivery item.
    select participation.event_job_id,
      coalesce(stop.building_id_snapshot, shop.building_id) as building_id,
      allocation.amount
    from public.payments payment
    join public.payment_allocations allocation on allocation.payment_id = payment.id
    join public.delivery_charges charge on charge.id = allocation.charge_id
    join public.shops shop on shop.id = charge.shop_id
    left join public.delivery_events delivery on delivery.id = charge.delivery_event_id
    left join public.round_stops stop on stop.id = delivery.round_stop_id
    left join public.event_settlement_contexts context on context.id = charge.event_settlement_context_id
    left join public.event_participations participation
      on participation.id = coalesce(context.event_participation_id, stop.event_participation_id)
    where payment.status = 'active' and charge.status = 'active'
      and payment.payment_method in ('cash', 'bank_transfer', 'qr')
      and payment.recorded_at >= p_service_date::timestamp at time zone 'Asia/Bangkok'
      and payment.recorded_at < (p_service_date + 1)::timestamp at time zone 'Asia/Bangkok'
    union all
    -- sale_amount excludes change and covers both measured and loose sales.
    select null::uuid, casual.sale_building_id, casual.sale_amount
    from public.casual_transactions casual
    where casual.status = 'active' and casual.transaction_kind = 'paid'
      and casual.payment_method in ('cash', 'bank_transfer', 'qr')
      and casual.recorded_at >= p_service_date::timestamp at time zone 'Asia/Bangkok'
      and casual.recorded_at < (p_service_date + 1)::timestamp at time zone 'Asia/Bangkok'
  ), attributed as (
    -- Casual sales can use an event's compatibility building. Resolve those
    -- into the same event row used for regular event receipts.
    select case
        when coalesce(receipt.event_job_id, job.id) is not null then 'event'
        when receipt.building_id is not null then 'building'
        else 'unassigned' end as kind,
      coalesce(receipt.event_job_id, job.id, receipt.building_id) as id,
      receipt.amount
    from receipts receipt
    left join public.buildings building on building.id = receipt.building_id
    left join public.event_jobs job
      on upper(btrim(building.code)) = upper('EVENT-' || job.id::text)
  ), totals as (
    select kind, id, sum(amount) as amount
    from attributed group by kind, id
  ), destinations as (
    select building.id, 'building'::text as kind, building.name, building.sort_order
    from public.buildings building
    where (building.is_active and coalesce(upper(btrim(building.code)), '') not like 'EVENT-%')
      or exists (select 1 from totals where kind = 'building' and id = building.id)
    union all
    select job.id, 'event'::text, job.name, 0
    from public.event_jobs job
    where (job.status = 'published'
        and p_service_date between coalesce(job.preparation_start_date, job.start_date) and job.end_date)
      or exists (select 1 from totals where kind = 'event' and id = job.id)
    union all
    select null::uuid, 'unassigned'::text, 'ไม่ระบุตึก'::text, 0
    where exists (select 1 from totals where kind = 'unassigned')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', coalesce(destination.id::text, 'unassigned'),
    'kind', destination.kind,
    'name', destination.name,
    'receivedValue', coalesce(totals.amount, 0)
  ) order by destination.kind, destination.sort_order, destination.name, destination.id), '[]'::jsonb)
  into v_result
  from destinations destination
  left join totals on totals.kind = destination.kind
    and totals.id is not distinct from destination.id;

  return v_result;
end;
$$;

revoke all on function public.daily_work_location_receipts(date) from public, anon, authenticated;
grant execute on function public.daily_work_location_receipts(date) to authenticated;

do $dashboard_receipts$
declare
  v_definition text := pg_get_functiondef('public.get_daily_work_dashboard(date)'::regprocedure);
  v_old text := '''locationSales'', public.daily_work_location_sales(v_service_date)';
  v_new text := '''locationSales'', public.daily_work_location_sales(v_service_date), ''locationReceipts'', public.daily_work_location_receipts(v_service_date)';
begin
  if strpos(v_definition, v_new) > 0 then return; end if;
  if strpos(v_definition, v_old) = 0 then
    raise exception 'Cannot add location receipts: dashboard sales contract has changed';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$dashboard_receipts$;

notify pgrst, 'reload schema';
