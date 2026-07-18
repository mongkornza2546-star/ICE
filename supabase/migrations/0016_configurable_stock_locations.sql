-- Stock locations are administrator-managed.  Earlier releases created a
-- TRUCK-MAIN location and one work-site per building automatically; stop that
-- behaviour so the dashboard only reflects locations configured by the user.

drop trigger if exists buildings_create_stock_location on public.buildings;
drop function if exists public.ensure_building_stock_location();

alter table public.stock_locations
  add column if not exists is_courier_source boolean not null default false,
  add column if not exists is_default_for_building boolean not null default false;

create unique index if not exists stock_locations_one_courier_source_idx
  on public.stock_locations (is_courier_source)
  where is_courier_source;

create unique index if not exists stock_locations_one_default_per_building_idx
  on public.stock_locations (building_id)
  where is_default_for_building;

drop function if exists public.save_stock_location(
  text, text, public.stock_location_kind, uuid, uuid, uuid, boolean
);

create or replace function public.save_stock_location(
  p_code text,
  p_name text,
  p_kind public.stock_location_kind,
  p_location_id uuid default null,
  p_building_id uuid default null,
  p_assigned_user_id uuid default null,
  p_is_courier_source boolean default false,
  p_is_default_for_building boolean default false,
  p_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_location_id uuid;
  v_before jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can manage stock locations';
  end if;

  if nullif(trim(p_code), '') is null or nullif(trim(p_name), '') is null then
    raise exception 'A location code and name are required';
  end if;

  if p_building_id is not null and not exists (
    select 1 from public.buildings where id = p_building_id
  ) then
    raise exception 'The selected building does not exist';
  end if;

  if p_kind = 'work_site' and p_building_id is null then
    raise exception 'A work-site stock location must be linked to a building';
  end if;

  if p_is_courier_source and (p_kind <> 'truck' or not p_is_active) then
    raise exception 'Only an active truck can be the courier stock source';
  end if;

  if p_is_default_for_building and (p_kind <> 'work_site' or p_building_id is null or not p_is_active) then
    raise exception 'Only an active work-site linked to a building can be its default stock location';
  end if;

  if p_kind = 'team' and p_assigned_user_id is null then
    raise exception 'An employee stock location must name its assigned user';
  end if;

  if p_assigned_user_id is not null and not exists (
    select 1 from public.users where id = p_assigned_user_id and is_active
  ) then
    raise exception 'The assigned stock recipient must be an active user';
  end if;

  if p_is_courier_source then
    update public.stock_locations
    set is_courier_source = false
    where is_courier_source and id is distinct from p_location_id;
  end if;

  if p_is_default_for_building then
    update public.stock_locations
    set is_default_for_building = false
    where is_default_for_building
      and building_id = p_building_id
      and id is distinct from p_location_id;
  end if;

  if p_location_id is null then
    insert into public.stock_locations (
      code, name, kind, building_id, assigned_user_id,
      is_courier_source, is_default_for_building, is_active
    ) values (
      upper(trim(p_code)), trim(p_name), p_kind, p_building_id,
      p_assigned_user_id, p_is_courier_source, p_is_default_for_building, p_is_active
    ) returning id into v_location_id;
  else
    select to_jsonb(location), location.id into v_before, v_location_id
    from public.stock_locations location
    where location.id = p_location_id
    for update;

    if v_location_id is null then
      raise exception 'The selected stock location does not exist';
    end if;

    if (
      not p_is_active
      or (v_before ->> 'kind')::public.stock_location_kind <> p_kind
      or (v_before ->> 'building_id')::uuid is distinct from p_building_id
      or (v_before ->> 'assigned_user_id')::uuid is distinct from p_assigned_user_id
    ) and exists (
      select 1
      from (
        select distinct round.service_date
        from public.delivery_rounds round
        where not exists (
          select 1 from public.daily_stock_closures closure
          where closure.service_date = round.service_date and closure.status = 'closed'
        )
      ) day
      join public.ice_types ice on ice.is_active
        and public.stock_balance_at(day.service_date, p_location_id, ice.id) <> 0
    ) then
      raise exception 'A stock location with an open balance cannot be deactivated or reassigned';
    end if;

    if exists (
      select 1 from public.shops shop where shop.stock_location_id = p_location_id
    ) and (
      not p_is_active
      or (v_before ->> 'kind')::public.stock_location_kind <> p_kind
      or (v_before ->> 'building_id')::uuid is distinct from p_building_id
    ) then
      raise exception 'A stock location assigned to shops cannot be deactivated or reassigned';
    end if;

    update public.stock_locations
    set code = upper(trim(p_code)),
        name = trim(p_name),
        kind = p_kind,
        building_id = p_building_id,
        assigned_user_id = p_assigned_user_id,
        is_courier_source = p_is_courier_source,
        is_default_for_building = p_is_default_for_building,
        is_active = p_is_active
    where id = p_location_id;
  end if;

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, before_value, after_value
  )
  select auth.uid(), 'stock_locations', v_location_id,
    case when v_before is null then 'created' else 'updated' end,
    v_before, to_jsonb(location)
  from public.stock_locations location
  where location.id = v_location_id;

  return v_location_id;
