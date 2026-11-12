import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refreshR2CatalogObjectUrl: vi.fn(),
  isR2Path: vi.fn((path: string) => path.startsWith('r2/') || path.includes('/r2/')),
  readCatalogImageByPath: vi.fn(),
  withPublicShopImages: vi.fn(),
}));

vi.mock('../src/lib/catalogImageCache', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/catalogImageCache')>(),
  readCatalogImageByPath: mocks.readCatalogImageByPath,
}));

vi.mock('../src/lib/r2Storage', () => ({
  isR2Path: mocks.isR2Path,
  refreshR2CatalogObjectUrl: mocks.refreshR2CatalogObjectUrl,
}));

vi.mock('../src/features/financial-operations/utils', () => ({ withPublicShopImages: mocks.withPublicShopImages }));

import { AutoRefreshShopImage } from '../src/features/financial-operations/components/AutoRefreshShopImage';

describe('AutoRefreshShopImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withPublicShopImages.mockReset().mockResolvedValue([{ image_url: 'https://r2.test/fresh-signed-url.webp' }]);
    mocks.readCatalogImageByPath.mockResolvedValue(null);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('renders fallback when imageUrl is null or empty', () => {
    render(
      <AutoRefreshShopImage
        fallback={<span data-testid="fallback-icon">Placeholder</span>}
        imageUrl={null}
      />,
    );
    expect(screen.getByTestId('fallback-icon')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders image when imageUrl is provided', () => {
    render(
      <AutoRefreshShopImage
        alt="Test Shop"
        fallback={<span data-testid="fallback-icon">Placeholder</span>}
        imageUrl="https://example.com/shop.webp"
      />,
    );
    const img = screen.getByRole('img', { name: 'Test Shop' });
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('https://example.com/shop.webp');
    expect(screen.queryByTestId('fallback-icon')).toBeNull();
  });

  it('loads a fresh URL when a local collection snapshot has only the image path', async () => {
    mocks.refreshR2CatalogObjectUrl.mockResolvedValue('https://r2.test/fresh-signed-url.webp');
    render(<AutoRefreshShopImage
      alt="Restored Shop"
      fallback={<span>Placeholder</span>}
      imagePath="shops/shop-1/r2/photo.webp"
      imageUrl={null}
    />);
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Restored Shop' }).getAttribute('src'))
        .toBe('https://r2.test/fresh-signed-url.webp');
    });
    expect(mocks.withPublicShopImages).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('restores a path-only image with a cache hit of %s', async (cacheHit) => {
    vi.stubGlobal('caches', {});
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = () => 'blob:shop-cache';
      static revokeObjectURL = () => {};
    });
    mocks.readCatalogImageByPath.mockResolvedValue(cacheHit ? new Blob(['photo']) : null);
    mocks.withPublicShopImages.mockResolvedValue([{ image_url: 'https://r2.test/fresh.webp' }]);
    render(<AutoRefreshShopImage
      alt="Cached Shop"
      loading="eager"
      fallback={<span>Placeholder</span>}
      imagePath="shops/shop-1/r2/photo.webp"
      imageUrl={null}
    />);
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Cached Shop' }).getAttribute('src'))
        .toBe(cacheHit ? 'blob:shop-cache' : 'https://r2.test/fresh.webp');
    });
    expect(mocks.withPublicShopImages).toHaveBeenCalledTimes(cacheHit ? 0 : 1);
  });

  it('recovers after signing fails and the connection returns without changing props', async () => {
    mocks.withPublicShopImages.mockResolvedValueOnce([{ image_url: null }])
      .mockResolvedValue([{ image_url: 'https://r2.test/recovered.webp' }]);
    render(<AutoRefreshShopImage alt="Recovery" imagePath="shops/test/r2/photo.webp"
      imageUrl={null} fallback={<span data-testid="missing">Placeholder</span>} />);
    await waitFor(() => expect(mocks.withPublicShopImages).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('missing')).toBeTruthy());
    fireEvent(window, new Event('online'));
    await waitFor(() => expect(screen.getByAltText('Recovery').getAttribute('src')).toBe('https://r2.test/recovered.webp'));
    fireEvent(window, new Event('online'));
    expect(mocks.withPublicShopImages).toHaveBeenCalledTimes(2);
  });

  it('resolves a legacy path on cache miss without force-refreshing R2', async () => {
    mocks.withPublicShopImages.mockResolvedValue([{ image_url: 'https://storage.test/shops/legacy.jpg' }]);
    render(<AutoRefreshShopImage alt="Legacy" imagePath="shops/legacy.jpg"
      imageUrl={null} fallback={<span>Placeholder</span>} />);
    await waitFor(() => expect(screen.getByAltText('Legacy').getAttribute('src')).toBe('https://storage.test/shops/legacy.jpg'));
    expect(mocks.withPublicShopImages).toHaveBeenCalledWith([{ image_path: 'shops/legacy.jpg' }]);
    expect(mocks.refreshR2CatalogObjectUrl).not.toHaveBeenCalled();
  });

  it('immediately falls back when error occurs and path is not R2', () => {
    render(
      <AutoRefreshShopImage
        alt="Legacy Shop"
        fallback={<span data-testid="fallback-icon">Placeholder</span>}
        imagePath="shops/legacy.jpg"
        imageUrl="https://example.com/legacy.jpg"
      />,
    );

    const img = screen.getByRole('img', { name: 'Legacy Shop' });
    fireEvent.error(img);

    expect(screen.getByTestId('fallback-icon')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(mocks.refreshR2CatalogObjectUrl).not.toHaveBeenCalled();
  });

  it('retries with refreshed signed URL on error when imagePath is R2', async () => {
    mocks.refreshR2CatalogObjectUrl.mockResolvedValue('https://r2.test/fresh-signed-url.webp');

    render(
      <AutoRefreshShopImage
        alt="R2 Shop"
        fallback={<span data-testid="fallback-icon">Placeholder</span>}
        imagePath="shops/shop-1/r2/photo.webp"
        imageUrl="https://r2.test/stale-url.webp"
      />,
    );

    const img = screen.getByRole('img', { name: 'R2 Shop' });
    fireEvent.error(img);

    expect(mocks.refreshR2CatalogObjectUrl).toHaveBeenCalledWith(
      'shop-images',
      'shops/shop-1/r2/photo.webp',
    );

    await waitFor(() => {
      const refreshedImg = screen.getByRole('img', { name: 'R2 Shop' });
      expect(refreshedImg.getAttribute('src')).toBe('https://r2.test/fresh-signed-url.webp');
    });
  });

  it('falls back to placeholder if retry also fails', async () => {
    mocks.refreshR2CatalogObjectUrl.mockResolvedValue('https://r2.test/fresh-signed-url.webp');

    render(
      <AutoRefreshShopImage
        alt="R2 Shop"
        fallback={<span data-testid="fallback-icon">Placeholder</span>}
        imagePath="shops/shop-1/r2/photo.webp"
        imageUrl="https://r2.test/stale-url.webp"
      />,
    );

    const img = screen.getByRole('img', { name: 'R2 Shop' });
    fireEvent.error(img);

    await waitFor(() => {
      const refreshed = screen.getByRole('img', { name: 'R2 Shop' });
      expect(refreshed.getAttribute('src')).toBe('https://r2.test/fresh-signed-url.webp');
    });

    // Fire error on the second attempt
    fireEvent.error(screen.getByRole('img', { name: 'R2 Shop' }));

    await waitFor(() => {
      expect(screen.getByTestId('fallback-icon')).toBeTruthy();
      expect(screen.queryByRole('img')).toBeNull();
    });
  });

  it('falls back to placeholder if refreshR2CatalogObjectUrl rejects', async () => {
    mocks.refreshR2CatalogObjectUrl.mockRejectedValue(new Error('Network error'));

    render(
      <AutoRefreshShopImage
        alt="R2 Shop"
        fallback={<span data-testid="fallback-icon">Placeholder</span>}
        imagePath="shops/shop-1/r2/photo.webp"
        imageUrl="https://r2.test/stale-url.webp"
      />,
    );

    const img = screen.getByRole('img', { name: 'R2 Shop' });
    fireEvent.error(img);

    await waitFor(() => {
      expect(screen.getByTestId('fallback-icon')).toBeTruthy();
      expect(screen.queryByRole('img')).toBeNull();
    });
  });
});
