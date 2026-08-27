import { describe, expect, it, vi } from 'vitest';
import { clearLegacyCatalogImageCache } from '../src/pwaUpdateSafety';

describe('legacy catalog image cache cleanup', () => {
  it('removes only the cache that may contain an opaque R2 error response', async () => {
    const deleteCache = vi.fn().mockResolvedValue(true);

    await expect(clearLegacyCatalogImageCache({ delete: deleteCache })).resolves.toBe(true);

    expect(deleteCache).toHaveBeenCalledOnce();
    expect(deleteCache).toHaveBeenCalledWith('catalog-images');
  });

  it('does not block app startup when Cache Storage is unavailable', async () => {
    await expect(clearLegacyCatalogImageCache(undefined)).resolves.toBe(false);
  });
});
