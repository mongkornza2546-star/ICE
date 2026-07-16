-- Atomic Excel catalog import: building -> zone -> shop.
-- Readable codes are canonical uppercase identities, independent of letter casing.

do $$
begin
  if exists (
    select 1 from public.buildings group by upper(code) having count(*) > 1
  ) then
    raise exception 'Building codes that differ only by letter casing must be merged before enabling Excel import';
  end if;

  if exists (
    select 1 from public.building_zones group by building_id, upper(code) having count(*) > 1
  ) then
    raise exception 'Zone codes that differ only by letter casing must be merged before enabling Excel import';
  end if;

  if exists (
    select 1 from public.shops group by upper(code) having count(*) > 1
  ) then
    raise exception 'Shop codes that differ only by letter casing must be merged before enabling Excel import';
  end if;
end;
$$;

create unique index buildings_code_ci_uidx on public.buildings (upper(code));
create unique index building_zones_building_code_ci_uidx
  on public.building_zones (building_id, upper(code));
create unique index shops_code_ci_uidx on public.shops (upper(code));

alter table public.shops
  add column government_shop_code text;

create or replace function public.save_shop(
  p_shop_id uuid,
  p_code text,
  p_name text,
  p_zone_id uuid,
  p_contact_name text,
  p_contact_phone text,
  p_normal_rounds_per_day smallint,
  p_access_note text,
  p_status public.shop_status,
  p_government_shop_code text
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

  if p_shop_id is null then
    insert into public.shops (
      code, name, zone_id, government_shop_code, contact_name, contact_phone,
      normal_rounds_per_day, access_note, status
    ) values (
      upper(trim(p_code)), trim(p_name), p_zone_id,
      nullif(trim(coalesce(p_government_shop_code, '')), ''),
      nullif(trim(coalesce(p_contact_name, '')), ''),
      nullif(trim(coalesce(p_contact_phone, '')), ''),
      p_normal_rounds_per_day,
      nullif(trim(coalesce(p_access_note, '')), ''),
      p_status
    )
    returning id into v_shop_id;
  else
    update public.shops
    set code = upper(trim(p_code)),
        name = trim(p_name),
        zone_id = p_zone_id,
        government_shop_code = nullif(trim(coalesce(p_government_shop_code, '')), ''),
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

  return v_shop_id;
end;
$$;

revoke all on function public.save_shop(uuid, text, text, uuid, text, text, smallint, text, public.shop_status, text) from public;
grant execute on function public.save_shop(uuid, text, text, uuid, text, text, smallint, text, public.shop_status, text) to authenticated;

create or replace function public.import_shop_catalog(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_building record;
  v_zone record;
  v_building_id uuid;
  v_building_active boolean;
  v_existing_building_code text;
  v_existing_building_name text;
  v_zone_id uuid;
  v_zone_active boolean;
  v_existing_zone_code text;
  v_existing_zone_name text;
  v_shop_id uuid;
  v_created integer := 0;
  v_updated integer := 0;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can import shop settings';
  end if;

  if jsonb_typeof(p_rows) is distinct from 'array'
    or jsonb_array_length(p_rows) = 0
    or jsonb_array_length(p_rows) > 1000 then
    raise exception 'The import must contain between 1 and 1000 rows';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) item
    where nullif(trim(item->>'building_code'), '') is null
      or nullif(trim(item->>'building_name'), '') is null
      or nullif(trim(item->>'zone_code'), '') is null
      or nullif(trim(item->>'zone_name'), '') is null
      or nullif(trim(item->>'shop_code'), '') is null
      or nullif(trim(item->>'shop_name'), '') is null
      or coalesce((item->>'zone_sort_order') ~ '^[1-9][0-9]*$', false) is false
      or coalesce((item->>'normal_rounds_per_day') ~ '^[1-9][0-9]*$', false) is false
      or coalesce(nullif(item->>'status', ''), 'active') not in ('active', 'inactive')
  ) then
    raise exception 'Every row requires valid building, zone, shop, order, rounds, and status values';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) item
    group by upper(trim(item->>'shop_code'))
    having count(*) > 1
  ) then
    raise exception 'Shop codes must be unique inside the import file';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) item
    group by upper(trim(item->>'building_code'))
    having count(distinct trim(item->>'building_name')) > 1
  ) then
    raise exception 'A building code must use one building name';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) item
    group by upper(trim(item->>'building_code')), upper(trim(item->>'zone_code'))
    having count(distinct trim(item->>'zone_name')) > 1
      or count(distinct (item->>'zone_sort_order')::integer) > 1
  ) then
    raise exception 'A zone code must use one name and one order inside its building';
  end if;

  if exists (
    select 1
    from (
      select distinct
        upper(trim(item->>'building_code')) as building_code,
        (item->>'zone_sort_order')::integer as zone_sort_order,
        upper(trim(item->>'zone_code')) as zone_code
      from jsonb_array_elements(p_rows) item
    ) zone_rows
    group by building_code, zone_sort_order
    having count(*) > 1
  ) then
    raise exception 'Zone order values must be unique inside each building';
  end if;

  for v_building in
    select
      upper(trim(item->>'building_code')) as code,
      min(trim(item->>'building_name')) as name
    from jsonb_array_elements(p_rows) item
    group by upper(trim(item->>'building_code'))
  loop
    select id, is_active, code, name
    into v_building_id, v_building_active, v_existing_building_code, v_existing_building_name
    from public.buildings
    where upper(code) = v_building.code
    for update;

    if found then
      if not v_building_active then
        raise exception 'Cannot import into inactive building %', v_building.code;
      end if;

      if v_existing_building_code is distinct from v_building.code
        or v_existing_building_name is distinct from v_building.name then
        update public.buildings
        set code = v_building.code,
            name = v_building.name
        where id = v_building_id;
      end if;
    else
      insert into public.buildings (code, name, is_active)
      values (v_building.code, v_building.name, true)
      returning id into v_building_id;
    end if;

    for v_zone in
      select
        upper(trim(item->>'zone_code')) as code,
        min(trim(item->>'zone_name')) as name,
        (item->>'zone_sort_order')::integer as sort_order
      from jsonb_array_elements(p_rows) item
      where upper(trim(item->>'building_code')) = v_building.code
      group by upper(trim(item->>'zone_code')), (item->>'zone_sort_order')::integer
      order by (item->>'zone_sort_order')::integer
    loop
      select id, is_active, code, name
      into v_zone_id, v_zone_active, v_existing_zone_code, v_existing_zone_name
      from public.building_zones
      where building_id = v_building_id
        and upper(code) = v_zone.code
      for update;

      if found then
        if not v_zone_active then
          raise exception 'Cannot import into inactive zone % in building %', v_zone.code, v_building.code;
        end if;

        -- Existing zone order is master data and is never changed by a partial shop import.
        if v_existing_zone_code is distinct from v_zone.code
          or v_existing_zone_name is distinct from v_zone.name then
          update public.building_zones
          set code = v_zone.code,
              name = v_zone.name
          where id = v_zone_id;
        end if;
      else
        if exists (
          select 1
          from public.building_zones
          where building_id = v_building_id
            and sort_order = v_zone.sort_order
        ) then
          raise exception 'Zone order % is already used in building %', v_zone.sort_order, v_building.code;
        end if;

        insert into public.building_zones (building_id, code, name, sort_order, is_active)
        values (v_building_id, v_zone.code, v_zone.name, v_zone.sort_order, true)
        returning id into v_zone_id;
      end if;
    end loop;
  end loop;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    select zone.id into v_zone_id
    from public.building_zones zone
    join public.buildings building on building.id = zone.building_id
    where upper(building.code) = upper(trim(v_row->>'building_code'))
      and upper(zone.code) = upper(trim(v_row->>'zone_code'));

    select id into v_shop_id
    from public.shops
    where upper(code) = upper(trim(v_row->>'shop_code'))
    for update;

    if found then
      update public.shops
      set code = upper(trim(v_row->>'shop_code')),
          name = trim(v_row->>'shop_name'),
          zone_id = v_zone_id,
          government_shop_code = nullif(trim(coalesce(v_row->>'government_shop_code', '')), ''),
          contact_name = nullif(trim(coalesce(v_row->>'contact_name', '')), ''),
          contact_phone = nullif(trim(coalesce(v_row->>'contact_phone', '')), ''),
          normal_rounds_per_day = (v_row->>'normal_rounds_per_day')::smallint,
          access_note = nullif(trim(coalesce(v_row->>'access_note', '')), ''),
          status = coalesce(nullif(v_row->>'status', ''), 'active')::public.shop_status
      where id = v_shop_id;
      v_updated := v_updated + 1;
    else
      insert into public.shops (
        code, name, zone_id, government_shop_code, contact_name, contact_phone,
        normal_rounds_per_day, access_note, status
      ) values (
        upper(trim(v_row->>'shop_code')),
        trim(v_row->>'shop_name'),
        v_zone_id,
        nullif(trim(coalesce(v_row->>'government_shop_code', '')), ''),
        nullif(trim(coalesce(v_row->>'contact_name', '')), ''),
        nullif(trim(coalesce(v_row->>'contact_phone', '')), ''),
        (v_row->>'normal_rounds_per_day')::smallint,
        nullif(trim(coalesce(v_row->>'access_note', '')), ''),
        coalesce(nullif(v_row->>'status', ''), 'active')::public.shop_status
      );
      v_created := v_created + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'row_count', jsonb_array_length(p_rows),
    'created_shop_count', v_created,
    'updated_shop_count', v_updated
  );
end;
$$;

revoke all on function public.import_shop_catalog(jsonb) from public;
grant execute on function public.import_shop_catalog(jsonb) to authenticated;
