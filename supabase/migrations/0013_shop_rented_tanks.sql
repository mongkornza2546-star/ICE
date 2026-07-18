-- Track each physical tank rented to a shop. The current rented quantity is
-- derived from active assignments so it cannot drift from the tank-code list.

create table public.shop_rented_tanks (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  tank_code text not null check (nullif(trim(tank_code), '') is not null),
  image_path text not null check (nullif(trim(image_path), '') is not null),
  rented_at date not null default current_date,
  returned_at timestamptz,
  created_by uuid not null references public.users(id),
  returned_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((returned_at is null and returned_by is null)
      or (returned_at is not null and returned_by is not null))
);

create unique index shop_rented_tanks_active_code_uidx
  on public.shop_rented_tanks (upper(tank_code))
  where returned_at is null;
create index shop_rented_tanks_shop_active_idx
  on public.shop_rented_tanks (shop_id, tank_code)
  where returned_at is null;

create trigger shop_rented_tanks_updated_at
  before update on public.shop_rented_tanks
  for each row execute function public.set_updated_at();
create trigger shop_rented_tanks_audit_update
  after update on public.shop_rented_tanks
  for each row execute function public.audit_row_update();

alter table public.shop_rented_tanks enable row level security;

create policy "active users read rented shop tanks"
  on public.shop_rented_tanks for select
  using (public.is_active_user());

create or replace function public.register_shop_rented_tank(
  p_shop_id uuid,
  p_tank_code text,
  p_image_path text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tank_id uuid;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can register a rented shop tank';
  end if;

  if nullif(trim(p_tank_code), '') is null
    or nullif(trim(p_image_path), '') is null then
    raise exception 'Tank code and tank photo are required';
  end if;

  if not exists (select 1 from public.shops where id = p_shop_id) then
    raise exception 'The selected shop does not exist';
  end if;

  insert into public.shop_rented_tanks (
    shop_id, tank_code, image_path, created_by
  ) values (
    p_shop_id, upper(trim(p_tank_code)), trim(p_image_path), auth.uid()
  )
  returning id into v_tank_id;

  return v_tank_id;
end;
$$;

create or replace function public.return_shop_rented_tank(p_tank_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tank_id uuid;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can return a rented shop tank';
  end if;

  select id into v_tank_id
  from public.shop_rented_tanks
  where id = p_tank_id and returned_at is null
  for update;

  if v_tank_id is null then
    raise exception 'The selected rented tank is not active';
  end if;

  update public.shop_rented_tanks
  set returned_at = now(), returned_by = auth.uid()
  where id = v_tank_id;

  return v_tank_id;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tank-images', 'tank-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "active users read tank images" on storage.objects for select
  using (bucket_id = 'tank-images' and public.is_active_user());
create policy "admins upload tank images" on storage.objects for insert
  with check (bucket_id = 'tank-images' and public.current_app_role() = 'admin');
create policy "admins update tank images" on storage.objects for update
  using (bucket_id = 'tank-images' and public.current_app_role() = 'admin')
  with check (bucket_id = 'tank-images' and public.current_app_role() = 'admin');
create policy "admins delete tank images" on storage.objects for delete
  using (bucket_id = 'tank-images' and public.current_app_role() = 'admin');

revoke all on function public.register_shop_rented_tank(uuid, text, text) from public;
revoke all on function public.return_shop_rented_tank(uuid) from public;
grant execute on function public.register_shop_rented_tank(uuid, text, text) to authenticated;
grant execute on function public.return_shop_rented_tank(uuid) to authenticated;
