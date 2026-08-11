-- Daily round shop membership is synchronized on demand so shops created after
-- the round starts can join the current work session.

create or replace function public.sync_daily_round_active_shops(
  p_round_id uuid
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_added_count integer;
  v_max_sequence integer;
  v_round public.delivery_rounds%rowtype;
begin
  -- Match close/cancel lock order so the state check cannot go stale.
  select round.* into v_round
  from public.delivery_rounds round
  where round.id = p_round_id
  for update;

  if not found then
    raise exception 'The selected delivery round does not exist';
  end if;

  if not public.is_active_user()
    or (public.current_app_role() not in ('admin', 'round_lead')
      and not public.is_round_member(p_round_id)) then
    raise exception 'You are not assigned to this delivery round';
  end if;

  if v_round.round_type <> 'daily'
    or v_round.status <> 'open'
    or v_round.cancelled_at is not null then
    return 0;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_round.service_date::text, 0));

  select coalesce(max(stop.sequence_no), 0)
  into v_max_sequence
  from public.round_stops stop
  where stop.round_id = p_round_id;

  insert into public.round_stops (
    round_id,
    shop_id,
    shop_code_snapshot,
    shop_name_snapshot,
    building_id_snapshot,
    building_name_snapshot,
    floor_or_zone_snapshot,
    sequence_no,
    updated_by
  )
  select
    p_round_id,
    shop.id,
    shop.code,
    shop.name,
    shop.building_id,
    building.name,
    shop.floor_or_zone,
    (v_max_sequence + row_number() over (
      order by building.sort_order, zone.sort_order,
        shop.delivery_sequence nulls last, shop.code, shop.id
    ))::integer,
    auth.uid()
  from public.shops shop
  join public.buildings building
    on building.id = shop.building_id and building.is_active
  join public.building_zones zone on zone.id = shop.zone_id
  where shop.status = 'active'
    and not exists (
      select 1
      from public.round_stops existing
      where existing.round_id = p_round_id
        and existing.shop_id = shop.id
    )
  on conflict (round_id, shop_id) do nothing;

  get diagnostics v_added_count = row_count;
  return v_added_count;
end;
$$;

revoke all on function public.sync_daily_round_active_shops(uuid) from public;
grant execute on function public.sync_daily_round_active_shops(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_publication publication
    where publication.pubname = 'supabase_realtime'
  ) then
    raise exception 'The supabase_realtime publication is required';
  elsif exists (
    select 1 from pg_catalog.pg_publication publication
    where publication.pubname = 'supabase_realtime'
      and publication.puballtables
  ) then
    null;
  elsif not exists (
    select 1
    from pg_catalog.pg_publication publication
    join pg_catalog.pg_publication_rel publication_rel
      on publication_rel.prpubid = publication.oid
    join pg_catalog.pg_class relation
      on relation.oid = publication_rel.prrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where publication.pubname = 'supabase_realtime'
      and namespace.nspname = 'public'
      and relation.relname = 'shops'
  ) then
    execute 'alter publication supabase_realtime add table public.shops';
  end if;
end;
$$;

notify pgrst, 'reload schema';
