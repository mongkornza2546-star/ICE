-- Delivery rounds no longer follow a pre-defined route.  Keep the nullable
-- legacy reference only so historical rounds remain intact.

alter table public.delivery_rounds
  alter column route_id drop not null;

drop function if exists public.create_delivery_round(date, text, uuid, uuid[], jsonb);

create function public.create_delivery_round(
  p_service_date date,
  p_name text,
  p_member_ids uuid[],
  p_loaded_quantities jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_id uuid;
  v_member_ids uuid[];
  v_expected_stop_count integer;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can create a delivery round';
  end if;

  if p_service_date is null or nullif(trim(p_name), '') is null then
    raise exception 'A service date and round name are required';
  end if;

  if jsonb_typeof(p_loaded_quantities) is distinct from 'array' then
    raise exception 'Loaded quantities must be a JSON array';
  end if;

  select array_agg(distinct member_id)
  into v_member_ids
  from unnest(coalesce(p_member_ids, '{}'::uuid[]) || auth.uid()) as member_id;

  if exists (
    select 1
    from unnest(v_member_ids) as member_id
    left join public.users u on u.id = member_id
    where u.id is null or not u.is_active
  ) then
    raise exception 'Every round member must be an active user';
  end if;

  if not exists (select 1 from public.ice_types where is_active) then
    raise exception 'At least one active ice type is required';
  end if;

  select count(*)
  into v_expected_stop_count
  from public.shops s
  join public.buildings b on b.id = s.building_id and b.is_active
  where s.status = 'active';

  if v_expected_stop_count = 0 then
    raise exception 'At least one active shop is required';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_loaded_quantities) as q(ice_type_id uuid, quantity integer)
    left join public.ice_types i on i.id = q.ice_type_id and i.is_active
    where q.ice_type_id is null or q.quantity is null or q.quantity < 0 or i.id is null
  ) or exists (
    select 1
    from jsonb_to_recordset(p_loaded_quantities) as q(ice_type_id uuid, quantity integer)
    group by q.ice_type_id
    having count(*) > 1
  ) then
    raise exception 'Loaded quantities must name each active ice type once with a non-negative quantity';
  end if;

  insert into public.delivery_rounds (service_date, name, opened_by)
  values (p_service_date, trim(p_name), auth.uid())
  returning id into v_round_id;

  insert into public.delivery_round_members (round_id, user_id)
  select v_round_id, member_id
  from unnest(v_member_ids) as member_id;

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
    v_round_id,
    s.id,
    s.code,
    s.name,
    b.id,
    b.name,
    s.floor_or_zone,
    row_number() over (order by b.code, coalesce(z.sort_order, 0), s.code)::integer,
    auth.uid()
  from public.shops s
  join public.buildings b on b.id = s.building_id and b.is_active
  left join public.building_zones z on z.id = s.zone_id
  where s.status = 'active';

  insert into public.round_ice_counts (round_id, ice_type_id, loaded_quantity, updated_by)
  select
    v_round_id,
    i.id,
    coalesce(q.quantity, 0),
    auth.uid()
  from public.ice_types i
  left join jsonb_to_recordset(p_loaded_quantities) as q(ice_type_id uuid, quantity integer)
    on q.ice_type_id = i.id
  where i.is_active;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(),
    'delivery_rounds',
    v_round_id,
    'created',
    jsonb_build_object('service_date', p_service_date, 'name', trim(p_name), 'shop_source', 'all_active_shops')
  );

  return v_round_id;
end;
$$;

create or replace function public.save_shop(
  p_shop_id uuid,
  p_code text,
  p_name text,
  p_zone_id uuid,
  p_contact_name text,
  p_contact_phone text,
  p_normal_rounds_per_day smallint,
  p_access_note text,
  p_status public.shop_status
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

  return v_shop_id;
end;
$$;

revoke all on function public.create_delivery_round(date, text, uuid[], jsonb) from public;
revoke all on function public.save_shop(uuid, text, text, uuid, text, text, smallint, text, public.shop_status) from public;
grant execute on function public.create_delivery_round(date, text, uuid[], jsonb) to authenticated;
grant execute on function public.save_shop(uuid, text, text, uuid, text, text, smallint, text, public.shop_status) to authenticated;
