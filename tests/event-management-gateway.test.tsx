import { beforeEach, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => {
  const range = vi.fn();
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    range,
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValue(query);
  return {
    client: { from: vi.fn(() => query) },
    range,
  };
});

vi.mock('../src/lib/supabase', () => ({ supabase: supabaseMock.client }));

import { eventManagementGateway } from '../src/features/event-management/eventManagementGateway';

beforeEach(() => {
  supabaseMock.client.from.mockClear();
  supabaseMock.range.mockReset();
});

it('loads every page of active shops for the participation picker', async () => {
  const firstPage = Array.from({ length: 500 }, (_, index) => ({
    id: `shop-${index}`,
    code: `S${index}`,
    name: `Shop ${index}`,
    contact_name: null,
    contact_phone: null,
    status: 'active' as const,
  }));
  const finalShop = {
    id: 'shop-500',
    code: 'S500',
    name: 'Shop 500',
    contact_name: null,
    contact_phone: null,
    status: 'active' as const,
  };
  supabaseMock.range
    .mockResolvedValueOnce({ data: firstPage, error: null })
    .mockResolvedValueOnce({ data: [finalShop], error: null });

  const result = await eventManagementGateway.loadActiveShops();

  expect(result).toHaveLength(501);
  expect(result.at(-1)).toEqual(finalShop);
  expect(supabaseMock.range).toHaveBeenNthCalledWith(1, 0, 499);
  expect(supabaseMock.range).toHaveBeenNthCalledWith(2, 500, 999);
});
