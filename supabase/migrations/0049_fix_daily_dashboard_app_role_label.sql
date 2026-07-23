-- users.role became public.app_role in migration 0045. The dashboard's role
-- label CASE previously kept its ELSE branch as app_role, which made Postgres
-- coerce Thai display labels such as "หัวหน้างาน" back into the enum.
do $migration$
declare
  v_definition text;
  v_fixed_definition text;
begin
  select pg_get_functiondef('public.get_daily_work_dashboard(date)'::regprocedure)
  into v_definition;

  if position('else u.role::text' in v_definition) > 0 then
    return;
  end if;

  v_fixed_definition := replace(
    v_definition,
    'else u.role',
    'else u.role::text'
  );

  if v_fixed_definition = v_definition then
    raise exception 'Could not locate the dashboard role-label fallback';
  end if;

  execute v_fixed_definition;
end;
$migration$;

