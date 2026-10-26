import { Capacitor, CapacitorHttp } from '@capacitor/core';

// Separate from the PWA cache: the employee APK has no service worker.
export const CATALOG_IMAGE_CACHE = 'catalog-device-images-v1';
export const CATALOG_IMAGE_MAX_BYTES = 50 * 1024 * 1024;
export const CATALOG_IMAGE_MAX_ENTRIES = 300;
export const CATALOG_IMAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const STORED_AT = 'x-ice-stored-at';
const BYTE_SIZE = 'x-ice-byte-size';

// Only catalog images qualify. Preserve version/transform parameters and the
// origin; remove temporary credentials only for known R2 object URLs.
export function catalogImageCacheKey(source: string): string | null {
  try {
    const url = new URL(source);
    if (url.protocol !== 'https:') return null;
    if (/\.r2\.cloudflarestorage\.com$/.test(url.hostname)
      && /^\/(?:[^/]+\/)?(?:shop-images|ice-type-images)\//.test(url.pathname)) {
      for (const key of [...url.searchParams.keys()]) {
        if (/^x-amz-/i.test(key) || key === 'x-id') url.searchParams.delete(key);
      }
    } else if (!/^\/storage\/v1\/object\/public\/(?:shop-images|ice-type-images)\//.test(url.pathname)) {
      return null;
    }
    url.hash = '';
    url.searchParams.sort();
    return url.href;
  } catch {
    return null;
  }
}

interface Metadata { bytes: number; storedAt: number }
let index: Map<string, Metadata> | undefined;
let writes: Promise<unknown> = Promise.resolve();
interface Download {
  promise: Promise<Blob>;
  controller: AbortController;
  consumers: number;
  started: boolean;
}
const pending = new Map<string, Download>();
let activeLoads = 0;
const waiting: Array<() => void> = [];
export type CatalogImageNamespace = 'shop-images' | 'ice-type-images';
let pathIndex: Promise<Map<string, string | null>> | undefined;

function abortError() {
  return new DOMException('Image no longer needed', 'AbortError');
}

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function fresh(storedAt: number) {
  const age = Date.now() - storedAt;
  return storedAt > 0 && age >= 0 && age < CATALOG_IMAGE_MAX_AGE_MS;
}

async function openCache() {
  try {
    return await globalThis.caches.open(CATALOG_IMAGE_CACHE);
  } catch {
    return null;
  }
}

function mutateCache(task: () => Promise<void>) {
  const result = writes.then(task);
  writes = result.catch(() => { index = undefined; });
  return writes;
}

async function storeImage(cache: Cache, key: string, blob: Blob) {
  if (blob.size > MAX_IMAGE_BYTES) return;
  await mutateCache(async () => {
    if (!index) {
      index = new Map();
      // Read only headers, once per session; never load the entire catalog into RAM.
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        const storedAt = Number(response?.headers.get(STORED_AT));
        const bytes = Number(response?.headers.get(BYTE_SIZE));
        if (!fresh(storedAt) || !Number.isFinite(bytes) || bytes <= 0) {
          await cache.delete(request);
        } else {
          index.set(request.url, { bytes, storedAt });
        }
      }
    }
    for (const [oldKey, entry] of index) {
      if (!fresh(entry.storedAt) || oldKey === key) {
        await cache.delete(oldKey);
        index.delete(oldKey);
      }
    }
    let totalBytes = [...index.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    const oldest = [...index].sort((a, b) => a[1].storedAt - b[1].storedAt);
    for (const [oldKey, entry] of oldest) {
      if (index.size < CATALOG_IMAGE_MAX_ENTRIES && totalBytes + blob.size <= CATALOG_IMAGE_MAX_BYTES) break;
      await cache.delete(oldKey);
      index.delete(oldKey);
      totalBytes -= entry.bytes;
    }
    const storedAt = Date.now();
    await cache.put(key, new Response(blob, {
      headers: { 'Content-Type': blob.type, [STORED_AT]: String(storedAt), [BYTE_SIZE]: String(blob.size) },
    }));
    index.set(key, { bytes: blob.size, storedAt });
    pathIndex = undefined;
  });
}

export async function discardCatalogImage(source: string, identity?: { namespace: CatalogImageNamespace; path: string }) {
  const sourceKey = catalogImageCacheKey(source);
  if (!sourceKey && !identity) return;
  await mutateCache(async () => {
    const cache = await openCache();
    if (!cache) return;
    const key = sourceKey ?? (identity ? await imagePathKey(cache, identity.namespace, identity.path) : null);
    if (!key) return;
    await cache.delete(key);
    index?.delete(key);
    pathIndex = undefined;
  });
}

