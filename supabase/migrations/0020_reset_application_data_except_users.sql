-- Test-environment reset: remove all application data while retaining every
-- authenticated account (auth.users) and its public.users profile.
--
-- Call only after this migration has been applied:
--   select public.reset_application_data_except_users('RESET ALL TEST DATA');

create or replace function public.reset_application_data_except_users(p_confirmation text)
returns void
language plpgsql
security definer
set search_path = public, storage
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

  -- Delete uploaded images that no longer have a related shop or rented tank.
  delete from storage.objects
  where bucket_id in ('shop-images', 'tank-images');

  -- Include every current and future ordinary table in the public schema except
  -- user profiles. auth.users is in a separate schema and is never touched.
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

revoke all on function public.reset_application_data_except_users(text) from public;
grant execute on function public.reset_application_data_except_users(text) to authenticated;
