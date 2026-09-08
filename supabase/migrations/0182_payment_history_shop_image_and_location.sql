create or replace function public.get_payment_history(
  p_from_date date,
  p_to_date date,
  p_page_size integer default 50,
  p_before_recorded_at timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_items jsonb;
  v_next_recorded_at timestamptz;
  v_next_id uuid;
  v_has_more boolean;
  v_summary jsonb;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required to view payment history';
  elsif p_from_date is null or p_to_date is null
    or p_to_date < p_from_date or p_to_date - p_from_date > 30 then
    raise exception 'Payment history requires a valid range of at most 31 days';
  elsif p_page_size not between 1 and 100 then
    raise exception 'Payment history page size must be between 1 and 100';
  elsif (p_before_recorded_at is null) <> (p_before_id is null) then
    raise exception 'Payment history cursor fields must be supplied together';
  end if;

  v_start := p_from_date::timestamp at time zone 'Asia/Bangkok';
  v_end := (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok';
  if p_before_recorded_at is not null
    and (p_before_recorded_at < v_start or p_before_recorded_at >= v_end) then
    raise exception 'Payment history cursor is outside the requested range';
  end if;

  with visible as (
    select payment.*,
      shop.code as shop_code,
      shop.name as shop_name,
      shop.image_path as shop_image_path,
      case when context.id is null then shop.building_id else null end as building_id,
      case when context.id is null then building.name else stop.event_location_snapshot end as building_name,
      case when context.id is null then shop.zone_id else null end as zone_id,
      case when context.id is null then zone.name else stop.event_zone_snapshot end as zone_name,
      context.event_participation_id,
      context.service_date as settlement_service_date,
      stop.event_job_name_snapshot as event_name,
      stop.event_location_snapshot as event_location,
      stop.event_zone_snapshot as event_zone,
      stop.event_booth_snapshot as event_booth
    from public.payments payment
    join public.shops shop on shop.id = payment.shop_id
    left join public.buildings building on building.id = shop.building_id
    left join public.building_zones zone on zone.id = shop.zone_id
    left join public.event_settlement_contexts context
      on context.id = payment.event_settlement_context_id
    left join lateral (
      select stop.*
      from public.payment_allocations allocation
      join public.delivery_charges charge on charge.id = allocation.charge_id
      join public.delivery_events event on event.id = charge.delivery_event_id
      join public.round_stops stop on stop.id = event.round_stop_id
      where allocation.payment_id = payment.id
      order by charge.created_at, charge.id
      limit 1
    ) stop on true
    where payment.recorded_at >= v_start
      and payment.recorded_at < v_end
      and public.is_payment_visible(payment.id)
  ), page as (
    select * from visible
    where p_before_recorded_at is null
      or (recorded_at, id) < (p_before_recorded_at, p_before_id)
    order by recorded_at desc, id desc
    limit p_page_size + 1
  ), returned as (
    select * from page order by recorded_at desc, id desc limit p_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', returned.id,
    'receipt_number', returned.receipt_number,
    'received_amount', returned.received_amount,
    'allocated_amount', returned.allocated_amount,
    'change_amount', returned.change_amount,
    'payment_method', returned.payment_method,
    'status', returned.status,
    'recorded_at', returned.recorded_at,
    'recorded_by', returned.recorded_by,
    'void_reason', returned.void_reason,
    'destination_kind', returned.operation_kind,
    'event_settlement_context_id', returned.event_settlement_context_id,
    'event_participation_id', returned.event_participation_id,
    'settlement_service_date', returned.settlement_service_date,
    'event_name', returned.event_name,
    'event_location', returned.event_location,
    'event_zone', returned.event_zone,
    'event_booth', returned.event_booth,
    'shop_id', returned.shop_id,
    'image_path', returned.shop_image_path,
    'building_id', returned.building_id,
    'building_name', returned.building_name,
    'zone_id', returned.zone_id,
    'zone_name', returned.zone_name,
    'shops', jsonb_build_object('code', returned.shop_code, 'name', returned.shop_name)
  ) order by returned.recorded_at desc, returned.id desc), '[]'::jsonb)
  into v_items from returned;

  with visible as (
    select payment.*
    from public.payments payment
    where payment.recorded_at >= v_start
      and payment.recorded_at < v_end
      and public.is_payment_visible(payment.id)
  )
  select jsonb_build_object(
    'visible_payment_count', count(*),
    'active_payment_count', count(*) filter (where status = 'active'),
    'active_allocated_amount', coalesce(sum(allocated_amount) filter (where status = 'active'), 0),
    'active_cash_amount', coalesce(sum(allocated_amount) filter (
      where status = 'active' and payment_method = 'cash'), 0),
    'active_non_cash_amount', coalesce(sum(allocated_amount) filter (
      where status = 'active' and payment_method <> 'cash'), 0)
  ) into v_summary from visible;

  with page as (
    select payment.recorded_at, payment.id
    from public.payments payment
    where payment.recorded_at >= v_start
      and payment.recorded_at < v_end
      and public.is_payment_visible(payment.id)
      and (p_before_recorded_at is null
        or (payment.recorded_at, payment.id) < (p_before_recorded_at, p_before_id))
    order by payment.recorded_at desc, payment.id desc
    limit p_page_size + 1
  ), numbered as (
    select *, row_number() over (order by recorded_at desc, id desc) as row_number
    from page
  )
  select count(*) > p_page_size,
    max(recorded_at) filter (where row_number = p_page_size),
    (array_agg(id) filter (where row_number = p_page_size))[1]
  into v_has_more, v_next_recorded_at, v_next_id
  from numbered;

  return jsonb_build_object(
    'items', v_items,
    'next_cursor', case when v_has_more then jsonb_build_object(
      'recorded_at', v_next_recorded_at, 'id', v_next_id
    ) else null end,
    'range_summary', v_summary
  );
end;
$$;

revoke all on function public.get_payment_history(date, date, integer, timestamptz, uuid) from public;
grant execute on function public.get_payment_history(date, date, integer, timestamptz, uuid) to authenticated;

notify pgrst, 'reload schema';
