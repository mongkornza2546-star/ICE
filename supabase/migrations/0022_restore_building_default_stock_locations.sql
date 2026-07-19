-- A shop must always point at an active stock location. Migration 0016 made
-- stock locations configurable, but removing the building trigger meant that
-- Excel imports could create a building and then fail on its first shop. Keep
-- the generated work-site as a replaceable default so a fresh/reset database
-- remains bootstrappable.

create or replace function public.ensure_building_default_stock_location()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := 'SITE-' || upper(trim(new.code));
begin
  if exists (select 1 from public.stock_locations where code = v_code) then
    v_code := v_code || '-' || left(replace(new.id::text, '-', ''), 8);
  end if;

  insert into public.stock_locations (
    code, name, kind, building_id, is_active, is_default_for_building
  ) values (
    v_code,
    new.name || ' · จุดปฏิบัติงาน',
    'work_site',
    new.id,
    true,
    true
  );

  return new;
end;
$$;

drop trigger if exists buildings_create_default_stock_location on public.buildings;
create trigger buildings_create_default_stock_location
  after insert on public.buildings
  for each row execute function public.ensure_building_default_stock_location();

-- An inactive row cannot serve shops and must not reserve the one-default slot.
update public.stock_locations
set is_default_for_building = false
where is_default_for_building and not is_active;

-- Prefer restoring the legacy generated location so existing identifiers and
-- movement history remain intact.
update public.stock_locations location
set is_active = true,
    is_default_for_building = true
from public.buildings building
where location.building_id = building.id
  and location.kind = 'work_site'
  and upper(location.code) = 'SITE-' || upper(trim(building.code))
  and not exists (
    select 1
    from public.stock_locations configured
    where configured.building_id = building.id
      and configured.kind = 'work_site'
      and configured.is_default_for_building
      and configured.is_active
  );

-- Backfill buildings created while the automatic default was disabled.
insert into public.stock_locations (
  code, name, kind, building_id, is_active, is_default_for_building
)
select
  case
    when exists (
      select 1 from public.stock_locations collision
      where collision.code = 'SITE-' || upper(trim(building.code))
    ) then 'SITE-' || upper(trim(building.code)) || '-'
      || left(replace(building.id::text, '-', ''), 8)
    else 'SITE-' || upper(trim(building.code))
  end,
  building.name || ' · จุดปฏิบัติงาน',
  'work_site',
  building.id,
  true,
  true
from public.buildings building
where not exists (
  select 1
  from public.stock_locations configured
  where configured.building_id = building.id
    and configured.kind = 'work_site'
    and configured.is_default_for_building
    and configured.is_active
);
