import React from 'react';
import { Blob as NodeBlob } from 'node:buffer';
import { act, render, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import type { ShopCard } from '../src/types/app';
const native = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true }, CapacitorHttp: { get: native.get } }));
vi.mock('@phosphor-icons/react', () => Object.fromEntries(['MagnifyingGlass', 'Buildings', 'MapPin', 'Storefront', 'CaretRight', 'WarningCircle', 'X'].map(name => [name, () => null])));
const source = 'https://review.account.r2.cloudflarestorage.com/shop-images/shops/return/r2/photo.webp';
const card: ShopCard = { round_stop_id: 'stop', shop_id: 'shop', shop_code: 'BB45', shop_name: 'Review', building_id: 'B', building_name: 'B', floor_or_zone: '3', sequence_no: 1, image_path: 'shops/return/r2/photo.webp', image_url: source, payment_status: 'unpaid', stop_status: 'delivered', stop_note: null, today_history: [], today_totals: {} };
const response = () => ({ status: 200, headers: { 'Content-Type': 'image/webp' }, data: btoa('pixels') });
let entries: Map<string, Response>;
let visible: Array<(entries: Array<{
    isIntersecting: boolean;
}>) => void>;
const cache = { match: vi.fn(), put: vi.fn(), keys: vi.fn(), delete: vi.fn() };
beforeEach(() => {
    vi.resetModules();
    entries = new Map();
    visible = [];
    cache.match.mockReset().mockImplementation(async (key: string | Request) => entries.get(typeof key === 'string' ? key : key.url)?.clone());
    cache.put.mockReset().mockImplementation(async (key: string, value: Response) => { entries.set(key, value.clone()); });
    cache.keys.mockReset().mockImplementation(async () => [...entries.keys()].map(url => new Request(url)));
    cache.delete.mockReset().mockImplementation(async (key: string | Request) => entries.delete(typeof key === 'string' ? key : key.url));
    native.get.mockReset().mockResolvedValue(response());
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
    vi.stubGlobal('URL', class extends URL {
        static createObjectURL = () => 'blob:review';
        static revokeObjectURL = () => { };
    });
    vi.stubGlobal('IntersectionObserver', class {
        constructor(cb: typeof visible[number]) { visible.push(cb); }
        observe() { }
        disconnect() { }
    });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function show() { await act(async () => { for (const callback of [...visible])
    callback([{ isIntersecting: true }]); }); }
async function picker(item: ShopCard, refresh = vi.fn(async () => source)) {
    const { EmployeeShopPicker } = await import('../src/features/employee-delivery/EmployeeShopPicker');
    return render(<EmployeeShopPicker casualCustomerEntryVisible enableAssignedStockFlow={false} selectedRoundId="round" query="" setQuery={vi.fn()} selectedBuildingId="" setSelectedBuildingId={vi.fn()} buildingOptions={[]} selectedZone="" setSelectedZone={vi.fn()} zoneOptions={[]} destinationKind="regular" setDestinationKind={vi.fn()} selectedEventJobId="" setSelectedEventJobId={vi.fn()} eventOptions={[]} eventCardsError={null} loadingCards={false} filteredCards={[item]} refreshShopImageUrl={refresh} casualCustomerButtonRef={{ current: null }} openCasualCustomer={vi.fn()} openCard={vi.fn()} stockState={null} shopButtonRefs={{ current: new Map() }}/>);
}
it('revisiting a persisted shop uses disk bytes with no new native download', async () => {
    const api = await import('../src/lib/catalogImageCache');
    const first = await picker(card);
    await show();
    await waitFor(() => expect(first.container.querySelector('img')?.getAttribute('src')).toBe('blob:review'));
    await waitFor(() => expect(entries.has(api.catalogImageCacheKey(source)!)).toBe(true));
    first.unmount();
    const second = await picker({ ...card, image_url: null });
    await show();
    await waitFor(() => expect(second.container.querySelector('img')?.getAttribute('src')).toBe('blob:review'));
    expect(native.get).toHaveBeenCalledTimes(1);
});
it('returning with the same URL shares an unfinished native download', async () => {
    let finish!: () => void;
    native.get.mockImplementation(() => new Promise(resolve => { finish = () => resolve(response()); }));
    const first = await picker(card);
    await show();
    await waitFor(() => expect(native.get).toHaveBeenCalledTimes(1));
    first.unmount();
    const second = await picker(card);
    await show();
    await act(async () => finish());
    await waitFor(() => expect(second.container.querySelector('img')?.getAttribute('src')).toBe('blob:review'));
    expect(native.get).toHaveBeenCalledTimes(1);
});
it.each([500, 2000])('should reuse disk images after an unrelated write recovers (%s ms)', async (stallMs) => {
    const api = await import('../src/lib/catalogImageCache');
    await api.loadCatalogImage(source);
    const key = api.catalogImageCacheKey(source)!;
    await waitFor(() => expect(entries.has(key)).toBe(true));
    let finish!: () => void;
    cache.put.mockImplementationOnce((writeKey: string, value: Response) => new Promise<void>(resolve => { finish = () => { entries.set(writeKey, value.clone()); resolve(); }; }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    await api.loadCatalogImage(source.replace('photo.webp', 'slow-write.webp'));
    await vi.advanceTimersByTimeAsync(stallMs);
    // A stalled write must not prevent reading another already-persisted image.
    await api.loadCatalogImage(source);
    expect(native.get).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(entries.has(key)).toBe(true); // The original file still exists on disk.
    await api.loadCatalogImage(source);
    await api.loadCatalogImage(source);
    expect(native.get).toHaveBeenCalledTimes(2); // Original + unrelated image only.
});
it.each([0, 10000])('restores an ongoing download by path despite unavailable signing (delay %s ms)', async (delayMs) => {
    const api = await import('../src/lib/catalogImageCache');
    const workspace = await import('../src/lib/employeeWorkspaceCache');
    let finish!: () => void;
    native.get.mockImplementation(() => new Promise(resolve => { finish = () => resolve(response()); }));
    const first = await picker(card);
    await show();
    await waitFor(() => expect(native.get).toHaveBeenCalledTimes(1));
    workspace.writeCachedEmployeeShopCards('review', '2026-10-26', 'round', [card]);
    first.unmount();
    const restored = workspace.readCachedEmployeeShopCards('review', '2026-10-26', 'round')![0];
    expect(restored.image_url).toBeNull();
    const refresh = vi.fn().mockRejectedValue(new Error('temporary signing failure'));
    if (delayMs)
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const second = await picker(restored, refresh);
    await show();
    if (delayMs)
        await act(async () => { await vi.advanceTimersByTimeAsync(delayMs); });
    await act(async () => finish());
    vi.useRealTimers();
    await waitFor(() => expect(entries.has(api.catalogImageCacheKey(source)!)).toBe(true));
    await waitFor(() => expect(second.container.querySelector('img')?.getAttribute('src')).toBe('blob:review'));
    expect(refresh).not.toHaveBeenCalled();
    expect(native.get).toHaveBeenCalledTimes(1);
});
it('reopens by path while an actual disk write is still pending past its timeout', async () => {
    const api = await import('../src/lib/catalogImageCache');
    let finish!: () => void;
    cache.put.mockImplementationOnce((key: string, value: Response) => new Promise<void>(resolve => { finish = () => { entries.set(key, value.clone()); resolve(); }; }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    await api.loadCatalogImage(source);
    await vi.advanceTimersByTimeAsync(2000);
    expect(entries.size).toBe(0);
    const refresh = vi.fn().mockRejectedValue(new Error('signing unavailable'));
    const second = await picker({ ...card, image_url: null }, refresh);
    await show();
    expect(second.container.querySelector('img')?.getAttribute('src')).toBe('blob:review');
    expect(native.get).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => finish());
});
it.each(['resolve', 'reject'])('recovers cache reads when a timed-out platform operation eventually %ss', async (outcome) => {
    const api = await import('../src/lib/catalogImageCache');
    await api.loadCatalogImage(source);
    await waitFor(() => expect(entries.size).toBe(1));
    let finish!: () => void;
    const open = vi.fn().mockImplementationOnce(() => new Promise((resolve, reject) => { finish = () => outcome === 'resolve' ? resolve(cache) : reject(new Error('temporary failure')); })).mockResolvedValue(cache);
    vi.stubGlobal('caches', { open });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const interrupted = api.readCatalogImageByPath('shop-images', card.image_path!);
    await vi.advanceTimersByTimeAsync(2000);
    await interrupted;
    finish();
    await vi.advanceTimersByTimeAsync(1);
    const restored = await api.readCatalogImageByPath('shop-images', card.image_path!);
    expect(await restored?.text()).toBe('pixels');
    expect(native.get).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2);
});
it.each(['origin', 'version'])('refuses ambiguous path-only reads across disk and pending %s', async (difference) => {
    const api = await import('../src/lib/catalogImageCache');
    await api.loadCatalogImage(source);
    await waitFor(() => expect(entries.size).toBe(1));
    let finish!: () => void;
    native.get.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(response()); }));
    const other = difference === 'origin' ? source.replace('review.account', 'other.account') : `${source}?v=2`;
    const otherDownload = api.loadCatalogImage(other);
    await waitFor(() => expect(native.get).toHaveBeenCalledTimes(2));
    expect(await api.readCatalogImageByPath('shop-images', card.image_path!)).toBeNull();
    finish();
    await otherDownload;
    await waitFor(() => expect(entries.size).toBe(2));
});
it('releases a path-only consumer without cancelling another consumer of the same native request', async () => {
    const api = await import('../src/lib/catalogImageCache');
    let finish!: () => void;
    native.get.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(response()); }));
    const original = api.loadCatalogImage(source);
    await waitFor(() => expect(native.get).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const pathReader = api.readCatalogImageByPath('shop-images', card.image_path!, { signal: controller.signal });
    const cancelled = expect(pathReader).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await cancelled;
    finish();
    expect(await (await original).text()).toBe('pixels');
    await waitFor(() => expect(entries.size).toBe(1));
    expect(await (await api.readCatalogImageByPath('shop-images', card.image_path!))?.text()).toBe('pixels');
    expect(native.get).toHaveBeenCalledTimes(1);
});
