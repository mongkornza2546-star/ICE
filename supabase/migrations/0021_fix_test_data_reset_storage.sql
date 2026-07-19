-- Storage objects cannot be deleted from SQL. Supabase requires its Storage API
-- so that both the object bytes and their metadata are removed together.

create or replace function public.reset_application_data_except_users(p_confirmation text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tables text;
begin
  if public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can reset application data';
  end if;

  if p_confirmation <> 'RESET ALL TEST DATA' then
    raise exception 'Confirmation text must be RESET ALL TEST DATA';
  end if;

  -- Includes every current and future ordinary table in public except user
  -- profiles. auth.users is in a separate schema and is never touched.
  select string_agg(format('%I.%I', schemaname, tablename), ', ' order by tablename)
  into v_tables
  from pg_tables
  where schemaname = 'public'
    and tablename <> 'users';

  if v_tables is not null then
    execute 'truncate table ' || v_tables || ' restart identity';
  end if;
end;
$$;
