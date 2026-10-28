-- Internal projection called only after the existing card readers authorize the
-- destination. Rentals are independent of ice deliveries and remain in history
-- after a return. Event rentals start on rental_start_date, including handoffs
-- made during preparation before the event opens.
create or replace function public.delivery_today_tank_rentals(p_round_stop_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with destination as (
    select stop.shop_id, stop.destination_kind, stop.event_participation_id, round.service_date
    from public.round_stops stop
    join public.delivery_rounds round on round.id = stop.round_id
    where stop.id = p_round_stop_id
  ), rentals as (
    select tank.id, 1 as quantity, tank.tank_code, tank.created_by as recorded_by,
      null::text as note, tank.created_at as recorded_at
    from destination d
    join public.shop_rented_tanks tank on tank.shop_id = d.shop_id
      and tank.rented_at = d.service_date
    where d.destination_kind = 'regular'
    union all
    select rental.id, rental.quantity, null::text, rental.recorded_by,
      rental.note, rental.recorded_at
    from destination d
    join public.shop_tank_rentals rental on rental.shop_id = d.shop_id
      and rental.handed_out_on = d.service_date
    where d.destination_kind = 'regular'
    union all
    select movement.id, movement.quantity, null::text, movement.recorded_by,
      movement.note, movement.recorded_at
    from destination d
    join public.event_tank_register movement
      on movement.event_participation_id = d.event_participation_id
      and movement.rental_start_date = d.service_date
      and movement.movement_kind = 'handoff'
    where d.destination_kind = 'event'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', rental.id, 'quantity', rental.quantity, 'tank_code', rental.tank_code,
    'recorded_by', recorder.display_name, 'note', rental.note
  ) order by rental.recorded_at desc, rental.id), '[]'::jsonb)
  from rentals rental
  join public.users recorder on recorder.id = rental.recorded_by;
$$;

revoke all on function public.delivery_today_tank_rentals(uuid) from public, anon, authenticated;

-- Preserve the original RPC contracts for installed clients. These readers
-- delegate authorization and filtering to the existing card readers before
-- adding rental history. They do not depend on POS or an open delivery round.
create or replace function public.get_round_shop_cards_with_tank_history(
  p_round_id uuid, p_building_id uuid default null
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  select to_jsonb(card) || jsonb_build_object(
    'today_tank_rentals', public.delivery_today_tank_rentals(card.round_stop_id)
  )
  from public.get_round_shop_cards(p_round_id, p_building_id) card;
end;
$$;

create or replace function public.get_event_delivery_cards_with_tank_history(
  p_round_id uuid, p_event_job_id uuid default null, p_search text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  v_result := public.get_event_delivery_cards(p_round_id, p_event_job_id, p_search);
  return jsonb_set(v_result, '{cards}', coalesce((
    select jsonb_agg(card || jsonb_build_object(
      'today_tank_rentals', public.delivery_today_tank_rentals((card->>'round_stop_id')::uuid)
    ) order by ordinal)
    from jsonb_array_elements(v_result->'cards') with ordinality as cards(card, ordinal)
  ), '[]'::jsonb));
end;
$$;

revoke all on function public.get_round_shop_cards_with_tank_history(uuid,uuid) from public, anon;
revoke all on function public.get_event_delivery_cards_with_tank_history(uuid,uuid,text) from public, anon;
grant execute on function public.get_round_shop_cards_with_tank_history(uuid,uuid) to authenticated;
grant execute on function public.get_event_delivery_cards_with_tank_history(uuid,uuid,text) to authenticated;

notify pgrst, 'reload schema';

