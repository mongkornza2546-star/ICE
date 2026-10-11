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

it('sends displayed VAT and gross total to the atomic checked delivery writer', async () => {
  database.rpc.mockResolvedValue({ data: { total_amount: 1070 }, error: null });
  await createSupabaseGateway().recordDelivery!({ destinationKind: 'regular', roundStopId: 'stop-1',
    items: [{ ice_type_id: 'ice-1', quantity: 40 }], status: 'delivered', note: null,
    clientRecordedAt: '2026-10-11T04:00:00Z', idempotencyKey: 'key', paymentTerm: 'credit',
    expectedVatRate: 7, expectedTotal: 1070,
  });
  expect(database.rpc).toHaveBeenCalledWith('record_delivery_with_vat_check', expect.objectContaining({
    p_expected_vat_rate: 7, p_expected_total: 1070, p_payment_term: 'credit',
  }));
});

it('routes legacy pending requests through the guard so a new sale cannot silently adopt a changed VAT rate', async () => {
  database.rpc.mockResolvedValue({ data: {}, error: null });
  await createSupabaseGateway().recordDelivery!({ destinationKind: 'regular', roundStopId: 'stop-1',
    items: [{ ice_type_id: 'ice-1', quantity: 1 }], status: 'delivered', note: null,
    clientRecordedAt: '2026-10-11T04:00:00Z', idempotencyKey: 'key', paymentTerm: 'credit',
  });
  expect(database.rpc).toHaveBeenCalledWith('record_delivery_with_vat_check', expect.objectContaining({
    p_expected_vat_rate: 0, p_expected_total: null,
  }));
});
