import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createManifestRecorder } from '../scripts/migrate-catalog-images-to-r2.mjs';
import {
  buildOptimizedPath,
  CATALOG_IMAGE_MAX_BYTES,
  CATALOG_IMAGE_MAX_HEIGHT,
  CATALOG_IMAGE_MAX_WIDTH,
  CATALOG_IMAGE_TARGET_BYTES,
  fetchWithRetry,
  mapWithConcurrency,
  optimizeCatalogImage,
  parseReoptimizeArgs,
  selectMigratedEntries,
} from '../scripts/reoptimize-r2-catalog-images.mjs';

test('catalog re-optimization keeps clear dimensions and enforces the existing 5 MB limit', async () => {
  const source = await sharp({
    create: {
      width: 3200,
      height: 2400,
      channels: 3,
      background: { r: 35, g: 120, b: 210 },
    },
  }).png().toBuffer();

  const optimized = await optimizeCatalogImage(source);
  const metadata = await sharp(optimized.bytes).metadata();

  assert.equal(CATALOG_IMAGE_MAX_WIDTH, 1600);
  assert.equal(CATALOG_IMAGE_MAX_HEIGHT, 1200);
  assert.equal(CATALOG_IMAGE_TARGET_BYTES, 1024 * 1024);
  assert.equal(CATALOG_IMAGE_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 1600);
  assert.equal(metadata.height, 1200);
  assert.ok(optimized.bytes.byteLength <= CATALOG_IMAGE_MAX_BYTES);
});

test('optimized object paths are immutable and stay beside the previous R2 object', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const first = buildOptimizedPath('shops/shop-1/r2/old.jpg', bytes);
  const second = buildOptimizedPath('shops/shop-1/r2/old.jpg', bytes);

  assert.equal(first, second);
  assert.match(first, /^shops\/shop-1\/r2\/optimized-[a-f0-9]{64}\.webp$/);
});

test('only completed migration entries are selected once', () => {
  const selected = selectMigratedEntries([
    { table: 'shops', id: 'shop-1', sourcePath: 'old-1', targetPath: 'r2-1', status: 'prepared' },
    { table: 'shops', id: 'shop-1', sourcePath: 'old-1', targetPath: 'r2-1', status: 'migrated' },
    { table: 'shops', id: 'shop-1', sourcePath: 'old-1', targetPath: 'r2-1', status: 'migrated' },
    { table: 'ice_types', id: 'ice-1', sourcePath: 'old-2', targetPath: 'r2-2', status: 'prepared' },
  ]);

  assert.deepEqual(selected, [{
    table: 'shops',
    id: 'shop-1',
    sourcePath: 'old-1',
    targetPath: 'r2-1',
    status: 'migrated',
  }]);
});

test('apply mode requires a separate rollback manifest', () => {
  assert.throws(
    () => parseReoptimizeArgs(['--source-manifest', 'old.jsonl', '--apply']),
    /--manifest/,
  );
  assert.throws(
    () => parseReoptimizeArgs(['--source-manifest', 'old.jsonl', '--apply', '--rollback', 'new.jsonl']),
    /cannot be combined/,
  );
  assert.throws(
    () => parseReoptimizeArgs(['--rollback', 'new.jsonl', '--apply', '--source-manifest', 'old.jsonl']),
    /cannot be combined/,
  );
  assert.deepEqual(
    parseReoptimizeArgs(['--source-manifest', 'old.jsonl']),
    { mode: 'dry-run', sourceManifestPath: 'old.jsonl', manifestPath: null, help: false },
  );
});

test('network requests time out and retry before failing', async () => {
  let calls = 0;
  const neverResponds = async (_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };

  await assert.rejects(
    fetchWithRetry('https://source.test/image', {}, {
      fetchImpl: neverResponds,
      timeoutMs: 5,
      attempts: 2,
      retryDelayMs: 0,
    }),
    /timed out/i,
  );
  assert.equal(calls, 2);
});

test('catalog work runs with bounded concurrency', async () => {
  let active = 0;
  let maximumActive = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(maximumActive, 2);
});

test('apply manifests must be new files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-reoptimization-manifest-'));
  const manifestPath = join(directory, 'rollback.jsonl');
  try {
    const manifest = await createManifestRecorder(manifestPath, { exclusive: true });
    await manifest.close();
    await assert.rejects(createManifestRecorder(manifestPath, { exclusive: true }), /EEXIST/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
