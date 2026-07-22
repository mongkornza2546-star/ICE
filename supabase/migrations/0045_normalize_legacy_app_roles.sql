-- Some legacy deployments stored Thai display labels in users.role while the
-- RPC contract expects the canonical public.app_role enum values.
do $$
declare
  v_role_type regtype;
  v_invalid_roles text[];
begin
  select attribute.atttypid::regtype
  into v_role_type
  from pg_attribute attribute
  where attribute.attrelid = 'public.users'::regclass
    and attribute.attname = 'role'
    and not attribute.attisdropped;

  if v_role_type = 'text'::regtype then
    update public.users
    set role = case trim(role)
      when 'พนักงานส่ง' then 'courier'
      when 'พนักงานส่งน้ำแข็ง' then 'courier'
      when 'หัวหน้ารอบ' then 'round_lead'
      when 'หัวหน้างาน' then 'round_lead'
      when 'แอดมิน' then 'admin'
      when 'ผู้ดูแลระบบ' then 'admin'
      else trim(role)
    end;

    select array_agg(distinct role order by role)
    into v_invalid_roles
    from public.users
    where role not in ('courier', 'round_lead', 'admin');

    if cardinality(v_invalid_roles) > 0 then
      raise exception 'Cannot normalize legacy users.role values: %', v_invalid_roles;
    end if;

    alter table public.users alter column role drop default;
    alter table public.users
      alter column role type public.app_role using role::public.app_role,
      alter column role set default 'courier'::public.app_role;
  end if;
end;
$$;

create or replace function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.users where id = auth.uid() and is_active;
$$;
