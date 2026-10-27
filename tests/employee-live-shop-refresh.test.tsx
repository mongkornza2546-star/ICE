import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';
import type { DeliveryPosContext, EmployeeStockState, ShopCard } from '../src/types/app';
import { LanguageProvider, LanguageSwitcher, translateUi } from '../src/i18n';
import { writeRecovery } from '../src/lib/recoveryStorage';
import { useEmployeeDeliveryData } from '../src/features/employee-delivery/useEmployeeDeliveryData';
import { publishDataChange } from '../src/lib/dataChange';

const supabaseMock = vi.hoisted(() => {
  const state: { postgresChangeListener: (() => void) | null; posSignals: AbortSignal[] } = {
    postgresChangeListener: null,
    posSignals: [],
  };
  const channel = {} as {
    on: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  channel.on = vi.fn((_event, _filter, listener: () => void) => {
    state.postgresChangeListener = listener;
    return channel;
  });
  channel.subscribe = vi.fn(() => channel);

  const getPublicUrl = vi.fn((path: string) => ({
    data: { publicUrl: `https://example.com/storage/v1/object/public/test/${path}` },
  }));

  const client = {
    rpc: vi.fn(),
    from: vi.fn(),
    storage: {
      from: vi.fn(() => ({ getPublicUrl })),
    },
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  };

  return { channel, client, getPublicUrl, state };
});

vi.mock('../src/lib/supabase', () => ({ supabase: {
  ...supabaseMock.client,
  rpc: (...args: unknown[]) => {
    const response = Promise.resolve(supabaseMock.client.rpc(...args));
    return Object.assign(response, {
      abortSignal(signal: AbortSignal) {
        supabaseMock.state.posSignals.push(signal);
        return response;
      },
    });
  },
} }));

import {
  EmployeeDeliveryWorkspace,
  createSupabaseGateway,
} from '../src/EmployeeDeliveryWorkspace';

beforeEach(() => {
  supabaseMock.state.postgresChangeListener = null;
  supabaseMock.state.posSignals = [];
  supabaseMock.client.rpc.mockReset();
  supabaseMock.client.from.mockReturnValue({ select: () => ({ eq: () => ({
    order: async () => ({ data: [], error: null }),
  }) }) });
  supabaseMock.client.storage.from.mockClear();
  supabaseMock.getPublicUrl.mockClear();
  supabaseMock.getPublicUrl.mockImplementation((path: string) => ({
    data: { publicUrl: `https://example.com/storage/v1/object/public/test/${path}` },
  }));
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const posContext: DeliveryPosContext = {
  round_id: 'round-1',
  round_stop_id: 'stop-1',
  service_date: '2026-08-11',
  shop: {
    id: 'shop-1',
    code: 'BB01',
    name: 'ร้านทดสอบ',
    building_name: 'อาคาร B',
    floor_or_zone: '1',
    image_path: null,
  },
  stock_source: { id: 'stock-1', code: 'STOCK', name: 'สต๊อก', kind: 'aggregate' },
  items: [{
    ice_type_id: 'ice-1',
    code: 'ICE',
    name: 'หลอดเล็ก',
    unit: 'ถุง',
    image_path: 'ice/small.jpg',
    stock_quantity: 10,
    unit_price: 60,
    price_source: 'standard',
    price_source_id: 'price-1',
  }],
  payment_profile: null,
};

const shopCard: ShopCard = {
  round_stop_id: 'stop-1',
  shop_id: 'shop-1',
  shop_code: 'BB01',
  shop_name: 'ร้านทดสอบ',
  building_id: 'building-1',
  building_name: 'อาคาร B',
  floor_or_zone: '1',
  sequence_no: 1,
  image_path: 'shops/bb01.jpg',
  image_url: null,
  payment_status: 'unpaid',
  stop_status: 'pending',
  stop_note: null,
  today_history: [],
  today_totals: {},
};

const newShopCard: ShopCard = {
  ...shopCard,
  round_stop_id: 'stop-2',
  shop_id: 'shop-2',
  shop_code: 'BB02',
  shop_name: 'ร้านเพิ่มใหม่',
  sequence_no: 2,
};

const stockState: EmployeeStockState = {
  round_id: 'round-1',
  service_date: '2026-08-11',
  withdrawn_balances: [],
  truck_location: {
    id: 'truck-1',
    code: 'TRUCK',
    name: 'รถหลัก',
    balances: [{ ice_type_id: 'ice-1', ice_type_name: 'น้ำแข็ง', unit: 'ถุง', quantity: 10 }],
  },
  holding_location: {
    id: 'holding-1',
    code: 'HOLDING',
    name: 'จุดถือครอง',
    balances: [{ ice_type_id: 'ice-1', ice_type_name: 'น้ำแข็ง', unit: 'ถุง', quantity: 0 }],
  },
};

const previewContext: DeliveryPosContext = {
  ...posContext,
  payment_profile: {
    allowed_payment_terms: ['end_of_day'], default_payment_term: 'end_of_day',
    allowed_payment_methods: ['cash'], default_payment_method: 'cash',
    cash_reference_required: false, cash_evidence_required: false,
    bank_transfer_reference_required: false, bank_transfer_evidence_required: false,
    qr_reference_required: false, qr_evidence_required: false, allow_outstanding: true,
    credit_due_rule: null, credit_days: null, credit_collection_weekday: null,
    credit_limit: null, credit_exposure: 0, credit_remaining: null, credit_suspended: false,
  },
};

function previewGateway(): EmployeeDeliveryGateway {
  return {
    loadReferenceData: vi.fn().mockResolvedValue({
      rounds: [{ id: 'round-1', service_date: '2026-08-11', name: 'งานประจำวัน', status: 'open', opened_at: '2026-08-11T01:00:00Z' }],
      iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'หลอดเล็ก', unit: 'ถุง' }],
    }),
    loadShopCards: vi.fn().mockResolvedValue([shopCard, newShopCard]),
    loadDeliveryPosContext: vi.fn().mockResolvedValue(previewContext),
    loadEmployeeStockState: vi.fn(), recordEmployeeStockTransfer: vi.fn(),
    recordEmployeeStockReturn: vi.fn(), recordEmployeeStockDamage: vi.fn(), recordDelivery: vi.fn(),
  };
}

it('reopens a shop with its price preview and allows drafting while fresh stock is pending', async () => {
  const gateway = previewGateway();
  const user = userEvent.setup();
  render(<EmployeeDeliveryWorkspace gateway={gateway} requestScope="preview" serviceDate="2026-08-11" />);
  await user.click(await screen.findByRole('button', { name: 'เลือกร้าน BB01 ร้านทดสอบ' }));
  await screen.findByText('คงเหลือ 10 ถุง');
  await user.click(screen.getByRole('button', { name: 'กลับไปเลือกร้าน' }));
  let finish!: (context: DeliveryPosContext) => void;
  vi.mocked(gateway.loadDeliveryPosContext!).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await user.click(await screen.findByRole('button', { name: 'เลือกร้าน BB01 ร้านทดสอบ' }));
  expect(screen.queryByText('กำลังโหลดราคา สต๊อก และเงื่อนไขชำระ…')).toBeNull();
  expect(screen.getByText('กำลังตรวจสอบข้อมูลล่าสุด กรอกจำนวนรอได้…')).toBeTruthy();
  expect(screen.queryByText('คงเหลือ 10 ถุง')).toBeNull();
  await user.click(screen.getByRole('button', { name: /หลอดเล็ก.*60.*คงเหลือ/ }));
  const quantity = screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' });
  expect(quantity.hasAttribute('disabled')).toBe(false);
  expect(quantity.hasAttribute('max')).toBe(false);
  await user.clear(quantity);
  await user.type(quantity, '12');
  await user.click(screen.getByRole('button', { name: 'เพิ่มรายการ' }));
  expect(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }).hasAttribute('disabled')).toBe(true);
  await act(async () => finish({ ...previewContext, items: [{ ...posContext.items[0], stock_quantity: 7, unit_price: 65 }] }));
  expect(screen.getByRole('button', { name: /หลอดเล็ก.*65.*12.*คงเหลือ 7/ })).toBeTruthy();
  expect(screen.getByText('จำนวนในรายการเกินสต๊อกคงเหลือ กรุณาแก้จำนวนก่อนส่ง')).toBeTruthy();
  expect(gateway.recordDelivery).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: /หลอดเล็ก.*65.*คงเหลือ 7/ }));
  await user.clear(screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' }));
  await user.type(screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' }), '6');
  await user.click(screen.getByRole('button', { name: 'เพิ่มรายการ' }));
  await user.click(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }));
  await waitFor(() => expect(gateway.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
    expectedTotal: 390, items: [{ ice_type_id: 'ice-1', quantity: 6 }],
  })));
});

it('keeps a failed preview refresh blocked, then retries with current terms and preserves the draft', async () => {
  const gateway = previewGateway();
  const { result } = renderHook(() => useEmployeeDeliveryData({ gateway, requestScope: 'preview-retry', serviceDate: '2026-08-11' }));
  await waitFor(() => expect(result.current.cards).toHaveLength(2));
  act(() => result.current.openCard(shopCard));
  await waitFor(() => expect(result.current.posContext).not.toBeNull());
  act(() => result.current.attemptBack());
  let fail!: (error: Error) => void;
  vi.mocked(gateway.loadDeliveryPosContext!).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
  act(() => result.current.openCard(shopCard));
  expect(result.current.posContext?.items[0].unit_price).toBe(60);
  expect(result.current.posContext?.client_cache?.stale).toBe(true);
  act(() => result.current.setDeliveryQuantity('ice-1', 12));
  act(() => result.current.submitDeliveryChoice('end_of_day'));
  expect(gateway.recordDelivery).not.toHaveBeenCalled();
  await act(async () => fail(new Error('offline')));
  expect(result.current.posContext?.items[0].unit_price).toBe(60);
  act(() => result.current.submitDeliveryChoice('end_of_day'));
  expect(gateway.recordDelivery).not.toHaveBeenCalled();
  await act(async () => { await result.current.refreshOpenPosContext(); });
  expect(result.current.posContext?.client_cache?.stale).not.toBe(true);
  expect(result.current.deliveryQuantities['ice-1']).toBe(12);
  act(() => result.current.submitDeliveryChoice('end_of_day'));
  expect(gateway.recordDelivery).not.toHaveBeenCalled();
  expect(result.current.entryError).toBe('จำนวนในรายการเกินสต๊อกคงเหลือ กรุณาแก้จำนวนก่อนส่ง');
});

it('clears an open preview and ignores pending results when the user scope changes', async () => {
  const gateway = previewGateway();
  const { result, rerender } = renderHook(({ scope }) => useEmployeeDeliveryData({ gateway, requestScope: scope, serviceDate: '2026-08-11' }), {
    initialProps: { scope: 'preview-owner' },
  });
  await waitFor(() => expect(result.current.cards).toHaveLength(2));
  act(() => result.current.openCard(shopCard));
  await waitFor(() => expect(result.current.posContext).not.toBeNull());
  rerender({ scope: 'next-user' });
  await waitFor(() => expect(result.current.cards).toHaveLength(2));
  let finish!: (context: DeliveryPosContext) => void;
  vi.mocked(gateway.loadDeliveryPosContext!).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  act(() => result.current.openCard(shopCard));
  expect(result.current.posContext).toBeNull();
  rerender({ scope: 'third-user' });
  await act(async () => finish(previewContext));
  expect(result.current.posContext).toBeNull();
});

