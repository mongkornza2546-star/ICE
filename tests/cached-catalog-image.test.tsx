import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CachedCatalogImage } from '../src/CachedCatalogImage';

const mocks = vi.hoisted(() => ({ load: vi.fn(), discard: vi.fn() }));
vi.mock('../src/lib/catalogImageCache', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/catalogImageCache')>(),
  loadCatalogImage: mocks.load,
  discardCatalogImage: mocks.discard,
}));
const source = 'https://bucket.account.r2.cloudflarestorage.com/shop-images/shops/one/r2/photo.webp';
let visible: (entries: Array<{ isIntersecting: boolean }>) => void;
const disconnect = vi.fn();
const revoke = vi.fn();
const create = vi.fn(() => 'blob:cached-image');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockReset().mockResolvedValue(new Blob(['image'], { type: 'image/webp' }));
  mocks.discard.mockResolvedValue(undefined);
  vi.stubGlobal('caches', {});
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof visible) { visible = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = create;
    static revokeObjectURL = revoke;
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('cached catalog image display', () => {
  it('waits until near the viewport, uses the blob directly, then releases it on unmount', async () => {
    const view = render(<CachedCatalogImage src={source} alt="shop" />);
    expect(screen.getByAltText('shop').getAttribute('src')).toBeNull();
    expect(mocks.load).not.toHaveBeenCalled();
    await act(async () => { visible([{ isIntersecting: true }]); });
    expect(screen.getByAltText('shop').getAttribute('src')).toBe('blob:cached-image');
    expect(mocks.load).toHaveBeenCalledWith(source, { signal: expect.any(AbortSignal) });
    view.unmount();
    expect(revoke).toHaveBeenCalledWith('blob:cached-image');
    expect(disconnect).toHaveBeenCalled();
  });

  it('loads an eager preview immediately from the same cache', async () => {
    render(<CachedCatalogImage src={source} loading="eager" alt="preview" />);
    await waitFor(() => expect(screen.getByAltText('preview').getAttribute('src')).toBe('blob:cached-image'));
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it('ignores a late old image response after the source changes', async () => {
    let resolveOld!: (blob: Blob) => void;
    mocks.load.mockImplementationOnce(() => new Promise<Blob>((resolve) => { resolveOld = resolve; }));
    const view = render(<CachedCatalogImage src={source} loading="eager" alt="shop" />);
    const replacement = source.replace('photo.webp', 'replacement.webp');
    view.rerender(<CachedCatalogImage src={replacement} loading="eager" alt="shop" />);
    await waitFor(() => expect(screen.getByAltText('shop').getAttribute('src')).toBe('blob:cached-image'));
    await act(async () => { resolveOld(new Blob(['old'])); });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('falls back to a native img on fetch/CORS failure and preserves signed URL retries', async () => {
    mocks.load.mockRejectedValue(new Error('CORS blocked'));
    const onError = vi.fn();
    render(<CachedCatalogImage src={source} loading="eager" alt="shop" onError={onError} />);
    await waitFor(() => expect(screen.getByAltText('shop').getAttribute('src')).toBe(source));
    fireEvent.error(screen.getByAltText('shop'));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('discards corrupt cached images and tries the original URL before calling onError', async () => {
    const onError = vi.fn();
    render(<CachedCatalogImage src={source} loading="eager" alt="shop" onError={onError} />);
    await waitFor(() => expect(screen.getByAltText('shop').getAttribute('src')).toBe('blob:cached-image'));
    fireEvent.error(screen.getByAltText('shop'));
    expect(mocks.discard).toHaveBeenCalledWith(source);
    expect(screen.getByAltText('shop').getAttribute('src')).toBe(source);
    expect(onError).not.toHaveBeenCalled();
    fireEvent.error(screen.getByAltText('shop'));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('preserves ordinary images when Cache Storage is unsupported', () => {
    vi.stubGlobal('caches', undefined);
    render(<CachedCatalogImage src={source} alt="shop" />);
    expect(screen.getByAltText('shop').getAttribute('src')).toBe(source);
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
