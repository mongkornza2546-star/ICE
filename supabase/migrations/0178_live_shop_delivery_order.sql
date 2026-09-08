-- Read current route settings for open daily rounds without rewriting stop
-- snapshots, sequence constraints, delivery history, or closed/special rounds.
do $ordering$
declare
  v_definition text;
  v_previous text;
begin
  select pg_get_functiondef('public.get_round_shop_cards(uuid,uuid)'::regprocedure)
    into v_definition;
  v_previous := v_definition;
  v_definition := replace(v_definition,
    'stop.sequence_no, shop.image_path',
    'case when current_round.round_type = ''daily'' and current_round.status = ''open''
        and current_round.cancelled_at is null
      then (row_number() over (order by
        building.sort_order nulls last, stop.building_id_snapshot,
        zone.sort_order nulls last, shop.zone_id,
        shop.delivery_sequence nulls last, shop.code, shop.id))::integer
      else stop.sequence_no end as sequence_no, shop.image_path');
  if v_definition = v_previous then
    raise exception 'get_round_shop_cards is missing the expected sequence projection';
  end if;

  v_previous := v_definition;
  v_definition := replace(v_definition,
    'from public.round_stops stop join public.shops shop on shop.id = stop.shop_id',
    'from public.round_stops stop join public.shops shop on shop.id = stop.shop_id
  join public.delivery_rounds current_round on current_round.id = stop.round_id
  left join public.buildings building on building.id = stop.building_id_snapshot
  left join public.building_zones zone on zone.id = shop.zone_id');
  if v_definition = v_previous then
    raise exception 'get_round_shop_cards is missing the expected shop join';
  end if;

  v_previous := v_definition;
  v_definition := replace(v_definition, 'order by stop.sequence_no;', 'order by 8;');
  if v_definition = v_previous then
    raise exception 'get_round_shop_cards is missing the expected ordering';
  end if;
  execute v_definition;
end;
$ordering$;

notify pgrst, 'reload schema';
