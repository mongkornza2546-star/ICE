import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bulkSaveShopIcePrices,
  loadPOSReadinessReport,
  saveIceTypePrice,
  saveShopIcePrice,
} from '../src/features/admin-reference-settings/adminReferenceSettingsService';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
  },
}));

function queryResult(data: unknown[], error: { message: string } | null = null) {
  const result = { data, error };
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order']) {
    query[method] = vi.fn(() => query);
  }
  query.then = (resolve: (value: typeof result) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return query;
}

describe('admin financial settings service', () => {
  beforeEach(() => {
    mocks.from.mockReset();
    mocks.rpc.mockReset();
  });

  it('uses atomic RPCs when setting standard and shop prices', async () => {
    mocks.rpc
      .mockReturnValueOnce({ single: vi.fn().mockResolvedValue({
        data: { id: 'price-1', ice_type_id: 'ice-1', unit_price: '40.00', valid_from: '2026-07-22', valid_to: null, is_active: true },
        error: null,
      }) })
      .mockReturnValueOnce({ single: vi.fn().mockResolvedValue({
        data: { id: 'price-2', shop_id: 'shop-1', ice_type_id: 'ice-1', unit_price: '35.00', valid_from: '2026-07-22', valid_to: null, is_active: true },
        error: null,
      }) });

    await saveIceTypePrice({ ice_type_id: 'ice-1', unit_price: 40, valid_from: '2026-07-22', valid_to: null });
    await saveShopIcePrice({ shop_id: 'shop-1', ice_type_id: 'ice-1', unit_price: 35, valid_from: '2026-07-22', valid_to: null });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'set_ice_type_price', {
      target_ice_type_id: 'ice-1',
      target_unit_price: 40,
      target_valid_from: '2026-07-22',
      target_valid_to: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'set_shop_ice_type_price', {
      target_shop_id: 'shop-1',
      target_ice_type_id: 'ice-1',
      target_unit_price: 35,
      target_valid_from: '2026-07-22',
      target_valid_to: null,
    });
  });

  it('uses one RPC for bulk shop prices', async () => {
    mocks.rpc.mockResolvedValue({ data: 2, error: null });

    const savedCount = await bulkSaveShopIcePrices(['shop-1', 'shop-2'], {
      ice_type_id: 'ice-1',
      unit_price: 35,
      valid_from: '2026-07-22',
      valid_to: null,
    });

    expect(savedCount).toBe(2);
    expect(mocks.rpc).toHaveBeenCalledWith('bulk_set_shop_ice_type_price', {
      target_shop_ids: ['shop-1', 'shop-2'],
      target_ice_type_id: 'ice-1',
      target_unit_price: 35,
      target_valid_from: '2026-07-22',
      target_valid_to: null,
    });
  });

  it('fails readiness instead of treating query errors as empty datasets', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'shops') return queryResult([], { message: 'shops unavailable' });
      return queryResult([]);
    });

    await expect(loadPOSReadinessReport('2026-07-22')).rejects.toThrow('shops unavailable');
  });

  it('calculates readiness for the explicitly requested service date', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'shops') return queryResult([{ id: 'shop-1', code: 'S01', name: 'ร้าน', buildings: { name: 'ตึก' }, building_zones: { name: 'โซน' } }]);
      if (table === 'shop_payment_profiles') return queryResult([{ shop_id: 'shop-1' }]);
      if (table === 'ice_types') return queryResult([{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง' }]);
      if (table === 'ice_type_prices') return queryResult([{ ice_type_id: 'ice-1', valid_from: '2026-07-22', valid_to: '2026-07-22' }]);
      return queryResult([]);
    });

    const report = await loadPOSReadinessReport('2026-07-22');
    expect(report.shops_ready_count).toBe(1);
    expect(report.ice_types_missing_standard_price).toBe(0);
  });
});
