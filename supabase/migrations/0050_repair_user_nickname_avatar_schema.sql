-- Repair deployments where 0047/0048 did not persist completely.
-- Safe to run more than once.

begin;

alter table public.users
  add column if not exists nickname text,
  add column if not exists avatar_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'user-avatars',
  'user-avatars',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

drop policy if exists "active users read user avatars" on storage.objects;
drop policy if exists "admins upload user avatars" on storage.objects;
drop policy if exists "admins update user avatars" on storage.objects;
drop policy if exists "admins delete user avatars" on storage.objects;

create policy "active users read user avatars" on storage.objects for select
  using (bucket_id = 'user-avatars' and public.is_active_user());

create policy "admins upload user avatars" on storage.objects for insert
  with check (bucket_id = 'user-avatars' and public.current_app_role() = 'admin');

create policy "admins update user avatars" on storage.objects for update
  using (bucket_id = 'user-avatars' and public.current_app_role() = 'admin')
  with check (bucket_id = 'user-avatars' and public.current_app_role() = 'admin');

create policy "admins delete user avatars" on storage.objects for delete
  using (bucket_id = 'user-avatars' and public.current_app_role() = 'admin');

create or replace function public.save_user_profile_with_work_site_assignments(
  p_user_id uuid,
  p_display_name text,
  p_phone text,
  p_role public.app_role,
  p_is_active boolean,
  p_work_site_ids uuid[],
  p_nickname text,
  p_avatar_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_saved public.users%rowtype;
  v_avatar_path text := nullif(trim(coalesce(p_avatar_path, '')), '');
begin
  if v_avatar_path is not null
    and v_avatar_path not like 'users/' || p_user_id::text || '/%' then
    raise exception 'The avatar path does not belong to the selected user';
  end if;

  v_result := public.save_user_with_work_site_assignments(
    p_user_id,
    p_display_name,
    p_phone,
    p_role,
    p_is_active,
    p_work_site_ids
  );

  update public.users
  set nickname = nullif(trim(coalesce(p_nickname, '')), ''),
      avatar_path = v_avatar_path
  where id = p_user_id
  returning * into v_saved;

  return jsonb_build_object(
    'user', to_jsonb(v_saved),
    'work_site_ids', coalesce(v_result -> 'work_site_ids', '[]'::jsonb)
  );
end;
$$;

revoke all on function public.save_user_profile_with_work_site_assignments(
  uuid, text, text, public.app_role, boolean, uuid[], text, text
) from public;

grant execute on function public.save_user_profile_with_work_site_assignments(
  uuid, text, text, public.app_role, boolean, uuid[], text, text
) to authenticated;

notify pgrst, 'reload schema';

commit;
