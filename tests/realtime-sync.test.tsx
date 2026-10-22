import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ALL_DATA_CHANGE_SCOPES,
  createRealtimeSync,
  REALTIME_TABLE_SCOPES,
} from '../src/lib/realtimeSync';
import type { DataChangeScope } from '../src/lib/dataChange';

describe('realtimeSync', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createMockSupabase() {
    const handlers = new Map<string, (payload?: unknown) => void>();
    const mockChannel = {
      on: vi.fn((_type: string, filter: { table: string }, callback: (payload?: unknown) => void) => {
        handlers.set(filter.table, callback);
        return mockChannel;
      }),
      subscribe: vi.fn().mockReturnThis(),
    };

    const mockClient = {
      channel: vi.fn().mockReturnValue(mockChannel),
      removeChannel: vi.fn().mockResolvedValue('ok'),
    } as unknown as SupabaseClient;

    return {
      mockClient,
      mockChannel,
      handlers,
    };
  }

  it('subscribes to all configured tables on the realtime channel', () => {
    const { mockClient, mockChannel } = createMockSupabase();
    const onPublish = vi.fn();

    createRealtimeSync(mockClient, onPublish, { debounceMs: 100, enableFocusCatchup: false });

    expect(mockClient.channel).toHaveBeenCalledWith('ice-global-realtime-sync');
    expect(mockChannel.subscribe).toHaveBeenCalled();

    const registeredTables = mockChannel.on.mock.calls.map((call) => (call[1] as { table: string }).table);
    for (const table of Object.keys(REALTIME_TABLE_SCOPES)) {
      expect(registeredTables).toContain(table);
    }
  });

  it('debounces and publishes corresponding scopes when table change event occurs', () => {
    const { mockClient, handlers } = createMockSupabase();
    const onPublish = vi.fn();

    createRealtimeSync(mockClient, onPublish, { debounceMs: 150, enableFocusCatchup: false });

    const paymentHandler = handlers.get('payments');
    expect(paymentHandler).toBeDefined();

    paymentHandler!();
    expect(onPublish).not.toHaveBeenCalled();

    vi.advanceTimersByTime(149);
    expect(onPublish).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(onPublish).toHaveBeenCalledTimes(1);
    const publishedScopes = onPublish.mock.calls[0][0] as DataChangeScope[];
    expect(publishedScopes).toEqual(expect.arrayContaining(['payment', 'receivable', 'accounting']));
  });

  it('merges scopes from multiple rapid table changes into a single notification', () => {
    const { mockClient, handlers } = createMockSupabase();
    const onPublish = vi.fn();

    createRealtimeSync(mockClient, onPublish, { debounceMs: 150, enableFocusCatchup: false });

    const deliveryHandler = handlers.get('delivery_events');
    const stockHandler = handlers.get('stock_movements');
    const paymentHandler = handlers.get('payments');

    deliveryHandler!();
    stockHandler!();
    paymentHandler!();

    vi.advanceTimersByTime(150);

    expect(onPublish).toHaveBeenCalledTimes(1);
    const publishedScopes = onPublish.mock.calls[0][0] as DataChangeScope[];
    expect(publishedScopes).toEqual(
      expect.arrayContaining(['pos', 'stock', 'accounting', 'payment', 'receivable'])
    );
  });

  it('triggers catch-up notification when window regains focus respecting cooldown', () => {
    const { mockClient } = createMockSupabase();
    const onPublish = vi.fn();

    createRealtimeSync(mockClient, onPublish, {
      debounceMs: 50,
      enableFocusCatchup: true,
      focusCatchupCooldownMs: 10_000,
    });

    // Simulate window focus
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(50);

    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0][0]).toEqual(expect.arrayContaining(ALL_DATA_CHANGE_SCOPES));

    // Refocus immediately within cooldown should not trigger again
    onPublish.mockClear();
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(50);
    expect(onPublish).not.toHaveBeenCalled();

    // Advance beyond cooldown
    vi.advanceTimersByTime(10_000);
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(50);
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it('cleans up channel and event listeners on unsubscribe', () => {
    const { mockClient, mockChannel } = createMockSupabase();
    const onPublish = vi.fn();

    const unsubscribe = createRealtimeSync(mockClient, onPublish, {
      debounceMs: 50,
      enableFocusCatchup: true,
    });

    unsubscribe();

    expect(mockClient.removeChannel).toHaveBeenCalledWith(mockChannel);

    // After unsubscribe, focus should not trigger onPublish
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(100);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('preserves every row identity when batching own documents with delivery changes', () => {
    const { mockClient, handlers } = createMockSupabase();
    const onPublish = vi.fn();
    const stop = createRealtimeSync(mockClient, onPublish, { debounceMs: 50, enableFocusCatchup: false });
    handlers.get('daily_credit_acknowledgements')!({ eventType: 'INSERT', new: {
      id: 'doc-2', shop_id: 'shop-1', service_date: '2026-10-22',
    } });
    handlers.get('delivery_charges')!({ eventType: 'UPDATE', new: { id: 'charge-1' } });
    vi.advanceTimersByTime(50);
    expect(onPublish).toHaveBeenCalledWith(expect.arrayContaining(['receivable', 'accounting', 'pos']), [
      { table: 'daily_credit_acknowledgements', eventType: 'INSERT', id: 'doc-2', shopId: 'shop-1', serviceDate: '2026-10-22' },
      { table: 'delivery_charges', eventType: 'UPDATE', id: 'charge-1' },
    ]);
    stop();
  });

  it('keeps focus catch-up as a full refresh even when batched with a known document', () => {
    const { mockClient, handlers } = createMockSupabase();
    const onPublish = vi.fn();
    const stop = createRealtimeSync(mockClient, onPublish, { debounceMs: 50 });
    handlers.get('daily_credit_acknowledgements')!({ eventType: 'INSERT', new: { id: 'doc-2' } });
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(50);
    expect(onPublish).toHaveBeenCalledWith(expect.arrayContaining(ALL_DATA_CHANGE_SCOPES), undefined);
    stop();
  });
});
