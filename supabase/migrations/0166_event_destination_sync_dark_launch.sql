-- Event delivery Slice A: destination synchronization dark launch.
--
-- This migration is additive after 0165. It exposes schema version 3 and the
-- destination sync RPC, but deliberately leaves event_stops_enabled unchanged.

do $$
begin
  if to_regclass('public.event_jobs') is null
    or to_regclass('public.event_participations') is null
    or to_regclass('public.event_delivery_feature_settings') is null
    or to_regprocedure('public.get_employee_active_session(date)') is null then
    raise exception
      'Migration 0166 requires migration 0165_event_read_models_and_destination_counts.sql';
  end if;
end $$;

create or replace function public.get_employee_active_session(
  p_service_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_date date := coalesce(
    p_service_date,
    (clock_timestamp() at time zone 'Asia/Bangkok')::date
  );
  v_daily_round_id uuid;
  v_rounds jsonb;
  v_count integer;
begin
  if not public.is_active_user() then
    raise exception 'User is not active';
  end if;

  if public.current_app_role() in ('courier', 'round_lead', 'admin') then
    perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

    select round.id into v_daily_round_id
    from public.delivery_rounds round
    where round.service_date = v_service_date
      and round.round_type = 'daily'
      and round.status = 'open'
      and round.cancelled_at is null
    order by round.created_at asc
    limit 1
    for update;

    if v_daily_round_id is not null then
      insert into public.delivery_round_members (round_id, user_id)
      values (v_daily_round_id, auth.uid())
      on conflict (round_id, user_id) do nothing;
    end if;
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'id', round.id,
      'service_date', round.service_date,
      'name', round.name,
      'round_type', round.round_type,
      'status', round.status,
      'opened_at', round.opened_at,
      'cancelled_at', round.cancelled_at
    ) order by round.created_at asc
  ), count(*)
  into v_rounds, v_count
  from public.delivery_rounds round
  where round.service_date = v_service_date
    and round.status = 'open'
    and round.cancelled_at is null
    and (
      public.current_app_role() in ('admin', 'round_lead')
      or exists (
        select 1
        from public.delivery_round_members member
        where member.round_id = round.id
          and member.user_id = auth.uid()
      )
    );

  v_rounds := coalesce(v_rounds, '[]'::jsonb);

  return jsonb_build_object(
    'single_session', (v_count = 1),
    'active_round', case when v_count = 1 then v_rounds->0 else null end,
    'sessions', v_rounds
  );
end;
$$;

create or replace function public.enforce_round_stop_snapshot_immutability()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.id is distinct from old.id
    or new.round_id is distinct from old.round_id
    or new.shop_id is distinct from old.shop_id
    or new.destination_kind is distinct from old.destination_kind
    or new.event_participation_id is distinct from old.event_participation_id
    or new.shop_code_snapshot is distinct from old.shop_code_snapshot
    or new.shop_name_snapshot is distinct from old.shop_name_snapshot
    or new.building_id_snapshot is distinct from old.building_id_snapshot
    or new.building_name_snapshot is distinct from old.building_name_snapshot
    or new.floor_or_zone_snapshot is distinct from old.floor_or_zone_snapshot
    or new.event_job_name_snapshot is distinct from old.event_job_name_snapshot
    or new.event_location_snapshot is distinct from old.event_location_snapshot
    or new.event_booth_snapshot is distinct from old.event_booth_snapshot
    or new.event_zone_snapshot is distinct from old.event_zone_snapshot
    or new.event_landmark_snapshot is distinct from old.event_landmark_snapshot
    or new.event_contact_name_snapshot is distinct from old.event_contact_name_snapshot
    or new.event_contact_phone_snapshot is distinct from old.event_contact_phone_snapshot then
    raise exception 'Round stop destination identity and snapshots are immutable';
  end if;

  return new;
end;
$$;

drop trigger if exists round_stops_enforce_snapshot_immutability
on public.round_stops;
create trigger round_stops_enforce_snapshot_immutability
before update on public.round_stops
for each row execute function public.enforce_round_stop_snapshot_immutability();

