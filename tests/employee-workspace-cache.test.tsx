import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useEmployeeDeliveryData } from '../src/features/employee-delivery/useEmployeeDeliveryData';
import { readCachedEmployeeReferenceData, writeCachedEmployeeReferenceData, writeCachedEmployeeShopCards } from '../src/lib/employeeWorkspaceCache';
import type { EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';
import type { DeliveryRound, ShopCard } from '../src/types/app';

afterEach(() => vi.useRealTimers());

it('removes expired entries from previous dates when writing new data', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-16T00:00:00Z'));
  writeCachedEmployeeReferenceData('review', '2026-09-16', { rounds: [], iceTypes: [] });
  writeCachedEmployeeShopCards('review', '2026-09-16', 'old-round', []);
  window.localStorage.setItem('unrelated', 'preserve');
  vi.setSystemTime(new Date('2026-09-17T00:00:01Z'));
  writeCachedEmployeeReferenceData('review', '2026-09-17', { rounds: [], iceTypes: [] });
  expect(window.localStorage.length).toBe(2);
  expect(window.localStorage.getItem('unrelated')).toBe('preserve');
  expect(readCachedEmployeeReferenceData('review', '2026-09-17')).toEqual({ rounds: [], iceTypes: [] });
});

it('bounds storage growth across many rounds within the cache lifetime', () => {
  for (let index = 0; index < 100; index += 1) {
    writeCachedEmployeeShopCards('review', '2026-09-17', `round-${index}`, []);
  }
  expect(window.localStorage.length).toBeLessThanOrEqual(50);
});

it('keeps an in-progress draft when startup reference revalidation resolves', async () => {
  const reference = {
    rounds: [{ id: 'r', service_date: '2026-09-17', name: 'Daily', round_type: 'daily', status: 'open' } as DeliveryRound],
    iceTypes: [{ id: 'ice', code: 'ICE', name: 'Ice', unit: 'bag' }],
  };
  const card = {
    round_stop_id: 'stop', shop_id: 'shop', shop_code: 'S1', shop_name: 'Shop',
    building_id: 'b', building_name: 'Building', floor_or_zone: '1', sequence_no: 1,
    image_path: null, image_url: null, payment_status: 'unpaid', stop_status: 'pending',
    stop_note: null, today_history: [], today_totals: {},
  } as ShopCard;
  writeCachedEmployeeReferenceData('review', '2026-09-17', reference);
  writeCachedEmployeeShopCards('review', '2026-09-17', 'r', [card]);
  let resolveReference!: (data: typeof reference) => void;
  const gateway = {
    loadReferenceData: vi.fn(() => new Promise<typeof reference>(resolve => { resolveReference = resolve; })),
    loadShopCards: vi.fn(() => new Promise<ShopCard[]>(() => {})),
  } as unknown as EmployeeDeliveryGateway;
  const { result } = renderHook(() => useEmployeeDeliveryData({
    gateway, enableAssignedStockFlow: false, requestScope: 'review',
    serviceDate: '2026-09-17', stockSourceLabel: 'Stock',
  }));
  act(() => { result.current.openCard(card); });
  act(() => { result.current.setNote('Customer asked for delivery at 10'); });
  act(() => { result.current.setDeliveryQuantity('ice', 3); });
  expect(result.current.selectedCardId).toBe('stop');
  await act(async () => { resolveReference(structuredClone(reference)); });
  expect(result.current.selectedCardId).toBe('stop');
  expect(result.current.note).toBe('Customer asked for delivery at 10');
  expect(result.current.deliveryQuantities.ice).toBe(3);
});

it('treats disabled browser storage as a cache miss', () => {
  const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new DOMException('Storage disabled', 'SecurityError');
  });
  try {
    expect(() => readCachedEmployeeReferenceData('review', '2026-09-17')).not.toThrow();
  } finally {
    spy.mockRestore();
  }
});
