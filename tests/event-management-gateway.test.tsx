import { beforeEach, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => {
  const range = vi.fn();
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    order: vi.fn(),
    range,
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.order.mockReturnValue(query);
  return {
    client: { from: vi.fn(() => query), rpc: vi.fn() },
    query,
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

  expect(supabaseMock.query.is).toHaveBeenCalledWith('event_job_id', null);
  expect(result).toHaveLength(501);
  expect(result.at(-1)).toEqual(finalShop);
  expect(supabaseMock.range).toHaveBeenNthCalledWith(1, 0, 499);
  expect(supabaseMock.range).toHaveBeenNthCalledWith(2, 500, 999);
});

it('creates a batch atomically through its idempotent RPC', async () => {
  supabaseMock.client.rpc.mockResolvedValue({ data: { created_count: 300, skipped_count: 0 }, error: null });
  const rows = [{ name: '', booth_number: 'A1', event_zone: 'ตึก B', landmark: '', contact_name: '', contact_phone: '', start_date: '2026-09-07', end_date: '2026-09-07' }];
  await expect(eventManagementGateway.createEventShops('event-1', 'request-1', rows)).resolves.toEqual({ created_count: 300, skipped_count: 0 });
  expect(supabaseMock.client.rpc).toHaveBeenCalledWith('create_event_shops', { p_event_job_id: 'event-1', p_request_id: 'request-1', p_rows: rows });
});


it.each([undefined, 'ร้านจากเชียงใหม่'])('routes participation saves with shop name %s to the appropriate RPC', async (shopName) => {
  supabaseMock.client.rpc.mockResolvedValue({ data: { id: 'participation-1' }, error: null });
  await eventManagementGateway.saveParticipation({
    participation_id: 'participation-1', event_job_id: 'event-1', shop_id: 'shop-1',
    booth_number: 'A1', event_zone: 'B', landmark: '', contact_name: '', contact_phone: '',
    start_date: '2026-09-07', end_date: '2026-09-07', rents_tank_from_us: false,
    ...(shopName !== undefined ? { shop_name: shopName } : {}),
  });
  const [rpc, args] = supabaseMock.client.rpc.mock.calls.at(-1)!;
  expect(rpc).toBe(shopName === undefined ? 'save_event_participation' : 'save_event_participation_with_shop_name');
  expect(args).toMatchObject({ p_participation_id: 'participation-1', p_shop_id: 'shop-1' });
  if (shopName === undefined) expect(args).not.toHaveProperty('p_shop_name');
  else expect(args.p_shop_name).toBe(shopName);
});
