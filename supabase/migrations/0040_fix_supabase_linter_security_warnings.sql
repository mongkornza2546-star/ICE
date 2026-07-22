-- Migration 0040: Supabase Linter Security Warnings Remediation

-- 1. Fix extension_in_public (lint 0014_extension_in_public)
-- Move btree_gist extension from public schema to extensions schema
create schema if not exists extensions;

do $$
begin
  if exists (
    select 1 from pg_extension
    where extname = 'btree_gist'
      and extnamespace = (select oid from pg_namespace where nspname = 'public')
  ) then
    alter extension btree_gist set schema extensions;
  end if;
end $$;

-- 2. Fix anon_security_definer_function_executable (lint 0028_anon_security_definer_function_executable)
-- Revoke EXECUTE privileges from role 'anon' on all functions in schema 'public'
revoke execute on all functions in schema public from anon;

-- Revoke default EXECUTE privileges for role 'anon' on future functions created in schema 'public'
alter default privileges in schema public revoke execute on functions from anon;

-- Ensure authenticated and service_role retain EXECUTE privileges on all functions in schema 'public'
grant execute on all functions in schema public to authenticated, service_role;
alter default privileges in schema public grant execute on functions to authenticated, service_role;