it('does not use another shop or user preview or a late response after leaving a shop', async () => {
  const gateway = previewGateway();
  const { result, rerender } = renderHook(({ scope }) => useEmployeeDeliveryData({ gateway, requestScope: scope, serviceDate: '2026-08-11' }), {
    initialProps: { scope: 'preview-owner' },
  });
  await waitFor(() => expect(result.current.cards).toHaveLength(2));
  act(() => result.current.openCard(shopCard));
  await waitFor(() => expect(result.current.posContext).not.toBeNull());
  let finish!: (context: DeliveryPosContext) => void;
  vi.mocked(gateway.loadDeliveryPosContext!).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  act(() => result.current.openCard(shopCard));
  vi.mocked(gateway.loadDeliveryPosContext!).mockReturnValue(new Promise(() => {}));
  act(() => result.current.openCard(newShopCard));
  expect(result.current.posContext).toBeNull();
  await act(async () => finish(posContext));
  expect(result.current.posContext).toBeNull();
  rerender({ scope: 'different-user' });
  await waitFor(() => expect(result.current.cards).toHaveLength(2));
  act(() => result.current.openCard(shopCard));
  expect(result.current.posContext).toBeNull();
});

describe('employee live shop loading', () => {
  it.each([false, true])('invalidates pre-withdrawal POS reads without waiting for them (split: %s)', async split => {
    const pending: Array<(value: unknown) => void> = [];
    supabaseMock.client.rpc.mockImplementation((name: string) => {
      if (name === 'get_employee_active_session') return Promise.resolve({ data: { sessions: [], pos_context_parts_version: split ? 1 : undefined }, error: null });
      if (name === 'record_employee_stock_transfer') return Promise.resolve({ data: stockState, error: null });
      return new Promise(resolve => { pending.push(resolve); });
    });
    const gateway = createSupabaseGateway();
    await gateway.loadReferenceData('2026-08-11');
    const options = { destinationKind: 'regular' as const, serviceDate: '2026-08-11', forceRefresh: false };
    const oldRead = gateway.loadDeliveryPosContext!('stop-1', options).catch(error => error);
    const parts = split ? 2 : 1;
    await gateway.recordEmployeeStockTransfer({ roundId: 'round-1', items: [{ ice_type_id: 'ice-1', quantity: 5 }], idempotencyKey: 'withdrawal-1' });
    expect(supabaseMock.state.posSignals.slice(0, parts).every(signal => signal.aborted)).toBe(true);
    const reopened = gateway.loadDeliveryPosContext!('stop-1', options);
    expect(pending).toHaveLength(parts * 2);
    // A late old response must neither become usable nor remove the new flight.
    pending.slice(0, parts).forEach(resolve => resolve({ data: posContext, error: null }));
    expect(await oldRead).toBeInstanceOf(Error);
    const concurrent = gateway.loadDeliveryPosContext!('stop-1', options);
    expect(pending).toHaveLength(parts * 2);
    pending.slice(parts).forEach(resolve => resolve({ data: { ...posContext,
      items: [{ ...posContext.items[0], stock_quantity: 15 }],
    }, error: null }));
    expect((await reopened).items[0].stock_quantity).toBe(15);
    expect((await concurrent).items[0].stock_quantity).toBe(15);
    expect(supabaseMock.state.posSignals.slice(parts).every(signal => !signal.aborted)).toBe(true);
  });

  it('invalidates another shop read when a delivery reduces the shared holding', async () => {
    let finishOld!: (value: unknown) => void;
    let reads = 0;
    const context = { ...posContext, round_stop_id: 'stop-2' };
    supabaseMock.client.rpc.mockImplementation((name: string) => {
      if (name === 'record_delivery_with_vat_check') return Promise.resolve({ data: {}, error: null });
      reads += 1;
      if (reads === 1) return new Promise(resolve => { finishOld = resolve; });
      return Promise.resolve({ data: { ...context, items: [{ ...context.items[0], stock_quantity: 7 }] }, error: null });
    });
    const gateway = createSupabaseGateway();
    const options = { destinationKind: 'regular' as const, serviceDate: '2026-08-11' };
    const oldRead = gateway.loadDeliveryPosContext!('stop-2', options).catch(error => error);
    await gateway.recordDelivery({ roundStopId: 'stop-1', status: 'delivered', items: [{ ice_type_id: 'ice-1', quantity: 3 }], note: null, clientRecordedAt: '2026-08-11T01:00:00Z', idempotencyKey: 'sale-1' });
    expect((await gateway.loadDeliveryPosContext!('stop-2', options)).items[0].stock_quantity).toBe(7);
    finishOld({ data: context, error: null });
    expect(await oldRead).toBeInstanceOf(Error);
  });

  it('never reads an old stock snapshot from local storage when the server is unavailable', async () => {
    window.localStorage.setItem('ice-employee-pos-context:v1:2026-08-11:stop-1', JSON.stringify({
      cachedAt: Date.now(), context: posContext,
    }));
    supabaseMock.client.rpc.mockResolvedValue({ data: null, error: new Error('network unavailable') });
    await expect(createSupabaseGateway().loadDeliveryPosContext!('stop-1', {
      destinationKind: 'regular', serviceDate: '2026-08-11',
    })).rejects.toThrow('network unavailable');
    expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(1);
  });

  it('does not join an older holding-stock read when refreshing after a withdrawal', async () => {
    let finishOld!: (value: unknown) => void;
    supabaseMock.client.rpc
      .mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce({ data: { ...stockState, holding_location: {
        ...stockState.holding_location, balances: [{ ice_type_id: 'ice-1', ice_type_name: 'น้ำแข็ง', unit: 'ถุง', quantity: 5 }],
      } }, error: null });
    const gateway = createSupabaseGateway();
    const oldRead = gateway.loadEmployeeStockState('round-1');
    const current = await gateway.loadEmployeeStockState('round-1');
    expect(current.holding_location.balances[0].quantity).toBe(5);
    finishOld({ data: stockState, error: null });
    await oldRead;
    expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('accepts a successful eleven-second read (split: %s)', async (split) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      supabaseMock.client.rpc.mockImplementation((name: string) => name === 'get_employee_active_session'
        ? Promise.resolve({ data: { sessions: [], pos_context_parts_version: split ? 1 : undefined }, error: null })
        : new Promise(resolve => setTimeout(() => resolve({ data: posContext, error: null }), 11_000)));
      const gateway = createSupabaseGateway();
      await gateway.loadReferenceData('2026-08-11');
      const result = vi.fn();
      const options = { destinationKind: 'regular' as const, serviceDate: '2026-08-11' };
      const request = gateway.loadDeliveryPosContext!('stop-1', options).then(result, result);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(result).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await request;
      expect(result).toHaveBeenCalledWith(expect.objectContaining({ round_stop_id: 'stop-1' }));
      expect(supabaseMock.state.posSignals.every(signal => !signal.aborted)).toBe(true);
      const nextRead = gateway.loadDeliveryPosContext!('stop-1', options);
      await vi.advanceTimersByTimeAsync(11_000);
      expect((await nextRead).items[0].stock_quantity).toBe(10);
      expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(split ? 5 : 3);
    } finally { vi.useRealTimers(); }
  });

  it.each(['regular', 'event'] as const)('loads %s POS stock and sale data concurrently', async (destinationKind) => {
    let finishStock!: (value: unknown) => void;
    let finishSale!: (value: unknown) => void;
    const stockRequest = new Promise((resolve) => { finishStock = resolve; });
    const saleRequest = new Promise((resolve) => { finishSale = resolve; });
    supabaseMock.client.rpc.mockImplementation((name: string, args?: { p_part?: string }) => {
      if (name === 'get_employee_active_session') return Promise.resolve({ data: { sessions: [], pos_context_parts_version: 1 }, error: null });
      return args?.p_part === 'stock' ? stockRequest : saleRequest;
    });
    const gateway = createSupabaseGateway();
    await gateway.loadReferenceData('2026-08-11');
    const resolved = vi.fn();
    const request = gateway.loadDeliveryPosContext!('stop-1', { destinationKind, serviceDate: '2026-08-11' }).then(resolved);
    const rpc = destinationKind === 'event' ? 'get_event_delivery_pos_context_part' : 'get_delivery_pos_context_part';
    expect(supabaseMock.client.rpc).toHaveBeenCalledWith(rpc, { p_round_stop_id: 'stop-1', p_part: 'stock' });
    expect(supabaseMock.client.rpc).toHaveBeenCalledWith(rpc, { p_round_stop_id: 'stop-1', p_part: 'sale' });
    const { stock_source, items, ...sale } = posContext;
    finishSale({ data: { ...sale, items: items.map(({ stock_quantity: _, ...item }) => item) }, error: null });
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    finishStock({ data: { round_id: posContext.round_id, round_stop_id: posContext.round_stop_id,
      service_date: posContext.service_date, stock_source,
      items: items.map(({ ice_type_id, stock_quantity }) => ({ ice_type_id, stock_quantity })),
    }, error: null });
    await request;
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining(posContext));
    await gateway.loadDeliveryPosContext!('stop-1', { destinationKind, serviceDate: '2026-08-11' });
    expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(5); // startup + fresh pair per visit
  });

  it('rejects mismatched POS parts without caching an incomplete context', async () => {
    let mismatched = true;
    supabaseMock.client.rpc.mockImplementation(async (name: string, args?: { p_part?: string }) => {
      if (name === 'get_employee_active_session') return { data: { sessions: [], pos_context_parts_version: 1 }, error: null };
      return { data: { ...posContext, items: args?.p_part === 'stock' && mismatched ? [] : posContext.items }, error: null };
    });
    const gateway = createSupabaseGateway();
    await gateway.loadReferenceData('2026-08-11');
    const options = { destinationKind: 'regular' as const, serviceDate: '2026-08-11' };
    await expect(gateway.loadDeliveryPosContext!('stop-1', options)).rejects.toThrow('ข้อมูลร้านเปลี่ยนระหว่างโหลด');
    mismatched = false;
    await expect(gateway.loadDeliveryPosContext!('stop-1', options)).resolves.toMatchObject(posContext);
    expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(5);
  });

  it.each([false, true])('rejects the read instead of reusing saved stock if one POS part fails (other stalled: %s)', async (stallSale) => {
    let failStock = false;
    supabaseMock.client.rpc.mockImplementation(async (name: string, args?: { p_part?: string }) => {
      if (name === 'get_employee_active_session') return { data: { sessions: [], pos_context_parts_version: 1 }, error: null };
      if (failStock && args?.p_part === 'stock') return { data: null, error: new Error('network unavailable') };
      if (failStock && stallSale) return new Promise(() => {});
      return { data: { ...posContext, items: [{ ...posContext.items[0], unit_price: failStock ? 100 : 60 }] }, error: null };
    });
    const gateway = createSupabaseGateway();
    await gateway.loadReferenceData('2026-08-11');
    const options = { destinationKind: 'regular' as const, serviceDate: '2026-08-11' };
    await gateway.loadDeliveryPosContext!('stop-1', options);
    failStock = true;
    await expect(gateway.loadDeliveryPosContext!('stop-1', { ...options, forceRefresh: true })).rejects.toThrow('network unavailable');
    expect(supabaseMock.state.posSignals).toHaveLength(4);
    expect(supabaseMock.state.posSignals.slice(2).every(signal => signal.aborted)).toBe(true);
  });

  it('times out an incomplete split pair and retries both parts without accepting a late response', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let finishStock!: (value: unknown) => void;
      const slowStock = new Promise((resolve) => { finishStock = resolve; });
      let firstStock = true;
      supabaseMock.client.rpc.mockImplementation(async (name: string, args?: { p_part?: string }) => {
        if (name === 'get_employee_active_session') return { data: { sessions: [], pos_context_parts_version: 1 }, error: null };
        if (args?.p_part === 'stock' && firstStock) { firstStock = false; return slowStock; }
        return { data: { ...posContext, items: [{ ...posContext.items[0], stock_quantity: 79 }] }, error: null };
      });
      const gateway = createSupabaseGateway();
      await gateway.loadReferenceData('2026-08-11');
      const options = { destinationKind: 'regular' as const, serviceDate: '2026-08-11' };
      const result = vi.fn();
      void gateway.loadDeliveryPosContext!('stop-1', options).then(result, result);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(result).toHaveBeenCalledWith(expect.any(Error));
      expect(supabaseMock.state.posSignals).toHaveLength(2);
      expect(supabaseMock.state.posSignals.every(signal => signal.aborted)).toBe(true);
      expect((await gateway.loadDeliveryPosContext!('stop-1', options)).items[0].stock_quantity).toBe(79);
      finishStock({ data: posContext, error: null });
      await vi.advanceTimersByTimeAsync(0);
      expect((await gateway.loadDeliveryPosContext!('stop-1', options)).items[0].stock_quantity).toBe(79);
      expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(7);
    } finally { vi.useRealTimers(); }
  });

  it('retries a failed initial shop load in place and preserves the delivery draft', async () => {
    let finishRetry!: (value: DeliveryPosContext) => void;
    const profile = {
      allowed_payment_terms: ['credit'] as const,
      default_payment_term: 'credit' as const,
      allowed_payment_methods: ['bank_transfer'] as const,
      default_payment_method: 'bank_transfer' as const,
      cash_reference_required: false, cash_evidence_required: false,
      bank_transfer_reference_required: false, bank_transfer_evidence_required: false,
      qr_reference_required: false, qr_evidence_required: false, allow_outstanding: true,
      credit_due_rule: null, credit_days: null, credit_collection_weekday: null,
      credit_limit: null, credit_exposure: 0, credit_remaining: null, credit_suspended: false,
    };
    const context: DeliveryPosContext = { ...posContext, payment_profile: {
      ...profile, allowed_payment_terms: [...profile.allowed_payment_terms],
      allowed_payment_methods: [...profile.allowed_payment_methods],
    } };
    const gateway: EmployeeDeliveryGateway = {
      loadReferenceData: vi.fn().mockResolvedValue({
        rounds: [{ id: 'round-1', service_date: '2026-08-11', name: 'งานประจำวัน', status: 'open', opened_at: '2026-08-11T01:00:00Z' }],
        iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'หลอดเล็ก', unit: 'ถุง' }],
      }),
      loadShopCards: vi.fn().mockResolvedValue([shopCard]),
      loadDeliveryPosContext: vi.fn().mockRejectedValueOnce(new Error('network unavailable'))
        .mockReturnValueOnce(new Promise<DeliveryPosContext>((resolve) => { finishRetry = resolve; })),
      loadEmployeeStockState: vi.fn(), recordEmployeeStockTransfer: vi.fn(),
      recordEmployeeStockReturn: vi.fn(), recordEmployeeStockDamage: vi.fn(), recordDelivery: vi.fn(),
    };
    const { result } = renderHook(() => useEmployeeDeliveryData({ gateway, requestScope: 'slow-pos', serviceDate: '2026-08-11' }));
    await waitFor(() => expect(result.current.cards).toHaveLength(1));
    act(() => result.current.openCard(shopCard));
    await waitFor(() => expect(result.current.posContextError).toBeTruthy());
    act(() => {
      result.current.setDeliveryQuantity('ice-1', 2);
      result.current.setNote('หน้าร้าน');
      void result.current.refreshOpenPosContext();
    });
    expect(result.current.loadingPosContext).toBe(true);
    await act(async () => { finishRetry(context); });
    expect(result.current.posContextError).toBeNull();
    expect(result.current.loadingPosContext).toBe(false);
    expect(result.current.deliveryQuantities['ice-1']).toBe(2);
    expect(result.current.note).toBe('หน้าร้าน');
    expect(result.current.paymentTerm).toBe('credit');
    expect(result.current.paymentMethod).toBe('bank_transfer');
    expect(gateway.recordDelivery).not.toHaveBeenCalled();
    let failRefresh!: (error: Error) => void;
    vi.mocked(gateway.loadDeliveryPosContext!).mockReturnValueOnce(new Promise((_, reject) => { failRefresh = reject; }));
    act(() => { void result.current.refreshOpenPosContext(); });
    act(() => result.current.submitDeliveryChoice('credit'));
    expect(gateway.recordDelivery).not.toHaveBeenCalled();
    await act(async () => { failRefresh(new Error('network unavailable')); });
    expect(result.current.posContextError).toBeTruthy();
    act(() => result.current.submitDeliveryChoice('credit'));
    expect(gateway.recordDelivery).not.toHaveBeenCalled();
    expect(result.current.entryError).toBe('ต้องตรวจสอบสต๊อกล่าสุดก่อนส่ง กรุณาลองโหลดข้อมูลอีกครั้ง');
  });

  it('stops waiting for a stalled first POS read and allows a fresh retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      supabaseMock.client.rpc
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValueOnce({ data: posContext, error: null });
      const gateway = createSupabaseGateway();
      const options = { destinationKind: 'regular' as const, serviceDate: '2026-08-11', forceRefresh: true };
      const result = vi.fn();
      void gateway.loadDeliveryPosContext!('stop-1', options).then(result, result);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(result).toHaveBeenCalledWith(expect.objectContaining({
        message: 'โหลดราคา สต๊อก และเงื่อนไขชำระนานเกินไป กรุณาลองใหม่',
      }));
      expect(supabaseMock.state.posSignals).toHaveLength(1);
      expect(supabaseMock.state.posSignals[0].aborted).toBe(true);
      await expect(gateway.loadDeliveryPosContext!('stop-1', options)).resolves.toMatchObject({ round_stop_id: 'stop-1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a stalled stock refresh despite an earlier successful read and ignores its late response', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let finishSlowRead!: (value: { data: DeliveryPosContext; error: null }) => void;
      supabaseMock.client.rpc
        .mockResolvedValueOnce({ data: posContext, error: null })
        .mockReturnValueOnce(new Promise((resolve) => { finishSlowRead = resolve; }))
        .mockResolvedValue({ data: { ...posContext, items: [{ ...posContext.items[0], stock_quantity: 79 }] }, error: null });
      const gateway = createSupabaseGateway();
      const options = { destinationKind: 'regular' as const, serviceDate: '2026-08-11' };
      await gateway.loadDeliveryPosContext!('stop-1', options);
      const result = vi.fn();
      void gateway.loadDeliveryPosContext!('stop-1', { ...options, forceRefresh: true }).then(result, result);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(result).toHaveBeenCalledWith(expect.any(Error));

      await gateway.loadDeliveryPosContext!('stop-1', { ...options, forceRefresh: true });
      finishSlowRead({ data: posContext, error: null });
      await vi.advanceTimersByTimeAsync(0);
      expect((await gateway.loadDeliveryPosContext!('stop-1', options)).items[0].stock_quantity).toBe(79);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the stock shown in an open admin shop after factory stock changes', async () => {
    let available = 5;
    const loadDeliveryPosContext = vi.fn(async () => ({
      ...posContext,
      items: [{ ...posContext.items[0], stock_quantity: available }],
    }));
    const gateway = {
      loadReferenceData: vi.fn().mockResolvedValue({
        rounds: [{
          id: 'round-1', service_date: '2026-08-11', name: 'งานประจำวัน',
          round_type: 'daily', status: 'open', opened_at: '2026-08-11T01:00:00Z',
        }],
        iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'หลอดเล็ก', unit: 'ถุง' }],
      }),
      loadShopCards: vi.fn().mockResolvedValue([shopCard]),
      loadEmployeeStockState: vi.fn(),
      loadDeliveryPosContext,
      invalidateDeliveryPosContextCache: vi.fn(),
      recordDelivery: vi.fn(),
    } as unknown as EmployeeDeliveryGateway;

    render(<EmployeeDeliveryWorkspace
      gateway={gateway}
      requestScope="admin-live-stock"
      serviceDate="2026-08-11"
    />);
    await userEvent.setup().click(await screen.findByRole('button', { name: /^เลือกร้าน / }));
    await screen.findByText('คงเหลือ 5 ถุง');
    expect(loadDeliveryPosContext).toHaveBeenNthCalledWith(1, 'stop-1', {
      destinationKind: 'regular', serviceDate: '2026-08-11', forceRefresh: true,
    });

    available = 79;
    act(() => publishDataChange(['stock']));

    await waitFor(() => expect(screen.getByText('คงเหลือ 79 ถุง')).toBeTruthy());
    expect(loadDeliveryPosContext).toHaveBeenCalledTimes(2);
    expect(loadDeliveryPosContext).toHaveBeenLastCalledWith('stop-1', {
      destinationKind: 'regular', serviceDate: '2026-08-11', forceRefresh: true,
    });
  });

  it('starts a new stock read after an older in-flight read completes', async () => {
    let finishOldRead!: (value: { data: DeliveryPosContext; error: null }) => void;
    const oldRead = new Promise<{ data: DeliveryPosContext; error: null }>((resolve) => {
      finishOldRead = resolve;
    });
    supabaseMock.client.rpc
      .mockReturnValueOnce(oldRead)
      .mockResolvedValueOnce({
        data: { ...posContext, items: [{ ...posContext.items[0], stock_quantity: 79 }] },
        error: null,
      });
    const gateway = createSupabaseGateway();
    const options = { destinationKind: 'regular' as const, serviceDate: '2026-08-11' };

    const oldContext = gateway.loadDeliveryPosContext!('stop-1', options);
    const freshContext = gateway.loadDeliveryPosContext!('stop-1', { ...options, forceRefresh: true });
    expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(1);

    finishOldRead({ data: posContext, error: null });
    await oldContext;
    expect((await freshContext).items[0].stock_quantity).toBe(79);
    expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(2);
  });

  it('requires the loose-transaction capability before enabling casual customers', async () => {
    supabaseMock.client.rpc
      .mockResolvedValueOnce({
        data: { enabled: true, version: 1, fulfillment_modes: ['measured'] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { enabled: true, version: 2, fulfillment_modes: ['measured', 'loose'] },
        error: null,
      });
    const gateway = createSupabaseGateway();

    await expect(gateway.loadCasualTransactionCapability!()).resolves.toBe(false);
    await expect(gateway.loadCasualTransactionCapability!()).resolves.toBe(true);
  });

  it('uses destination sync on schema version 3 before reading shop cards', async () => {
    supabaseMock.client.rpc
      .mockResolvedValueOnce({ data: { schema_version: 3 }, error: null })
      .mockResolvedValueOnce({ data: 1, error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    await expect(createSupabaseGateway().loadShopCards('round-1')).resolves.toEqual([]);

    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(
      1,
      'get_event_delivery_capability',
    );
    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(
      2,
      'sync_daily_round_destinations',
      { p_round_id: 'round-1' },
    );
    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(
      3,
      'get_round_shop_cards',
      { p_round_id: 'round-1', p_building_id: null },
    );
  });

  it('loads event destinations and maps the booth without a shop image', async () => {
    supabaseMock.client.rpc
      .mockResolvedValueOnce({
        data: {
          schema_version: 4,
          event_reads_enabled: true,
          event_stops_enabled: true,
          event_ice_delivery_enabled: true,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: 1, error: null })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({
        data: {
          cards: [{
            event_participation_id: 'participation-1',
            event_job_id: 'event-1',
            round_stop_id: 'event-stop-1',
            event_name: 'งานอาหารเย็น',
            location: 'ฮอลล์ A',
            shop_id: 'shop-1',
            shop_code: 'BB01',
            shop_name: 'ร้านทดสอบ',
            booth_number: 'B-17',
            event_zone: 'อาหาร',
            landmark: 'ข้างเวที',
            contact_name: 'สมชาย',
            contact_phone: '0800000000',
            is_operational: true,
            stop_status: 'issue',
            stop_note: 'เข้าถึงบูธไม่ได้',
            today_history: [{
              delivery_event_id: 'delivery-issue-1',
              can_cancel: true,
              recorded_at: '2026-08-11T01:00:00Z',
              stop_status: 'no_access',
              note: 'เข้าบูธไม่ได้',
              items: [],
            }],
            today_totals: [],
          }],
        },
        error: null,
      });

    const cards = await createSupabaseGateway().loadShopCards('round-1');

    expect(cards).toMatchObject([{
      destination_kind: 'event',
      round_stop_id: 'event-stop-1',
      booth_number: 'B-17',
      event_name: 'งานอาหารเย็น',
      image_path: null,
      image_url: null,
      stop_status: 'issue',
      stop_note: 'เข้าถึงบูธไม่ได้',
      event_delivery_enabled: false,
      today_history: [{
        event_id: 'delivery-issue-1',
        can_cancel: true,
        stop_status: 'no_access',
        note: 'เข้าบูธไม่ได้',
        items: {},
      }],
    }]);
    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(
      4,
      'get_event_delivery_cards',
      { p_round_id: 'round-1', p_event_job_id: null, p_search: null },
    );
    expect(supabaseMock.getPublicUrl).not.toHaveBeenCalled();
  });

  it('uses schema-v7 per-card eligibility and routes POS reads and writes to event RPCs', async () => {
    const eventContext = {
      ...posContext,
      round_stop_id: 'event-stop-1',
      payment_profile: {
        allowed_payment_terms: ['end_of_day'],
        default_payment_term: 'end_of_day',
      },
    } as DeliveryPosContext;
    const deliveryResult = {
      delivery_event_id: 'delivery-1',
      round_stop_id: 'event-stop-1',
      charge_id: 'charge-1',
      service_date: '2026-08-11',
      total_amount: 60,
      payment_term: 'end_of_day',
      payment_status: 'unpaid',
      due_date: null,
      approval_id: null,
    };
    supabaseMock.client.rpc
      .mockResolvedValueOnce({
        data: {
          schema_version: 7,
          event_reads_enabled: true,
          event_stops_enabled: true,
          event_ice_delivery_enabled: true,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: 1, error: null })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({
        data: {
          cards: [{
            event_participation_id: 'participation-1',
            event_job_id: 'event-1',
            round_stop_id: 'event-stop-1',
            event_name: 'งานอาหารเย็น',
            location: 'ฮอลล์ A',
            shop_id: 'shop-1',
            shop_code: 'BB01',
            shop_name: 'ร้านทดสอบ',
            booth_number: 'B-17',
            event_zone: 'อาหาร',
            landmark: null,
            contact_name: null,
            contact_phone: null,
            is_operational: true,
            event_delivery_enabled: true,
            stop_status: 'pending',
            stop_note: null,
            today_history: [],
            today_totals: [],
          }],
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: eventContext, error: null })
      .mockResolvedValueOnce({ data: deliveryResult, error: null });

    const gateway = createSupabaseGateway();
    const cards = await gateway.loadShopCards('round-1');
    await gateway.loadDeliveryPosContext!('event-stop-1', {
      destinationKind: 'event',
      serviceDate: '2026-08-11',
    });
    await gateway.recordDelivery({
      destinationKind: 'event',
      roundStopId: 'event-stop-1',
      items: [{ ice_type_id: 'ice-1', quantity: 1 }],
      status: 'delivered',
      note: null,
      clientRecordedAt: '2026-08-11T01:00:00Z',
      idempotencyKey: 'request-1',
      paymentTerm: 'end_of_day',
    });

    expect(cards[0].event_delivery_enabled).toBe(true);
    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(
      5,
      'get_event_delivery_pos_context',
      { p_round_stop_id: 'event-stop-1' },
    );
    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(
      6,
      'record_event_ice_delivery',
      {
        p_round_stop_id: 'event-stop-1',
        p_items: [{ ice_type_id: 'ice-1', quantity: 1 }],
        p_stop_status: 'delivered',
        p_note: null,
        p_client_recorded_at: '2026-08-11T01:00:00Z',
        p_idempotency_key: 'request-1',
      },
    );
  });

  it('routes event POS reads and writes explicitly without loading cards first', async () => {
    supabaseMock.client.rpc
      .mockResolvedValueOnce({ data: posContext, error: null })
      .mockResolvedValueOnce({ data: { delivery_event_id: 'delivery-1' }, error: null });
    const gateway = createSupabaseGateway();

    await gateway.loadDeliveryPosContext!('event-stop-1', {
      destinationKind: 'event',
      serviceDate: '2026-08-11',
    });
    await gateway.recordDelivery({
      destinationKind: 'event',
      roundStopId: 'event-stop-1',
      items: [],
      status: 'no_access',
      note: 'เข้าบูธไม่ได้',
      clientRecordedAt: '2026-08-11T01:00:00Z',
      idempotencyKey: 'request-1',
      paymentTerm: null,
    });

    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(
      1,
      'get_event_delivery_pos_context',
      { p_round_stop_id: 'event-stop-1' },
    );
    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(
      2,
      'record_event_ice_delivery',
      {
        p_round_stop_id: 'event-stop-1',
        p_items: [],
        p_stop_status: 'no_access',
        p_note: 'เข้าบูธไม่ได้',
        p_client_recorded_at: '2026-08-11T01:00:00Z',
        p_idempotency_key: 'request-1',
      },
    );
  });

  it('keeps regular cards usable when the event read fails', async () => {
    const eventReadError = new Error('event cards unavailable');
    supabaseMock.client.rpc
      .mockResolvedValueOnce({
        data: { schema_version: 4, event_reads_enabled: true, event_stops_enabled: true },
        error: null,
      })
      .mockResolvedValueOnce({ data: 1, error: null })
      .mockResolvedValueOnce({ data: [shopCard], error: null })
      .mockResolvedValueOnce({ data: null, error: eventReadError });

    const gateway = createSupabaseGateway();
    const cards = await gateway.loadShopCards('round-1');

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ destination_kind: 'regular', shop_id: 'shop-1' });
    expect(gateway.getEventCardsLoadError?.('round-1')).toBe('event cards unavailable');
  });

  it('refreshes event capability during a forced catalog refresh', async () => {
    supabaseMock.client.rpc
      .mockResolvedValueOnce({ data: { schema_version: 3, event_reads_enabled: true, event_stops_enabled: false }, error: null })
      .mockResolvedValueOnce({ data: 1, error: null })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: { schema_version: 4, event_reads_enabled: true, event_stops_enabled: true }, error: null })
      .mockResolvedValueOnce({ data: 1, error: null })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: { cards: [] }, error: null });

    const gateway = createSupabaseGateway();
    await gateway.loadShopCards('round-1');
    await gateway.loadShopCards('round-1', { forceRefresh: true });

    expect(supabaseMock.client.rpc.mock.calls.filter(([name]) => name === 'get_event_delivery_capability')).toHaveLength(2);
    expect(supabaseMock.client.rpc).toHaveBeenLastCalledWith(
      'get_event_delivery_cards',
      { p_round_id: 'round-1', p_event_job_id: null, p_search: null },
    );
  });

  it('refreshes event capability after the capability cache expires', async () => {
    let now = new Date('2026-08-11T01:00:00Z').getTime();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    supabaseMock.client.rpc
      .mockResolvedValueOnce({ data: { schema_version: 3 }, error: null })
      .mockResolvedValueOnce({ data: 1, error: null })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: { schema_version: 3 }, error: null })
      .mockResolvedValueOnce({ data: 1, error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    const gateway = createSupabaseGateway();
    await gateway.loadShopCards('round-1');
    now += 60 * 1000 + 1;
    await gateway.loadShopCards('round-2');

    expect(supabaseMock.client.rpc.mock.calls.filter(([name]) => name === 'get_event_delivery_capability')).toHaveLength(2);
    nowSpy.mockRestore();
  });

  it('falls back to legacy sync on schema version 2', async () => {
    supabaseMock.client.rpc
      .mockResolvedValueOnce({ data: { schema_version: 2 }, error: null })
      .mockResolvedValueOnce({ data: 1, error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    await expect(createSupabaseGateway().loadShopCards('round-1')).resolves.toEqual([]);

    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(
      2,
      'sync_daily_round_active_shops',
      { p_round_id: 'round-1' },
    );
    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(
      3,
      'get_round_shop_cards',
      { p_round_id: 'round-1', p_building_id: null },
    );
  });

  it('retries destination capability after a transient capability error', async () => {
    const capabilityError = new Error('capability unavailable');
    supabaseMock.client.rpc
      .mockResolvedValueOnce({ data: null, error: capabilityError })
      .mockResolvedValueOnce({ data: 1, error: null })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: { schema_version: 3 }, error: null })
      .mockResolvedValueOnce({ data: 1, error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    const gateway = createSupabaseGateway();
    await expect(gateway.loadShopCards('round-1')).resolves.toEqual([]);
    await expect(gateway.loadShopCards('round-2')).resolves.toEqual([]);

    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(
      2,
      'sync_daily_round_active_shops',
      { p_round_id: 'round-1' },
    );
    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(
      4,
      'get_event_delivery_capability',
    );
    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(
      5,
      'sync_daily_round_destinations',
      { p_round_id: 'round-2' },
    );
  });

  it('does not read stale cards when synchronization fails', async () => {
    const syncError = new Error('sync failed');
    supabaseMock.client.rpc
      .mockResolvedValueOnce({ data: { schema_version: 3 }, error: null })
      .mockResolvedValueOnce({ data: null, error: syncError });

    await expect(createSupabaseGateway().loadShopCards('round-1')).rejects.toBe(syncError);
    expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent POS reads but fetches live stock again on the next visit', async () => {
    supabaseMock.client.rpc.mockResolvedValue({ data: posContext, error: null });
    const gateway = createSupabaseGateway();

    const [first, concurrent] = await Promise.all([
      gateway.loadDeliveryPosContext!('stop-1', { destinationKind: 'regular', serviceDate: '2026-08-11' }),
      gateway.loadDeliveryPosContext!('stop-1', { destinationKind: 'regular', serviceDate: '2026-08-11' }),
    ]);
    supabaseMock.client.rpc.mockResolvedValue({ data: {
      ...posContext, items: [{ ...posContext.items[0], stock_quantity: 7 }],
    }, error: null });
    const refreshed = await gateway.loadDeliveryPosContext!('stop-1', {
      destinationKind: 'regular',
      serviceDate: '2026-08-11',
    });

    expect(first.round_stop_id).toBe('stop-1');
    expect(concurrent.round_stop_id).toBe('stop-1');
    expect(refreshed.items[0].stock_quantity).toBe(7);
    expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(2);
    expect(supabaseMock.client.storage.from).not.toHaveBeenCalled();
  });

  it('rejects a failed stock read even when the same shop was loaded successfully earlier', async () => {
    let now = new Date('2026-08-11T01:00:00Z').getTime();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    supabaseMock.client.rpc
      .mockResolvedValueOnce({ data: posContext, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error('network unavailable') });
    const gateway = createSupabaseGateway();

    await gateway.loadDeliveryPosContext!('stop-1', { destinationKind: 'regular', serviceDate: '2026-08-11' });
    now += 6 * 60 * 1000;
    await expect(gateway.loadDeliveryPosContext!('stop-1', {
      destinationKind: 'regular',
      serviceDate: '2026-08-11',
    })).rejects.toThrow('network unavailable');
    expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('keeps public shop image URLs stable across card refreshes', async () => {
    let now = new Date('2026-08-11T01:00:00Z').getTime();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    supabaseMock.client.rpc.mockImplementation(async (name: string) => name === 'get_round_shop_cards'
      ? { data: [shopCard], error: null }
      : { data: 1, error: null });
    const gateway = createSupabaseGateway();

    const first = await gateway.loadShopCards('round-image-cache');
    now += 6 * 1000;
    const refreshed = await gateway.loadShopCards('round-image-cache');

    expect(first[0].image_url).toBe('https://example.com/storage/v1/object/public/test/shops/bb01.jpg');
    expect(refreshed[0].image_url).toBe(first[0].image_url);
    expect(supabaseMock.getPublicUrl).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('bypasses the shop-card burst cache for a catalog change refresh', async () => {
    let catalogChanged = false;
    supabaseMock.client.rpc.mockImplementation(async (name: string) => name === 'get_round_shop_cards'
      ? { data: catalogChanged ? [shopCard, newShopCard] : [shopCard], error: null }
      : { data: 1, error: null });
    const gateway = createSupabaseGateway();

    await gateway.loadShopCards('round-catalog-refresh');
    catalogChanged = true;
    const refreshed = await gateway.loadShopCards('round-catalog-refresh', { forceRefresh: true });

    expect(refreshed.map((card) => card.shop_id)).toEqual(['shop-1', 'shop-2']);
    expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(6);
  });

  it('keeps shop business data usable when public image URL resolution fails', async () => {
    supabaseMock.client.rpc.mockImplementation(async (name: string) => name === 'get_round_shop_cards'
      ? { data: [{ ...shopCard, image_path: 'shops/signing-failure.jpg' }], error: null }
      : { data: 1, error: null });
    supabaseMock.getPublicUrl.mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });

    const cards = await createSupabaseGateway().loadShopCards('round-signing-failure');

    expect(cards[0].shop_name).toBe('ร้านทดสอบ');
    expect(cards[0].image_url).toBeNull();
  });

  it('reloads immediately after a shop change but throttles browser focus refreshes', async () => {
    let now = new Date('2026-08-11T01:00:00Z').getTime();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const loadShopCards = vi.fn().mockResolvedValue([]);
    const gateway = {
      loadReferenceData: vi.fn().mockResolvedValue({
        rounds: [{
          id: 'round-1',
          service_date: '2026-08-11',
          name: 'งานประจำวัน',
          round_type: 'daily',
          status: 'open',
          opened_at: '2026-08-11T01:00:00Z',
        }],
        iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
      }),
      loadShopCards,
      loadEmployeeStockState: vi.fn(),
      recordEmployeeStockTransfer: vi.fn(),
      recordEmployeeStockReturn: vi.fn(),
      recordEmployeeStockDamage: vi.fn(),
      recordDelivery: vi.fn(),
    } as unknown as EmployeeDeliveryGateway;

    render(<EmployeeDeliveryWorkspace
      gateway={gateway}
      requestScope="employee-1"
      serviceDate="2026-08-11"
    />);

    await waitFor(() => expect(loadShopCards).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(supabaseMock.state.postgresChangeListener).toBeTypeOf('function'));

    act(() => supabaseMock.state.postgresChangeListener?.());
    await waitFor(() => expect(loadShopCards).toHaveBeenCalledTimes(2));
    expect(loadShopCards).toHaveBeenNthCalledWith(2, 'round-1', { forceRefresh: true });

    fireEvent.focus(window);
    expect(loadShopCards).toHaveBeenCalledTimes(2);

    now += 5 * 60 * 1000;
    fireEvent.focus(window);
    await waitFor(() => expect(loadShopCards).toHaveBeenCalledTimes(3));
    nowSpy.mockRestore();
  });

  it('orders shops by delivery sequence and updates the order after a catalog refresh', async () => {
    let catalogCards = [{ ...shopCard, sequence_no: 2 }, { ...newShopCard, sequence_no: 1 }];
    const loadShopCards = vi.fn().mockImplementation(async () => catalogCards);
    const gateway = {
      loadReferenceData: vi.fn().mockResolvedValue({
        rounds: [{
          id: 'round-1',
          service_date: '2026-08-11',
          name: 'งานประจำวัน',
          round_type: 'daily',
          status: 'open',
          opened_at: '2026-08-11T01:00:00Z',
        }],
        iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
      }),
      loadShopCards,
      loadEmployeeStockState: vi.fn(),
      recordEmployeeStockTransfer: vi.fn(),
      recordEmployeeStockReturn: vi.fn(),
      recordEmployeeStockDamage: vi.fn(),
      recordDelivery: vi.fn(),
    } as unknown as EmployeeDeliveryGateway;
    const view = render(<EmployeeDeliveryWorkspace
      gateway={gateway}
      requestScope="employee-reactivation"
      serviceDate="2026-08-11"
    />);

    await screen.findByText(shopCard.shop_name);
    expect(screen.getAllByRole('button', { name: /^เลือกร้าน / }).map((button) => button.textContent)).toEqual([expect.stringContaining(newShopCard.shop_name), expect.stringContaining(shopCard.shop_name)]);
    view.rerender(<EmployeeDeliveryWorkspace
      gateway={gateway}
      isActive={false}
      requestScope="employee-reactivation"
      serviceDate="2026-08-11"
    />);
    catalogCards = [shopCard, newShopCard];
    view.rerender(<EmployeeDeliveryWorkspace
      gateway={gateway}
      isActive
      requestScope="employee-reactivation"
      serviceDate="2026-08-11"
    />);

    await waitFor(() => expect(screen.getAllByRole('button', { name: /^เลือกร้าน / }).map((button) => button.textContent)).toEqual([expect.stringContaining(shopCard.shop_name), expect.stringContaining(newShopCard.shop_name)]));
    expect(loadShopCards).toHaveBeenNthCalledWith(2, 'round-1', { forceRefresh: true });
  });

  it('reconciles the shop catalog when an inactive workspace becomes active again', async () => {
    let catalogCards = [shopCard];
    const loadShopCards = vi.fn().mockImplementation(async () => catalogCards);
    const gateway = {
      loadReferenceData: vi.fn().mockResolvedValue({
        rounds: [{
          id: 'round-1',
          service_date: '2026-08-11',
          name: 'งานประจำวัน',
          round_type: 'daily',
          status: 'open',
          opened_at: '2026-08-11T01:00:00Z',
        }],
        iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
      }),
      loadShopCards,
      loadEmployeeStockState: vi.fn(),
      recordEmployeeStockTransfer: vi.fn(),
      recordEmployeeStockReturn: vi.fn(),
      recordEmployeeStockDamage: vi.fn(),
      recordDelivery: vi.fn(),
    } as unknown as EmployeeDeliveryGateway;
    const view = render(<EmployeeDeliveryWorkspace
      gateway={gateway}
      requestScope="employee-reactivation"
      serviceDate="2026-08-11"
    />);

    await screen.findByText(shopCard.shop_name);
    view.rerender(<EmployeeDeliveryWorkspace
      gateway={gateway}
      isActive={false}
      requestScope="employee-reactivation"
      serviceDate="2026-08-11"
    />);
    catalogCards = [shopCard, newShopCard];
    view.rerender(<EmployeeDeliveryWorkspace
      gateway={gateway}
      isActive
      requestScope="employee-reactivation"
      serviceDate="2026-08-11"
    />);

    await screen.findByText(newShopCard.shop_name);
    expect(loadShopCards).toHaveBeenNthCalledWith(2, 'round-1', { forceRefresh: true });
  });

  it('keeps the existing shop list visible while revalidating after reactivation', async () => {
    let resolveRefresh!: (cards: ShopCard[]) => void;
    const refresh = new Promise<ShopCard[]>((resolve) => {
      resolveRefresh = resolve;
    });
    const loadShopCards = vi.fn()
      .mockResolvedValueOnce([shopCard])
      .mockReturnValueOnce(refresh);
    const gateway = {
      loadReferenceData: vi.fn().mockResolvedValue({
        rounds: [{
          id: 'round-1',
          service_date: '2026-08-11',
          name: 'งานประจำวัน',
          round_type: 'daily',
          status: 'open',
          opened_at: '2026-08-11T01:00:00Z',
        }],
        iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
      }),
      loadShopCards,
      loadEmployeeStockState: vi.fn(),
      recordEmployeeStockTransfer: vi.fn(),
      recordEmployeeStockReturn: vi.fn(),
      recordEmployeeStockDamage: vi.fn(),
      recordDelivery: vi.fn(),
    } as unknown as EmployeeDeliveryGateway;
    const view = render(<EmployeeDeliveryWorkspace
      gateway={gateway}
      requestScope="employee-reactivation-stale-while-refresh"
      serviceDate="2026-08-11"
    />);

    await screen.findByText(shopCard.shop_name);
    view.rerender(<EmployeeDeliveryWorkspace
      gateway={gateway}
      isActive={false}
      requestScope="employee-reactivation-stale-while-refresh"
      serviceDate="2026-08-11"
    />);
    view.rerender(<EmployeeDeliveryWorkspace
      gateway={gateway}
      isActive
      requestScope="employee-reactivation-stale-while-refresh"
      serviceDate="2026-08-11"
    />);

    await waitFor(() => expect(loadShopCards).toHaveBeenCalledTimes(2));
    expect(screen.getByText(shopCard.shop_name)).toBeTruthy();
    expect(screen.queryByText('กำลังโหลดร้าน')).toBeNull();

    await act(async () => resolveRefresh([shopCard, newShopCard]));
    await screen.findByText(newShopCard.shop_name);
  });

  it('restores the last shop list immediately after the workspace is remounted', async () => {
    const referenceData = {
      rounds: [{
        id: 'round-1',
        service_date: '2026-08-11',
        name: 'งานประจำวัน',
        round_type: 'daily' as const,
        status: 'open' as const,
        opened_at: '2026-08-11T01:00:00Z',
      }],
      iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
    };
    const createGateway = (loadReferenceData: EmployeeDeliveryGateway['loadReferenceData'], loadShopCards: EmployeeDeliveryGateway['loadShopCards']) => ({
      loadReferenceData,
      loadShopCards,
      loadEmployeeStockState: vi.fn(),
      recordEmployeeStockTransfer: vi.fn(),
      recordEmployeeStockReturn: vi.fn(),
      recordEmployeeStockDamage: vi.fn(),
      recordDelivery: vi.fn(),
    }) as unknown as EmployeeDeliveryGateway;

    const firstView = render(<EmployeeDeliveryWorkspace
      gateway={createGateway(vi.fn().mockResolvedValue(referenceData), vi.fn().mockResolvedValue([shopCard]))}
      requestScope="employee-remount-cache"
      serviceDate="2026-08-11"
    />);
    await screen.findByText(shopCard.shop_name);
    firstView.unmount();

    const pendingReference = new Promise<typeof referenceData>(() => {});
    const pendingCards = new Promise<ShopCard[]>(() => {});
    render(<EmployeeDeliveryWorkspace
      gateway={createGateway(vi.fn(() => pendingReference), vi.fn(() => pendingCards))}
      requestScope="employee-remount-cache"
      serviceDate="2026-08-11"
    />);

    expect(screen.getByText(shopCard.shop_name)).toBeTruthy();
    expect(screen.queryByText('กำลังโหลดงานวันนี้')).toBeNull();
    expect(screen.queryByText('กำลังโหลดร้าน')).toBeNull();
  });

  it('queues a catalog refresh received while a stock submission is pending', async () => {
    const user = userEvent.setup();
    const onStockReceived = vi.fn();
    let resolveTransfer!: (value: EmployeeStockState) => void;
    const transfer = new Promise<EmployeeStockState>((resolve) => {
      resolveTransfer = resolve;
    });
    const loadShopCards = vi.fn().mockResolvedValue([shopCard]);
    const gateway = {
      loadReferenceData: vi.fn().mockResolvedValue({
        rounds: [{
          id: 'round-1',
          service_date: '2026-08-11',
          name: 'งานประจำวัน',
          round_type: 'daily',
          status: 'open',
          opened_at: '2026-08-11T01:00:00Z',
        }],
        iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
      }),
      loadShopCards,
      loadEmployeeStockState: vi.fn().mockResolvedValue(stockState),
      recordEmployeeStockTransfer: vi.fn().mockReturnValue(transfer),
      recordEmployeeStockReturn: vi.fn(),
      recordEmployeeStockDamage: vi.fn(),
      recordDelivery: vi.fn(),
    } as unknown as EmployeeDeliveryGateway;

    render(<EmployeeDeliveryWorkspace
      enableAssignedStockFlow
      gateway={gateway}
      requestScope="employee-submitting"
      serviceDate="2026-08-11"
      viewMode="withdrawal"
      onStockReceived={onStockReceived}
    />);

    await user.click(await screen.findByRole('button', { name: 'เพิ่มครึ่งถุง น้ำแข็ง' }));
    await user.click(screen.getByRole('button', { name: /บันทึกเติมจากรถ · 0.5 ถุง/ }));
    await waitFor(() => expect(gateway.recordEmployeeStockTransfer).toHaveBeenCalledTimes(1));
    act(() => supabaseMock.state.postgresChangeListener?.());
    expect(loadShopCards).toHaveBeenCalledTimes(1);

    await act(async () => resolveTransfer(stockState));

    expect(onStockReceived).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(loadShopCards).toHaveBeenCalledTimes(2));
    expect(loadShopCards).toHaveBeenNthCalledWith(2, 'round-1', { forceRefresh: true });
  });
});

it('stock form rejects zero, undoes edits, retains failed input and updates stock after retry', async () => {
  const user = userEvent.setup();
  const after = { ...stockState, truck_location: { ...stockState.truck_location, balances: [{ ...stockState.truck_location.balances[0], quantity: 5.5 }] } };
  const before = { ...stockState, truck_location: { ...stockState.truck_location, balances: [{ ...stockState.truck_location.balances[0], quantity: 20 }] } };
  let currentStock = before;
  const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => {
    currentStock = after;
    return after;
  });
  const gateway = {
    loadReferenceData: vi.fn().mockResolvedValue({ rounds: [{ id: 'round-1', service_date: '2026-08-11', name: 'งานประจำวัน', status: 'open' }], iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }] }),
    loadShopCards: vi.fn().mockResolvedValue([]), loadEmployeeStockState: vi.fn(async () => currentStock),
    recordEmployeeStockTransfer: save, recordEmployeeStockReturn: vi.fn(), recordEmployeeStockDamage: vi.fn(), recordDelivery: vi.fn(),
  } as unknown as EmployeeDeliveryGateway;
  render(<EmployeeDeliveryWorkspace enableAssignedStockFlow gateway={gateway} requestScope="bag-retry-test" serviceDate="2026-08-11" viewMode="withdrawal" />);
  await user.click(await screen.findByRole('button', { name: /บันทึกเติมจากรถ · 0 ถุง/ }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getAllByText('ใส่จำนวนอย่างน้อยหนึ่งรายการก่อนบันทึก').length).toBeGreaterThan(0);
  const full = screen.getByLabelText('เต็มถุง น้ำแข็ง') as HTMLInputElement;
  const half = screen.getByLabelText('ครึ่งถุง น้ำแข็ง') as HTMLInputElement;
  fireEvent.change(full, { target: { value: '14' } });
  fireEvent.change(half, { target: { value: '1' } });
  await user.click(screen.getByRole('button', { name: 'ย้อนกลับ' }));
  expect(full.value).toBe('14'); expect(half.value).toBe('0');
  await user.click(screen.getByRole('button', { name: 'เพิ่มครึ่งถุง น้ำแข็ง' }));
  expect(screen.getByText('เหลือบนรถ 5.5 ถุง')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /บันทึกเติมจากรถ · 14.5 ถุง/ }));
  await waitFor(() => expect(screen.getAllByText(/กรุณาลองบันทึกใหม่/).length).toBeGreaterThan(0));
  expect(full.value).toBe('14'); expect(half.value).toBe('1');
  await user.click(screen.getByRole('button', { name: /บันทึกเติมจากรถ · 14.5 ถุง/ }));
  await waitFor(() => expect(full.value).toBe('0'));
  expect(half.value).toBe('0');
  expect(screen.getByText('เหลือบนรถ 5.5 ถุง')).toBeTruthy();
  expect(screen.getAllByText('บันทึกแล้ว เติมไป 14.5 ถุง').length).toBeGreaterThan(0);
  expect((screen.getByRole('button', { name: 'ย้อนกลับ' }) as HTMLButtonElement).disabled).toBe(true);
  expect(save.mock.calls[0][0].items).toEqual([{ ice_type_id: 'ice-1', fullBags: 14, halfBags: 1, quantity: 14.5 }]);
  expect(save.mock.calls[0][0].idempotencyKey).toBe(save.mock.calls[1][0].idempotencyKey);
});

