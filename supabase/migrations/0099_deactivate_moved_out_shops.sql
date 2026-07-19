-- Shops with delivery history are never hard-deleted. When a tenant moves out,
-- retain its records and exclude it from all newly created delivery work.

create or replace function public.prevent_shop_deactivation_with_active_tanks()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'active' and new.status = 'inactive' and exists (
    select 1
    from public.shop_rented_tanks
    where shop_id = old.id and returned_at is null
  ) then
    raise exception 'All rented tanks must be returned before deactivating a shop';
  end if;
  return new;
end;
$$;

create trigger shops_prevent_deactivation_with_active_tanks
  before update of status on public.shops
  for each row execute function public.prevent_shop_deactivation_with_active_tanks();

create or replace function public.deactivate_shop(p_shop_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can deactivate a shop';
  end if;

  select id into v_shop_id
  from public.shops
  where id = p_shop_id
  for update;

  if v_shop_id is null then
    raise exception 'The selected shop does not exist';
  end if;

  update public.shops
  set status = 'inactive'
  where id = v_shop_id;

  return v_shop_id;
end;
$$;

revoke all on function public.deactivate_shop(uuid) from public;
grant execute on function public.deactivate_shop(uuid) to authenticated;
