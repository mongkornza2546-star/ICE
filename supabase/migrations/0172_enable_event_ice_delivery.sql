-- Install explicit global activation controls. Applying migrations through 0172
-- must remain a dark install; an active admin invokes the activation RPC only
-- after the schema-7 client and one-participation pilot pass acceptance.

do $$
begin
  if to_regclass('public.event_settlement_contexts') is null
    or to_regclass('public.event_ice_delivery_pilots') is null
    or to_regprocedure(
      'public.record_event_payment(uuid,uuid,date,text,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid)'
    ) is null
    or to_regprocedure(
      'public.get_payment_history(date,date,integer,timestamp with time zone,uuid)'
    ) is null
    or not exists (
      select 1 from public.event_delivery_feature_settings settings
      where settings.singleton
        and settings.schema_version >= 7
        and settings.event_stops_enabled
    ) then
    raise exception 'Migration 0172 requires the complete migration 0171 contract';
  end if;
end $$;

create or replace function public.activate_event_ice_delivery()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an active admin can activate event ice delivery';
  end if;

  perform 1
  from public.event_delivery_feature_settings settings
  where settings.singleton and settings.schema_version >= 7
  for update;
  if not found then
    raise exception 'The schema-7 event delivery contract is not installed';
  end if;

  update public.event_delivery_feature_settings
  set event_ice_delivery_enabled = true,
      updated_at = now()
  where singleton;
  delete from public.event_ice_delivery_pilots;

  return jsonb_build_object('event_ice_delivery_enabled', true);
end;
$$;

create or replace function public.deactivate_event_ice_delivery()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an active admin can deactivate event ice delivery';
  end if;

  perform 1
  from public.event_delivery_feature_settings settings
  where settings.singleton
  for update;
  if not found then
    raise exception 'Event delivery feature settings are missing';
  end if;

  update public.event_delivery_feature_settings
  set event_ice_delivery_enabled = false,
      updated_at = now()
  where singleton;
  delete from public.event_ice_delivery_pilots;

  return jsonb_build_object('event_ice_delivery_enabled', false);
end;
$$;

revoke all on function public.activate_event_ice_delivery() from public, anon;
revoke all on function public.deactivate_event_ice_delivery() from public, anon;
grant execute on function public.activate_event_ice_delivery() to authenticated;
grant execute on function public.deactivate_event_ice_delivery() to authenticated;

notify pgrst, 'reload schema';