function stockRetryGateway(save: ReturnType<typeof vi.fn>) {
  const available = { ...stockState, holding_location: { ...stockState.holding_location,
    balances: [{ ...stockState.holding_location.balances[0], quantity: 20 }] } };
  return {
    loadReferenceData: vi.fn().mockResolvedValue({
      rounds: [{ id: 'round-1', service_date: '2026-08-11', name: 'งานประจำวัน', status: 'open' }],
      iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
    }),
    loadShopCards: vi.fn().mockResolvedValue([]), loadEmployeeStockState: vi.fn().mockResolvedValue(available),
    recordEmployeeStockTransfer: save, recordEmployeeStockReturn: save, recordEmployeeStockDamage: save,
    recordDelivery: vi.fn(),
  } as unknown as EmployeeDeliveryGateway;
}

it.each([
  ['receive', 'stock-transfer', 'เติมจากรถ'],
  ['return', 'stock-return', 'คืนขึ้นรถ'],
  ['damage', 'stock-damage', 'ละลาย'],
])('recovers a legacy %s draft with its original request key and quantity-only payload', async (mode, operation, label) => {
  const scope = `bag-upgrade-${mode}`;
  const key = crypto.randomUUID();
  const legacyItems = [{ ice_type_id: 'ice-1', quantity: 2.5 }];
  const signature = `${scope}:${operation}:${JSON.stringify({ roundId: 'round-1', items: legacyItems })}`;
  window.localStorage.setItem('ice-delivery.pending-requests.v1', JSON.stringify({
    [signature]: { key, clientRecordedAt: new Date().toISOString() },
  }));
  writeRecovery(scope, '2026-08-11', 'withdrawal', {
    selectedRoundId: 'round-1', selectedBuildingId: '', selectedZone: '', query: '', selectedCardId: null,
    selectedIceTypeId: 'ice-1', deliveryQuantities: {}, transferQuantities: { 'ice-1': 2.5 },
    stockTransferMode: mode, status: 'delivered', note: '', paymentOpen: false,
  });
  const save = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue(stockState);
  render(<EmployeeDeliveryWorkspace enableAssignedStockFlow gateway={stockRetryGateway(save)} requestScope={scope} serviceDate="2026-08-11" viewMode="withdrawal" />);
  const button = await screen.findByRole('button', { name: `บันทึก${label} · 2.5 ถุง` });
  fireEvent.click(button);
  await waitFor(() => expect(screen.getAllByText(/กรุณาลองบันทึกใหม่/).length).toBeGreaterThan(0));
  expect(save.mock.calls[0][0]).toEqual({ roundId: 'round-1', items: legacyItems, idempotencyKey: key });
  fireEvent.click(button);
  await waitFor(() => expect((screen.getByLabelText('เต็มถุง น้ำแข็ง') as HTMLInputElement).value).toBe('0'));
  expect(save.mock.calls[1][0]).toEqual(save.mock.calls[0][0]);
  expect(JSON.parse(window.localStorage.getItem('ice-delivery.pending-requests.v1')!)[signature]).toBeUndefined();
  // A separate save with the same total now uses a fresh key and preserves the split.
  fireEvent.click(screen.getByRole('button', { name: 'เติมจากรถ' }));
  fireEvent.change(screen.getByLabelText('เต็มถุง น้ำแข็ง'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('ครึ่งถุง น้ำแข็ง'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกเติมจากรถ · 2.5 ถุง' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
  expect(save.mock.calls[2][0].idempotencyKey).not.toBe(key);
  expect(save.mock.calls[2][0].items[0]).toMatchObject({ quantity: 2.5, fullBags: 2, halfBags: 1 });
});

it('localizes stock controls and blocked overstock feedback in Burmese', async () => {
  window.localStorage.setItem('ice-delivery.language.v1', 'my');
  const save = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue(stockState);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  try {
    render(<LanguageProvider><LanguageSwitcher /><EmployeeDeliveryWorkspace enableAssignedStockFlow gateway={stockRetryGateway(save)} requestScope="bag-burmese" serviceDate="2026-08-11" viewMode="withdrawal" /></LanguageProvider>);
    await screen.findByRole('button', { name: translateUi('เติมจากรถ') });
    await waitFor(() => expect(document.querySelector('.bag-transfer-card')).not.toBeNull());
    const fullLabel = translateUi('เต็มถุง');
    expect(fullLabel).not.toBe('เต็มถุง');
    const full = screen.getByLabelText(`${fullLabel} น้ำแข็ง`) as HTMLInputElement;
    fireEvent.click(document.querySelector('.bag-transfer-buttons .employee-submit')!);
    expect(document.querySelector('.bag-transfer-error')!.textContent).not.toMatch(/[ก-๙]/);
    fireEvent.change(full, { target: { value: '14' } });
    expect(full.value).toBe('0');
    expect(document.querySelector('.bag-transfer-error')!.textContent).not.toMatch(/[ก-๙]/);
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.change(full, { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(`${translateUi('ครึ่งถุง')} น้ำแข็ง`), { target: { value: '1' } });
    for (const selector of ['.bag-transfer-warning', '.bag-transfer-total', '.bag-transfer-buttons', '.bag-product-name small']) {
      expect(document.querySelector(selector)!.textContent).not.toMatch(/[ก-๙]/);
    }
    fireEvent.click(document.querySelector('.bag-transfer-buttons .employee-submit')!);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector('.bag-transfer-error')).not.toBeNull());
    expect(document.querySelector('.bag-transfer-error')!.textContent).not.toMatch(/[ก-๙]/);
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('.bag-transfer-buttons .employee-submit')!);
    await waitFor(() => expect(full.value).toBe('0'));
    const success = document.querySelector('.bag-transfer-success')!;
    expect(success.textContent).toContain('1.5');
    expect(success.textContent).not.toMatch(/[ก-๙]/);
    fireEvent.change(document.querySelector('.language-switcher select')!, { target: { value: 'th' } });
    expect(success.textContent).toBe('บันทึกแล้ว เติมไป 1.5 ถุง');
  } finally {
    confirm.mockRestore();
    const switcher = document.querySelector('.language-switcher select');
    if (switcher) fireEvent.change(switcher, { target: { value: 'th' } });
  }
});


it.each([
  ['receive', 'เติมจากรถ'], ['return', 'คืนขึ้นรถ'], ['damage', 'ละลาย'],
])('limits %s edits to available full and half bags', async (mode, label) => {
  const save = vi.fn().mockResolvedValue(stockState);
  const gateway = stockRetryGateway(save);
  gateway.loadEmployeeStockState = vi.fn().mockResolvedValue({
    ...stockState,
    truck_location: { ...stockState.truck_location, balances: [{ ...stockState.truck_location.balances[0], quantity: mode === 'receive' ? 1.5 : 100 }] },
    holding_location: { ...stockState.holding_location, balances: [{ ...stockState.holding_location.balances[0], quantity: mode === 'receive' ? 100 : 1.5 }] },
  });
  render(<EmployeeDeliveryWorkspace enableAssignedStockFlow gateway={gateway} requestScope={`stock-limit-${mode}`} serviceDate="2026-08-11" viewMode="withdrawal" />);
  await screen.findByLabelText('เต็มถุง น้ำแข็ง');
  fireEvent.click(screen.getByRole('button', { name: label }));
  const full = screen.getByLabelText('เต็มถุง น้ำแข็ง') as HTMLInputElement;
  const half = screen.getByLabelText('ครึ่งถุง น้ำแข็ง') as HTMLInputElement;
  fireEvent.change(full, { target: { value: '7' } });
  expect(full.value).toBe('0');
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(full, { target: { value: '1' } });
  expect((screen.getByRole('button', { name: 'เพิ่มเต็มถุง น้ำแข็ง' }) as HTMLButtonElement).disabled).toBe(true);
  const addHalf = screen.getByRole('button', { name: 'เพิ่มครึ่งถุง น้ำแข็ง' }) as HTMLButtonElement;
  expect(addHalf.disabled).toBe(false);
  fireEvent.change(half, { target: { value: '2' } });
  expect(half.value).toBe('0');
  fireEvent.click(addHalf);
  expect(half.value).toBe('1');
  expect(addHalf.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: `บันทึก${label} · 1.5 ถุง` }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0].items).toEqual([{ ice_type_id: 'ice-1', quantity: 1.5, fullBags: 1, halfBags: 1 }]);
});