create or replace function public.sync_daily_round_destinations(
  p_round_id uuid
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_added_count integer := 0;
  v_event_added_count integer := 0;
  v_event_job_id uuid;
  v_event_participation_id uuid;
  v_event_stops_enabled boolean := false;
  v_lock_service_date date;
  v_max_sequence integer;
  v_round public.delivery_rounds%rowtype;
begin
  select round.service_date into v_lock_service_date
  from public.delivery_rounds round
  where round.id = p_round_id;

  if not found then
    raise exception 'The selected delivery round does not exist';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_lock_service_date::text, 0));

  select round.* into v_round
  from public.delivery_rounds round
  where round.id = p_round_id
  for update;

  if not found then
    raise exception 'The selected delivery round does not exist';
  elsif v_round.service_date is distinct from v_lock_service_date then
    raise exception 'The delivery round changed service date; retry the request';
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

  insert into public.delivery_round_members (round_id, user_id)
  select p_round_id, app_user.id
  from public.users app_user
  where app_user.is_active
    and app_user.role in ('courier', 'round_lead', 'admin')
  on conflict (round_id, user_id) do nothing;

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
    updated_by,
    destination_kind,
    event_participation_id,
    is_operational
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
    auth.uid(),
    'regular',
    null,
    true
  from public.shops shop
  join public.buildings building
    on building.id = shop.building_id and building.is_active
  join public.building_zones zone on zone.id = shop.zone_id
  where shop.status = 'active'
  on conflict (round_id, shop_id) where destination_kind = 'regular' do nothing;

  get diagnostics v_added_count = row_count;

  select coalesce(settings.event_stops_enabled, false)
  into v_event_stops_enabled
  from public.event_delivery_feature_settings settings
  where settings.singleton;

  if not coalesce(v_event_stops_enabled, false) then
    return v_added_count;
  end if;

  -- Lock every job that can produce a stop today, plus jobs already represented
  -- in the round. The latter set is required for safe deactivation.
  for v_event_job_id in
    with relevant_job_ids as (
      select job.id
      from public.event_jobs job
      where v_round.service_date between job.start_date and job.end_date
      union
      select participation.event_job_id
      from public.round_stops stop
      join public.event_participations participation
        on participation.id = stop.event_participation_id
      where stop.round_id = p_round_id
        and stop.destination_kind = 'event'
    )
    select job.id
    from public.event_jobs job
    join relevant_job_ids relevant on relevant.id = job.id
    order by job.id
    for update of job
  loop
    null;
  end loop;

  -- Job locks serialize participation lifecycle writers. Lock all participation
  -- rows for today's jobs, not only currently eligible rows, so a concurrent date
  -- expansion cannot be missed by reactivation.
  for v_event_participation_id in
    with relevant_participation_ids as (
      select participation.id
      from public.event_participations participation
      join public.event_jobs job on job.id = participation.event_job_id
      where v_round.service_date between job.start_date and job.end_date
      union
      select stop.event_participation_id
      from public.round_stops stop
      where stop.round_id = p_round_id
        and stop.destination_kind = 'event'
        and stop.event_participation_id is not null
    )
    select participation.id
    from public.event_participations participation
    join relevant_participation_ids relevant on relevant.id = participation.id
    order by participation.id
    for update of participation
  loop
    null;
  end loop;

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
    updated_by,
    destination_kind,
    event_participation_id,
    is_operational,
    event_job_name_snapshot,
    event_location_snapshot,
    event_booth_snapshot,
    event_zone_snapshot,
    event_landmark_snapshot,
    event_contact_name_snapshot,
    event_contact_phone_snapshot
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
      order by job.id, participation.id
    ))::integer,
    auth.uid(),
    'event',
    participation.id,
    true,
    job.name,
    job.location,
    participation.booth_number,
    participation.event_zone,
    participation.landmark,
    coalesce(participation.contact_name, shop.contact_name),
    coalesce(participation.contact_phone, shop.contact_phone)
  from public.event_participations participation
  join public.event_jobs job on job.id = participation.event_job_id
  join public.shops shop on shop.id = participation.shop_id
  join public.buildings building on building.id = shop.building_id
  where job.status = 'published'
    and participation.status = 'active'
    and v_round.service_date between job.start_date and job.end_date
    and v_round.service_date between participation.start_date and participation.end_date
  on conflict (round_id, event_participation_id)
    where destination_kind = 'event' do nothing;

  get diagnostics v_event_added_count = row_count;

  update public.round_stops stop
  set is_operational = exists (
        select 1
        from public.event_participations participation
        join public.event_jobs job on job.id = participation.event_job_id
        where participation.id = stop.event_participation_id
          and job.status = 'published'
          and participation.status = 'active'
          and v_round.service_date between job.start_date and job.end_date
          and v_round.service_date between participation.start_date and participation.end_date
      ),
      updated_by = auth.uid(),
      updated_at = now()
  where stop.round_id = p_round_id
    and stop.destination_kind = 'event'
    and stop.is_operational is distinct from exists (
      select 1
      from public.event_participations participation
      join public.event_jobs job on job.id = participation.event_job_id
      where participation.id = stop.event_participation_id
        and job.status = 'published'
        and participation.status = 'active'
        and v_round.service_date between job.start_date and job.end_date
        and v_round.service_date between participation.start_date and participation.end_date
    );

  return v_added_count + v_event_added_count;
end;
$$;

update public.event_delivery_feature_settings
set schema_version = greatest(schema_version, 3),
    updated_at = now()
where singleton;

revoke all on function public.enforce_round_stop_snapshot_immutability()
  from public, anon, authenticated;
revoke all on function public.sync_daily_round_destinations(uuid) from public, anon;
grant execute on function public.sync_daily_round_destinations(uuid) to authenticated;

notify pgrst, 'reload schema';
