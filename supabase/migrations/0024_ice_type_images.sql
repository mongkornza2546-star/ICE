-- Add image_path to ice_types
alter table public.ice_types add column image_path text;

-- Create ice-type-images bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ice-type-images', 'ice-type-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Set up RLS for ice-type-images
create policy "active users read ice type images" on storage.objects for select
  using (bucket_id = 'ice-type-images' and public.is_active_user());
create policy "admins upload ice type images" on storage.objects for insert
  with check (bucket_id = 'ice-type-images' and public.current_app_role() = 'admin');
create policy "admins update ice type images" on storage.objects for update
  using (bucket_id = 'ice-type-images' and public.current_app_role() = 'admin')
  with check (bucket_id = 'ice-type-images' and public.current_app_role() = 'admin');
create policy "admins delete ice type images" on storage.objects for delete
  using (bucket_id = 'ice-type-images' and public.current_app_role() = 'admin');
