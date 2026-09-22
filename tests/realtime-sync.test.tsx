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
    const handlers = new Map<string, () => void>();
    const mockChannel = {
      on: vi.fn((_type: string, filter: { table: string }, callback: () => void) => {
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
});
