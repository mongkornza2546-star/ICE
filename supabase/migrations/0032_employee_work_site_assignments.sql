-- Employees can be permanently assigned to one or more operational work sites.
-- This responsibility is separate from stock_locations.assigned_user_id, which
-- continues to identify the person who owns an employee/team stock holding.

create table public.employee_work_site_assignments (
  user_id uuid not null references public.users(id) on delete restrict,
  stock_location_id uuid not null references public.stock_locations(id) on delete restrict,
  assigned_by uuid references public.users(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  primary key (user_id, stock_location_id)
);

create index employee_work_site_assignments_location_idx
  on public.employee_work_site_assignments (stock_location_id, user_id);

-- Preserve any responsibility that administrators previously expressed through
-- assigned_user_id on work-site locations. New edits use the dedicated table.
insert into public.employee_work_site_assignments (
  user_id, stock_location_id
)
select location.assigned_user_id, location.id
from public.stock_locations location
where location.kind = 'work_site'
  and location.is_active
  and location.assigned_user_id is not null
on conflict (user_id, stock_location_id) do nothing;

alter table public.employee_work_site_assignments enable row level security;

create policy "active users read employee work-site assignments"
  on public.employee_work_site_assignments for select
  using (public.is_active_user());

create or replace function public.save_user_with_work_site_assignments(
  p_user_id uuid,
  p_display_name text,
  p_phone text,
  p_role public.app_role,
  p_is_active boolean,
  p_work_site_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.users%rowtype;
  v_saved public.users%rowtype;
  v_before_assignments jsonb;
  v_after_assignments jsonb;
  v_work_site_ids uuid[] := coalesce(p_work_site_ids, '{}'::uuid[]);
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an active admin can edit users and their work sites';
  end if;

  select * into v_before
  from public.users
  where id = p_user_id
  for update;

  if v_before.id is null then
    raise exception 'The selected user does not exist';
  end if;

  if nullif(trim(coalesce(p_display_name, '')), '') is null then
    raise exception 'A display name is required';
  end if;

  if p_user_id = auth.uid()
    and (p_role is distinct from v_before.role or not p_is_active) then
    raise exception 'The current admin cannot change their own role or deactivate their account';
  end if;

  if cardinality(v_work_site_ids) <> (
    select count(distinct work_site_id)
    from unnest(v_work_site_ids) as selected(work_site_id)
    where work_site_id is not null
  ) then
    raise exception 'Work-site assignments must be unique and cannot be null';
  end if;

  if cardinality(v_work_site_ids) > 0 and (p_role <> 'courier' or not p_is_active) then
    raise exception 'Only an active courier can have permanent work-site assignments';
  end if;

  if cardinality(v_work_site_ids) <> (
    select count(*)
    from public.stock_locations location
    where location.id = any(v_work_site_ids)
      and location.kind = 'work_site'
      and location.is_active
  ) then
    raise exception 'Every assigned work site must be an active work-site stock location';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'stock_location_id', assignment.stock_location_id,
    'code', location.code,
    'name', location.name
  ) order by location.code), '[]'::jsonb)
  into v_before_assignments
  from public.employee_work_site_assignments assignment
  join public.stock_locations location on location.id = assignment.stock_location_id
  where assignment.user_id = p_user_id;

  update public.users
  set display_name = trim(p_display_name),
      phone = nullif(trim(coalesce(p_phone, '')), ''),
      role = p_role,
      is_active = p_is_active
  where id = p_user_id
  returning * into v_saved;

  delete from public.employee_work_site_assignments
  where user_id = p_user_id;

  insert into public.employee_work_site_assignments (
    user_id, stock_location_id, assigned_by
  )
  select p_user_id, selected.work_site_id, auth.uid()
  from unnest(v_work_site_ids) as selected(work_site_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'stock_location_id', assignment.stock_location_id,
    'code', location.code,
    'name', location.name
  ) order by location.code), '[]'::jsonb)
  into v_after_assignments
  from public.employee_work_site_assignments assignment
  join public.stock_locations location on location.id = assignment.stock_location_id
  where assignment.user_id = p_user_id;

  if v_before_assignments is distinct from v_after_assignments then
    insert into public.audit_logs (
      actor_id, entity_type, entity_id, action, before_value, after_value
    ) values (
      auth.uid(), 'employee_work_site_assignments', p_user_id, 'updated',
      v_before_assignments, v_after_assignments
    );
  end if;

  return jsonb_build_object(
    'user', to_jsonb(v_saved),
    'work_site_ids', to_jsonb(v_work_site_ids)
  );
end;
$$;

revoke all on function public.save_user_with_work_site_assignments(
  uuid, text, text, public.app_role, boolean, uuid[]
) from public;
grant execute on function public.save_user_with_work_site_assignments(
  uuid, text, text, public.app_role, boolean, uuid[]
) to authenticated;
