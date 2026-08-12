export interface ImagePathItem {
  image_path?: string | null;
  image_url?: string | null;
}

interface SignedUrlEntry {
  path?: string | null;
  signedUrl?: string | null;
}

type SignImagePaths = (paths: string[]) => Promise<{
  data: SignedUrlEntry[] | null;
  error: unknown;
}>;

interface SignedImageUrlCacheOptions {
  namespace: string;
  ttlMs: number;
}

interface SignedImageUrlCacheEntry {
  signedUrl: string;
  expiresAt: number;
}

export const SIGNED_IMAGE_URL_CACHE_TTL_MS = 55 * 60 * 1000;

const signedImageUrlMemoryCache = new Map<string, SignedImageUrlCacheEntry>();

function cacheKey(namespace: string, path: string) {
  return `ice-signed-image:v1:${namespace}:${path}`;
}

function readCachedUrl(namespace: string, path: string, now: number) {
  const key = cacheKey(namespace, path);
  const memoryEntry = signedImageUrlMemoryCache.get(key);
  if (memoryEntry && memoryEntry.expiresAt > now) return memoryEntry.signedUrl;
  signedImageUrlMemoryCache.delete(key);

  try {
    const stored = window.localStorage.getItem(key);
    if (!stored) return null;
    const entry = JSON.parse(stored) as SignedImageUrlCacheEntry;
    if (typeof entry.signedUrl !== 'string' || typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) {
      window.localStorage.removeItem(key);
      return null;
    }
    signedImageUrlMemoryCache.set(key, entry);
    return entry.signedUrl;
  } catch {
    return null;
  }
}

function writeCachedUrl(namespace: string, path: string, signedUrl: string, expiresAt: number) {
  const key = cacheKey(namespace, path);
  const entry = { signedUrl, expiresAt };
  signedImageUrlMemoryCache.set(key, entry);
  try {
    window.localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // The in-memory cache still prevents duplicate signing within this page session.
  }
}

export async function withSignedImageUrls<T extends ImagePathItem>(
  items: T[],
  signImagePaths: SignImagePaths,
  cacheOptions?: SignedImageUrlCacheOptions,
): Promise<T[]> {
  const imagePaths = [...new Set(items
    .map((item) => item.image_path)
    .filter((path): path is string => Boolean(path)))];
  if (imagePaths.length === 0) return items;

  const now = Date.now();
  const cachedUrls = new Map<string, string>();
  const pathsToSign = cacheOptions
    ? imagePaths.filter((path) => {
      const signedUrl = readCachedUrl(cacheOptions.namespace, path, now);
      if (signedUrl) cachedUrls.set(path, signedUrl);
      return !signedUrl;
    })
    : imagePaths;

  if (pathsToSign.length > 0) {
    try {
      const { data, error } = await signImagePaths(pathsToSign);
      if (!error) {
        for (const entry of data ?? []) {
          if (!entry.path || !entry.signedUrl) continue;
          cachedUrls.set(entry.path, entry.signedUrl);
          if (cacheOptions) {
            writeCachedUrl(cacheOptions.namespace, entry.path, entry.signedUrl, now + cacheOptions.ttlMs);
          }
        }
      }
    } catch {
      // Images are optional; business data must remain usable when URL signing fails.
    }
  }

  return items.map((item) => ({
    ...item,
    image_url: item.image_path ? cachedUrls.get(item.image_path) ?? item.image_url ?? null : null,
  }));
}
