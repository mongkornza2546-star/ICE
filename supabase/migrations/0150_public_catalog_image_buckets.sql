-- Catalog images are intentionally public so their stable URLs can be cached by
-- the browser and Supabase CDN. Upload, update, and delete remain protected by
-- the existing storage.objects policies.
-- After deployment, run `npm run storage:refresh-catalog-cache` once with the
-- service-role environment variables to update existing ice image cache headers.
update storage.buckets
set public = true
where id in ('shop-images', 'ice-type-images');
