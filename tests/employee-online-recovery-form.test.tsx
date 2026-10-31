import { IDBFactory } from 'fake-indexeddb';
import { createEmployeeRuntime, offlineStore } from '../src/offline/runtime/client';
import { createOfflineGateway } from '../src/offline/runtime/gateway';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { EmployeeDeliveryGateway, EmployeeDeliveryPayload } from '../src/EmployeeDeliveryWorkspace';
import { useEmployeeDeliveryData } from '../src/features/employee-delivery/useEmployeeDeliveryData';
import { offlineSnapshot } from './helpers/offlineSnapshot';
import type { CollectionFocusRequest, DeliveryPosContext, ShopCard } from '../src/types/app';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => Object.assign(Promise.resolve(rpcMock(...args)), { abortSignal() { return this; } }), auth: { getSession: async () => ({ data: { session: { user: { id: 'employee-1' } } }, error: null }) } } }));

const shop: ShopCard = {
  round_stop_id: 'stop-1',
  shop_id: 'shop-1',
  shop_code: 'BB15',
  shop_name: 'ร้านทดสอบ',
  building_id: 'building-1',
  building_name: 'อาคาร B',
  floor_or_zone: '1',
  sequence_no: 15,
  image_path: null,
  image_url: null,
  payment_status: 'unpaid',
  stop_status: 'pending',
  stop_note: null,
  today_history: [],
  today_totals: {},
};

function createGateway(): EmployeeDeliveryGateway {
  return {
    loadReferenceData: vi.fn().mockResolvedValue({
      rounds: [{
        id: 'round-1',
        service_date: '2026-08-19',
        name: 'งานประจำวัน',
        status: 'open',
        opened_at: '2026-08-19T01:00:00Z',
      }],
      iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
    }),
    loadShopCards: vi.fn().mockResolvedValue([shop]),
    loadEmployeeStockState: vi.fn(),
    recordEmployeeStockTransfer: vi.fn(),
    recordEmployeeStockReturn: vi.fn(),
    recordEmployeeStockDamage: vi.fn(),
    recordDelivery: vi.fn(),
    recordImmediateSale: vi.fn(),
  };
}

function DeliveryHarness({
  canCollectShopPayments = true,
  card = shop,
  gateway,
  onOpenCollection,
  requestScope = 'employee-1',
}: {
  canCollectShopPayments?: boolean;
  card?: ShopCard;
  gateway: EmployeeDeliveryGateway;
  onOpenCollection: (request: CollectionFocusRequest) => void;
  requestScope?: string;
}) {
  const data = useEmployeeDeliveryData({
    canCollectShopPayments,
    gateway,
    onOpenCollection,
    requestScope,
    serviceDate: '2026-08-19',
  });

  if (data.loadingReference || data.loadingCards || data.cards.length === 0) return <div>กำลังโหลด</div>;
  if (!data.selectedCard) {
    return <button onClick={() => data.openCard(card)} type="button">เลือกร้าน</button>;
  }
  return (
    <div>
      {data.posContext && !data.loadingPosContext ? <span>context-ready</span> : null}
      <button onClick={() => data.setDeliveryQuantity('ice-1', 1)} type="button">ใส่จำนวน</button>
      <button onClick={() => { data.setDeliveryQuantity('ice-1', 2); data.setNote('แก้หลังคำขอแรก'); }} type="button">แก้รายการ</button>
      <button onClick={() => data.submitDeliveryChoice('end_of_day')} type="button">ส่งอย่างเดียว</button>
      <button onClick={() => data.submitDeliveryChoice('immediate')} type="button">ส่งและรับชำระ</button>
      {data.hasPendingDelivery ? <button onClick={data.retryPendingDelivery} type="button">ลองคำขอเดิมอีกครั้ง</button> : null}
      {data.entryError ? <p role="alert">{data.entryError}</p> : null}
    </div>
  );
}

