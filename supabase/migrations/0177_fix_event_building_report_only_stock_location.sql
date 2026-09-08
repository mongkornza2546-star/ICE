-- A building created for an event also receives the default report-only work
-- site.  Since work sites cannot hold inventory, set both holder flags
-- explicitly instead of inheriting the stock_locations defaults.
create or replace function public.ensure_building_default_stock_location()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := 'SITE-' || upper(trim(new.code));
begin
  if exists (select 1 from public.stock_locations where code = v_code) then
    v_code := v_code || '-' || left(replace(new.id::text, '-', ''), 8);
  end if;

  insert into public.stock_locations (
    code,
    name,
    kind,
    building_id,
    is_active,
    is_default_for_building,
    holds_inventory,
    requires_daily_count
  ) values (
    v_code,
    new.name || ' · จุดปฏิบัติงาน',
    'work_site',
    new.id,
    true,
    true,
    false,
    false
  );

  return new;
end;
$$;
