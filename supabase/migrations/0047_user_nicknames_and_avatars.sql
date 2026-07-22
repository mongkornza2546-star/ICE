alter table public.users
  add column if not exists nickname text,
  add column if not exists avatar_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('user-avatars', 'user-avatars', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "active users read user avatars" on storage.objects for select
  using (bucket_id = 'user-avatars' and public.is_active_user());
create policy "admins upload user avatars" on storage.objects for insert
  with check (bucket_id = 'user-avatars' and public.current_app_role() = 'admin');
create policy "admins update user avatars" on storage.objects for update
  using (bucket_id = 'user-avatars' and public.current_app_role() = 'admin')
  with check (bucket_id = 'user-avatars' and public.current_app_role() = 'admin');
create policy "admins delete user avatars" on storage.objects for delete
  using (bucket_id = 'user-avatars' and public.current_app_role() = 'admin');
