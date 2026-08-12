import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';
import type { DeliveryPosContext, ShopCard } from '../src/types/app';

const supabaseMock = vi.hoisted(() => {
  const state: { postgresChangeListener: (() => void) | null } = {
    postgresChangeListener: null,
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
    storage: {
      from: vi.fn(() => ({ getPublicUrl })),
    },
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  };

  return { channel, client, getPublicUrl, state };
});

vi.mock('../src/lib/supabase', () => ({ supabase: supabaseMock.client }));

import {
  EmployeeDeliveryWorkspace,
  createSupabaseGateway,
} from '../src/EmployeeDeliveryWorkspace';

beforeEach(() => {
  supabaseMock.state.postgresChangeListener = null;
  supabaseMock.client.rpc.mockReset();
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

describe('employee live shop loading', () => {
  it('synchronizes the round before reading shop cards', async () => {
    supabaseMock.client.rpc
      .mockResolvedValueOnce({ data: 1, error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    await expect(createSupabaseGateway().loadShopCards('round-1')).resolves.toEqual([]);

    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(
      1,
      'sync_daily_round_active_shops',
      { p_round_id: 'round-1' },
    );
    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(
      2,
      'get_round_shop_cards',
      { p_round_id: 'round-1', p_building_id: null },
    );
  });

  it('does not read stale cards when synchronization fails', async () => {
    const syncError = new Error('sync failed');
    supabaseMock.client.rpc.mockResolvedValueOnce({ data: null, error: syncError });

    await expect(createSupabaseGateway().loadShopCards('round-1')).rejects.toBe(syncError);
    expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(1);
  });

  it('deduplicates POS requests and reuses the current-day cache', async () => {
    supabaseMock.client.rpc.mockResolvedValue({ data: posContext, error: null });
    const gateway = createSupabaseGateway();

    const [first, concurrent] = await Promise.all([
      gateway.loadDeliveryPosContext!('stop-1', { serviceDate: '2026-08-11' }),
      gateway.loadDeliveryPosContext!('stop-1', { serviceDate: '2026-08-11' }),
    ]);
    const cached = await gateway.loadDeliveryPosContext!('stop-1', { serviceDate: '2026-08-11' });

    expect(first.round_stop_id).toBe('stop-1');
    expect(concurrent.round_stop_id).toBe('stop-1');
    expect(cached.client_cache?.stale).toBe(false);
    expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(1);
    expect(supabaseMock.client.storage.from).not.toHaveBeenCalled();
  });

  it('falls back to the saved POS context when a refresh fails', async () => {
    let now = new Date('2026-08-11T01:00:00Z').getTime();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    supabaseMock.client.rpc
      .mockResolvedValueOnce({ data: posContext, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error('network unavailable') });
    const gateway = createSupabaseGateway();

    await gateway.loadDeliveryPosContext!('stop-1', { serviceDate: '2026-08-11' });
    now += 6 * 60 * 1000;
    const fallback = await gateway.loadDeliveryPosContext!('stop-1', { serviceDate: '2026-08-11' });

    expect(fallback.client_cache?.stale).toBe(true);
    expect(fallback.items[0].unit_price).toBe(60);
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

    fireEvent.focus(window);
    expect(loadShopCards).toHaveBeenCalledTimes(2);

    now += 5 * 60 * 1000;
    fireEvent.focus(window);
    await waitFor(() => expect(loadShopCards).toHaveBeenCalledTimes(3));
    nowSpy.mockRestore();
  });
});
