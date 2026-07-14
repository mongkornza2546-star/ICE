-- Normalize the real location hierarchy: building -> building zone -> shop.

create table public.building_zones (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references public.buildings(id) on delete restrict,
  code text not null,
  name text not null,
  sort_order integer not null default 1 check (sort_order > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (building_id, code),
  unique (building_id, name),
  unique (building_id, sort_order)
);

alter table public.shops add column zone_id uuid references public.building_zones(id) on delete restrict;

-- Preserve existing shops by converting each distinct free-text zone into a zone row.
insert into public.building_zones (building_id, code, name, sort_order)
select
  building_id,
  'ZONE-' || row_number() over (partition by building_id order by floor_or_zone),
  floor_or_zone,
  row_number() over (partition by building_id order by floor_or_zone)
from (
  select distinct building_id, floor_or_zone
  from public.shops
) existing_zones;

update public.shops s
set zone_id = z.id
from public.building_zones z
where z.building_id = s.building_id and z.name = s.floor_or_zone;

alter table public.shops alter column zone_id set not null;

create or replace function public.sync_shop_location_from_zone()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_building_id uuid;
  v_zone_name text;
begin
  select building_id, name into v_building_id, v_zone_name
  from public.building_zones
  where id = new.zone_id and is_active;

  if v_building_id is null then
    raise exception 'The selected building zone is not active';
  end if;

  new.building_id := v_building_id;
  new.floor_or_zone := v_zone_name;
  return new;
end;
$$;

create or replace function public.sync_shops_after_zone_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.building_id <> old.building_id and exists (
    select 1 from public.shops where zone_id = new.id
  ) then
    raise exception 'A zone with shops cannot move to another building';
  end if;

  if old.is_active and not new.is_active and exists (
    select 1 from public.shops where zone_id = new.id and status = 'active'
  ) then
    raise exception 'Deactivate shops in this zone before deactivating the zone';
  end if;

  if new.name <> old.name then
    update public.shops
    set floor_or_zone = new.name
    where zone_id = new.id;
  end if;
  return new;
end;
$$;

create trigger building_zones_updated_at
  before update on public.building_zones
  for each row execute function public.set_updated_at();
create trigger building_zones_audit_update
  after update on public.building_zones
  for each row execute function public.audit_row_update();
create trigger shops_sync_location_from_zone
  before insert or update of zone_id, building_id, floor_or_zone on public.shops
  for each row execute function public.sync_shop_location_from_zone();
create trigger building_zones_sync_shops
  after update of building_id, name on public.building_zones
  for each row execute function public.sync_shops_after_zone_update();

alter table public.building_zones enable row level security;

create policy "active users read building zones" on public.building_zones for select
  using (public.is_active_user());
create policy "admins create building zones" on public.building_zones for insert
  with check (public.current_app_role() = 'admin');
create policy "admins update building zones" on public.building_zones for update
  using (public.current_app_role() = 'admin') with check (public.current_app_role() = 'admin');

create or replace function public.save_shop_with_routes(
  p_shop_id uuid,
  p_code text,
  p_name text,
  p_zone_id uuid,
  p_contact_name text,
  p_contact_phone text,
  p_normal_rounds_per_day smallint,
  p_access_note text,
  p_status public.shop_status,
  p_route_assignments jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can save shop settings';
  end if;

  if nullif(trim(p_code), '') is null
    or nullif(trim(p_name), '') is null
    or p_normal_rounds_per_day is null
    or p_normal_rounds_per_day <= 0 then
    raise exception 'Shop code, name, and a positive rounds-per-day value are required';
  end if;

  if not exists (
    select 1 from public.building_zones where id = p_zone_id and is_active
  ) then
    raise exception 'The selected building zone is not active';
  end if;

  if jsonb_typeof(p_route_assignments) is distinct from 'array' then
    raise exception 'Route assignments must be a JSON array';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_route_assignments)
      as assignment(route_id uuid, sequence_no integer)
    left join public.routes r on r.id = assignment.route_id and r.is_active
    where assignment.route_id is null
      or assignment.sequence_no is null
      or assignment.sequence_no <= 0
      or r.id is null
  ) or exists (
    select 1
    from jsonb_to_recordset(p_route_assignments)
      as assignment(route_id uuid, sequence_no integer)
    group by assignment.route_id
    having count(*) > 1
  ) then
    raise exception 'Each active route may be assigned once with a positive sequence number';
  end if;

  if p_shop_id is null then
    insert into public.shops (
      code, name, zone_id, contact_name, contact_phone,
      normal_rounds_per_day, access_note, status
    ) values (
      trim(p_code), trim(p_name), p_zone_id,
      nullif(trim(coalesce(p_contact_name, '')), ''),
      nullif(trim(coalesce(p_contact_phone, '')), ''),
      p_normal_rounds_per_day,
      nullif(trim(coalesce(p_access_note, '')), ''),
      p_status
    )
    returning id into v_shop_id;
  else
    update public.shops
    set code = trim(p_code),
        name = trim(p_name),
        zone_id = p_zone_id,
        contact_name = nullif(trim(coalesce(p_contact_name, '')), ''),
        contact_phone = nullif(trim(coalesce(p_contact_phone, '')), ''),
        normal_rounds_per_day = p_normal_rounds_per_day,
        access_note = nullif(trim(coalesce(p_access_note, '')), ''),
        status = p_status
    where id = p_shop_id
    returning id into v_shop_id;

    if v_shop_id is null then
      raise exception 'The selected shop does not exist';
    end if;
  end if;

  update public.route_shops rs
  set is_active = false
  where rs.shop_id = v_shop_id
    and rs.is_active
    and not exists (
      select 1
      from jsonb_to_recordset(p_route_assignments)
        as assignment(route_id uuid, sequence_no integer)
      where assignment.route_id = rs.route_id
    );

  insert into public.route_shops (route_id, shop_id, sequence_no, is_active)
  select assignment.route_id, v_shop_id, assignment.sequence_no, true
  from jsonb_to_recordset(p_route_assignments)
    as assignment(route_id uuid, sequence_no integer)
  on conflict (route_id, shop_id) do update
  set sequence_no = excluded.sequence_no,
      is_active = true;

  return v_shop_id;
end;
$$;

revoke all on function public.save_shop_with_routes(
  uuid, text, text, uuid, text, text, smallint, text, public.shop_status, jsonb
) from public;
grant execute on function public.save_shop_with_routes(
  uuid, text, text, uuid, text, text, smallint, text, public.shop_status, jsonb
) to authenticated;

create index building_zones_building_active_idx
  on public.building_zones (building_id, is_active, sort_order);
create index shops_zone_idx on public.shops (zone_id);
