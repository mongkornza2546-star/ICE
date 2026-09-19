select jsonb_build_object(
  'counts', jsonb_build_object(
    'shops', (select count(*) from public.shops),
    'ice_types', (select count(*) from public.ice_types),
    'september_rounds', (
      select count(*) from public.delivery_rounds
      where service_date between date '2026-09-01' and date '2026-09-18'
    ),
    'september_deliveries', (
      select count(*)
      from public.delivery_events event
      join public.round_stops stop on stop.id = event.round_stop_id
      join public.delivery_rounds round on round.id = stop.round_id
      where round.service_date between date '2026-09-01' and date '2026-09-18'
    ),
    'september_casual', (
      select count(*) from public.casual_transactions
      where service_date between date '2026-09-01' and date '2026-09-18'
    )
  ),
  'ice_types', (
    select jsonb_agg(
      jsonb_build_object(
        'id', id,
        'code', code,
        'name', name,
        'unit', unit,
        'active', is_active
      ) order by code
    )
    from public.ice_types
  ),
  'stock_locations', (
    select jsonb_agg(
      jsonb_build_object(
        'id', id,
        'code', code,
        'name', name,
        'type', kind,
        'active', is_active
      ) order by code
    )
    from public.stock_locations
  )
) as snapshot;
