import React from 'react';
import { Blob as NodeBlob } from 'node:buffer';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadCatalogImage } from '../src/lib/catalogImageCache';
import { CachedCatalogImage } from '../src/CachedCatalogImage';
import { AutoRefreshShopImage } from '../src/features/financial-operations/components/AutoRefreshShopImage';
import { readCachedEmployeeShopCards, writeCachedEmployeeShopCards } from '../src/lib/employeeWorkspaceCache';
import type { ShopCard } from '../src/types/app';
import { EmployeeShopPicker } from '../src/features/employee-delivery/EmployeeShopPicker';
import { EmployeeStockProductImage } from '../src/features/employee-delivery/EmployeeStockProductImage';
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
const base = 'https://bucket.account.r2.cloudflarestorage.com/shop-images/shops/test/r2/';
const data = new Map<string, Response>();
const image = () => new Response(new NodeBlob(['pixels'], { type: 'image/webp' }));
const network = vi.fn();
const cache = {
  match: async (key: string | Request) => data.get(typeof key === 'string' ? key : key.url)?.clone(),
  put: async (key: string, response: Response) => { data.set(key, response.clone()); },
  delete: async (key: string | Request) => data.delete(typeof key === 'string' ? key : key.url),
  keys: async () => [...data.keys()].map((url) => new Request(url)),
};
beforeEach(() => {
  network.mockReset().mockImplementation(async () => image());
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('caches', { open: async () => cache });
  vi.stubGlobal('URL', class extends URL { static createObjectURL = () => 'blob:loaded'; static revokeObjectURL = () => {}; });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('serves an existing disk image without waiting for unrelated slow downloads', async () => {
  await loadCatalogImage(`${base}warm.webp`);
  const release: Array<() => void> = [];
  network.mockImplementation(() => new Promise<Response>((resolve) => release.push(() => resolve(image()))));
  const slow = [loadCatalogImage(`${base}slow-1.webp`), loadCatalogImage(`${base}slow-2.webp`)];
  await waitFor(() => expect(release).toHaveLength(2));
  let served = false;
  const warm = loadCatalogImage(`${base}warm.webp`).then(() => { served = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const servedBeforeNetwork = served;
  for (const resolve of release) resolve();
  await Promise.all([...slow, warm]);
  expect(servedBeforeNetwork, 'disk cache must not depend on unrelated networking').toBe(true);
});

it('does not start queued image downloads after their components unmount', async () => {
  const release: Array<() => void> = [];
  network.mockImplementation(() => new Promise<Response>((resolve) => release.push(() => resolve(image()))));
  const view = render(<>{[1, 2, 3].map((i) => <CachedCatalogImage key={i} loading="eager" src={`${base}abandoned-${i}.webp`} alt={`image-${i}`} />)}</>);
  await waitFor(() => expect(release).toHaveLength(2));
  view.unmount();
  await act(async () => { release[0](); release[1](); });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const downloaded = network.mock.calls.map(([url]) => url);
  if (release[2]) { await act(async () => { release[2](); }); }
  expect(downloaded).not.toContain(`${base}abandoned-3.webp`);
});

it('shows persisted shop image bytes immediately when reopening cached workspace data', async () => {
  const source = `${base}restored.webp`;
  await loadCatalogImage(source);
  writeCachedEmployeeShopCards('review', '2026-10-22', 'round-1', [
    { shop_id: 'shop-1', image_path: 'shops/test/r2/restored.webp', image_url: source } as ShopCard,
  ]);
  const [card] = readCachedEmployeeShopCards('review', '2026-10-22', 'round-1')!;
  expect(card.image_path).toBe('shops/test/r2/restored.webp');
  expect(card.image_url).toBeNull();
  network.mockRejectedValue(new Error('offline'));
  render(<AutoRefreshShopImage imagePath={card.image_path} imageUrl={card.image_url} alt="Restored shop" fallback={<span>No image</span>} />);
  await waitFor(() => expect(screen.getByRole('img', { name: 'Restored shop' }).getAttribute('src')).toBe('blob:loaded'));
  expect(network).toHaveBeenCalledTimes(1);
});

it('opens a restored shop tile and its full-size preview using only the path', async () => {
  await loadCatalogImage(`${base}tile.webp`);
  network.mockRejectedValue(new Error('offline'));
  const card: ShopCard = {
    round_stop_id: 'stop-1', shop_id: 'shop-1', shop_code: 'BB16', shop_name: 'ร้านทดสอบ',
    building_id: 'building-1', building_name: 'อาคาร', floor_or_zone: 'B', sequence_no: 1,
    image_path: 'shops/test/r2/tile.webp', image_url: null, payment_status: 'unpaid',
    stop_status: 'pending', stop_note: null, today_history: [], today_totals: {},
  };
  const refresh = vi.fn();
  const { container } = render(<EmployeeShopPicker
    casualCustomerEntryVisible enableAssignedStockFlow={false} selectedRoundId="round-1"
    query="" setQuery={vi.fn()} selectedBuildingId="" setSelectedBuildingId={vi.fn()} buildingOptions={[]}
    selectedZone="" setSelectedZone={vi.fn()} zoneOptions={[]} destinationKind="regular" setDestinationKind={vi.fn()}
    selectedEventJobId="" setSelectedEventJobId={vi.fn()} eventOptions={[]} eventCardsError={null} loadingCards={false}
    filteredCards={[card]} refreshShopImageUrl={refresh} casualCustomerButtonRef={{ current: null }}
    openCasualCustomer={vi.fn()} openCard={vi.fn()} stockState={null} shopButtonRefs={{ current: new Map() }}
  />);
  await waitFor(() => expect(container.querySelector('.employee-shop-tile__visual img')?.getAttribute('src')).toBe('blob:loaded'));
  fireEvent.click(screen.getByRole('button', { name: 'ดูรูปร้าน BB16 ร้านทดสอบ' }));
  await waitFor(() => expect(screen.getByRole('img', { name: 'รูปร้าน BB16 · ร้านทดสอบ' }).getAttribute('src')).toBe('blob:loaded'));
  expect(refresh).not.toHaveBeenCalled();
  expect(network).toHaveBeenCalledTimes(1);
});

it('shows a restored stock product image and opens its preview without signing', async () => {
  const source = `${base.replace('shop-images', 'ice-type-images')}product.webp`;
  await loadCatalogImage(source);
  network.mockRejectedValue(new Error('offline'));
  const preview = vi.fn();
  render(<EmployeeStockProductImage iceType={{ id: 'ice-1', code: '01', name: 'น้ำแข็ง', unit: 'ถุง', image_path: 'shops/test/r2/product.webp', image_url: null }} onPreview={preview} />);
  const img = await screen.findByRole('img', { name: 'น้ำแข็ง' });
  await waitFor(() => expect(img.getAttribute('src')).toBe('blob:loaded'));
  fireEvent.load(img);
  fireEvent.click(screen.getByRole('button', { name: 'ดูรูป น้ำแข็ง ขนาดใหญ่' }));
  expect(preview).toHaveBeenCalledWith({ name: 'น้ำแข็ง', url: 'blob:loaded', imagePath: 'shops/test/r2/product.webp' });
  expect(network).toHaveBeenCalledTimes(1);
});
