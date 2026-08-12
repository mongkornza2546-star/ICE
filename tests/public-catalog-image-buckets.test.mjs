import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0150_public_catalog_image_buckets.sql', import.meta.url),
  'utf8',
);
const refreshScript = readFileSync(
  new URL('../scripts/refresh-catalog-image-cache.mjs', import.meta.url),
  'utf8',
);

test('catalog image buckets become public while existing ice images get a cache refresh path', () => {
  assert.match(migration, /update storage\.buckets\s+set public = true/);
  assert.match(migration, /where id in \('shop-images', 'ice-type-images'\)/);
  assert.match(refreshScript, /\.from\('ice-type-images'\)/);
  assert.match(refreshScript, /cacheControl: '31536000'/);
  assert.match(refreshScript, /upsert: true/);
});
