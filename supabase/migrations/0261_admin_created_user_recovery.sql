-- Service-only lookup for retrying admin account creation. The Auth email is
-- stable per admin + request, and app_metadata proves this flow created it.
create or replace function public.get_admin_created_user(
  p_actor_id uuid,
  p_request_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user', to_jsonb(profile),
    'work_site_ids', coalesce((
      select jsonb_agg(assignment.stock_location_id order by assignment.stock_location_id)
      from public.employee_work_site_assignments assignment
      where assignment.user_id = profile.id
    ), '[]'::jsonb)
  )
  from auth.users account
  join public.users profile on profile.id = account.id
  where account.email = replace(p_actor_id::text, '-', '')
    || replace(p_request_id::text, '-', '') || '@staff.ice-delivery.invalid'
    and account.raw_app_meta_data ->> 'created_by_admin' = p_actor_id::text
    and account.raw_app_meta_data ->> 'creation_request_id' = p_request_id::text;
$$;

revoke all on function public.get_admin_created_user(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_admin_created_user(uuid, uuid) to service_role;
