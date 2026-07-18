-- Keep employee cards current across every round on the same service date and
-- retain the outcome of non-delivery events in the visible shop history.

create or replace function public.get_round_shop_cards(
  p_round_id uuid,
  p_building_id uuid default null
)
returns table (
  round_stop_id uuid,
  shop_id uuid,
  shop_code text,
  shop_name text,
  building_id uuid,
  building_name text,
  floor_or_zone text,
  sequence_no integer,
  image_path text,
  payment_status public.shop_payment_status,
  stop_status public.shop_round_status,
  stop_note text,
  today_history jsonb,
  today_totals jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date;
  v_can_view_all boolean;
begin
  select service_date into v_service_date from public.delivery_rounds where id = p_round_id;

  if v_service_date is null then
    raise exception 'The selected delivery round does not exist';
  end if;

  v_can_view_all := public.current_app_role() in ('admin', 'round_lead');

  if not public.is_active_user()
    or (not coalesce(v_can_view_all, false)
      and not public.is_round_member(p_round_id)) then
    raise exception 'You are not assigned to this delivery round';
  end if;

  return query
  with daily_events as (
    select
      day_stop.shop_id,
      e.id,
      e.recorded_at,
      day_round.name as round_name,
      u.display_name as recorded_by_name,
      e.note,
      coalesce(
        (
          select log.after_value ->> 'stop_status'
          from public.audit_logs log
          where log.entity_type = 'delivery_events'
            and log.entity_id = e.id
            and log.after_value ? 'stop_status'
          order by log.occurred_at
          limit 1
        ),
        case when count(i.ice_type_id) > 0 then 'delivered' else 'issue' end
      ) as stop_status,
      coalesce(
        jsonb_object_agg(i.ice_type_id, i.quantity) filter (where i.ice_type_id is not null),
        '{}'::jsonb
      ) as items
    from public.round_stops day_stop
    join public.delivery_rounds day_round on day_round.id = day_stop.round_id
    join public.delivery_events e on e.round_stop_id = day_stop.id and e.status = 'active'
    join public.users u on u.id = e.recorded_by
    left join public.delivery_items i on i.delivery_event_id = e.id
    where day_round.service_date = v_service_date
    group by day_stop.shop_id, e.id, e.recorded_at, day_round.name, u.display_name, e.note
  ), daily_history as (
    select
      daily_events.shop_id,
      jsonb_agg(
        jsonb_build_object(
          'event_id', daily_events.id,
          'recorded_at', daily_events.recorded_at,
          'round_name', daily_events.round_name,
          'recorded_by', daily_events.recorded_by_name,
          'stop_status', daily_events.stop_status,
          'note', daily_events.note,
          'items', daily_events.items
        )
        order by daily_events.recorded_at
      ) as history
    from daily_events
    group by daily_events.shop_id
  ), daily_item_totals as (
    select
      day_stop.shop_id,
      item.ice_type_id,
      sum(item.quantity) as quantity
    from public.round_stops day_stop
    join public.delivery_rounds day_round on day_round.id = day_stop.round_id
    join public.delivery_events e on e.round_stop_id = day_stop.id and e.status = 'active'
    join public.delivery_items item on item.delivery_event_id = e.id
    where day_round.service_date = v_service_date
    group by day_stop.shop_id, item.ice_type_id
  ), daily_totals as (
    select
      daily_item_totals.shop_id,
      jsonb_object_agg(ice_type_id, quantity) as totals
    from daily_item_totals
    group by daily_item_totals.shop_id
  )
  select
    stop.id,
    stop.shop_id,
    stop.shop_code_snapshot,
    stop.shop_name_snapshot,
    stop.building_id_snapshot,
    stop.building_name_snapshot,
    stop.floor_or_zone_snapshot,
    stop.sequence_no,
    shop.image_path,
    shop.payment_status,
    stop.status,
    stop.note,
    coalesce(history.history, '[]'::jsonb),
    coalesce(totals.totals, '{}'::jsonb)
  from public.round_stops stop
  join public.shops shop on shop.id = stop.shop_id
  left join daily_history history on history.shop_id = stop.shop_id
  left join daily_totals totals on totals.shop_id = stop.shop_id
  where stop.round_id = p_round_id
    and (p_building_id is null or stop.building_id_snapshot = p_building_id)
  order by stop.sequence_no;
end;
$$;

revoke all on function public.get_round_shop_cards(uuid, uuid) from public;
grant execute on function public.get_round_shop_cards(uuid, uuid) to authenticated;
