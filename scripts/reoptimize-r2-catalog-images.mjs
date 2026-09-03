import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import WebSocket from 'ws';
import {
  createManifestRecorder,
  readManifestEntries,
  rollbackCatalogImages,
  updateCatalogImagePath,
} from './migrate-catalog-images-to-r2.mjs';

export const CATALOG_IMAGE_MAX_WIDTH = 1600;
export const CATALOG_IMAGE_MAX_HEIGHT = 1200;
export const CATALOG_IMAGE_TARGET_BYTES = 1024 * 1024;
export const CATALOG_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const REOPTIMIZE_CONCURRENCY = 3;
export const NETWORK_TIMEOUT_MS = 15_000;
export const NETWORK_MAX_ATTEMPTS = 3;
const INITIAL_WEBP_QUALITY = 92;
const MIN_WEBP_QUALITY = 82;
const WEBP_EFFORT = 4;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const sourceByTable = {
  shops: { bucket: 'shop-images' },
  ice_types: { bucket: 'ice-type-images' },
};

export function parseReoptimizeArgs(args) {
  const options = {
    mode: 'dry-run',
    sourceManifestPath: null,
    manifestPath: null,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      if (options.mode === 'rollback') throw new Error('--apply and --rollback cannot be combined');
      options.mode = 'apply';
    }
    else if (arg === '--source-manifest' || arg === '--manifest' || arg === '--rollback') {
      const path = args[index + 1];
      if (!path || path.startsWith('--')) throw new Error(`${arg} requires a file path`);
      if (arg === '--source-manifest') options.sourceManifestPath = path;
      else options.manifestPath = path;
      if (arg === '--rollback') {
        if (options.mode === 'apply') throw new Error('--apply and --rollback cannot be combined');
        options.mode = 'rollback';
      }
      index += 1;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.help) return options;
  if (options.mode !== 'rollback' && !options.sourceManifestPath) {
    throw new Error('--source-manifest is required');
  }
  if ((options.mode === 'apply' || options.mode === 'rollback') && !options.manifestPath) {
    throw new Error('--manifest is required for apply and rollback');
  }
  return options;
}

