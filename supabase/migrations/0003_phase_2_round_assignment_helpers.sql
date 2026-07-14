-- Phase 2: frontend helper RPCs for round creation.

create or replace function public.get_assignable_round_members()
returns table (
  id uuid,
  code text,
  display_name text,
  phone text,
  role public.app_role
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can list assignable round members';
  end if;

  return query
  select
    u.id,
    u.code,
    u.display_name,
    u.phone,
    u.role
  from public.users u
  where u.is_active
  order by
    case u.role
      when 'round_lead' then 0
      when 'courier' then 1
      else 2
    end,
    u.display_name;
end;
$$;

revoke all on function public.get_assignable_round_members() from public;
grant execute on function public.get_assignable_round_members() to authenticated;
