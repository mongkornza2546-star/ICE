create or replace function public.set_ice_type_price(
  target_ice_type_id uuid,
  target_unit_price numeric,
  target_valid_from date,
  target_valid_to date default null
)
returns public.ice_type_prices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous public.ice_type_prices%rowtype;
  v_created public.ice_type_prices%rowtype;
begin
  if public.current_app_role() <> 'admin' then
    raise exception 'Only admins can manage standard prices';
  end if;
  if target_unit_price is null or target_unit_price <= 0 then
    raise exception 'Unit price must be greater than zero';
  end if;
  if target_valid_from is null or (target_valid_to is not null and target_valid_to < target_valid_from) then
    raise exception 'Invalid effective date range';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ice-type-price:' || target_ice_type_id::text, 0));

  if exists (
    select 1
    from public.ice_type_prices price
    where price.ice_type_id = target_ice_type_id
      and price.is_active
      and price.valid_from = target_valid_from
  ) then
    raise exception 'An active standard price already starts on this date';
  end if;

  select price.*
  into v_previous
  from public.ice_type_prices price
  where price.ice_type_id = target_ice_type_id
    and price.is_active
    and price.valid_from < target_valid_from
    and (price.valid_to is null or price.valid_to >= target_valid_from)
  order by price.valid_from desc
  limit 1
  for update;

  if v_previous.id is not null then
    update public.ice_type_prices
    set valid_to = target_valid_from - 1
    where id = v_previous.id;
  end if;

  insert into public.ice_type_prices (
    ice_type_id, unit_price, valid_from, valid_to, created_by
  ) values (
    target_ice_type_id, target_unit_price, target_valid_from, target_valid_to, auth.uid()
  )
  returning * into v_created;

  return v_created;
end;
$$;

create or replace function public.set_shop_ice_type_price(
  target_shop_id uuid,
  target_ice_type_id uuid,
  target_unit_price numeric,
  target_valid_from date,
  target_valid_to date default null
)
returns public.shop_ice_type_prices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous public.shop_ice_type_prices%rowtype;
  v_created public.shop_ice_type_prices%rowtype;
begin
  if public.current_app_role() <> 'admin' then
    raise exception 'Only admins can manage shop prices';
  end if;
  if target_unit_price is null or target_unit_price <= 0 then
    raise exception 'Unit price must be greater than zero';
  end if;
  if target_valid_from is null or (target_valid_to is not null and target_valid_to < target_valid_from) then
    raise exception 'Invalid effective date range';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('shop-ice-price:' || target_shop_id::text || ':' || target_ice_type_id::text, 0)
  );

  if exists (
    select 1
    from public.shop_ice_type_prices price
    where price.shop_id = target_shop_id
      and price.ice_type_id = target_ice_type_id
      and price.is_active
      and price.valid_from = target_valid_from
  ) then
    raise exception 'An active shop price already starts on this date';
  end if;

  select price.*
  into v_previous
  from public.shop_ice_type_prices price
  where price.shop_id = target_shop_id
    and price.ice_type_id = target_ice_type_id
    and price.is_active
    and price.valid_from < target_valid_from
    and (price.valid_to is null or price.valid_to >= target_valid_from)
  order by price.valid_from desc
  limit 1
  for update;

  if v_previous.id is not null then
    update public.shop_ice_type_prices
    set valid_to = target_valid_from - 1
    where id = v_previous.id;
  end if;

  insert into public.shop_ice_type_prices (
    shop_id, ice_type_id, unit_price, valid_from, valid_to, created_by
  ) values (
    target_shop_id, target_ice_type_id, target_unit_price,
    target_valid_from, target_valid_to, auth.uid()
  )
  returning * into v_created;

  return v_created;
end;
$$;

revoke all on function public.set_ice_type_price(uuid, numeric, date, date) from public;
revoke all on function public.set_shop_ice_type_price(uuid, uuid, numeric, date, date) from public;
grant execute on function public.set_ice_type_price(uuid, numeric, date, date) to authenticated;
grant execute on function public.set_shop_ice_type_price(uuid, uuid, numeric, date, date) to authenticated;