export function selectMigratedEntries(entries) {
  const selected = [];
  const seen = new Set();
  for (const entry of entries) {
    if (entry.status !== 'migrated') continue;
    const key = `${entry.table}:${entry.id}:${entry.targetPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(entry);
  }
  return selected;
}

export function buildOptimizedPath(previousPath, bytes) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return `${dirname(previousPath)}/optimized-${digest}.webp`;
}

export async function optimizeCatalogImage(sourceBytes) {
  const input = sharp(sourceBytes, { failOn: 'error' }).rotate().resize({
    width: CATALOG_IMAGE_MAX_WIDTH,
    height: CATALOG_IMAGE_MAX_HEIGHT,
    fit: 'inside',
    withoutEnlargement: true,
  });
  let bytes = null;
  let quality = INITIAL_WEBP_QUALITY;
  for (; quality >= MIN_WEBP_QUALITY; quality -= 2) {
    bytes = await input.clone().webp({ quality, effort: WEBP_EFFORT }).toBuffer();
    if (bytes.byteLength <= CATALOG_IMAGE_TARGET_BYTES) break;
  }
  if (!bytes || bytes.byteLength > CATALOG_IMAGE_MAX_BYTES) {
    throw new Error('รูปหลังบีบอัดต้องมีขนาดไม่เกิน 5 MB');
  }
  const metadata = await sharp(bytes).metadata();
  return {
    bytes,
    quality: Math.max(quality, MIN_WEBP_QUALITY),
    width: metadata.width,
    height: metadata.height,
  };
}

function requiredEnvironment(name, fallbackName) {
  const value = process.env[name]?.trim() || (fallbackName ? process.env[fallbackName]?.trim() : '');
  if (!value) throw new Error(`Set ${name} before running this script.`);
  return value;
}

function publicObjectUrl(supabaseUrl, bucket, path) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/${encodedPath}`;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

export async function fetchWithRetry(
  url,
  options = {},
  {
    fetchImpl = fetch,
    timeoutMs = NETWORK_TIMEOUT_MS,
    attempts = NETWORK_MAX_ATTEMPTS,
    retryDelayMs = 250,
  } = {},
) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Network request timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: controller.signal,
      });
      if (!isRetryableStatus(response.status) || attempt === attempts) return response;
      await response.body?.cancel().catch(() => undefined);
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    } finally {
      clearTimeout(timeout);
    }
    await delay(retryDelayMs * (2 ** (attempt - 1)));
  }
  throw lastError ?? new Error('Network request failed');
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function downloadRetainedSource(supabaseUrl, bucket, path, fetchImpl = fetch) {
  const response = await fetchWithRetry(publicObjectUrl(supabaseUrl, bucket, path), {}, { fetchImpl });
  if (!response.ok) throw new Error(`Source download failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function verifyOptimizedImageThroughApp({
  supabaseUrl,
  apiKey,
  accessToken,
  namespace,
  path,
  fetchImpl = fetch,
}) {
  const signResponse = await fetchWithRetry(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/r2-storage`, {
    method: 'POST',
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'sign', namespace, path }),
  }, { fetchImpl });
  const payload = await signResponse.json().catch(() => null);
  if (!signResponse.ok || typeof payload?.signedUrl !== 'string') {
    throw new Error(`Application signing failed: ${payload?.error ?? signResponse.status}`);
  }
  const imageResponse = await fetchWithRetry(payload.signedUrl, {}, { fetchImpl });
  if (!imageResponse.ok) throw new Error(`Application image read failed: HTTP ${imageResponse.status}`);
  const bytes = new Uint8Array(await imageResponse.arrayBuffer());
  if (bytes.byteLength > CATALOG_IMAGE_MAX_BYTES) throw new Error('Verified image exceeds 5 MB');
  const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
  if (metadata.format !== 'webp' || !metadata.width || !metadata.height) {
    throw new Error('Verified image is not a decodable WebP');
  }
}

function printHelp() {
  console.log(`Usage:
  npm run storage:reoptimize-catalog-images -- --source-manifest <old-manifest>
  npm run storage:reoptimize-catalog-images -- --source-manifest <old-manifest> --apply --manifest <new-manifest>
  npm run storage:reoptimize-catalog-images -- --rollback <new-manifest>

Dry run downloads the retained public Supabase originals, resizes them to at most
1600 x 1200, and reports the result without changing R2 or the database.
Apply uploads immutable high-quality WebP files capped at 5 MB, fully downloads
and decodes each uploaded image, then conditionally updates image_path.
Old R2 objects are retained so the new manifest can roll back safely.`);
}

