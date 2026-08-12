import { beforeEach, describe, expect, it } from 'vitest';
import type { UserProfile } from '../src/types/app';
import {
  clearCachedUserProfile,
  readCachedUserProfile,
  writeCachedUserProfile,
} from '../src/lib/userProfileCache';

const profile: UserProfile = {
  id: 'user-1',
  code: 'EMP001',
  display_name: 'พนักงานทดสอบ',
  phone: null,
  role: 'courier',
  is_active: true,
};

describe('user profile cache', () => {
  beforeEach(() => window.localStorage.clear());

  it('restores a recently validated profile for immediate rendering', () => {
    writeCachedUserProfile(profile, 1_000);
    expect(readCachedUserProfile(profile.id, 2_000)).toEqual({ profile, validatedAt: 1_000 });
  });

  it('rejects expired, malformed, or cross-user profile data', () => {
    writeCachedUserProfile(profile, 1_000);
    expect(readCachedUserProfile(profile.id, 24 * 60 * 60 * 1000 + 1_001)).toBeNull();

    window.localStorage.setItem('ice-user-profile:v1:user-2', JSON.stringify({ profile, validatedAt: 2_000 }));
    expect(readCachedUserProfile('user-2', 2_001)).toBeNull();

    writeCachedUserProfile(profile, 4_000);
    expect(readCachedUserProfile(profile.id, 3_999)).toBeNull();
  });

  it('clears the cached profile on sign-out', () => {
    writeCachedUserProfile(profile, 1_000);
    clearCachedUserProfile(profile.id);
    expect(readCachedUserProfile(profile.id, 2_000)).toBeNull();
  });
});
