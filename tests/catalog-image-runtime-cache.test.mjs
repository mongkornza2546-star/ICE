import assert from 'node:assert/strict';
import test from 'node:test';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  catalogImageRuntimeCaching,
  r2CatalogImagePattern,
  supabaseCatalogImagePattern,
} from '../vite.config.js';

async function resolveR2RequestUrl() {
  let resolvedUrl = '';
  const client = new S3Client({
    region: 'auto',
    endpoint: 'https://account-id.r2.cloudflarestorage.com',
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
    requestHandler: {
      async handle(request) {
        resolvedUrl = `${request.protocol}//${request.hostname}${request.path}`;
        return {
          response: {
            statusCode: 200,
            headers: { 'content-length': '1' },
            body: new Uint8Array(),
          },
        };
      },
    },
  });
  await client.send(new HeadObjectCommand({
    Bucket: 'ice-delivery',
    Key: 'shop-images/shops/shop-1/r2/photo.webp',
  }));
  return resolvedUrl;
}

test('R2 catalog cache matches the virtual-hosted URL produced by S3Client', async () => {
  const resolvedUrl = await resolveR2RequestUrl();
  assert.equal(resolvedUrl, 'https://ice-delivery.account-id.r2.cloudflarestorage.com/shop-images/shops/shop-1/r2/photo.webp');
  assert.equal(r2CatalogImagePattern.test(resolvedUrl), true);
});

test('catalog cache patterns also cover path-style R2 and public Supabase URLs', () => {
  assert.equal(r2CatalogImagePattern.test(
    'https://account-id.r2.cloudflarestorage.com/ice-delivery/ice-type-images/ice_types/ice-1/r2/photo.webp?signature=one',
  ), true);
  assert.equal(supabaseCatalogImagePattern.test(
    'https://project.supabase.co/storage/v1/object/public/shop-images/shops/shop-1/photo.webp',
  ), true);
});

test('R2 signed and stable public catalog URLs use bounded runtime caches', () => {
  assert.deepEqual(catalogImageRuntimeCaching, [
    {
      urlPattern: r2CatalogImagePattern,
      handler: 'CacheFirst',
      options: {
        cacheName: 'catalog-r2-images-v2',
        cacheableResponse: { statuses: [0, 200] },
        expiration: {
          maxEntries: 500,
          maxAgeSeconds: 60 * 60 * 24 * 30,
          purgeOnQuotaError: true,
        },
      },
    },
    {
      urlPattern: supabaseCatalogImagePattern,
      handler: 'CacheFirst',
      options: {
        cacheName: 'catalog-public-images-v2',
        cacheableResponse: { statuses: [200] },
        expiration: {
          maxEntries: 500,
          maxAgeSeconds: 60 * 60 * 24 * 365,
          purgeOnQuotaError: true,
        },
      },
    },
  ]);
});
