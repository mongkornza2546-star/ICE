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
  [[{ charge_id: 'credit-invoice' }], true],
  [[], false],
  [null, false],
])('enables credit documents only when the shop has invoices on the selected date (%j)', async (invoices, expected) => {
  database.rpc.mockResolvedValue({ data: invoices, error: null });
  expect(await createSupabaseGateway().loadShopCreditEligibility!('shop-1', '2026-09-25')).toBe(expected);
  expect(database.rpc).toHaveBeenCalledWith('get_daily_credit_acknowledgement_details', {
    p_shop_id: 'shop-1', p_service_date: '2026-09-25',
  });
  expect(database.from).not.toHaveBeenCalled();
});

it('propagates credit lookup failures for retry', async () => {
  const error = new Error('Network unavailable');
  database.rpc.mockResolvedValue({ data: null, error });
  await expect(createSupabaseGateway().loadShopCreditEligibility!('shop-1', '2026-09-25')).rejects.toBe(error);
});

it.each([
  [[{ shop_id: 'shop-1', charges: [], statements: [] }], { shop_id: 'shop-1', charges: [], statements: [] }],
  [[{ shop_id: 'other-shop' }], null],
  [[], null],
  [null, null],
])('loads reusable billing data only for the requested shop (%j)', async (accounts, expected) => {
  database.rpc.mockResolvedValue({ data: accounts, error: null });
  expect(await createSupabaseGateway().loadShopBillingAccount!('shop-1')).toEqual(expected);
  expect(database.rpc).toHaveBeenCalledWith('get_employee_billing_accounts', { p_shop_id: 'shop-1' });
});

it('propagates billing lookup failures for retry', async () => {
  const error = new Error('Network unavailable');
  database.rpc.mockResolvedValue({ data: null, error });
  await expect(createSupabaseGateway().loadShopBillingAccount!('shop-1')).rejects.toBe(error);
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
