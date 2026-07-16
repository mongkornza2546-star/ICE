-- Phase 3 review fixes: protect open stock when ice types are retired and
-- expose factory-order history without truncating it behind other movements.

create or replace function public.save_ice_type(
  p_ice_type_id uuid,
  p_code text,
  p_name text,
  p_unit text,
  p_is_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.ice_types%rowtype;
  v_saved public.ice_types%rowtype;
  v_day record;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can save ice types';
  end if;

  if nullif(trim(p_code), '') is null
    or nullif(trim(p_name), '') is null
    or nullif(trim(p_unit), '') is null then
    raise exception 'Ice type code, name, and unit are required';
  end if;

  if p_ice_type_id is null then
    insert into public.ice_types (code, name, unit, is_active)
    values (upper(trim(p_code)), trim(p_name), trim(p_unit), p_is_active)
    returning * into v_saved;
  else
    select * into v_existing
    from public.ice_types
    where id = p_ice_type_id
    for update;

    if not found then
      raise exception 'The selected ice type does not exist';
    end if;

    if v_existing.is_active and not p_is_active then
      -- Stock writes use the same service-date locks. Taking every open date in
      -- order prevents a movement from racing with retirement of its ice type.
      for v_day in
        select distinct round.service_date
        from public.delivery_rounds round
        where not exists (
          select 1
          from public.daily_stock_closures closure
          where closure.service_date = round.service_date
            and closure.status = 'closed'
        )
        order by round.service_date
      loop
        perform pg_advisory_xact_lock(hashtextextended(v_day.service_date::text, 0));
      end loop;

      if exists (
        select 1
        from (
          select distinct round.service_date
          from public.delivery_rounds round
          where not exists (
            select 1
            from public.daily_stock_closures closure
            where closure.service_date = round.service_date
              and closure.status = 'closed'
          )
        ) day
        cross join public.stock_locations location
        where public.stock_balance_at(day.service_date, location.id, p_ice_type_id) <> 0
      ) then
        raise exception 'An ice type with stock on an open service day cannot be deactivated';
      end if;
    end if;

    update public.ice_types
    set code = upper(trim(p_code)),
        name = trim(p_name),
        unit = trim(p_unit),
        is_active = p_is_active
    where id = p_ice_type_id
    returning * into v_saved;
  end if;

  return jsonb_build_object(
    'id', v_saved.id,
    'code', v_saved.code,
    'name', v_saved.name,
    'unit', v_saved.unit,
    'is_active', v_saved.is_active
  );
end;
$$;

create or replace function public.get_factory_order_history(
  p_round_id uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date;
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view factory orders';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'Factory order history limit must be between 1 and 200';
  end if;

  select service_date into v_service_date
  from public.delivery_rounds
  where id = p_round_id;

  if v_service_date is null then
    raise exception 'The selected delivery round does not exist';
  end if;

  select coalesce(jsonb_agg(to_jsonb(recent) order by recent.recorded_at desc), '[]'::jsonb)
  into v_result
  from (
    select
      movement.id,
      movement.kind,
      movement.recorded_at,
      movement.note,
      source.name as from_location_name,
      destination.name as to_location_name,
      recorder.display_name as recorded_by,
      (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'ice_type_id', ice.id,
            'ice_type_name', ice.name,
            'unit', ice.unit,
            'quantity', item.quantity
          ) order by ice.code
        ), '[]'::jsonb)
        from public.stock_movement_items item
        join public.ice_types ice on ice.id = item.ice_type_id
        where item.movement_id = movement.id
      ) as items
    from public.stock_movements movement
    left join public.stock_locations source on source.id = movement.from_location_id
    left join public.stock_locations destination on destination.id = movement.to_location_id
    join public.users recorder on recorder.id = movement.recorded_by
    where movement.service_date = v_service_date
      and movement.kind = 'factory_order'
      and movement.status = 'active'
    order by movement.recorded_at desc
    limit p_limit
  ) recent;

  return v_result;
end;
$$;

drop policy if exists "admins create ice types" on public.ice_types;
drop policy if exists "admins update ice types" on public.ice_types;

revoke all on function public.save_ice_type(uuid, text, text, text, boolean) from public;
revoke all on function public.get_factory_order_history(uuid, integer) from public;
grant execute on function public.save_ice_type(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.get_factory_order_history(uuid, integer) to authenticated;