export async function main() {
  const options = parseReoptimizeArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const supabaseUrl = requiredEnvironment('SUPABASE_URL', 'VITE_SUPABASE_URL');
  if (options.mode === 'rollback') {
    const anonKey = requiredEnvironment('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY');
    const adminAccessToken = requiredEnvironment('SUPABASE_ADMIN_ACCESS_TOKEN');
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${adminAccessToken}` } },
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { transport: WebSocket },
    });
    const entries = await readManifestEntries(options.manifestPath);
    const result = await rollbackCatalogImages({ client, entries });
    console.log(`Rollback complete: ${result.restored} restored, ${result.skipped} skipped, ${result.failed} failed.`);
    if (result.failed > 0) process.exitCode = 1;
    return;
  }

  const sourceEntries = selectMigratedEntries(await readManifestEntries(options.sourceManifestPath));
  if (sourceEntries.length === 0) {
    console.log('No completed catalog migration entries found.');
    return;
  }

  let r2 = null;
  let r2Bucket = null;
  let client = null;
  let anonKey = null;
  let adminAccessToken = null;
  let manifest = null;
  if (options.mode === 'apply') {
    anonKey = requiredEnvironment('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY');
    adminAccessToken = requiredEnvironment('SUPABASE_ADMIN_ACCESS_TOKEN');
    r2Bucket = requiredEnvironment('R2_BUCKET_NAME');
    r2 = new S3Client({
      region: 'auto',
      endpoint: `https://${requiredEnvironment('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: requiredEnvironment('R2_ACCESS_KEY_ID'),
        secretAccessKey: requiredEnvironment('R2_SECRET_ACCESS_KEY'),
      },
    });
    client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${adminAccessToken}` } },
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { transport: WebSocket },
    });
    manifest = await createManifestRecorder(options.manifestPath, { exclusive: true });
    console.log(`Rollback manifest: ${manifest.path}`);
  }

  let optimizedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let sourceBytesTotal = 0;
  let optimizedBytesTotal = 0;
  try {
    await mapWithConcurrency(sourceEntries, REOPTIMIZE_CONCURRENCY, async (entry) => {
      const source = sourceByTable[entry.table];
      try {
        const sourceBytes = await downloadRetainedSource(supabaseUrl, source.bucket, entry.sourcePath);
        const optimized = await optimizeCatalogImage(sourceBytes);
        const nextPath = buildOptimizedPath(entry.targetPath, optimized.bytes);
        sourceBytesTotal += sourceBytes.byteLength;
        optimizedBytesTotal += optimized.bytes.byteLength;

        if (options.mode === 'apply') {
          await r2.send(new PutObjectCommand({
            Bucket: r2Bucket,
            Key: `${source.bucket}/${nextPath}`,
            Body: optimized.bytes,
            ContentType: 'image/webp',
            CacheControl: CACHE_CONTROL,
          }));
          const head = await r2.send(new HeadObjectCommand({
            Bucket: r2Bucket,
            Key: `${source.bucket}/${nextPath}`,
          }));
          if (head.ContentLength !== optimized.bytes.byteLength) {
            throw new Error(`R2 verification failed: expected ${optimized.bytes.byteLength} bytes, got ${head.ContentLength ?? 'unknown'}`);
          }
          await verifyOptimizedImageThroughApp({
            supabaseUrl,
            apiKey: anonKey,
            accessToken: adminAccessToken,
            namespace: source.bucket,
            path: nextPath,
          });
          const manifestEntry = {
            table: entry.table,
            id: entry.id,
            sourcePath: entry.targetPath,
            targetPath: nextPath,
            sourceBytes: sourceBytes.byteLength,
            optimizedBytes: optimized.bytes.byteLength,
            width: optimized.width,
            height: optimized.height,
            quality: optimized.quality,
          };
          await manifest.record({ ...manifestEntry, status: 'prepared' });
          const updated = await updateCatalogImagePath({
            client,
            table: entry.table,
            id: entry.id,
            expectedPath: entry.targetPath,
            nextPath,
          });
          if (!updated) {
            skippedCount += 1;
            console.log(`SKIPPED ${entry.table}/${entry.id}: image_path changed after the original migration`);
            return;
          }
          await manifest.record({ ...manifestEntry, status: 'migrated' });
        }
        optimizedCount += 1;
        console.log(`${options.mode === 'apply' ? 'OPTIMIZED' : 'WOULD OPTIMIZE'} ${entry.table}/${entry.id}: ${sourceBytes.byteLength} -> ${optimized.bytes.byteLength} bytes (${optimized.width}x${optimized.height}, quality ${optimized.quality})`);
      } catch (error) {
        failedCount += 1;
        console.error(`FAILED ${entry.table}/${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  } finally {
    await manifest?.close();
  }

  const savedPercent = sourceBytesTotal > 0
    ? Math.round((1 - optimizedBytesTotal / sourceBytesTotal) * 100)
    : 0;
  console.log(`${options.mode === 'apply' ? 'Optimization' : 'Dry run'} complete: ${optimizedCount} optimized, ${skippedCount} skipped, ${failedCount} failed, ${savedPercent}% fewer bytes.`);
  if (failedCount > 0) process.exitCode = 1;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