it.each(['receive', 'return', 'damage'] as const)('blocks recovered %s overstock even when the submit handler is called directly', async (mode) => {
  const scope = `stock-recovered-overdraw-${mode}`;
  writeRecovery(scope, '2026-08-11', 'withdrawal', {
    selectedRoundId: 'round-1', selectedBuildingId: '', selectedZone: '', query: '', selectedCardId: null,
    selectedIceTypeId: 'ice-1', deliveryQuantities: {}, transferQuantities: { 'ice-1': { fullBags: 7, halfBags: 0 } },
    stockTransferMode: mode, status: 'delivered', note: '', paymentOpen: false,
  });
  const save = vi.fn();
  const gateway = stockRetryGateway(save);
  gateway.loadEmployeeStockState = vi.fn().mockResolvedValue({
    ...stockState,
    truck_location: { ...stockState.truck_location, balances: [] },
    holding_location: { ...stockState.holding_location, balances: [] },
  });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  try {
    const { result } = renderHook(() => useEmployeeDeliveryData({
      gateway, enableAssignedStockFlow: true, requestScope: scope, serviceDate: '2026-08-11',
    }));
    await waitFor(() => expect(result.current.stockState).not.toBeNull());
    expect(result.current.transferItems[0].quantity).toBe(7);
    await act(async () => { await result.current.handleStockTransfer(); });
    expect(save).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(result.current.stockError).toBe('จำนวนเกินสต๊อกคงเหลือ ไม่สามารถบันทึกได้');
    act(() => result.current.changeTransferQuantity('ice-1', 'fullBags', 6));
    expect(result.current.transferItems[0].quantity).toBe(6);
    act(() => result.current.changeTransferQuantity('ice-1', 'fullBags', 0));
    expect(result.current.transferItems).toEqual([]);
    act(() => result.current.changeTransferQuantity('ice-1', 'halfBags', 1));
    expect(result.current.transferItems).toEqual([]);
  } finally {
    confirm.mockRestore();
  }
});

