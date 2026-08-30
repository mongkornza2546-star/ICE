-- Event delivery Slice B: expose the real stop presentation state to clients.
-- Event ice-delivery and tank-rental writers remain disabled.

do $presentation$
declare
  v_definition text;
  v_updated_definition text;
begin
  if to_regprocedure('public.get_event_delivery_cards(uuid,uuid,text)') is null
    or to_regprocedure('public.sync_daily_round_destinations(uuid)') is null
    or not exists (
      select 1
      from public.event_delivery_feature_settings settings
      where settings.singleton
        and settings.schema_version >= 3
    ) then
    raise exception
      'Migration 0168 requires migration 0166_event_destination_sync_dark_launch.sql';
  end if;

  select pg_get_functiondef(
    to_regprocedure('public.get_event_delivery_cards(uuid,uuid,text)')
  )
  into v_definition;

  v_updated_definition := regexp_replace(
    v_definition,
    E'''is_operational'',\\s*coalesce\\(current_stop\\.is_operational,\\s*true\\),\\s*''today_history''',
    E'''is_operational'', coalesce(current_stop.is_operational, true),\n      ''stop_status'', coalesce(current_stop.status, ''pending''::public.shop_round_status),\n      ''stop_note'', current_stop.note,\n      ''today_history''',
    'i'
  );

  if v_updated_definition = v_definition then
    raise exception
      'Migration 0168 could not locate the event card presentation fragment';
  end if;

  execute v_updated_definition;
end;
$presentation$;

update public.event_delivery_feature_settings
set schema_version = greatest(schema_version, 4),
    event_ice_delivery_enabled = false,
    event_tank_rental_enabled = false,
    updated_at = now()
where singleton;

notify pgrst, 'reload schema';
