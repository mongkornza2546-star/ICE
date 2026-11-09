import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EmployeeDeliveryWorkspace, type EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';
import type { CollectionCloseResult, CollectionFocusRequest, ShopCard } from '../src/types/app';

const images = vi.hoisted(() => ({ load: vi.fn(), read: vi.fn(), create: vi.fn(), revoke: vi.fn() }));
vi.mock('../src/lib/catalogImageCache', async (original) => ({
  ...await original<typeof import('../src/lib/catalogImageCache')>(),
  loadCatalogImage: images.load,
  readCatalogImageByPath: images.read,
}));
// Keep the real workspace, navigation, submit and picker; shorten only cart entry.
vi.mock('../src/features/employee-delivery/EmployeeDeliveryReview', () => ({
  EmployeeDeliveryReview: (props: ComponentProps<typeof import('../src/features/employee-delivery/EmployeeDeliveryReview').EmployeeDeliveryReview>) => <section>
    <button onClick={() => props.onSetQuantity('ice', 1)}>ใส่จำนวนทดสอบ</button>
    <button onClick={() => props.onConfirmDelivery('immediate')}>ส่งและรับชำระทดสอบ</button>
    <button onClick={props.onBack}>กลับจากรายการส่ง</button>
  </section>,
}));

const source = 'https://bucket.account.r2.cloudflarestorage.com/shop-images/shops/one/r2/photo.webp';
const shop: ShopCard = {
  round_stop_id: 'stop', shop_id: 'shop', shop_code: 'AA10', shop_name: 'ร้านทดสอบ',
  building_id: 'building', building_name: 'A', floor_or_zone: 'A', sequence_no: 1,
  image_path: 'shops/one/r2/photo.webp', image_url: source,
  payment_status: 'unpaid', stop_status: 'delivered', stop_note: null, today_history: [], today_totals: {},
};
let observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void>;
beforeEach(() => {
  vi.clearAllMocks();
  observers = [];
  images.load.mockResolvedValue(new Blob(['pixels'], { type: 'image/webp' }));
  images.read.mockResolvedValue(new Blob(['pixels'], { type: 'image/webp' }));
  images.create.mockReturnValue('blob:shop-photo');
  vi.stubGlobal('caches', {});
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = images.create;
    static revokeObjectURL = images.revoke;
  });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof observers[number]) { observers.push(callback); }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function gateway(): EmployeeDeliveryGateway {
  return {
    loadReferenceData: vi.fn().mockResolvedValue({
      rounds: [{ id: 'round', service_date: '2026-11-04', name: 'งานประจำวัน', status: 'open', opened_at: '2026-11-04T01:00:00Z' }],
      iceTypes: [{ id: 'ice', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
    }),
    loadShopCards: vi.fn().mockResolvedValue([shop]),
    loadCollectionOutstanding: vi.fn().mockResolvedValue([]),
    loadEmployeeStockState: vi.fn(), recordEmployeeStockTransfer: vi.fn(),
    recordEmployeeStockReturn: vi.fn(), recordEmployeeStockDamage: vi.fn(),
    recordDelivery: vi.fn().mockResolvedValue({
      delivery_event_id: 'delivery', round_stop_id: 'stop', charge_id: 'charge',
      service_date: '2026-11-04', total_amount: 25, payment_term: 'immediate',
      payment_status: 'unpaid', due_date: null, approval_id: null,
    }),
  };
}

function Harness({ api }: { api: EmployeeDeliveryGateway }) {
  const [request, setRequest] = useState<CollectionFocusRequest | null>(null);
  const [result, setResult] = useState<CollectionCloseResult | null>(null);
  return <>
    <div hidden={Boolean(request)}>
      <EmployeeDeliveryWorkspace gateway={api} canCollectShopPayments viewMode="pos"
        requestScope="image-navigation" serviceDate="2026-11-04" isActive={!request}
        onOpenCollection={setRequest} collectionCloseResult={result} />
    </div>
    {request ? <button onClick={() => {
      setResult({ requestId: request.requestId, shopId: 'shop', status: 'completed', paymentId: 'payment' });
      setRequest(null);
    }}>รับเงินแล้วกลับรายการ</button> : null}
  </>;
}

it.each(['back', 'payment', 'progressive-payment'] as const)('keeps the loaded shop photo ready when returning from %s', async (action) => {
  const api = gateway();
  let finishPhotos: (() => void) | undefined;
  if (action === 'progressive-payment') {
    api.supportsProgressiveShopCardLoading = true;
    api.loadShopCards = vi.fn().mockResolvedValueOnce([shop]).mockImplementation((_round, options) => {
      options.onBaseCards([{ ...shop, image_url: null, payment_status: 'paid' }]);
      return new Promise<ShopCard[]>(resolve => { finishPhotos = () => resolve([{ ...shop, payment_status: 'paid' }]); });
    });
  }
  const view = render(<Harness api={api} />);
  const select = await screen.findByRole('button', { name: 'เลือกร้าน AA10 ร้านทดสอบ' });
  await act(async () => observers.forEach(callback => callback([{ isIntersecting: true }])));
  const photo = view.container.querySelector('.employee-shop-tile img')!;
  await waitFor(() => expect(photo.getAttribute('src')).toBe('blob:shop-photo'));
  expect(images.load).toHaveBeenCalledTimes(1);
  fireEvent.click(select);
  expect(screen.queryByRole('button', { name: 'เลือกร้าน AA10 ร้านทดสอบ' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'ส่งเพิ่ม' }));
  expect(screen.queryByRole('button', { name: 'เลือกร้าน AA10 ร้านทดสอบ' })).toBeNull();
  if (action !== 'back') {
    fireEvent.click(screen.getByRole('button', { name: 'ใส่จำนวนทดสอบ' }));
    fireEvent.click(screen.getByRole('button', { name: 'ส่งและรับชำระทดสอบ' }));
    fireEvent.click(await screen.findByRole('button', { name: 'รับเงินแล้วกลับรายการ' }));
  } else {
    fireEvent.click(screen.getByRole('button', { name: 'กลับจากรายการส่ง' }));
  }
  await screen.findByRole('button', { name: 'เลือกร้าน AA10 ร้านทดสอบ' });
  // No new intersection notification or cache read should be needed to show it.
  expect(view.container.querySelector('.employee-shop-tile img')?.getAttribute('src')).toBe('blob:shop-photo');
  expect(images.load).toHaveBeenCalledTimes(1);
  expect(images.revoke).not.toHaveBeenCalled();
  expect(view.container.querySelector('.employee-shop-tile img')).toBe(photo);
  if (finishPhotos) {
    await act(async () => finishPhotos!());
    expect(view.container.querySelector('.employee-shop-tile img')).toBe(photo);
    expect(photo.getAttribute('src')).toBe('blob:shop-photo');
    expect(images.load).toHaveBeenCalledTimes(1);
    expect(images.read).not.toHaveBeenCalled();
  }
  view.unmount();
  expect(images.revoke).toHaveBeenCalledWith('blob:shop-photo');
});

it.each(['replaced', 'removed'] as const)('does not retain the old photo when its path is %s during refresh', async (change) => {
  const api = gateway();
  const next = { ...shop, image_path: change === 'removed' ? null : 'shops/one/r2/replacement.webp', image_url: null };
  api.supportsProgressiveShopCardLoading = true;
  api.loadShopCards = vi.fn().mockResolvedValueOnce([shop]).mockImplementation(async (_round, options) => {
    options.onBaseCards([next]);
    return [next];
  });
  const view = render(<Harness api={api} />);
  const select = await screen.findByRole('button', { name: 'เลือกร้าน AA10 ร้านทดสอบ' });
  await act(async () => observers.forEach(callback => callback([{ isIntersecting: true }])));
  const photo = view.container.querySelector('.employee-shop-tile img')!;
  await waitFor(() => expect(photo.getAttribute('src')).toBe('blob:shop-photo'));
  fireEvent.click(select);
  fireEvent.click(await screen.findByRole('button', { name: 'ส่งเพิ่ม' }));
  fireEvent.click(screen.getByRole('button', { name: 'ใส่จำนวนทดสอบ' }));
  fireEvent.click(screen.getByRole('button', { name: 'ส่งและรับชำระทดสอบ' }));
  fireEvent.click(await screen.findByRole('button', { name: 'รับเงินแล้วกลับรายการ' }));
  await screen.findByRole('button', { name: 'เลือกร้าน AA10 ร้านทดสอบ' });
  expect(view.container.querySelector('.employee-shop-tile img')?.getAttribute('src')).not.toBe('blob:shop-photo');
  expect(images.revoke).toHaveBeenCalledWith('blob:shop-photo');
  if (change === 'replaced') {
    await act(async () => observers.forEach(callback => callback([{ isIntersecting: true }])));
    expect(images.read).toHaveBeenCalledWith('shop-images', next.image_path, { signal: expect.any(AbortSignal) });
  } else {
    expect(view.container.querySelector('.employee-shop-tile img')).toBeNull();
    expect(images.read).not.toHaveBeenCalled();
  }
});

vi.mock('../src/lib/r2Storage', async (original) => ({
  ...await original<typeof import('../src/lib/r2Storage')>(),
  refreshR2CatalogObjectUrl: vi.fn(async () => source),
}));

it.each([false, true])('preserves displayed bytes when only the signed URL rotates (after retry: %s)', async (retryFirst) => {
  const api = gateway();
  api.supportsProgressiveShopCardLoading = true;
  if (retryFirst) images.load.mockRejectedValueOnce(new Error('temporary failure'));
  const view = render(<Harness api={api} />);
  const select = await screen.findByRole('button', { name: 'เลือกร้าน AA10 ร้านทดสอบ' });
  if (retryFirst) {
    await act(async () => observers.forEach(callback => callback([{ isIntersecting: true }])));
    await waitFor(() => expect(view.container.querySelector('.employee-shop-tile img')?.getAttribute('src')).toBe(source));
    await act(async () => fireEvent.error(view.container.querySelector('.employee-shop-tile img')!));
  }
  await waitFor(async () => {
    await act(async () => observers.forEach(callback => callback([{ isIntersecting: true }])));
    expect(view.container.querySelector('.employee-shop-tile img')?.getAttribute('src')).toBe('blob:shop-photo');
  });
  const photo = view.container.querySelector('.employee-shop-tile img')!;
  const loadsBeforeReturn = images.load.mock.calls.length;
  const revokesBeforeReturn = images.revoke.mock.calls.length;
  vi.mocked(api.loadShopCards).mockImplementation(async (_round, options) => {
    options?.onBaseCards?.([{ ...shop, image_url: null }]);
    return [{ ...shop, image_url: source + '?X-Amz-Signature=new-signature' }];
  });
  fireEvent.click(select);
  fireEvent.click(await screen.findByRole('button', { name: 'ส่งเพิ่ม' }));
  fireEvent.click(screen.getByRole('button', { name: 'ใส่จำนวนทดสอบ' }));
  fireEvent.click(screen.getByRole('button', { name: 'ส่งและรับชำระทดสอบ' }));
  fireEvent.click(await screen.findByRole('button', { name: 'รับเงินแล้วกลับรายการ' }));
  await screen.findByRole('button', { name: 'เลือกร้าน AA10 ร้านทดสอบ' });
  expect(view.container.querySelector('.employee-shop-tile img')?.getAttribute('src')).toBe('blob:shop-photo');
  expect(view.container.querySelector('.employee-shop-tile img')).toBe(photo);
  expect(images.load).toHaveBeenCalledTimes(loadsBeforeReturn);
  expect(images.revoke).toHaveBeenCalledTimes(revokesBeforeReturn);
});

it('recovers a previously failed shop photo after navigating back', async () => {
  const api = gateway();
  images.load.mockRejectedValue(new Error('temporary network failure'));
  const view = render(<Harness api={api} />);
  const select = await screen.findByRole('button', { name: 'เลือกร้าน AA10 ร้านทดสอบ' });
  await act(async () => observers.forEach(callback => callback([{ isIntersecting: true }])));
  await waitFor(() => expect(view.container.querySelector('.employee-shop-tile img')?.getAttribute('src')).toBe(source));
  await act(async () => fireEvent.error(view.container.querySelector('.employee-shop-tile img')!));
  await act(async () => observers.forEach(callback => callback([{ isIntersecting: true }])));
  await waitFor(() => expect(view.container.querySelector('.employee-shop-tile img')?.getAttribute('src')).toBe(source));
  await act(async () => fireEvent.error(view.container.querySelector('.employee-shop-tile img')!));
  expect(view.container.querySelector('.employee-shop-tile img')).toBeNull();
  images.load.mockResolvedValue(new Blob(['pixels'], { type: 'image/webp' }));
  fireEvent.click(select);
  fireEvent.click(await screen.findByRole('button', { name: 'ส่งเพิ่ม' }));
  fireEvent.click(screen.getByRole('button', { name: 'กลับจากรายการส่ง' }));
  await screen.findByRole('button', { name: 'เลือกร้าน AA10 ร้านทดสอบ' });
  await act(async () => observers.forEach(callback => callback([{ isIntersecting: true }])));
  await waitFor(() => expect(view.container.querySelector('.employee-shop-tile img')?.getAttribute('src')).toBe('blob:shop-photo'));
});