it.each([
  ['receive', 'เติมจากรถ'], ['return', 'คืนขึ้นรถ'], ['damage', 'ละลาย'],
])('acknowledges a committed %s request after response loss and stock refresh', async (mode, label) => {
  let balance = 20;
  const committed = new Set<string>();
  const currentStock = () => ({
    ...stockState,
    truck_location: { ...stockState.truck_location, balances: [{ ...stockState.truck_location.balances[0], quantity: balance }] },
    holding_location: { ...stockState.holding_location, balances: [{ ...stockState.holding_location.balances[0], quantity: balance }] },
  });
  const save = vi.fn(async (payload) => {
    if (!committed.has(payload.idempotencyKey)) {
      balance -= payload.items[0].quantity;
      committed.add(payload.idempotencyKey);
      throw new Error('Failed to fetch');
    }
    return currentStock();
  });
  const gateway = stockRetryGateway(save);
  gateway.loadEmployeeStockState = vi.fn(async () => currentStock());
  render(<EmployeeDeliveryWorkspace enableAssignedStockFlow gateway={gateway} requestScope={`stock-lost-response-${mode}`} serviceDate="2026-08-11" viewMode="withdrawal" />);
  await screen.findByLabelText('เต็มถุง น้ำแข็ง');
  fireEvent.click(screen.getByRole('button', { name: label }));
  const full = screen.getByLabelText('เต็มถุง น้ำแข็ง') as HTMLInputElement;
  fireEvent.change(full, { target: { value: '14' } });
  fireEvent.change(screen.getByLabelText('ครึ่งถุง น้ำแข็ง'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: `บันทึก${label} · 14.5 ถุง` }));
  await screen.findAllByText(/กรุณาลองบันทึกใหม่/);
  expect(committed.size).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));
  const retry = await screen.findByRole('button', { name: 'ตรวจสอบผลรายการเดิม · 14.5 ถุง' });
  expect((retry as HTMLButtonElement).disabled).toBe(false);
  // A changed payload must not inherit the pending request's exception.
  fireEvent.change(full, { target: { value: '6' } });
  expect((screen.getByRole('button', { name: `บันทึก${label} · 6.5 ถุง` }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'ย้อนกลับ' }));
  fireEvent.click(screen.getByRole('button', { name: 'ตรวจสอบผลรายการเดิม · 14.5 ถุง' }));
  await waitFor(() => expect(full.value).toBe('0'));
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1][0]).toEqual(save.mock.calls[0][0]);
  expect(committed.size).toBe(1);
  expect(balance).toBe(5.5);
  expect(Object.values(JSON.parse(window.localStorage.getItem('ice-delivery.pending-requests.v1')!)))
    .not.toContainEqual(expect.objectContaining({ key: save.mock.calls[0][0].idempotencyKey }));
});

