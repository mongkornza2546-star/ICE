-- A work-site assignment identifies where a courier works, while stock must
-- remain in a dedicated employee holder. Provision that holder automatically
-- so assigned couriers are immediately available as stock-transfer recipients.

create function public.ensure_courier_stock_holder(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_location_id uuid;
  v_display_name text;
  v_generated_code text := 'HOLDER-' || replace(p_user_id::text, '-', '');
begin
  if p_user_id is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select employee.display_name
  into v_display_name
  from public.users employee
  where employee.id = p_user_id
    and employee.role = 'courier'
    and employee.is_active;

  if v_display_name is null then
    return null;
  end if;

  select location.id
  into v_location_id
  from public.stock_locations location
  where location.assigned_user_id = p_user_id
    and location.kind in ('team', 'small_vehicle')
    and location.is_active
  limit 1
  for update;

  if v_location_id is not null then
    update public.stock_locations
    set holds_inventory = true,
        requires_daily_count = true
    where id = v_location_id;
    return v_location_id;
  end if;

  select location.id
  into v_location_id
  from public.stock_locations location
  where location.code = v_generated_code
    and location.assigned_user_id = p_user_id
    and location.kind in ('team', 'small_vehicle')
  for update;

  if v_location_id is not null then
    update public.stock_locations
    set name = v_display_name || ' · จุดรับสต๊อก',
        is_active = true,
        holds_inventory = true,
        requires_daily_count = true
    where id = v_location_id;
    return v_location_id;
  end if;

  insert into public.stock_locations (
    code,
    name,
    kind,
    assigned_user_id,
    is_courier_source,
    is_default_for_building,
    is_active,
    holds_inventory,
    requires_daily_count
  ) values (
    v_generated_code,
    v_display_name || ' · จุดรับสต๊อก',
    'team',
    p_user_id,
    false,
    false,
    true,
    true,
    true
  )
  returning id into v_location_id;

  return v_location_id;
end;
$$;

revoke all on function public.ensure_courier_stock_holder(uuid) from public, authenticated;

create function public.provision_courier_stock_holder_from_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_courier_stock_holder(new.user_id);
  return new;
end;
$$;

revoke all on function public.provision_courier_stock_holder_from_assignment() from public, authenticated;

create trigger employee_work_site_assignments_provision_stock_holder
after insert or update of user_id on public.employee_work_site_assignments
for each row execute function public.provision_courier_stock_holder_from_assignment();

create function public.enforce_active_stock_transfer_recipient()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind = 'transfer'
    and new.to_location_id is not null
    and exists (
      select 1
      from public.stock_locations destination
      where destination.id = new.to_location_id
        and destination.kind in ('team', 'small_vehicle')
    )
    and not exists (
      select 1
      from public.stock_locations destination
      join public.users employee on employee.id = destination.assigned_user_id
      where destination.id = new.to_location_id
        and employee.role = 'courier'
        and employee.is_active
        and exists (
          select 1
          from public.employee_work_site_assignments assignment
          join public.stock_locations work_site on work_site.id = assignment.stock_location_id
          where assignment.user_id = employee.id
            and work_site.kind = 'work_site'
            and work_site.is_active
        )
    ) then
    raise exception 'An employee stock destination requires an active courier with a work-site assignment';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_active_stock_transfer_recipient() from public, authenticated;

create trigger stock_movements_enforce_active_transfer_recipient
before insert or update of kind, to_location_id on public.stock_movements
for each row execute function public.enforce_active_stock_transfer_recipient();

do $$
declare
  v_user_id uuid;
begin
  for v_user_id in
    select distinct assignment.user_id
    from public.employee_work_site_assignments assignment
    join public.users employee on employee.id = assignment.user_id
    where employee.role = 'courier'
      and employee.is_active
  loop
    perform public.ensure_courier_stock_holder(v_user_id);
  end loop;
end;
$$;
