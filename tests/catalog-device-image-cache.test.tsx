import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ isNativePlatform: vi.fn(() => false), get: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: native.isNativePlatform }, CapacitorHttp: { get: native.get } }));

const base = 'https://bucket.account.r2.cloudflarestorage.com/shop-images/shops/one/r2/';
const source = `${base}photo.webp?X-Amz-Date=20261022T000000Z&X-Amz-Signature=old`;
const image = () => new Response(new NodeBlob(['pixels'], { type: 'image/webp' }));
const entries = new Map<string, Response>();
const cache = {
  match: vi.fn(async (key: string | Request) => entries.get(typeof key === 'string' ? key : key.url)?.clone()),
  put: vi.fn(async (key: string, response: Response) => { entries.set(key, response.clone()); }),
  delete: vi.fn(async (key: string | Request) => entries.delete(typeof key === 'string' ? key : key.url)),
  keys: vi.fn(async () => [...entries.keys()].map((url) => new Request(url))),
};
const fetchImage = vi.fn(async () => image());

beforeEach(() => {
  vi.resetModules();
  native.isNativePlatform.mockReturnValue(false);
  entries.clear();
  cache.put.mockImplementation(async (key, response) => { entries.set(key, response.clone()); });
  fetchImage.mockReset().mockImplementation(async () => image());
  vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
  vi.stubGlobal('fetch', fetchImage);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('persistent catalog image cache (without a service worker)', () => {
  it('downloads through native HTTP on Android, then reads the disk cache without networking', async () => {
    native.isNativePlatform.mockReturnValue(true);
    vi.stubGlobal('Blob', NodeBlob);
    native.get.mockResolvedValue({ status: 200, headers: { 'Content-Type': 'image/webp' }, data: btoa('pixels') });
    const { loadCatalogImage } = await import('../src/lib/catalogImageCache');
    expect(await (await loadCatalogImage(source)).text()).toBe('pixels');
    expect(await (await loadCatalogImage(source)).text()).toBe('pixels');
    expect(native.get).toHaveBeenCalledTimes(1);
    expect(native.get).toHaveBeenCalledWith(expect.objectContaining({ url: source, responseType: 'arraybuffer' }));
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('reuses saved bytes after reopening the module and renewing the signed URL, even offline', async () => {
    let api = await import('../src/lib/catalogImageCache');
    expect(await (await api.loadCatalogImage(source)).text()).toBe('pixels');
    vi.resetModules();
    api = await import('../src/lib/catalogImageCache');
    fetchImage.mockRejectedValue(new Error('offline'));
    const renewed = source.replace('Signature=old', 'Signature=new');
    expect(await (await api.loadCatalogImage(renewed)).text()).toBe('pixels');
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it('does not mix namespaces, hosts, new upload paths, or explicit versions', async () => {
    const { loadCatalogImage } = await import('../src/lib/catalogImageCache');
    for (const url of [source, source.replace('shop-images', 'ice-type-images'),
      source.replace('bucket.account', 'other.account'), source.replace('photo.webp', 'new.webp'),
      `${source}&v=2`]) await loadCatalogImage(url);
    expect(fetchImage).toHaveBeenCalledTimes(5);
  });

  it('supports legacy public Supabase catalog images and excludes evidence and arbitrary images', async () => {
    const { catalogImageCacheKey, loadCatalogImage } = await import('../src/lib/catalogImageCache');
    const legacy = 'https://project.supabase.co/storage/v1/object/public/ice-type-images/product.webp';
    await loadCatalogImage(legacy);
    await loadCatalogImage(legacy);
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(catalogImageCacheKey(source.replace('shop-images', 'payment-evidence'))).toBeNull();
    expect(catalogImageCacheKey('https://example.com/photo.webp')).toBeNull();
    expect(catalogImageCacheKey(legacy.replace('/public/', '/sign/'))).toBeNull();
  });

  it('deduplicates concurrent loads of the same object', async () => {
    const { loadCatalogImage } = await import('../src/lib/catalogImageCache');
    await Promise.all([loadCatalogImage(source), loadCatalogImage(source.replace('Signature=old', 'Signature=new'))]);
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it('keeps a shared download alive while another consumer still needs it', async () => {
    const { loadCatalogImage } = await import('../src/lib/catalogImageCache');
    let finish!: () => void;
    fetchImage.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = () => resolve(image()); }));
    const first = new AbortController();
    const second = new AbortController();
    const left = loadCatalogImage(source, { signal: first.signal });
    const right = loadCatalogImage(source, { signal: second.signal });
    const cancelled = expect(left).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledTimes(1));
    first.abort();
    await cancelled;
    expect(fetchImage.mock.calls[0][1].signal.aborted).toBe(false);
    finish();
    expect(await (await right).text()).toBe('pixels');
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it('finishes browser HTTP after the final consumer leaves and reuses it on return', async () => {
    const { loadCatalogImage } = await import('../src/lib/catalogImageCache');
    let finish!: () => void;
    fetchImage.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = () => resolve(image()); }));
    const controller = new AbortController();
    const request = loadCatalogImage(source, { signal: controller.signal });
    const cancelled = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledTimes(1));
    controller.abort();
    await cancelled;
    const wasAborted = fetchImage.mock.calls[0][1].signal.aborted;
    const returning = loadCatalogImage(source.replace('Signature=old', 'Signature=new'));
    finish();
    expect(await (await returning).text()).toBe('pixels');
    expect(await (await loadCatalogImage(source)).text()).toBe('pixels');
    expect(wasAborted).toBe(false);
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it('finishes and caches a native download after its consumer leaves while preserving the slot limit', async () => {
    native.isNativePlatform.mockReturnValue(true);
    vi.stubGlobal('Blob', NodeBlob);
    const { loadCatalogImage, catalogImageCacheKey } = await import('../src/lib/catalogImageCache');
    const finish: Array<() => void> = [];
    native.get.mockImplementation(() => new Promise((resolve) => {
      finish.push(() => resolve({ status: 200, headers: { 'Content-Type': 'image/webp' }, data: btoa('pixels') }));
    }));
    const controller = new AbortController();
    const first = loadCatalogImage(source, { signal: controller.signal });
    const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = loadCatalogImage(`${base}second.webp`);
    const third = loadCatalogImage(`${base}third.webp`);
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    controller.abort();
    await cancelled;
    expect(finish).toHaveLength(2);
    finish[0]();
    await vi.waitFor(() => expect(finish).toHaveLength(3));
    finish[1](); finish[2]();
    await Promise.all([second, third]);
    expect(entries.has(catalogImageCacheKey(source)!)).toBe(true);
    expect(await (await loadCatalogImage(source)).text()).toBe('pixels');
    expect(finish).toHaveLength(3);
  });

  it('looks up restored paths without signing and keeps namespaces and replacement paths separate', async () => {
    const api = await import('../src/lib/catalogImageCache');
    await api.loadCatalogImage(source);
    vi.resetModules();
    const reopened = await import('../src/lib/catalogImageCache');
    fetchImage.mockRejectedValue(new Error('offline'));
    expect(await (await reopened.readCatalogImageByPath('shop-images', 'shops/one/r2/photo.webp'))?.text()).toBe('pixels');
    expect(await reopened.readCatalogImageByPath('ice-type-images', 'shops/one/r2/photo.webp')).toBeNull();
    expect(await reopened.readCatalogImageByPath('shop-images', 'shops/one/r2/replacement.webp')).toBeNull();
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it('does not guess a storage origin when path-only lookup is ambiguous', async () => {
    const api = await import('../src/lib/catalogImageCache');
    await api.loadCatalogImage(source);
    await api.loadCatalogImage(source.replace('bucket.account', 'other.account'));
    expect(await api.readCatalogImageByPath('shop-images', 'shops/one/r2/photo.webp')).toBeNull();
  });

  it('downloads at most two images concurrently', async () => {
    const { loadCatalogImage } = await import('../src/lib/catalogImageCache');
    let active = 0;
    let peak = 0;
    fetchImage.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return image();
    });
    await Promise.all(Array.from({ length: 8 }, (_, i) => loadCatalogImage(`${base}${i}.webp`)));
    expect(peak).toBe(2);
  });

  it('refreshes expired bytes and never caches failed or non-image responses', async () => {
    const api = await import('../src/lib/catalogImageCache');
    const key = api.catalogImageCacheKey(source)!;
    entries.set(key, new Response('old', { headers: {
      'x-ice-stored-at': String(Date.now() - api.CATALOG_IMAGE_MAX_AGE_MS - 1),
      'x-ice-byte-size': '3', 'content-type': 'image/webp',
    } }));
    await api.loadCatalogImage(source);
    await vi.waitFor(async () => expect(await entries.get(key)!.clone().text()).toBe('pixels'));
    await api.discardCatalogImage(source);
    fetchImage.mockResolvedValueOnce(new Response('denied', { status: 403 }));
    await expect(api.loadCatalogImage(source)).rejects.toThrow();
    fetchImage.mockResolvedValueOnce(new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }));
    await expect(api.loadCatalogImage(source)).rejects.toThrow();
    expect(entries.size).toBe(0);
    await api.loadCatalogImage(source);
    await vi.waitFor(() => expect(entries.size).toBe(1));
  });

  it('keeps successful downloads usable when disk writes fail', async () => {
    const { loadCatalogImage } = await import('../src/lib/catalogImageCache');
    cache.put.mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    expect(await (await loadCatalogImage(source)).text()).toBe('pixels');
    expect(entries.size).toBe(0);
  });

  it('keeps successful downloads usable when storage access is denied', async () => {
    vi.stubGlobal('caches', { open: vi.fn().mockRejectedValue(new Error('denied')) });
    const { loadCatalogImage } = await import('../src/lib/catalogImageCache');
    expect(await (await loadCatalogImage(source)).text()).toBe('pixels');
  });

  it.each(['bytes', 'count'])('evicts the oldest entries before exceeding the %s limit', async (limit) => {
    const api = await import('../src/lib/catalogImageCache');
    const count = limit === 'count' ? api.CATALOG_IMAGE_MAX_ENTRIES : 10;
    const bytes = limit === 'bytes' ? api.CATALOG_IMAGE_MAX_BYTES / count : 1;
    for (let i = 0; i < count; i++) {
      entries.set(`${base}${i}.webp`, new Response('x', { headers: {
        'x-ice-stored-at': String(Date.now() - 1000 + i), 'x-ice-byte-size': String(bytes),
      } }));
    }
    await api.loadCatalogImage(source);
    await vi.waitFor(() => expect(entries.has(api.catalogImageCacheKey(source)!)).toBe(true));
    expect(entries.has(`${base}0.webp`)).toBe(false);
    expect(entries.size).toBeLessThanOrEqual(api.CATALOG_IMAGE_MAX_ENTRIES);
    const total = [...entries.values()].reduce((sum, response) => sum + Number(response.headers.get('x-ice-byte-size')), 0);
    expect(total).toBeLessThanOrEqual(api.CATALOG_IMAGE_MAX_BYTES);
  });
});
