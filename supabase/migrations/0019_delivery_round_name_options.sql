create table public.delivery_round_name_options (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (nullif(trim(name), '') is not null),
  sort_order integer not null default 0 check (sort_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.delivery_round_name_options (name, sort_order) values
  ('เช้ามืด', 10), ('เช้า', 20), ('สาย', 30), ('บ่าย', 40), ('รอบเพิ่ม', 50);

create trigger delivery_round_name_options_updated_at
before update on public.delivery_round_name_options
for each row execute function public.set_updated_at();

alter table public.delivery_round_name_options enable row level security;
create policy "active users read delivery round name options"
on public.delivery_round_name_options for select using (public.is_active_user());

create or replace function public.save_delivery_round_name_option(
  p_option_id uuid,
  p_name text,
  p_sort_order integer,
  p_is_active boolean
)
returns public.delivery_round_name_options
language plpgsql security definer set search_path = public
as $$
declare v_saved public.delivery_round_name_options%rowtype;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can save delivery round name options';
  end if;
  if nullif(trim(p_name), '') is null or p_sort_order is null or p_sort_order < 0 then
    raise exception 'A round name and non-negative sort order are required';
  end if;
  if p_option_id is null then
    insert into public.delivery_round_name_options (name, sort_order, is_active)
    values (trim(p_name), p_sort_order, coalesce(p_is_active, true)) returning * into v_saved;
  else
    update public.delivery_round_name_options set name = trim(p_name), sort_order = p_sort_order,
      is_active = coalesce(p_is_active, true) where id = p_option_id returning * into v_saved;
    if not found then raise exception 'Delivery round name option not found'; end if;
  end if;
  return v_saved;
end;
$$;

create or replace function public.validate_delivery_round_name()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.delivery_round_name_options option where option.name = new.name and option.is_active) then
    raise exception 'Delivery round name must be an active configured option';
  end if;
  return new;
end;
$$;

create trigger delivery_rounds_validate_configured_name
before insert or update of name on public.delivery_rounds
for each row execute function public.validate_delivery_round_name();

revoke all on function public.save_delivery_round_name_option(uuid, text, integer, boolean) from public;
grant execute on function public.save_delivery_round_name_option(uuid, text, integer, boolean) to authenticated;
