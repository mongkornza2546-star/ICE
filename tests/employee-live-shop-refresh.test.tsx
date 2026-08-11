import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';

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

  const client = {
    rpc: vi.fn(),
    storage: {
      from: vi.fn(() => ({ createSignedUrls: vi.fn() })),
    },
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  };

  return { channel, client, state };
});

vi.mock('../src/lib/supabase', () => ({ supabase: supabaseMock.client }));

import {
  EmployeeDeliveryWorkspace,
  createSupabaseGateway,
} from '../src/EmployeeDeliveryWorkspace';

beforeEach(() => {
  supabaseMock.state.postgresChangeListener = null;
  supabaseMock.client.rpc.mockReset();
});

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

  it('reloads the selected round after a shop change and browser focus', async () => {
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
    await waitFor(() => expect(loadShopCards).toHaveBeenCalledTimes(3));
  });
});
