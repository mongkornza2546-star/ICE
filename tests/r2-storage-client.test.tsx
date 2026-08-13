import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('../src/lib/supabase', () => ({
  supabase: { functions: { invoke: mocks.invoke } },
}));

import { getHybridObjectUrls } from '../src/lib/r2Storage';
import { removeTankImage } from '../src/lib/tankImage';

describe('R2 storage client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue({
      data: {
        signedUrls: [
          { path: 'shops/a/r2/one.webp', signedUrl: 'https://r2.test/one' },
          { path: 'shops/b/r2/two.webp', signedUrl: 'https://r2.test/two' },
        ],
      },
      error: null,
    });
  });

  it('deduplicates and signs all R2 paths in one Edge Function call', async () => {
    const signLegacy = vi.fn(async (paths: string[]) => paths.map((path) => ({
      path,
      signedUrl: `https://supabase.test/${path}`,
    })));

    const entries = await getHybridObjectUrls('shop-images', [
      'shops/a/r2/one.webp',
      'shops/a/r2/one.webp',
      'shops/legacy.webp',
      'shops/b/r2/two.webp',
    ], signLegacy);

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('r2-storage', {
      body: {
        action: 'signMany',
        namespace: 'shop-images',
        paths: ['shops/a/r2/one.webp', 'shops/b/r2/two.webp'],
      },
    });
    expect(signLegacy).toHaveBeenCalledWith(['shops/legacy.webp']);
    expect(entries).toHaveLength(3);
  });

  it('cleans up failed tank registrations through R2', async () => {
    mocks.invoke.mockResolvedValueOnce({ data: { success: true }, error: null });

    await removeTankImage('shop-1/r2/tank.webp');

    expect(mocks.invoke).toHaveBeenCalledWith('r2-storage', {
      body: {
        action: 'delete',
        namespace: 'tank-images',
        paths: ['shop-1/r2/tank.webp'],
      },
    });
  });

  it('keeps legacy Supabase URLs when R2 signing is unavailable', async () => {
    mocks.invoke.mockResolvedValueOnce({ data: null, error: new Error('R2 unavailable') });

    const entries = await getHybridObjectUrls(
      'shop-images',
      ['shops/a/r2/one.webp', 'shops/legacy.webp'],
      async (paths) => paths.map((path) => ({
        path,
        signedUrl: `https://supabase.test/${path}`,
      })),
    );

    expect(entries).toEqual([{
      path: 'shops/legacy.webp',
      signedUrl: 'https://supabase.test/shops/legacy.webp',
    }]);
  });
});
