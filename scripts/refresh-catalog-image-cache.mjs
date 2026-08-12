import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this script.');
}

const client = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const bucket = client.storage.from('ice-type-images');
const { data: iceTypes, error: loadError } = await client
  .from('ice_types')
  .select('image_path')
  .not('image_path', 'is', null);

if (loadError) throw loadError;

const paths = [...new Set((iceTypes ?? []).map((iceType) => iceType.image_path).filter(Boolean))];
for (const path of paths) {
  const { data: file, error: downloadError } = await bucket.download(path);
  if (downloadError) throw new Error(`Download failed for ${path}: ${downloadError.message}`);

  const { error: uploadError } = await bucket.upload(path, file, {
    cacheControl: '31536000',
    contentType: file.type || undefined,
    upsert: true,
  });
  if (uploadError) throw new Error(`Cache refresh failed for ${path}: ${uploadError.message}`);
}

console.log(`Updated Cache-Control for ${paths.length} ice-type image(s).`);