const factory = new IDBFactory();
it.each(['open', 'prepared', 'reopened'] as const)('consumes the original confirmation with a %s draft after automatic recovery', async state => {
  vi.stubGlobal('indexedDB', factory);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-08-19T02:00:00Z');
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  rpcMock.mockReturnValue({ error: { message: 'Network unavailable' }, data: null });
  const live = createGateway();
  const committed = new Set<string>();
  const record = vi.fn(async (payload: EmployeeDeliveryPayload) => {
    const replay = committed.has(payload.idempotencyKey);
    committed.add(payload.idempotencyKey);
    if (!replay && committed.size === 1) throw new TypeError('Failed to fetch');
    return undefined;
  });
  live.recordDelivery = record;
  live.loadDeliveryPosContext = vi.fn(async () => ({
    round_id: 'round-1', round_stop_id: 'stop-1', service_date: '2026-08-19',
    shop: { id: 'shop-1', code: 'BB15', name: 'ร้านทดสอบ', building_name: 'B', floor_or_zone: '1', image_path: null },
    stock_source: { id: 'stock-1', code: 'STOCK', name: 'สต๊อก', kind: 'aggregate' },
    items: [{ ice_type_id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง', image_path: null,
      stock_quantity: 100, unit_price: 30, price_source: 'standard', price_source_id: 'price-1' }],
    payment_profile: { default_payment_term: 'end_of_day', allowed_payment_terms: ['end_of_day'],
      default_payment_method: 'cash', allowed_payment_methods: ['cash'], vat_enabled: false,
      credit_remaining: null, credit_exposure: 0, credit_suspended: false },
  } as DeliveryPosContext));
  const runtime = createEmployeeRuntime('employee-1', '2026-08-19', live);
  const gateway = createOfflineGateway(live, runtime);
  try {
    const form = render(<DeliveryHarness gateway={gateway} onOpenCollection={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'เลือกร้าน' }));
    fireEvent.click(screen.getByRole('button', { name: 'ใส่จำนวน' }));
    await screen.findByText('context-ready');
    fireEvent.click(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }));
    await screen.findByRole('button', { name: 'ลองคำขอเดิมอีกครั้ง' });
    await waitFor(() => expect(committed.size).toBe(1));
    await screen.findByRole('alert');
    vi.setSystemTime('2026-08-19T02:00:31Z');
    await act(async () => { await runtime.tick(); });
    expect(record).toHaveBeenCalledTimes(2);
    expect(await offlineStore().hasOnlineWrite()).toBe(false);
    if (state !== 'open') {
      const snapshot = offlineSnapshot();
      const context = await live.loadDeliveryPosContext!('stop-1');
      const stock = snapshot.stocks.round;
      stock.round_id = 'round-1'; stock.service_date = '2026-08-19';
      stock.holding_location.id = 'stock-1';
      stock.holding_location.balances[0].ice_type_id = 'ice-1';
      stock.holding_location.balances[0].quantity = 99;
      context.items[0].stock_quantity = 99;
      const reference = await live.loadReferenceData('2026-08-19');
      await runtime.engine.install({ ...snapshot, ...reference, ownerId: 'employee-1', serviceDate: '2026-08-19',
        profile: { ...snapshot.profile, id: 'employee-1' }, validUntil: '2026-08-19T17:00:00Z',
        cards: { 'round-1': [shop] }, stocks: { 'round-1': stock }, contexts: { 'stop-1': context }, aggregate: { 'ice-1': 99 } });
      if (state === 'reopened') {
        form.unmount(); await offlineStore().close();
        render(<DeliveryHarness gateway={createOfflineGateway(live, runtime)} onOpenCollection={vi.fn()} />);
        await screen.findByText('context-ready');
      }
      online.mockReturnValue(false);
    }
    fireEvent.click(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }));
    await screen.findByRole('button', { name: 'เลือกร้าน' });
    expect(record).toHaveBeenCalledTimes(2);
    expect(committed.size).toBe(1);
    expect(await offlineStore().commands('employee-1')).toEqual([]);
    if (state !== 'open') expect((await runtime.snapshot())?.contexts['stop-1'].items[0].stock_quantity).toBe(99);
    else {
      // A deliberate new delivery after the recovered draft is completed still
      // receives a fresh identity, even when its items are identical.
      fireEvent.click(screen.getByRole('button', { name: 'เลือกร้าน' }));
      await screen.findByText('context-ready');
      fireEvent.click(screen.getByRole('button', { name: 'ใส่จำนวน' }));
      fireEvent.click(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }));
      await screen.findByRole('button', { name: 'เลือกร้าน' });
      expect(committed.size).toBe(2);
      expect(record).toHaveBeenCalledTimes(3);
    }
  } finally {
    runtime.engine.dispose(); await runtime.prepare(); await offlineStore().close();
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase('ice-employee-work-v1');
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    });
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  }
});
