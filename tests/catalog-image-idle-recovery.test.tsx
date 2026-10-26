import React from 'react';
import { Blob as NodeBlob } from 'node:buffer';
import { act, render, cleanup, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, it, vi, expect } from 'vitest';
const native = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true }, CapacitorHttp: { get: native.get } }));
// Icons are unrelated to image loading; avoid importing the full icon catalog
// inside each reset-module reproduction.
vi.mock('@phosphor-icons/react', () => Object.fromEntries(
    ['MagnifyingGlass', 'Buildings', 'MapPin', 'Storefront', 'CaretRight', 'WarningCircle', 'X']
        .map(name => [name, () => <span aria-hidden="true" />]),
));
const base = 'https://idle.account.r2.cloudflarestorage.com/shop-images/shops/idle/r2/';
type VisibilityCallback = (entries: Array<{
    isIntersecting: boolean;
}>) => void;
let callbacks: VisibilityCallback[];
let cache: {
    match: ReturnType<typeof vi.fn>;
    keys: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
};
const ok = () => ({ status: 200, headers: { 'Content-Type': 'image/webp' }, data: btoa('pixels') });
beforeEach(() => {
    vi.resetModules();
    callbacks = [];
    cache = { match: vi.fn(async () => undefined), keys: vi.fn(async () => []), delete: vi.fn(async () => true), put: vi.fn(async () => { }) };
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('URL', class extends URL {
        static createObjectURL = () => 'blob:ready';
        static revokeObjectURL = () => { };
    });
    vi.stubGlobal('IntersectionObserver', class {
        constructor(callback: VisibilityCallback) { callbacks.push(callback); }
        observe() { }
        disconnect() { }
    });
    native.get.mockReset().mockResolvedValue(ok());
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('loads the current tile next when queued shops leave the viewport', async () => {
    const finishes: Array<() => void> = [];
    native.get.mockImplementation(() => new Promise(resolve => finishes.push(() => resolve(ok()))));
    const { CachedCatalogImage } = await import('../src/CachedCatalogImage');
    const { container } = render(<>{Array.from({ length: 8 }, (_, i) => <CachedCatalogImage key={i} alt={`shop-${i}`} src={`${base}${i}.webp`}/>)}</>);
    await act(async () => { for (const cb of [...callbacks])
        cb([{ isIntersecting: true }]); });
    await waitFor(() => expect(native.get).toHaveBeenCalledTimes(2));
    // User scrolls past the first seven shops; they remain mounted in EmployeeShopPicker.
    await act(async () => { for (const cb of callbacks.slice(0, 7))
        cb([{ isIntersecting: false }]); });
    await act(async () => { finishes[0](); finishes[1](); });
    await waitFor(() => expect(native.get).toHaveBeenCalledTimes(3));
    expect(native.get.mock.calls.map(([request]) => request.url)).toEqual([0, 1, 7].map(i => `${base}${i}.webp`));
    await act(async () => finishes[2]());
    await waitFor(() => expect(container.querySelector('img[alt="shop-7"]')?.getAttribute('src')).toBe('blob:ready'));
    // Returning to a cancelled queued shop starts a new request.
    await act(async () => callbacks[2]([{ isIntersecting: true }]));
    await waitFor(() => expect(native.get).toHaveBeenCalledTimes(4));
    expect(native.get.mock.calls[3][0].url).toBe(`${base}2.webp`);
    await act(async () => finishes[3]());
    await waitFor(() => expect(container.querySelector('img[alt="shop-2"]')?.getAttribute('src')).toBe('blob:ready'));
});
it('displays downloaded images and releases network slots before a pending disk write', async () => {
    let release!: () => void;
    cache.put.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const { CachedCatalogImage } = await import('../src/CachedCatalogImage');
    const { container } = render(<>{[1, 2, 3].map(i => <CachedCatalogImage key={i} alt={`shop-${i}`} loading="eager" src={`${base}write-${i}.webp`}/>)}</>);
    await waitFor(() => expect(cache.put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(native.get).toHaveBeenCalledTimes(3));
    await waitFor(() => expect([...container.querySelectorAll('img')].map(img => img.getAttribute('src'))).toEqual(['blob:ready', 'blob:ready', 'blob:ready']));
    vi.useRealTimers();
    await act(async () => release());
    await waitFor(() => expect([...container.querySelectorAll('img')].every(img => img.getAttribute('src') === 'blob:ready')).toBe(true));
});
it.each([true, false])('recovers a path-only shop once (cache supported: %s)', async (supported) => {
    if (!supported)
        vi.stubGlobal('caches', undefined);
    const { EmployeeShopPicker } = await import('../src/features/employee-delivery/EmployeeShopPicker');
    const refresh = vi.fn(async () => `${base}recover.webp`);
    const { container } = render(<EmployeeShopPicker casualCustomerEntryVisible enableAssignedStockFlow={false} selectedRoundId="round" query="" setQuery={vi.fn()} selectedBuildingId="" setSelectedBuildingId={vi.fn()} buildingOptions={[]} selectedZone="" setSelectedZone={vi.fn()} zoneOptions={[]} destinationKind="regular" setDestinationKind={vi.fn()} selectedEventJobId="" setSelectedEventJobId={vi.fn()} eventOptions={[]} eventCardsError={null} loadingCards={false} filteredCards={[{ round_stop_id: 'stop', shop_id: 'shop', shop_code: 'BB45', shop_name: 'Test', building_id: 'B', building_name: 'B', floor_or_zone: '3', sequence_no: 1, image_path: 'shops/idle/r2/recover.webp', image_url: null, payment_status: 'unpaid', stop_status: 'delivered', stop_note: null, today_history: [], today_totals: {} }]} refreshShopImageUrl={refresh} casualCustomerButtonRef={{ current: null }} openCasualCustomer={vi.fn()} openCard={vi.fn()} stockState={null} shopButtonRefs={{ current: new Map() }}/>);
    await act(async () => { for (const cb of [...callbacks])
        cb([{ isIntersecting: true }]); });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await act(async () => { for (const cb of [...callbacks])
        cb([{ isIntersecting: true }]); });
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(supported ? 'blob:ready' : `${base}recover.webp`));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(native.get).toHaveBeenCalledTimes(supported ? 1 : 0);
});
it('falls back to the direct URL when native HTTP never completes and ignores a late result', async () => {
    let finish!: (response: ReturnType<typeof ok>) => void;
    native.get.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { CachedCatalogImage } = await import('../src/CachedCatalogImage');
    render(<CachedCatalogImage alt="stalled" loading="eager" src={`${base}stalled.webp`}/>);
    await waitFor(() => expect(native.get).toHaveBeenCalledTimes(1));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    // Timeout was installed before fake timers: remount under the controlled clock.
    cleanup();
    const view = render(<CachedCatalogImage alt="stalled" loading="eager" src={`${base}stalled.webp`}/>);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe(`${base}stalled.webp`);
    await act(async () => finish(ok()));
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe(`${base}stalled.webp`);
});
it('bypasses a stalled cache open while the platform operation remains pending', async () => {
    const open = vi.fn(() => new Promise<Cache>(() => { }));
    vi.stubGlobal('caches', { open });
    const { CachedCatalogImage } = await import('../src/CachedCatalogImage');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const view = render(<CachedCatalogImage alt="cache stalled" loading="eager" src={`${base}open.webp`}/>);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:ready');
    view.rerender(<CachedCatalogImage alt="cache stalled" loading="eager" src={`${base}next.webp`}/>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:ready');
    expect(open).toHaveBeenCalledTimes(1);
    expect(native.get).toHaveBeenCalledTimes(2);
});
it('shares downloaded bytes while persistence is pending without waiting for the write', async () => {
    let release!: () => void;
    cache.put.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const { loadCatalogImage } = await import('../src/lib/catalogImageCache');
    const first = await loadCatalogImage(`${base}shared.webp`);
    const second = await loadCatalogImage(`${base}shared.webp`);
    expect(first).toBe(second);
    expect(native.get).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(cache.put).toHaveBeenCalledTimes(1));
    release();
});
