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
  v_existing public.shop_ice_type_prices%rowtype;
  v_previous public.shop_ice_type_prices%rowtype;
  v_saved public.shop_ice_type_prices%rowtype;
  v_next_valid_from date;
  v_effective_valid_to date;
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

  select min(price.valid_from)
  into v_next_valid_from
  from public.shop_ice_type_prices price
  where price.shop_id = target_shop_id
    and price.ice_type_id = target_ice_type_id
    and price.is_active
    and price.valid_from > target_valid_from;

  v_effective_valid_to := target_valid_to;
  if v_next_valid_from is not null
    and (v_effective_valid_to is null or v_effective_valid_to >= v_next_valid_from) then
    v_effective_valid_to := v_next_valid_from - 1;
  end if;

  select price.*
  into v_existing
  from public.shop_ice_type_prices price
  where price.shop_id = target_shop_id
    and price.ice_type_id = target_ice_type_id
    and price.is_active
    and price.valid_from = target_valid_from
  for update;

  if v_existing.id is not null then
    update public.shop_ice_type_prices
    set unit_price = target_unit_price,
        valid_to = v_effective_valid_to
    where id = v_existing.id
    returning * into v_saved;

    return v_saved;
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
    target_valid_from, v_effective_valid_to, auth.uid()
  )
  returning * into v_saved;

  return v_saved;
end;
$$;

create or replace function public.bulk_set_shop_ice_type_price(
  target_shop_ids uuid[],
  target_ice_type_id uuid,
  target_unit_price numeric,
  target_valid_from date,
  target_valid_to date default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid;
  v_shop_count integer;
begin
  if public.current_app_role() <> 'admin' then
    raise exception 'Only admins can manage shop prices';
  end if;

  select count(*)
  into v_shop_count
  from (
    select distinct shop_id
    from unnest(target_shop_ids) as selected(shop_id)
  ) shops;

  if v_shop_count = 0 then
    raise exception 'Select at least one shop';
  end if;

  if (
    select count(*)
    from public.shops shop
    where shop.id = any(target_shop_ids)
      and shop.status = 'active'
  ) <> v_shop_count then
    raise exception 'One or more selected shops do not exist or are inactive';
  end if;

  for v_shop_id in
    select distinct shop_id
    from unnest(target_shop_ids) as selected(shop_id)
    order by shop_id
  loop
    perform public.set_shop_ice_type_price(
      v_shop_id,
      target_ice_type_id,
      target_unit_price,
      target_valid_from,
      target_valid_to
    );
  end loop;

  return v_shop_count;
end;
$$;

revoke all on function public.set_shop_ice_type_price(uuid, uuid, numeric, date, date) from public;
revoke all on function public.bulk_set_shop_ice_type_price(uuid[], uuid, numeric, date, date) from public;
grant execute on function public.set_shop_ice_type_price(uuid, uuid, numeric, date, date) to authenticated;
grant execute on function public.bulk_set_shop_ice_type_price(uuid[], uuid, numeric, date, date) to authenticated;
