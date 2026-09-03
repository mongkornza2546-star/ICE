import { supabase } from './supabase';

export type R2Namespace =
  | 'shop-images'
  | 'ice-type-images'
  | 'user-avatars'
  | 'tank-images'
  | 'payment-evidence'
  | 'credit-signoff-evidence';

export const R2_SIGN_BATCH_SIZE = 50;
export const R2_SIGN_BATCH_CONCURRENCY = 3;
const R2_CATALOG_URL_CACHE_PREFIX = 'ice-r2-catalog-url:v1:';
const R2_CATALOG_URL_CACHE_TTL_MS = 6 * 24 * 60 * 60 * 1000;
const catalogNamespaces = new Set<R2Namespace>(['shop-images', 'ice-type-images']);

interface CachedR2Url {
  signedUrl: string;
  expiresAt: number;
}

const r2CatalogUrlMemoryCache = new Map<string, CachedR2Url>();

function r2CatalogCacheKey(namespace: R2Namespace, path: string) {
  return `${R2_CATALOG_URL_CACHE_PREFIX}${namespace}:${path}`;
}

function readCachedR2CatalogUrl(namespace: R2Namespace, path: string, now: number) {
  if (!catalogNamespaces.has(namespace)) return null;
  const key = r2CatalogCacheKey(namespace, path);
  const memoryEntry = r2CatalogUrlMemoryCache.get(key);
  if (memoryEntry?.expiresAt && memoryEntry.expiresAt > now) return memoryEntry.signedUrl;
  r2CatalogUrlMemoryCache.delete(key);

  try {
    const stored = window.localStorage.getItem(key);
    if (!stored) return null;
    const entry = JSON.parse(stored) as CachedR2Url;
    if (typeof entry.signedUrl !== 'string'
      || typeof entry.expiresAt !== 'number'
      || entry.expiresAt <= now) {
      window.localStorage.removeItem(key);
      return null;
    }
    r2CatalogUrlMemoryCache.set(key, entry);
    return entry.signedUrl;
  } catch {
    return null;
  }
}

function writeCachedR2CatalogUrl(
  namespace: R2Namespace,
  path: string,
  signedUrl: string,
  expiresAt: number,
) {
  if (!catalogNamespaces.has(namespace)) return;
  const key = r2CatalogCacheKey(namespace, path);
  const entry = { signedUrl, expiresAt };
  r2CatalogUrlMemoryCache.set(key, entry);
  try {
    window.localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // The in-memory cache still avoids repeated signing in this page session.
  }
}

export function clearR2CatalogUrlCache() {
  r2CatalogUrlMemoryCache.clear();
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(R2_CATALOG_URL_CACHE_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    // Cache cleanup is best effort.
  }
}

function clearR2CatalogPathUrl(namespace: R2Namespace, path: string) {
  const key = r2CatalogCacheKey(namespace, path);
  r2CatalogUrlMemoryCache.delete(key);
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Cache cleanup is best effort.
  }
}

export function isR2Path(path: string) {
  return path.startsWith('r2/') || path.includes('/r2/');
}

async function invokeR2<T>(body: FormData | Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
  const { data, error } = await supabase.functions.invoke('r2-storage', { body });
  if (error) {
    const response = 'context' in error ? error.context : null;
    const payload = response ? await response.json().catch(() => null) : null;
    throw new Error(payload?.error ?? error.message);
  }
  return data as T;
}

export async function uploadR2Object(namespace: R2Namespace, path: string, file: Blob) {
  const body = new FormData();
  body.set('namespace', namespace);
  body.set('path', path);
  body.set('file', file);
  await invokeR2<{ success: true }>(body);
  return path;
}

export async function getR2ObjectUrl(namespace: R2Namespace, path: string) {
  if (!catalogNamespaces.has(namespace)) {
    const result = await invokeR2<{ signedUrl: string }>({ action: 'sign', namespace, path });
    return result.signedUrl;
  }
  const [entry] = await getR2ObjectUrls(namespace, [path]);
  if (!entry?.signedUrl) throw new Error('ไม่สามารถเปิดรูปจาก R2 ได้');
  return entry.signedUrl;
}

export async function refreshR2CatalogObjectUrl(namespace: R2Namespace, path: string) {
  clearR2CatalogPathUrl(namespace, path);
  return getR2ObjectUrl(namespace, path);
}

export async function getR2ObjectUrls(namespace: R2Namespace, paths: string[]) {
  if (paths.length === 0) return [];
  const uniquePaths = [...new Set(paths)];
  const now = Date.now();
  const urls = new Map<string, string>();
  const pathsToSign = uniquePaths.filter((path) => {
    const cachedUrl = readCachedR2CatalogUrl(namespace, path, now);
    if (cachedUrl) urls.set(path, cachedUrl);
    return !cachedUrl;
  });
  const batches: string[][] = [];
  for (let index = 0; index < pathsToSign.length; index += R2_SIGN_BATCH_SIZE) {
    batches.push(pathsToSign.slice(index, index + R2_SIGN_BATCH_SIZE));
  }
  const results: Array<Array<{ path: string; signedUrl: string }>> = [];
  for (let index = 0; index < batches.length; index += R2_SIGN_BATCH_CONCURRENCY) {
    const wave = await Promise.all(batches
      .slice(index, index + R2_SIGN_BATCH_CONCURRENCY)
      .map(async (batch) => {
        try {
          const result = await invokeR2<{
            signedUrls: Array<{ path: string; signedUrl: string }>;
          }>({ action: 'signMany', namespace, paths: batch });
          return result.signedUrls;
        } catch {
          return [];
        }
      }));
    results.push(...wave);
  }
  for (const entry of results.flat()) {
    if (!entry.path || !entry.signedUrl) continue;
    urls.set(entry.path, entry.signedUrl);
    writeCachedR2CatalogUrl(
      namespace,
      entry.path,
      entry.signedUrl,
      now + R2_CATALOG_URL_CACHE_TTL_MS,
    );
  }
  return uniquePaths.flatMap((path) => {
    const signedUrl = urls.get(path);
    return signedUrl ? [{ path, signedUrl }] : [];
  });
}

export async function removeR2Objects(namespace: R2Namespace, paths: string[]) {
  if (paths.length === 0) return;
  await invokeR2<{ success: true }>({ action: 'delete', namespace, paths });
}

export async function getHybridObjectUrl(
  namespace: R2Namespace,
  path: string,
  getSupabaseUrl: () => Promise<string> | string,
) {
  return isR2Path(path) ? getR2ObjectUrl(namespace, path) : getSupabaseUrl();
}

export async function getHybridObjectUrls(
  namespace: R2Namespace,
  paths: string[],
  getSupabaseUrls: (paths: string[]) => Promise<Array<{ path?: string | null; signedUrl?: string | null }>>,
) {
  const uniquePaths = [...new Set(paths)];
  const r2Paths = uniquePaths.filter(isR2Path);
  const supabasePaths = uniquePaths.filter((path) => !isR2Path(path));
  const [r2Entries, supabaseEntries] = await Promise.all([
    getR2ObjectUrls(namespace, r2Paths),
    getSupabaseUrls(supabasePaths).catch(() => []),
  ]);
  return [...r2Entries, ...supabaseEntries];
}
