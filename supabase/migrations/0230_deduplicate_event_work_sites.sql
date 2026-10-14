-- Event compatibility buildings are report-only implementation records, not
-- permanent work sites. Preserve all rows/history; filter only live summaries.
-- Fix the shared resolver used by both admin bulk entry and employee booths.

create or replace function public.resolve_event_shop_zone_internal(
  p_event_job_id uuid, p_event_zone text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_job public.event_jobs%rowtype;
  v_zone text := trim(coalesce(p_event_zone, ''));
  v_building_id uuid;
  v_zone_id uuid;
  v_zone_code text;
  v_zone_name text;
  v_location text;
begin
  select * into v_job from public.event_jobs where id = p_event_job_id for update;
  if not found then raise exception 'The selected event does not exist'; end if;

  v_location := coalesce(nullif(trim(v_job.location), ''), nullif(v_zone, ''), v_job.name);
  -- Prefer permanent buildings. Generated EVENT-* rows must never win a
  -- name match for another event. Preserve explicit location over zone labels.
  select id into v_building_id from public.buildings
  where is_active and btrim(code) !~* '^(SITE-)?EVENT-' and (
    upper(btrim(name)) = upper(v_location)
    or upper(btrim(code)) = upper(v_location)
  ) order by id limit 1;

  if v_building_id is null then
    -- "A" and "ตึก A" are aliases only when they identify one active building.
    -- Ambiguous labels keep the event's separate compatibility location.
    select min(id::text)::uuid into v_building_id from public.buildings
    where is_active and btrim(code) !~* '^(SITE-)?EVENT-' and (
      upper(regexp_replace(btrim(name), '^ตึก[[:space:]]*', '')) =
        upper(regexp_replace(v_location, '^ตึก[[:space:]]*', ''))
      or upper(regexp_replace(btrim(code), '^ตึก[[:space:]]*', '')) =
        upper(regexp_replace(v_location, '^ตึก[[:space:]]*', ''))
    ) having count(*) = 1;
  end if;

  if v_building_id is null then
    select id into v_building_id from public.buildings
    where upper(code) = upper('EVENT-' || v_job.id::text);
  end if;

  if v_building_id is null then
    insert into public.buildings(code, name)
    values ('EVENT-' || v_job.id::text, coalesce(nullif(v_job.location, ''), nullif(v_zone, ''), v_job.name))
    returning id into v_building_id;
  else
    update public.buildings set is_active = true where id = v_building_id and not is_active;
  end if;

  -- Serialize zone ordering against other event creations at this building.
  perform 1 from public.buildings where id = v_building_id for update;

  v_zone_code := 'EVENT-' || v_job.id::text || case when nullif(v_zone, '') is not null then '-' || md5(v_zone) else '' end;
  v_zone_name := coalesce(nullif(v_zone, ''), nullif(v_job.location, ''), v_job.name);

  select id into v_zone_id from public.building_zones
  where building_id = v_building_id
    and (
      upper(code) = upper(v_zone_code)
      or upper(name) = upper(v_zone_name)
    )
  order by
    case when upper(code) = upper(v_zone_code) then 0 else 1 end,
    id
  limit 1;

  if v_zone_id is null then
    insert into public.building_zones(building_id, code, name, sort_order)
    select
      v_building_id,
      v_zone_code,
      v_zone_name,
      coalesce(max(sort_order), 0) + 1
    from public.building_zones
    where building_id = v_building_id
    returning id into v_zone_id;
  else
    update public.building_zones set is_active = true where id = v_zone_id and not is_active;
  end if;
  return v_zone_id;
end;
$$;
revoke all on function public.resolve_event_shop_zone_internal(uuid,text) from public, anon, authenticated;

create or replace function public.get_stock_control_summary(
  p_round_id uuid default null,
  p_service_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_locations jsonb;
begin
  v_result := public.get_stock_control_summary_v2(p_round_id, p_service_date);

  select coalesce(jsonb_agg(
    location_value || jsonb_build_object(
      'holds_inventory', coalesce(location.holds_inventory, false),
      'requires_daily_count', coalesce(location.requires_daily_count, false),
      'is_courier_source', coalesce(location.is_courier_source, false),
      'assigned_employee', case
        when coalesce((v_result ->> 'is_snapshot')::boolean, false) then null
        else (
          select jsonb_build_object(
            'id', employee.id,
            'code', employee.code,
            'display_name', employee.display_name,
            'nickname', employee.nickname,
            'avatar_path', employee.avatar_path
          )
          from public.users employee
          where employee.id = location.assigned_user_id
            and employee.is_active
        )
      end,
      'assigned_work_sites', case
        when coalesce((v_result ->> 'is_snapshot')::boolean, false) then '[]'::jsonb
        else coalesce((
          select jsonb_agg(jsonb_build_object('id', work_site.id, 'code', work_site.code, 'name', work_site.name) order by work_site.code, work_site.name)
          from public.employee_work_site_assignments assignment
          join public.stock_locations work_site on work_site.id = assignment.stock_location_id
          where assignment.user_id = location.assigned_user_id
            and work_site.kind = 'work_site'
            and work_site.is_active
        ), '[]'::jsonb)
      end,
      'assigned_employees', case
        when coalesce((v_result ->> 'is_snapshot')::boolean, false) then '[]'::jsonb
        when location.kind = 'work_site' then coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', employee.id,
            'code', employee.code,
            'display_name', employee.display_name,
            'nickname', employee.nickname,
            'avatar_path', employee.avatar_path
          ) order by employee.code, employee.display_name)
          from public.employee_work_site_assignments assignment
          join public.users employee on employee.id = assignment.user_id
          where assignment.stock_location_id = location.id
            and employee.is_active
        ), '[]'::jsonb)
        else '[]'::jsonb
      end,
      'balances', coalesce((
        select jsonb_agg(balance_value || jsonb_build_object('image_path', ice_type.image_path) order by balance_ordinality)
        from jsonb_array_elements(coalesce(location_value -> 'balances', '[]'::jsonb))
          with ordinality as summary_balance(balance_value, balance_ordinality)
        left join public.ice_types ice_type on ice_type.id = (balance_value ->> 'ice_type_id')::uuid
      ), '[]'::jsonb)
    ) order by location_ordinality
  ), '[]'::jsonb)
  into v_locations
  from jsonb_array_elements(coalesce(v_result -> 'locations', '[]'::jsonb))
    with ordinality as summary_location(location_value, location_ordinality)
  left join public.stock_locations location
    on location.id = (location_value ->> 'id')::uuid
  left join public.buildings building on building.id = location.building_id
  where coalesce((v_result ->> 'is_snapshot')::boolean, false)
    or not coalesce((
      location.kind = 'work_site'
      and location.holds_inventory = false
      and (
        coalesce(btrim(location.code) ~* '^(SITE-)?EVENT-', false)
        or coalesce(btrim(building.code) ~* '^(SITE-)?EVENT-', false)
      )
    ), false);

  return jsonb_set(v_result, '{locations}', v_locations, true);
end;
$$;

revoke all on function public.get_stock_control_summary(uuid, date) from public;
grant execute on function public.get_stock_control_summary(uuid, date) to authenticated;
