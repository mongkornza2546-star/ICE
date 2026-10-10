import { beforeEach, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => {
  const maybeSingle = vi.fn();
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  return { maybeSingle, eq, select, from: vi.fn(() => ({ select })), rpc: vi.fn() };
});

vi.mock('../src/lib/supabase', () => ({ supabase: database }));

import { createSupabaseGateway } from '../src/EmployeeDeliveryWorkspace';

beforeEach(() => {
  vi.clearAllMocks();
});

it.each([
  [['credit'], true],
  [['end_of_day', 'immediate'], false],
  [null, false],
])('reads credit eligibility without delivery or stock RPCs (%j)', async (terms, expected) => {
  database.maybeSingle.mockResolvedValue({
    data: terms ? { allowed_payment_terms: terms } : null, error: null,
  });
  const gateway = createSupabaseGateway();
  expect(await gateway.loadShopCreditEligibility!('shop-1')).toBe(expected);
  expect(database.from).toHaveBeenCalledWith('shop_payment_profiles');
  expect(database.eq).toHaveBeenCalledWith('shop_id', 'shop-1');
  expect(database.rpc).not.toHaveBeenCalled();
});

it('propagates lookup failures instead of treating them as a non-credit shop', async () => {
  const error = new Error('Network unavailable');
  database.maybeSingle.mockResolvedValue({ data: null, error });
  await expect(createSupabaseGateway().loadShopCreditEligibility!('shop-1')).rejects.toBe(error);
});
