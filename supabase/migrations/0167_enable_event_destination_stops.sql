-- Activate event-stop mutation only after the schema-v3 sync contract exists.
-- Event ice delivery and tank rental writers remain disabled.

do $$
begin
  if to_regprocedure('public.sync_daily_round_destinations(uuid)') is null
    or not exists (
      select 1
      from pg_trigger trigger
      where trigger.tgrelid = 'public.round_stops'::regclass
        and trigger.tgname = 'round_stops_enforce_snapshot_immutability'
        and not trigger.tgisinternal
    )
    or not exists (
      select 1
      from public.event_delivery_feature_settings settings
      where settings.singleton
        and settings.schema_version >= 3
    ) then
    raise exception
      'Migration 0167 requires migration 0166_event_destination_sync_dark_launch.sql';
  end if;
end $$;

update public.event_delivery_feature_settings
set event_stops_enabled = true,
    event_ice_delivery_enabled = false,
    event_tank_rental_enabled = false,
    updated_at = now()
where singleton;

notify pgrst, 'reload schema';
