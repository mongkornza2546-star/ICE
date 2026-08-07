-- Treat government_shop_code as a reusable stall/sales-space code.
-- Historical inactive shops may share a code, but only one active shop may use it.

-- Keep the duplicate preflight and index build on one stable table state.
lock table public.shops in share row exclusive mode;

do $$
declare
  v_duplicates text;
begin
  select string_agg(
    format('%s [%s]', duplicate.stall_code, array_to_string(duplicate.shop_codes, ', ')),
    '; '
    order by duplicate.stall_code
  )
  into v_duplicates
  from (
    select
      upper(trim(government_shop_code)) as stall_code,
      array_agg(code order by code) as shop_codes
    from public.shops
    where status = 'active'
      and nullif(trim(government_shop_code), '') is not null
    group by upper(trim(government_shop_code))
    having count(*) > 1
  ) duplicate;

  if v_duplicates is not null then
    raise exception
      'Active shop stall codes must be resolved before applying this migration: %',
      v_duplicates;
  end if;
end;
$$;

create unique index shops_one_active_stall_code_uidx
  on public.shops (upper(trim(government_shop_code)))
  where status = 'active'
    and nullif(trim(government_shop_code), '') is not null;

create or replace function public.enforce_one_active_shop_per_stall()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_old_stall_code text;
  v_new_stall_code text;
  v_lock_code text;
begin
  if tg_op = 'UPDATE' then
    v_old_stall_code := nullif(upper(trim(coalesce(old.government_shop_code, ''))), '');
  end if;
  v_new_stall_code := nullif(upper(trim(coalesce(new.government_shop_code, ''))), '');

  -- Lock releases and acquisitions in a stable order. This makes an outgoing
  -- inactive update and an incoming active insert safe across concurrent clients.
  for v_lock_code in
    select distinct lock_code
    from unnest(array[v_old_stall_code, v_new_stall_code]) lock_code
    where lock_code is not null
    order by lock_code
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_code, 0));
  end loop;

  if new.status = 'active'
    and v_new_stall_code is not null
    and exists (
      select 1
      from public.shops shop
      where shop.status = 'active'
        and upper(trim(shop.government_shop_code)) = v_new_stall_code
        and shop.id is distinct from new.id
    ) then
    raise exception using
      errcode = '23505',
      constraint = 'shops_one_active_stall_code_uidx',
      message = 'รหัสล็อกนี้มีร้านที่ใช้งานอยู่แล้ว กรุณาปิดร้านเดิมก่อนเปิดร้านใหม่';
  end if;

  return new;
end;
$$;

create trigger shops_enforce_one_active_stall
  before insert or update of government_shop_code, status on public.shops
  for each row execute function public.enforce_one_active_shop_per_stall();

-- Keep the original import implementation intact and private. The public wrapper
-- validates the intended final state and orders releases before acquisitions.
alter function public.import_shop_catalog(jsonb)
  rename to import_shop_catalog_without_stall_validation;

revoke all on function public.import_shop_catalog_without_stall_validation(jsonb) from public;
revoke all on function public.import_shop_catalog_without_stall_validation(jsonb) from authenticated;

create function public.import_shop_catalog(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conflicting_stall_code text;
  v_ordered_rows jsonb;
  v_result jsonb;
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
    group by upper(trim(item->>'shop_code'))
    having count(*) > 1
  ) then
    raise exception 'Shop codes must be unique inside the import file';
  end if;

  with input_rows as (
    select
      upper(trim(item->>'shop_code')) as shop_code,
      nullif(upper(trim(coalesce(item->>'government_shop_code', ''))), '') as stall_code,
      coalesce(nullif(item->>'status', ''), 'active') as status
    from jsonb_array_elements(p_rows) item
  ), final_active_stalls as (
    select upper(trim(shop.government_shop_code)) as stall_code
    from public.shops shop
    where shop.status = 'active'
      and nullif(trim(shop.government_shop_code), '') is not null
      and not exists (
        select 1
        from input_rows input
        where input.shop_code = upper(trim(shop.code))
      )
    union all
    select input.stall_code
    from input_rows input
    where input.status = 'active'
      and input.stall_code is not null
  )
  select final.stall_code
  into v_conflicting_stall_code
  from final_active_stalls final
  group by final.stall_code
  having count(*) > 1
  order by final.stall_code
  limit 1;

  if v_conflicting_stall_code is not null then
    raise exception using
      errcode = '23505',
      constraint = 'shops_one_active_stall_code_uidx',
      message = format(
        'รหัสล็อก %s มีร้านที่ใช้งานอยู่แล้ว กรุณาปิดร้านเดิมก่อนเปิดร้านใหม่',
        v_conflicting_stall_code
      );
  end if;

  select jsonb_agg(row.item order by
    case when coalesce(nullif(row.item->>'status', ''), 'active') = 'inactive' then 0 else 1 end,
    nullif(upper(trim(coalesce(row.item->>'government_shop_code', ''))), '') nulls last,
    upper(trim(row.item->>'shop_code')),
    row.ordinality
  )
  into v_ordered_rows
  from jsonb_array_elements(p_rows) with ordinality as row(item, ordinality);

  select public.import_shop_catalog_without_stall_validation(v_ordered_rows)
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.import_shop_catalog(jsonb) from public;
grant execute on function public.import_shop_catalog(jsonb) to authenticated;