async function downloadImage(source: string, signal: AbortSignal): Promise<Blob> {
  checkAborted(signal);
  if (Capacitor.isNativePlatform()) {
    // Native HTTP avoids requiring the R2 bucket to allow the WebView origin.
    // This does not enable global fetch patching or affect business API calls.
    const response = await CapacitorHttp.get({
      url: source, responseType: 'arraybuffer', connectTimeout: 20_000, readTimeout: 20_000,
    });
    // Started downloads keep their slot and populate the cache even after
    // the last consumer leaves, including native calls that cannot be cancelled.
    checkAborted(signal);
    const type = new Headers(response.headers).get('content-type') ?? '';
    if (response.status !== 200 || !type.startsWith('image/') || typeof response.data !== 'string'
      || response.data.length > MAX_IMAGE_BYTES * 1.4) throw new Error('Catalog image unavailable');
    const binary = atob(response.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(source, { mode: 'cors', credentials: 'omit', signal: controller.signal });
    if (!response.ok || !response.headers.get('Content-Type')?.startsWith('image/')) {
      throw new Error('Catalog image unavailable');
    }
    return await response.blob();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

async function readImage(cache: Cache | null, key: string): Promise<Blob | null> {
  try {
    const cached = await cache?.match(key);
    if (cached && fresh(Number(cached.headers.get(STORED_AT)))) return await cached.blob();
  } catch {
    // Storage denial/eviction must not prevent the image from loading.
  }
  return null;
}

// Build a small key-only index once, rather than parsing every stored URL for
// each restored tile. Never keep image blobs in this index.
async function imagePathKey(cache: Cache, namespace: CatalogImageNamespace, path: string) {
  pathIndex ??= cache.keys().then((requests) => {
    const paths = new Map<string, string | null>();
    for (const request of requests) {
      if (!catalogImageCacheKey(request.url)) continue;
      try {
        const pathname = decodeURIComponent(new URL(request.url).pathname);
        const match = pathname.match(/^\/(?:storage\/v1\/object\/public\/|[^/]+\/)?(shop-images|ice-type-images)\/(.+)$/);
        if (!match) continue;
        const identity = JSON.stringify([match[1], match[2]]);
        // A path without an origin must not select an ambiguous object.
        paths.set(identity, paths.has(identity) ? null : request.url);
      } catch { /* Ignore malformed keys from old caches. */ }
    }
    return paths;
  }).catch((error) => { pathIndex = undefined; throw error; });
  return (await pathIndex).get(JSON.stringify([namespace, path])) ?? null;
}

// Existing URL-keyed entries remain readable after an app restart, even when
// workspace data deliberately omits expired signed URLs.
export async function readCatalogImageByPath(namespace: CatalogImageNamespace, path: string): Promise<Blob | null> {
  const cache = await openCache();
  if (!cache) return null;
  try {
    const key = await imagePathKey(cache, namespace, path);
    return key ? readImage(cache, key) : null;
  } catch {
    return null;
  }
}

async function acquireDownloadSlot(signal: AbortSignal) {
  checkAborted(signal);
  if (activeLoads < 2) { activeLoads += 1; return; }
  await new Promise<void>((resolve, reject) => {
    const start = () => { signal.removeEventListener('abort', cancel); resolve(); };
    const cancel = () => {
      const position = waiting.indexOf(start);
      if (position >= 0) waiting.splice(position, 1);
      reject(abortError());
    };
    signal.addEventListener('abort', cancel, { once: true });
    waiting.push(start);
  });
}

async function loadImage(source: string, key: string, cache: Cache | null, signal: AbortSignal, onStart: () => void): Promise<Blob> {
  await acquireDownloadSlot(signal);
  try {
    checkAborted(signal);
    onStart();
    const blob = await downloadImage(source, signal);
    checkAborted(signal);
    if (!blob.size) throw new Error('Empty catalog image');
    if (cache) await storeImage(cache, key, blob);
    return blob;
  } finally {
    const next = waiting.shift();
    if (next) next();
    else activeLoads -= 1;
  }
}

export async function loadCatalogImage(source: string, options: { signal?: AbortSignal } = {}): Promise<Blob> {
  const key = catalogImageCacheKey(source);
  if (!key) throw new Error('Not a catalog image');
  checkAborted(options.signal);
  // Disk hits must never wait behind slow or abandoned network requests.
  const cache = await openCache();
  const cached = await readImage(cache, key);
  checkAborted(options.signal);
  if (cached) return cached;
  let entry = pending.get(key);
  if (!entry) {
    const controller = new AbortController();
    const download: Download = {
      controller, consumers: 0, started: false,
      promise: loadImage(source, key, cache, controller.signal, () => { download.started = true; }).finally(() => {
        if (pending.get(key) === download) pending.delete(key);
      }),
    };
    entry = download;
    pending.set(key, download);
  }
  const download = entry;
  download.consumers += 1;
  return new Promise<Blob>((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      options.signal?.removeEventListener('abort', cancel);
      download.consumers -= 1;
      return true;
    };
    const cancel = () => {
      if (!finish()) return;
      // Cancel only work that has not started. Keep in-flight bytes and the
      // shared pending entry so returning consumers reuse the same download.
      if (download.consumers === 0 && !download.started) {
        download.controller.abort();
        if (pending.get(key) === download) pending.delete(key);
      }
      reject(abortError());
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    download.promise.then(
      (blob) => { if (finish()) resolve(blob); },
      (error) => { if (finish()) reject(error); },
    );
  });
}