it.each([
  ['receive', 'stock-transfer'], ['return', 'stock-return'], ['damage', 'stock-damage'],
])('reconciles a recovered legacy %s request even when stock is now zero', async (mode, operation) => {
  const scope = `stock-legacy-lost-response-${mode}`;
  const key = crypto.randomUUID();
  const items = [{ ice_type_id: 'ice-1', quantity: 7 }];
  const signature = `${scope}:${operation}:${JSON.stringify({ roundId: 'round-1', items })}`;
  window.localStorage.setItem('ice-delivery.pending-requests.v1', JSON.stringify({
    [signature]: { key, clientRecordedAt: new Date().toISOString() },
  }));
  writeRecovery(scope, '2026-08-11', 'withdrawal', {
    selectedRoundId: 'round-1', selectedBuildingId: '', selectedZone: '', query: '', selectedCardId: null,
    selectedIceTypeId: 'ice-1', deliveryQuantities: {}, transferQuantities: { 'ice-1': 7 },
    stockTransferMode: mode, status: 'delivered', note: '', paymentOpen: false,
  });
  const empty = { ...stockState, truck_location: { ...stockState.truck_location, balances: [] }, holding_location: { ...stockState.holding_location, balances: [] } };
  const save = vi.fn().mockResolvedValue(empty);
  const gateway = stockRetryGateway(save);
  gateway.loadEmployeeStockState = vi.fn().mockResolvedValue(empty);
  render(<EmployeeDeliveryWorkspace enableAssignedStockFlow gateway={gateway} requestScope={scope} serviceDate="2026-08-11" viewMode="withdrawal" />);
  fireEvent.click(await screen.findByRole('button', { name: 'ตรวจสอบผลรายการเดิม · 7 ถุง' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ roundId: 'round-1', items, idempotencyKey: key }));
  await waitFor(() => expect((screen.getByLabelText('เต็มถุง น้ำแข็ง') as HTMLInputElement).value).toBe('0'));
});

