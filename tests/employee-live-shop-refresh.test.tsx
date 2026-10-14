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

describe('employee live shop loading', () => {
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

  it('deduplicates POS requests and reuses the current-day cache', async () => {
    supabaseMock.client.rpc.mockResolvedValue({ data: posContext, error: null });
    const gateway = createSupabaseGateway();

    const [first, concurrent] = await Promise.all([
      gateway.loadDeliveryPosContext!('stop-1', { destinationKind: 'regular', serviceDate: '2026-08-11' }),
      gateway.loadDeliveryPosContext!('stop-1', { destinationKind: 'regular', serviceDate: '2026-08-11' }),
    ]);
    const cached = await gateway.loadDeliveryPosContext!('stop-1', {
      destinationKind: 'regular',
      serviceDate: '2026-08-11',
    });

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

    await gateway.loadDeliveryPosContext!('stop-1', { destinationKind: 'regular', serviceDate: '2026-08-11' });
    now += 6 * 60 * 1000;
    const fallback = await gateway.loadDeliveryPosContext!('stop-1', {
      destinationKind: 'regular',
      serviceDate: '2026-08-11',
    });

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
  const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(after);
  const gateway = {
    loadReferenceData: vi.fn().mockResolvedValue({ rounds: [{ id: 'round-1', service_date: '2026-08-11', name: 'งานประจำวัน', status: 'open' }], iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }] }),
    loadShopCards: vi.fn().mockResolvedValue([]), loadEmployeeStockState: vi.fn().mockResolvedValue(before),
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
