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

  it('retains loaded bytes across signature rotation and uses the latest URL if those bytes fail', async () => {
    const view = render(<CachedCatalogImage src={source} loading="eager" alt="shop" />);
    const photo = screen.getByAltText('shop');
    await waitFor(() => expect(photo.getAttribute('src')).toBe('blob:cached-image'));
    const renewed = `${source}?X-Amz-Signature=renewed`;
    view.rerender(<CachedCatalogImage src={renewed} loading="eager" alt="shop" />);
    expect(screen.getByAltText('shop')).toBe(photo);
    expect(photo.getAttribute('src')).toBe('blob:cached-image');
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.error(photo);
    expect(photo.getAttribute('src')).toBe(renewed);
    expect(mocks.discard).toHaveBeenCalledWith(renewed);
    view.unmount();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('uses a renewed URL when a lazy image first comes into view', async () => {
    const view = render(<CachedCatalogImage src={source} alt="shop" />);
    const renewed = `${source}?X-Amz-Signature=renewed`;
    view.rerender(<CachedCatalogImage src={renewed} alt="shop" />);
    await act(async () => visible([{ isIntersecting: true }]));
    expect(mocks.load).toHaveBeenCalledWith(renewed, { signal: expect.any(AbortSignal) });
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it('falls back to the latest URL if an older in-flight signed request fails', async () => {
    let fail!: (error: Error) => void;
    mocks.load.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const view = render(<CachedCatalogImage src={source} loading="eager" alt="shop" />);
    const renewed = `${source}?X-Amz-Signature=renewed`;
    view.rerender(<CachedCatalogImage src={renewed} loading="eager" alt="shop" />);
    await act(async () => fail(new Error('Expired signature')));
    expect(screen.getByAltText('shop').getAttribute('src')).toBe(renewed);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    const newer = `${source}?X-Amz-Signature=newer`;
    view.rerender(<CachedCatalogImage src={newer} loading="eager" alt="shop" />);
    expect(screen.getByAltText('shop').getAttribute('src')).toBe(newer);
  });

  it.each([
    source.replace('photo.webp', 'replacement.webp'),
    source.replace('bucket.account', 'other.account'),
    `${source}?v=2`,
  ])('loads new bytes when object identity changes to %s', async (replacement) => {
    const view = render(<CachedCatalogImage src={source} loading="eager" alt="shop" />);
    await waitFor(() => expect(screen.getByAltText('shop').getAttribute('src')).toBe('blob:cached-image'));
    view.rerender(<CachedCatalogImage src={replacement} loading="eager" alt="shop" />);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith(replacement, { signal: expect.any(AbortSignal) }));
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(1);
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
