-- Preview and context RPCs run in read-only transactions.  Keep the row lock
-- for delivery writes, but use a plain lookup when the transaction is read-only.

create or replace function public.resolve_delivery_price(
  p_shop_id uuid,
  p_ice_type_id uuid,
  p_service_date date
)
returns table (
  unit_price numeric(12,2),
  price_source public.price_source,
  price_source_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('transaction_read_only') = 'on' then
    return query
    select price.unit_price, 'shop_override'::public.price_source, price.id
    from public.shop_ice_type_prices price
    where price.shop_id = p_shop_id
      and price.ice_type_id = p_ice_type_id
      and price.is_active
      and price.valid_from <= p_service_date
      and (price.valid_to is null or price.valid_to >= p_service_date)
    order by price.valid_from desc
    limit 1;

    if found then
      return;
    end if;

    return query
    select price.unit_price, 'standard'::public.price_source, price.id
    from public.ice_type_prices price
    where price.ice_type_id = p_ice_type_id
      and price.is_active
      and price.valid_from <= p_service_date
      and (price.valid_to is null or price.valid_to >= p_service_date)
    order by price.valid_from desc
    limit 1;
    return;
  end if;

  return query
  select price.unit_price, 'shop_override'::public.price_source, price.id
  from public.shop_ice_type_prices price
  where price.shop_id = p_shop_id
    and price.ice_type_id = p_ice_type_id
    and price.is_active
    and price.valid_from <= p_service_date
    and (price.valid_to is null or price.valid_to >= p_service_date)
  order by price.valid_from desc
  limit 1
  for share;

  if found then
    return;
  end if;

  return query
  select price.unit_price, 'standard'::public.price_source, price.id
  from public.ice_type_prices price
  where price.ice_type_id = p_ice_type_id
    and price.is_active
    and price.valid_from <= p_service_date
    and (price.valid_to is null or price.valid_to >= p_service_date)
  order by price.valid_from desc
  limit 1
  for share;
end;
$$;

notify pgrst, 'reload schema';
