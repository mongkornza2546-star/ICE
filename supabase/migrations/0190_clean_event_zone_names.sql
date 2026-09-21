-- Migration 0190: Clean event zone names and avoid UUID suffixes in zone titles

-- 1. Clean existing event zone names where event UUID was appended
update public.building_zones
set name = regexp_replace(name, '\s*[·/]\s*[0-9a-fA-F-]{36}$', '')
where name ~ '\s*[·/]\s*[0-9a-fA-F-]{36}$';

-- 2. Update create_event_shops to use the human-readable event or zone name without appending UUID
create or replace function public.create_event_shops(
  p_event_job_id uuid,
  p_request_id uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.event_jobs%rowtype;
  v_request public.event_shop_creation_requests%rowtype;
  v_row jsonb;
  v_shop_id uuid;
  v_building_id uuid;
  v_zone_id uuid;
  v_booth text;
  v_zone text;
  v_name text;
  v_created integer := 0;
  v_skipped integer := 0;
  v_result jsonb;
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only an active admin or round lead can create event shops';
  end if;
  if p_request_id is null then raise exception 'A request ID is required'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Expected an array of event shops';
  end if;
  if jsonb_array_length(p_rows) not between 1 and 1000 then
    raise exception 'Create between 1 and 1000 event shops per request';
  end if;
  select * into v_job from public.event_jobs where id = p_event_job_id for update;
  if v_job.id is null then raise exception 'The selected event does not exist'; end if;
  select * into v_request from public.event_shop_creation_requests where request_id = p_request_id;
  if found then
    if v_request.event_job_id <> p_event_job_id or v_request.payload <> p_rows then
      raise exception 'This request ID was already used for different input';
    end if;
    return v_request.result;
  end if;
  if v_job.status = 'cancelled' then raise exception 'Cancelled events cannot accept participations'; end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object' then raise exception 'Invalid event shop row'; end if;
    if nullif(v_row ->> 'start_date', '') is null or nullif(v_row ->> 'end_date', '') is null
      or (v_row ->> 'start_date')::date < v_job.start_date
      or (v_row ->> 'end_date')::date > v_job.end_date
      or (v_row ->> 'end_date')::date < (v_row ->> 'start_date')::date then
      raise exception 'Participation dates must be within the event date range';
    end if;
    v_booth := nullif(upper(trim(v_row ->> 'booth_number')), '');
    v_zone := trim(coalesce(v_row ->> 'event_zone', ''));
    if v_booth is not null and exists (
      select 1 from public.event_participations
      where event_job_id = v_job.id
        and upper(trim(booth_number)) = v_booth
        and upper(trim(coalesce(event_zone, ''))) = upper(v_zone)
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Use the real building if its code/name matches the supplied location.
    -- Otherwise provision an event location so no location entry is mandatory.
    select id into v_building_id from public.buildings
    where is_active and (
      upper(name) = upper(coalesce(nullif(v_zone, ''), v_job.location))
      or upper(code) = upper(coalesce(nullif(v_zone, ''), v_job.location))
      or code = 'EVENT-' || v_job.id::text
    ) order by case when code = 'EVENT-' || v_job.id::text then 1 else 0 end, id limit 1;
    if v_building_id is null then
      insert into public.buildings(code, name)
      values ('EVENT-' || v_job.id::text, coalesce(nullif(v_zone, ''), nullif(v_job.location, ''), v_job.name))
      returning id into v_building_id;
    end if;
    -- Serialize zone ordering against other event creations at this building.
    perform 1 from public.buildings where id = v_building_id for update;
    select id into v_zone_id from public.building_zones
    where building_id = v_building_id and code = 'EVENT-' || v_job.id::text;
    if v_zone_id is null then
      insert into public.building_zones(building_id, code, name, sort_order)
      select v_building_id, 'EVENT-' || v_job.id::text, coalesce(nullif(v_zone, ''), nullif(v_job.location, ''), v_job.name),
        coalesce(max(sort_order), 0) + 1
      from public.building_zones where building_id = v_building_id
      returning id into v_zone_id;
    end if;
    v_shop_id := gen_random_uuid();
    v_name := coalesce(nullif(trim(v_row ->> 'name'), ''),
      case when v_booth is not null then 'บูธ ' || v_booth end,
      'ร้านใหม่ ' || left(v_shop_id::text, 8));
    insert into public.shops(id, code, name, zone_id, event_job_id, contact_name, contact_phone)
    values (v_shop_id, 'EV-' || v_shop_id::text, v_name, v_zone_id, v_job.id,
      nullif(trim(v_row ->> 'contact_name'), ''), nullif(trim(v_row ->> 'contact_phone'), ''));
    perform public.save_event_participation(
      null, v_job.id, v_shop_id, v_booth, v_zone, v_row ->> 'landmark',
      v_row ->> 'contact_name', v_row ->> 'contact_phone',
      (v_row ->> 'start_date')::date, (v_row ->> 'end_date')::date, false
    );
    v_created := v_created + 1;
  end loop;
  v_result := jsonb_build_object('created_count', v_created, 'skipped_count', v_skipped);
  insert into public.event_shop_creation_requests(request_id, event_job_id, payload, result)
  values (p_request_id, v_job.id, p_rows, v_result);
  return v_result;
end;
$$;

revoke all on function public.create_event_shops(uuid, uuid, jsonb) from public, anon;
grant execute on function public.create_event_shops(uuid, uuid, jsonb) to authenticated;