it('ignores hidden recovered half bags when validating a full bag edit', async () => {
  const scope = 'stock-hidden-half-bags';
  writeRecovery(scope, '2026-08-11', 'withdrawal', {
    selectedRoundId: 'round-1', selectedBuildingId: '', selectedZone: '', query: '', selectedCardId: null,
    selectedIceTypeId: 'ice-1', deliveryQuantities: {}, transferQuantities: { 'ice-1': { fullBags: 0, halfBags: 1 } },
    stockTransferMode: 'receive', status: 'delivered', note: '', paymentOpen: false,
  });
  const save = vi.fn().mockResolvedValue(stockState);
  const gateway = stockRetryGateway(save);
  gateway.loadReferenceData = vi.fn().mockResolvedValue({
    rounds: [{ id: 'round-1', service_date: '2026-08-11', name: 'งานประจำวัน', status: 'open' }],
    iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง', allowHalf: false }],
  });
  gateway.loadEmployeeStockState = vi.fn().mockResolvedValue({
    ...stockState, truck_location: { ...stockState.truck_location, balances: [{ ...stockState.truck_location.balances[0], quantity: 1 }] },
  });
  render(<EmployeeDeliveryWorkspace enableAssignedStockFlow gateway={gateway} requestScope={scope} serviceDate="2026-08-11" viewMode="withdrawal" />);
  await screen.findByLabelText('เต็มถุง น้ำแข็ง');
  expect(screen.queryByLabelText('ครึ่งถุง น้ำแข็ง')).toBeNull();
  const add = screen.getByRole('button', { name: 'เพิ่มเต็มถุง น้ำแข็ง' }) as HTMLButtonElement;
  expect(add.disabled).toBe(false);
  fireEvent.click(add);
  expect((screen.getByLabelText('เต็มถุง น้ำแข็ง') as HTMLInputElement).value).toBe('1');
  expect(add.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกเติมจากรถ · 1 ถุง' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0].items).toEqual([{ ice_type_id: 'ice-1', fullBags: 1, halfBags: 0, quantity: 1 }]);
});

it.each([
  ['receive', 'เติมจากรถ'], ['return', 'คืนขึ้นรถ'], ['damage', 'ละลาย'],
])('does not clear or complete an uncommitted %s retry rejected by the server', async (mode, label) => {
  let balance = 20;
  const currentStock = () => ({
    ...stockState,
    truck_location: { ...stockState.truck_location, balances: [{ ...stockState.truck_location.balances[0], quantity: balance }] },
    holding_location: { ...stockState.holding_location, balances: [{ ...stockState.holding_location.balances[0], quantity: balance }] },
  });
  const save = vi.fn()
    .mockRejectedValueOnce(new Error('Failed to fetch'))
    .mockRejectedValue(new Error('The employee holding does not have enough stock'));
  const gateway = stockRetryGateway(save);
  gateway.loadEmployeeStockState = vi.fn(async () => currentStock());
  render(<EmployeeDeliveryWorkspace enableAssignedStockFlow gateway={gateway} requestScope={`stock-uncommitted-${mode}`} serviceDate="2026-08-11" viewMode="withdrawal" />);
  await screen.findByLabelText('เต็มถุง น้ำแข็ง');
  fireEvent.click(screen.getByRole('button', { name: label }));
  const full = screen.getByLabelText('เต็มถุง น้ำแข็ง') as HTMLInputElement;
  fireEvent.change(full, { target: { value: '14' } });
  fireEvent.click(screen.getByRole('button', { name: `บันทึก${label} · 14 ถุง` }));
  await screen.findAllByText(/กรุณาลองบันทึกใหม่/);
  balance = 0; // Another request consumed the available stock.
  fireEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));
  fireEvent.click(await screen.findByRole('button', { name: 'ตรวจสอบผลรายการเดิม · 14 ถุง' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(document.querySelector('.bag-transfer-error')).not.toBeNull());
  expect(save.mock.calls[1][0]).toEqual(save.mock.calls[0][0]);
  expect(full.value).toBe('14');
  expect(document.querySelector('.bag-transfer-success')).toBeNull();
  expect(Object.values(JSON.parse(window.localStorage.getItem('ice-delivery.pending-requests.v1')!)))
    .toContainEqual(expect.objectContaining({ key: save.mock.calls[0][0].idempotencyKey }));
});


it('opens the closed admin round and accepts delivery quantities after stock close', async () => {
  const gateway: EmployeeDeliveryGateway = {
    loadReferenceData: vi.fn().mockResolvedValue({
      rounds: [{ id: 'round-1', service_date: '2026-08-11', name: 'งานประจำวัน',
        status: 'closed', can_record_delivery: true, opened_at: '2026-08-11T01:00:00Z' }],
      iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'หลอดเล็ก', unit: 'ถุง' }],
    }),
    loadShopCards: vi.fn().mockResolvedValue([shopCard]),
    loadDeliveryPosContext: vi.fn().mockResolvedValue({ ...posContext, stock_check_required: false,
      items: [{ ...posContext.items[0], stock_quantity: 0 }] }),
    loadEmployeeStockState: vi.fn(), recordEmployeeStockTransfer: vi.fn(),
    recordEmployeeStockReturn: vi.fn(), recordEmployeeStockDamage: vi.fn(), recordDelivery: vi.fn(),
  };
  const user = userEvent.setup();
  render(<EmployeeDeliveryWorkspace gateway={gateway} requestScope="admin-closed-day" serviceDate="2026-08-11" />);
  await user.click(await screen.findByRole('button', { name: /^เลือกร้าน / }));
  await screen.findByText(/บันทึกส่งของหลังปิดยอด/);
  await user.click(screen.getByRole('button', { name: /หลอดเล็ก.*คงเหลือ/ }));
  const quantity = screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' });
  await user.clear(quantity);
  await user.type(quantity, '3');
  expect((quantity as HTMLInputElement).value).toBe('3');
  expect(quantity.hasAttribute('max')).toBe(false);
});

