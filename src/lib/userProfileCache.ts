import type { AppRole, UserProfile } from '../types/app';

interface CachedUserProfile {
  profile: UserProfile;
  validatedAt: number;
}

const USER_PROFILE_CACHE_PREFIX = 'ice-user-profile:v1';
const USER_PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const USER_PROFILE_REVALIDATE_MS = 5 * 60 * 1000;

const APP_ROLES = new Set<AppRole>(['admin', 'round_lead', 'courier']);

function cacheKey(userId: string) {
  return `${USER_PROFILE_CACHE_PREFIX}:${userId}`;
}

function isUserProfile(value: unknown, userId: string): value is UserProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<UserProfile>;
  return profile.id === userId
    && typeof profile.code === 'string'
    && typeof profile.display_name === 'string'
    && (profile.phone === null || typeof profile.phone === 'string')
    && typeof profile.role === 'string'
    && APP_ROLES.has(profile.role as AppRole)
    && typeof profile.is_active === 'boolean';
}

export function readCachedUserProfile(userId: string, now = Date.now()): CachedUserProfile | null {
  if (typeof window === 'undefined') return null;
  const key = cacheKey(userId);
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Partial<CachedUserProfile> | null;
    if (!parsed || !isUserProfile(parsed.profile, userId) || typeof parsed.validatedAt !== 'number'
      || !Number.isFinite(parsed.validatedAt) || parsed.validatedAt > now
      || now - parsed.validatedAt > USER_PROFILE_MAX_AGE_MS) {
      window.localStorage.removeItem(key);
      return null;
    }
    return { profile: parsed.profile, validatedAt: parsed.validatedAt };
  } catch {
    window.localStorage.removeItem(key);
    return null;
  }
}

export function writeCachedUserProfile(profile: UserProfile, validatedAt = Date.now()) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(cacheKey(profile.id), JSON.stringify({ profile, validatedAt }));
  } catch {
    // A disabled cache must not block authentication.
  }
}

export function clearCachedUserProfile(userId: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(cacheKey(userId));
  } catch {
    // A disabled cache must not block sign-out or server validation.
  }
}
