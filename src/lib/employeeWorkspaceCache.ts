import type { DeliveryRound, IceTypeOption, ShopCard } from '../types/app';

const CACHE_PREFIX = 'ice-employee-workspace:v1';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;

interface CacheEntry<T> {
  cachedAt: number;
  value: T;
}

export interface CachedEmployeeReferenceData {
  rounds: DeliveryRound[];
  iceTypes: IceTypeOption[];
}

function cacheKey(kind: 'reference' | 'cards', scope: string, serviceDate: string, roundId?: string) {
  return [CACHE_PREFIX, kind, scope, serviceDate, roundId]
    .filter((part): part is string => Boolean(part))
    .map(encodeURIComponent)
    .join(':');
}

function readEntry<T>(key: string, now = Date.now()): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Partial<CacheEntry<T>> | null;
    if (!parsed || typeof parsed.cachedAt !== 'number' || !Number.isFinite(parsed.cachedAt)
      || parsed.cachedAt > now || now - parsed.cachedAt > CACHE_MAX_AGE_MS
      || parsed.value === undefined) {
      window.localStorage.removeItem(key);
      return null;
    }
    return parsed.value;
  } catch {
    return null;
  }
}

function pruneEntries(storage: Storage, incomingKey: string, now: number) {
  const entries: Array<{ key: string; cachedAt: number }> = [];
  const prefix = `${encodeURIComponent(CACHE_PREFIX)}:`;
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    let entry: Partial<CacheEntry<unknown>> | null = null;
    try {
      entry = JSON.parse(storage.getItem(key) ?? 'null');
    } catch {
      // Malformed entries are disposable, just like expired entries.
    }
    if (!entry || typeof entry.cachedAt !== 'number' || !Number.isFinite(entry.cachedAt)
      || entry.cachedAt > now || now - entry.cachedAt > CACHE_MAX_AGE_MS
      || entry.value === undefined) {
      storage.removeItem(key);
    } else if (key !== incomingKey) {
      entries.push({ key, cachedAt: entry.cachedAt });
    }
  }
  entries.sort((left, right) => left.cachedAt - right.cachedAt);
  for (const entry of entries.slice(0, Math.max(0, entries.length - CACHE_MAX_ENTRIES + 1))) {
    storage.removeItem(entry.key);
  }
}

function writeEntry<T>(key: string, value: T) {
  if (typeof window === 'undefined') return;
  try {
    const storage = window.localStorage;
    const cachedAt = Date.now();
    pruneEntries(storage, key, cachedAt);
    storage.setItem(key, JSON.stringify({ cachedAt, value } satisfies CacheEntry<T>));
  } catch {
    // Cached data only improves startup and must never block live data.
  }
}

export function readCachedEmployeeReferenceData(scope: string, serviceDate: string) {
  const value = readEntry<CachedEmployeeReferenceData>(cacheKey('reference', scope, serviceDate));
  return value && Array.isArray(value.rounds) && Array.isArray(value.iceTypes) ? value : null;
}

export function writeCachedEmployeeReferenceData(
  scope: string,
  serviceDate: string,
  value: CachedEmployeeReferenceData,
) {
  writeEntry(cacheKey('reference', scope, serviceDate), {
    rounds: value.rounds,
    iceTypes: value.iceTypes.map((iceType) => ({ ...iceType, image_url: null })),
  });
}

export function readCachedEmployeeShopCards(scope: string, serviceDate: string, roundId: string) {
  const value = readEntry<ShopCard[]>(cacheKey('cards', scope, serviceDate, roundId));
  return Array.isArray(value) ? value : null;
}

export function writeCachedEmployeeShopCards(
  scope: string,
  serviceDate: string,
  roundId: string,
  cards: ShopCard[],
) {
  writeEntry(
    cacheKey('cards', scope, serviceDate, roundId),
    cards.map((card) => ({ ...card, image_url: null })),
  );
}