it('retains the POS preview across the actual withdrawal-tab round trip', async () => {
  const gateway = previewGateway();
  gateway.loadEmployeeStockState = vi.fn().mockResolvedValue(stockState);
  const { result, rerender } = renderHook(({ withdrawal }) => useEmployeeDeliveryData({
    gateway, requestScope: 'review-mode-cache', serviceDate: '2026-08-11', enableAssignedStockFlow: withdrawal,
  }), { initialProps: { withdrawal: false } });
  await waitFor(() => expect(result.current.cards).toHaveLength(2));
  act(() => result.current.openCard(shopCard));
  await waitFor(() => expect(result.current.loadingPosContext).toBe(false));
  expect(result.current.posContext?.items[0].unit_price).toBe(60);
  act(() => result.current.attemptBack());
  rerender({ withdrawal: true });
  await waitFor(() => expect(result.current.stockState).toEqual(stockState));
  let finishWithdrawal!: (context: DeliveryPosContext) => void;
  vi.mocked(gateway.loadDeliveryPosContext!).mockReturnValueOnce(new Promise(resolve => { finishWithdrawal = resolve; }));
  act(() => result.current.openCard(shopCard));
  expect(result.current.posContext).toBeNull();
  await act(async () => finishWithdrawal({ ...previewContext,
    items: [{ ...previewContext.items[0], unit_price: 80 }],
  }));
  expect(result.current.posContext?.items[0].unit_price).toBe(80);
  act(() => result.current.attemptBack());
  rerender({ withdrawal: false });
  vi.mocked(gateway.loadDeliveryPosContext!).mockReturnValue(new Promise(() => {}));
  act(() => result.current.openCard(shopCard));
  expect(result.current.loadingPosContext).toBe(true);
  expect(result.current.posContext?.items[0].unit_price).toBe(60);
});

it('recovers outstanding balances on focus after a transient queue failure', async () => {
  const gateway = previewGateway();
  gateway.loadCollectionOutstanding = vi.fn().mockRejectedValueOnce(new Error('temporary network failure'))
    .mockResolvedValue([{ queueKey: 'regular:shop-1', shopId: 'shop-1', outstandingAmount: 120 }]);
  render(<EmployeeDeliveryWorkspace gateway={gateway} requestScope="review-outstanding" serviceDate="2026-08-11" />);
  expect(await screen.findAllByText('โหลดยอดรอรับชำระไม่สำเร็จ')).toHaveLength(2);
  const now = Date.now();
  const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now + 600_000);
  try {
    fireEvent.focus(window);
    await waitFor(() => expect(gateway.loadShopCards).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(gateway.loadCollectionOutstanding).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('โหลดยอดรอรับชำระไม่สำเร็จ')).toBeNull();
  } finally { dateSpy.mockRestore(); }
});

it('lets the user dismiss an unfinished quantity after the background read fails', async () => {
  const gateway = previewGateway();
  const user = userEvent.setup();
  render(<EmployeeDeliveryWorkspace gateway={gateway} requestScope="review-keypad" serviceDate="2026-08-11" />);
  await user.click(await screen.findByRole('button', { name: 'เลือกร้าน BB01 ร้านทดสอบ' }));
  await screen.findByText('คงเหลือ 10 ถุง');
  await user.click(screen.getByRole('button', { name: 'กลับไปเลือกร้าน' }));
  let fail!: (reason: Error) => void;
  vi.mocked(gateway.loadDeliveryPosContext!).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
  await user.click(await screen.findByRole('button', { name: 'เลือกร้าน BB01 ร้านทดสอบ' }));
  await user.click(screen.getByRole('button', { name: /หลอดเล็ก.*60.*คงเหลือ/ }));
  const quantity = screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' });
  await user.clear(quantity);
  await user.type(quantity, '2');
  await act(async () => fail(new Error('offline')));
  expect(quantity.hasAttribute('disabled')).toBe(true);
  await user.click(screen.getByRole('button', { name: 'ปิดแป้นใส่จำนวน' }));
  expect(screen.queryByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' })).toBeNull();
  expect(gateway.recordDelivery).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'ลองโหลดข้อมูลอีกครั้ง' }));
  await screen.findByText('คงเหลือ 10 ถุง');
  await user.click(screen.getByRole('button', { name: /หลอดเล็ก.*60.*คงเหลือ/ }));
  expect((screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' }) as HTMLInputElement).value).toBe('0');
});

it('retries outstanding balances from the shop list without entering a shop', async () => {
  const gateway = previewGateway();
  gateway.loadCollectionOutstanding = vi.fn().mockRejectedValueOnce(new Error('temporary network failure'))
    .mockResolvedValue([{ queueKey: 'regular:shop-1', shopId: 'shop-1', outstandingAmount: 120 }]);
  render(<EmployeeDeliveryWorkspace gateway={gateway} requestScope="retry-balances" serviceDate="2026-08-11" />);
  await userEvent.setup().click(await screen.findByRole('button', { name: 'ลองใหม่' }));
  await screen.findByText(/ยอดรอรับชำระ.*120/);
  expect(screen.queryByText('โหลดยอดรอรับชำระไม่สำเร็จ')).toBeNull();
  expect(screen.getByRole('button', { name: 'เลือกร้าน BB01 ร้านทดสอบ' })).toBeTruthy();
  expect(gateway.loadDeliveryPosContext).not.toHaveBeenCalled();
});

it.each(['online', 'visibilitychange'])('retries a failed balance read on %s without waiting five minutes or duplicating a resume burst', async eventType => {
  const gateway = previewGateway();
  let finish!: (balances: Array<{ queueKey: string; shopId: string; outstandingAmount: number }>) => void;
  gateway.loadCollectionOutstanding = vi.fn().mockRejectedValueOnce(new Error('temporary network failure'))
    .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<EmployeeDeliveryWorkspace gateway={gateway} requestScope={`resume-${eventType}`} serviceDate="2026-08-11" />);
  await screen.findByRole('button', { name: 'ลองใหม่' });
  act(() => {
    (eventType === 'online' ? window : document).dispatchEvent(new Event(eventType));
    window.dispatchEvent(new Event('focus'));
  });
  expect(gateway.loadCollectionOutstanding).toHaveBeenCalledTimes(2);
  await act(async () => finish([{ queueKey: 'regular:shop-1', shopId: 'shop-1', outstandingAmount: 120 }]));
  expect(screen.getByText(/ยอดรอรับชำระ.*120/)).toBeTruthy();
  expect(screen.queryByText('โหลดยอดรอรับชำระไม่สำเร็จ')).toBeNull();
});


it('loads event settlement balances as well as regular shop balances for POS', async () => {
  supabaseMock.client.rpc.mockResolvedValue({ data: { status: 'open', collection_run_id: 'run-1', queue: [
    { queue_key: 'regular:shop-1', shop_id: 'shop-1', destination_kind: 'regular', outstanding_amount: 240 },
    { queue_key: 'event:context-1', shop_id: 'shop-1', destination_kind: 'event',
      event_participation_id: 'participation-1', outstanding_amount: '160.75' },
    { queue_key: 'event:context-2', shop_id: 'shop-1', destination_kind: 'event',
      event_participation_id: 'participation-1', outstanding_amount: 90 },
  ] }, error: null });
  const result = await createSupabaseGateway().loadCollectionOutstanding!('2026-09-25');
  expect(supabaseMock.client.rpc).toHaveBeenCalledWith('get_daily_shop_collection_queue', { p_service_date: '2026-09-25' });
  expect(result).toEqual([
    { queueKey: 'regular:shop-1', shopId: 'shop-1', outstandingAmount: 240 },
    { queueKey: 'event:context-1', shopId: 'shop-1', eventParticipationId: 'participation-1', outstandingAmount: 160.75 },
    { queueKey: 'event:context-2', shopId: 'shop-1', eventParticipationId: 'participation-1', outstandingAmount: 90 },
  ]);
});
