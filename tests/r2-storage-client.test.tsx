import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('../src/lib/supabase', () => ({
  supabase: { functions: { invoke: mocks.invoke } },
}));

import {
  clearR2CatalogUrlCache,
  getHybridObjectUrls,
  refreshR2CatalogObjectUrl,
  R2_SIGN_BATCH_CONCURRENCY,
  R2_SIGN_BATCH_SIZE,
} from '../src/lib/r2Storage';
import { removeTankImage } from '../src/lib/tankImage';

describe('R2 storage client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearR2CatalogUrlCache();
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

  it('signs large R2 catalogs in bounded batches', async () => {
    const paths = Array.from({ length: 121 }, (_, index) => `shops/${index}/r2/photo.webp`);
    mocks.invoke.mockImplementation(async (_name, request: { body: { paths: string[] } }) => ({
      data: {
        signedUrls: request.body.paths.map((path) => ({ path, signedUrl: `https://r2.test/${path}` })),
      },
      error: null,
    }));

    const entries = await getHybridObjectUrls('shop-images', paths, async () => []);

    expect(R2_SIGN_BATCH_SIZE).toBe(50);
    expect(entries).toHaveLength(121);
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    expect(mocks.invoke.mock.calls.map(([, request]) => request.body.paths.length)).toEqual([50, 50, 21]);
  });

  it('keeps successful R2 batches when another batch fails', async () => {
    const paths = Array.from({ length: 70 }, (_, index) => `shops/${index}/r2/photo.webp`);
    mocks.invoke.mockImplementation(async (_name, request: { body: { paths: string[] } }) => (
      request.body.paths.includes('shops/0/r2/photo.webp')
        ? { data: null, error: new Error('temporary signing failure') }
        : {
            data: {
              signedUrls: request.body.paths.map((path) => ({ path, signedUrl: `https://r2.test/${path}` })),
            },
            error: null,
          }
    ));

    const entries = await getHybridObjectUrls('shop-images', paths, async () => []);

    expect(entries).toHaveLength(20);
    expect(entries[0].path).toBe('shops/50/r2/photo.webp');
  });

  it('limits concurrent signing batches', async () => {
    const paths = Array.from({ length: 201 }, (_, index) => `shops/${index}/r2/photo.webp`);
    let active = 0;
    let maximumActive = 0;
    mocks.invoke.mockImplementation(async (_name, request: { body: { paths: string[] } }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        data: {
          signedUrls: request.body.paths.map((path) => ({ path, signedUrl: `https://r2.test/${path}` })),
        },
        error: null,
      };
    });

    const entries = await getHybridObjectUrls('shop-images', paths, async () => []);

    expect(entries).toHaveLength(201);
    expect(R2_SIGN_BATCH_CONCURRENCY).toBe(3);
    expect(maximumActive).toBe(3);
  });

  it('reuses catalog signed URLs while they remain valid', async () => {
    const path = 'shops/cached/r2/photo.webp';
    mocks.invoke.mockImplementation(async () => ({
      data: { signedUrls: [{ path, signedUrl: 'https://r2.test/cached' }] },
      error: null,
    }));

    const first = await getHybridObjectUrls('shop-images', [path], async () => []);
    const second = await getHybridObjectUrls('shop-images', [path], async () => []);

    expect(first).toEqual(second);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('evicts a failed catalog URL before signing a replacement', async () => {
    const path = 'shops/refreshed/r2/photo.webp';
    mocks.invoke
      .mockResolvedValueOnce({
        data: { signedUrls: [{ path, signedUrl: 'https://r2.test/stale' }] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { signedUrls: [{ path, signedUrl: 'https://r2.test/fresh' }] },
        error: null,
      });

    await getHybridObjectUrls('shop-images', [path], async () => []);
    const refreshed = await refreshR2CatalogObjectUrl('shop-images', path);

    expect(refreshed).toBe('https://r2.test/fresh');
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
});
