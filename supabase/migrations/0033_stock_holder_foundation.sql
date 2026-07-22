-- Add holds_inventory and requires_daily_count to stock_locations
alter table public.stock_locations
  add column if not exists holds_inventory boolean not null default true,
  add column if not exists requires_daily_count boolean not null default false;

alter table public.stock_locations
  add constraint stock_locations_daily_count_requires_inventory_check
  check (not requires_daily_count or holds_inventory);

alter table public.stock_locations
  add constraint stock_locations_courier_source_is_holder_check
  check (
    not is_courier_source
    or (kind = 'truck' and is_active and holds_inventory)
  );

-- Existing work sites still hold legacy balances until migration 0036 performs
-- the cutover. NOT VALID leaves those rows in place while preventing new writes
-- from reintroducing inventory-holding work sites.
alter table public.stock_locations
  add constraint stock_locations_work_site_report_only_check
  check (kind <> 'work_site' or not holds_inventory) not valid;

-- Enforce that one active user can only own at most one active team/small_vehicle holding location
create unique index if not exists stock_locations_one_active_employee_holding_idx
  on public.stock_locations (assigned_user_id)
  where is_active and (kind in ('team', 'small_vehicle'));

-- Create stock_holder_area_assignments table
create table if not exists public.stock_holder_area_assignments (
  id uuid primary key default gen_random_uuid(),
  stock_location_id uuid not null references public.stock_locations(id) on delete restrict,
  building_id uuid references public.buildings(id) on delete restrict,
  zone_id uuid references public.building_zones(id) on delete restrict,
  assigned_by uuid references public.users(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  constraint stock_holder_area_assignments_zone_building_check check (
    (zone_id is null) or (building_id is not null)
  )
);

create unique index if not exists stock_holder_area_assignments_uniq_idx
  on public.stock_holder_area_assignments (
    stock_location_id,
    coalesce(building_id, '00000000-0000-0000-0000-000000000000'),
    coalesce(zone_id, '00000000-0000-0000-0000-000000000000')
  );

alter table public.stock_holder_area_assignments enable row level security;

create policy "active users read stock holder area assignments"
  on public.stock_holder_area_assignments for select
  using (public.is_active_user());

-- Drop old function signature before creating updated version
drop function if exists public.save_stock_location(
  text, text, public.stock_location_kind, uuid, uuid, uuid, boolean, boolean, boolean
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
  p_is_active boolean default true,
  p_holds_inventory boolean default true,
  p_requires_daily_count boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_location_id uuid;
  v_before jsonb;
  v_holds_inventory boolean;
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

  if p_is_default_for_building and (p_kind <> 'work_site' or p_building_id is null or not p_is_active) then
    raise exception 'Only an active work-site linked to a building can be its default stock location';
  end if;

  if p_kind = 'team' and p_assigned_user_id is null then
    raise exception 'An employee stock location must name its assigned user';
  end if;

  v_holds_inventory := case when p_kind = 'work_site' then false else p_holds_inventory end;

  if p_is_courier_source and (p_kind <> 'truck' or not p_is_active or not v_holds_inventory) then
    raise exception 'Only an active inventory-holding truck can be the courier stock source';
  end if;

  if p_requires_daily_count and not v_holds_inventory then
    raise exception 'Only an inventory-holding location can require a daily count';
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
      is_courier_source, is_default_for_building, is_active,
      holds_inventory, requires_daily_count
    ) values (
      upper(trim(p_code)), trim(p_name), p_kind, p_building_id,
      p_assigned_user_id, p_is_courier_source, p_is_default_for_building, p_is_active,
      v_holds_inventory, p_requires_daily_count
    ) returning id into v_location_id;
  else
    select to_jsonb(location), location.id into v_before, v_location_id
    from public.stock_locations location
    where location.id = p_location_id
    for update;

    if v_location_id is null then
      raise exception 'The selected stock location does not exist';
    end if;

    -- Enforce: Cannot change owner if location has history
    if (v_before ->> 'assigned_user_id')::uuid is distinct from p_assigned_user_id
      and (
        exists (
          select 1 from public.stock_movements
          where from_location_id = p_location_id or to_location_id = p_location_id
        ) or exists (
          select 1 from public.delivery_events
          where source_stock_location_id = p_location_id
        ) or exists (
          select 1 from public.stock_count_snapshots
          where location_id = p_location_id
        )
      ) then
      raise exception 'Cannot change the owner of a stock location with movement or delivery history';
    end if;

    if (
      not p_is_active
      or (v_before ->> 'kind')::public.stock_location_kind <> p_kind
      or (v_before ->> 'building_id')::uuid is distinct from p_building_id
      or (v_before ->> 'assigned_user_id')::uuid is distinct from p_assigned_user_id
      or (
        coalesce((v_before ->> 'holds_inventory')::boolean, true)
        and not v_holds_inventory
      )
    ) and exists (
      select 1
      from (
        select movement.service_date
        from public.stock_movements movement
        union
        select round.service_date
        from public.delivery_rounds round
      ) day
      where not exists (
        select 1 from public.daily_stock_closures closure
        where closure.service_date = day.service_date and closure.status = 'closed'
      )
        and exists (
          select 1
          from public.ice_types ice
          where public.stock_balance_at(day.service_date, p_location_id, ice.id) <> 0
        )
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
        is_active = p_is_active,
        holds_inventory = v_holds_inventory,
        requires_daily_count = p_requires_daily_count
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

grant execute on function public.save_stock_location(
  text, text, public.stock_location_kind, uuid, uuid, uuid, boolean, boolean, boolean, boolean, boolean
) to authenticated;

-- Preserve the proven live/snapshot summary implementation and enrich only its
-- location contract with holder metadata required by v2 clients.
alter function public.get_stock_control_summary(uuid, date)
  rename to get_stock_control_summary_v1;

create function public.get_stock_control_summary(
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
  v_result := public.get_stock_control_summary_v1(p_round_id, p_service_date);

  select coalesce(jsonb_agg(
    location_value || jsonb_build_object(
      'holds_inventory', coalesce(location.holds_inventory, false),
      'requires_daily_count', coalesce(location.requires_daily_count, false),
      'is_courier_source', coalesce(location.is_courier_source, false)
    ) order by location_ordinality
  ), '[]'::jsonb)
  into v_locations
  from jsonb_array_elements(coalesce(v_result -> 'locations', '[]'::jsonb))
    with ordinality as summary_location(location_value, location_ordinality)
  left join public.stock_locations location
    on location.id = (location_value ->> 'id')::uuid;

  return jsonb_set(v_result, '{locations}', v_locations, true);
end;
$$;

revoke all on function public.get_stock_control_summary_v1(uuid, date) from public, authenticated;
revoke all on function public.get_stock_control_summary(uuid, date) from public;
grant execute on function public.get_stock_control_summary(uuid, date) to authenticated;
