import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { publishDataChange, type DataChangeScope } from './dataChange';

export const ALL_DATA_CHANGE_SCOPES: DataChangeScope[] = [
  'accounting',
  'payment',
  'receivable',
  'refund',
  'stock',
  'pos',
];

export const REALTIME_TABLE_SCOPES: Record<string, DataChangeScope[]> = {
  payments: ['payment', 'receivable', 'accounting'],
  payment_allocations: ['payment', 'receivable', 'accounting'],
  delivery_charges: ['receivable', 'accounting', 'pos'],
  delivery_events: ['pos', 'stock', 'accounting'],
  delivery_rounds: ['pos', 'stock', 'accounting'],
  round_stops: ['pos', 'stock', 'accounting'],
  stock_movements: ['stock', 'accounting'],
  daily_credit_acknowledgements: ['receivable', 'accounting'],
  casual_transactions: ['pos', 'accounting'],
  shop_tank_rentals: ['receivable', 'pos', 'accounting'],
  shops: ['pos', 'accounting'],
};

export interface RealtimeSyncOptions {
  channelName?: string;
  debounceMs?: number;
  tableScopeMap?: Record<string, DataChangeScope[]>;
  enableFocusCatchup?: boolean;
  focusCatchupCooldownMs?: number;
}

/**
 * Creates and manages a real-time subscription using Supabase Realtime Channels.
 * Debounces incoming Postgres change notifications to prevent cascading re-renders,
 * and optionally catches up on tab focus / wake-from-sleep.
 */
export function createRealtimeSync(
  client: SupabaseClient | null | undefined,
  onPublish: (scopes: DataChangeScope[]) => void = publishDataChange,
  options: RealtimeSyncOptions = {},
) {
  if (!client || typeof client.channel !== 'function') {
    return () => {};
  }

  const channelName = options.channelName ?? 'ice-global-realtime-sync';
  const debounceMs = options.debounceMs ?? 250;
  const tableScopeMap = options.tableScopeMap ?? REALTIME_TABLE_SCOPES;
  const enableFocusCatchup = options.enableFocusCatchup ?? true;
  const focusCatchupCooldownMs = options.focusCatchupCooldownMs ?? 15_000;

  const pendingScopes = new Set<DataChangeScope>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFocusCatchupAt = 0;

  const flush = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (pendingScopes.size === 0) return;
    const scopesToPublish = Array.from(pendingScopes);
    pendingScopes.clear();
    onPublish(scopesToPublish);
  };

  const schedulePublish = (scopes: DataChangeScope[]) => {
    for (const scope of scopes) {
      pendingScopes.add(scope);
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(flush, debounceMs);
  };

  let channel: ReturnType<typeof client.channel> | null = null;
  try {
    channel = client.channel(channelName);
    for (const [table, scopes] of Object.entries(tableScopeMap)) {
      if (typeof channel?.on === 'function') {
        channel = channel.on(
          'postgres_changes' as never,
          {
            event: '*',
            schema: 'public',
            table,
          },
          () => {
            schedulePublish(scopes);
          },
        );
      }
    }

    if (typeof channel?.subscribe === 'function') {
      channel.subscribe();
    }
  } catch {
    // Graceful fallback if channel creation fails
    channel = null;
  }

  const handleFocusOrVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - lastFocusCatchupAt < focusCatchupCooldownMs) return;
    lastFocusCatchupAt = now;
    schedulePublish(ALL_DATA_CHANGE_SCOPES);
  };

  if (enableFocusCatchup && typeof window !== 'undefined') {
    window.addEventListener('focus', handleFocusOrVisible);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleFocusOrVisible);
    }
  }

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    pendingScopes.clear();

    if (enableFocusCatchup && typeof window !== 'undefined') {
      window.removeEventListener('focus', handleFocusOrVisible);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleFocusOrVisible);
      }
    }

    if (channel && typeof client.removeChannel === 'function') {
      try {
        void client.removeChannel(channel);
      } catch {
        // Ignore errors during channel removal
      }
    }
  };
}

/**
 * Global singleton initializer for active application sessions.
 */
export function initGlobalRealtimeSync(options?: RealtimeSyncOptions) {
  return createRealtimeSync(supabase, publishDataChange, options);
}