end;
$$;

revoke all on function public.save_stock_location(
  text, text, public.stock_location_kind, uuid, uuid, uuid, boolean, boolean, boolean
) from public;
grant execute on function public.save_stock_location(
  text, text, public.stock_location_kind, uuid, uuid, uuid, boolean, boolean, boolean
) to authenticated;

-- Hide legacy auto-created locations that have never been used.  Locations
-- already assigned to a shop or referenced by a movement are retained so that
-- historical deliveries remain valid; they can now be edited in Settings.
update public.stock_locations location
set is_active = false
where location.is_active
  and (location.code = 'TRUCK-MAIN' or location.code like 'SITE-%')
  and not exists (select 1 from public.shops shop where shop.stock_location_id = location.id)
  and not exists (
    select 1
    from public.stock_movements movement
    where movement.from_location_id = location.id or movement.to_location_id = location.id
  );

-- Existing automatic locations remain valid until an administrator replaces
-- them.  Mark one active work-site per building as its default source.
update public.stock_locations location
set is_default_for_building = true
where location.id in (
  select distinct on (building_id) id
  from public.stock_locations
  where kind = 'work_site' and is_active and building_id is not null
  order by building_id, created_at
);

create or replace function public.assign_shop_stock_location()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_building_id uuid;
begin
  select building_id into v_building_id
  from public.building_zones
  where id = new.zone_id;

  if v_building_id is null then
    raise exception 'The selected building zone does not exist';
  end if;

  if new.stock_location_id is null
    or not exists (
      select 1 from public.stock_locations location
      where location.id = new.stock_location_id
        and location.building_id = v_building_id
        and location.is_active
    ) then
    select id into new.stock_location_id
    from public.stock_locations
    where building_id = v_building_id
      and kind = 'work_site'
      and is_default_for_building
      and is_active;
  end if;

  if new.stock_location_id is null then
    raise exception 'The shop building does not have a configured default stock location';
  end if;

  return new;
end;
$$;

-- Preserve a single legacy truck as the source until the administrator selects
-- another one in Settings. Multiple trucks intentionally require a choice.
update public.stock_locations location
set is_courier_source = true
where location.id = (
  select truck.id
  from public.stock_locations truck
  where truck.kind = 'truck' and truck.is_active
    and 1 = (
      select count(*)
      from public.stock_locations candidate
      where candidate.kind = 'truck' and candidate.is_active
    )
);

create or replace function public.get_employee_stock_state(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date;
  v_truck_location_id uuid;
  v_holding_location_id uuid;
  v_active_holding_count integer;
  v_result jsonb;
begin
  if not public.is_active_user() or public.current_app_role() <> 'courier' then
    raise exception 'Only an active courier can view employee stock';
  end if;

  select round.service_date into v_service_date
  from public.delivery_rounds round where round.id = p_round_id;
  if v_service_date is null then
    raise exception 'The selected delivery round does not exist';
  end if;
  if not public.is_round_member(p_round_id) then
    raise exception 'You are not assigned to this delivery round';
  end if;

  select location.id into v_truck_location_id
  from public.stock_locations location
  where location.kind = 'truck' and location.is_courier_source and location.is_active;
  if v_truck_location_id is null then
    raise exception 'Employee stock requires a configured courier source truck';
  end if;

  select count(*)::integer into v_active_holding_count
  from public.stock_locations location
  where location.assigned_user_id = auth.uid()
    and location.kind in ('team', 'small_vehicle') and location.is_active;
  if v_active_holding_count = 0 then
    raise exception 'Employee stock requires one active assigned holding location; none is configured';
  elsif v_active_holding_count > 1 then
    raise exception 'Employee stock requires one active assigned holding location; multiple are configured';
  end if;

  select location.id into v_holding_location_id
  from public.stock_locations location
  where location.assigned_user_id = auth.uid()
    and location.kind in ('team', 'small_vehicle') and location.is_active;

  select jsonb_build_object(
    'round_id', p_round_id,
    'service_date', v_service_date,
    'truck_location', jsonb_build_object(
      'id', truck.id, 'code', truck.code, 'name', truck.name,
      'balances', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'ice_type_id', ice.id, 'ice_type_name', ice.name, 'unit', ice.unit,
          'quantity', public.stock_balance_at(v_service_date, truck.id, ice.id)
        ) order by ice.code), '[]'::jsonb)
        from public.ice_types ice where ice.is_active
      )
    ),
    'holding_location', jsonb_build_object(
      'id', holding.id, 'code', holding.code, 'name', holding.name,
      'balances', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'ice_type_id', ice.id, 'ice_type_name', ice.name, 'unit', ice.unit,
          'quantity', public.stock_balance_at(v_service_date, holding.id, ice.id)
        ) order by ice.code), '[]'::jsonb)
        from public.ice_types ice where ice.is_active
      )
    )
  ) into v_result
  from public.stock_locations truck
  cross join public.stock_locations holding
  where truck.id = v_truck_location_id and holding.id = v_holding_location_id;

  return v_result;
end;
$$;
