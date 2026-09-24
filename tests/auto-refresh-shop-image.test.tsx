import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refreshR2CatalogObjectUrl: vi.fn(),
  isR2Path: vi.fn((path: string) => path.startsWith('r2/') || path.includes('/r2/')),
}));

vi.mock('../src/lib/r2Storage', () => ({
  isR2Path: mocks.isR2Path,
  refreshR2CatalogObjectUrl: mocks.refreshR2CatalogObjectUrl,
}));

import { AutoRefreshShopImage } from '../src/features/financial-operations/components/AutoRefreshShopImage';

describe('AutoRefreshShopImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
