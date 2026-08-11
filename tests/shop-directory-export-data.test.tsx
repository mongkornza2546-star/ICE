import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { loadShopDirectoryExportData } from '../src/features/shop-settings/loadShopDirectoryExportData';
import type { ShopSetting } from '../src/types/app';

type FakeRow = { id: string; [key: string]: unknown };

function createFakeClient(tables: Record<string, FakeRow[]>, truncateShopPrices = false) {
  const rangeCalls: Record<string, Array<[number, number]>> = {};
  const filters: Array<[string, string, unknown]> = [];

  const from = vi.fn((table: string) => {
    let rows = [...(tables[table] ?? [])];
    let includeCount = false;
    const query = {
      select: vi.fn((_columns: string, options?: { count?: string }) => {
        includeCount = options?.count === 'exact';
        return query;
      }),
      in: vi.fn((column: string, values: unknown[]) => {
        filters.push([table, `in:${column}`, values]);
        rows = rows.filter((row) => values.includes(row[column]));
        return query;
      }),
      eq: vi.fn((column: string, value: unknown) => {
        filters.push([table, `eq:${column}`, value]);
        rows = rows.filter((row) => row[column] === value);
        return query;
      }),
      lte: vi.fn((column: string, value: unknown) => {
        filters.push([table, `lte:${column}`, value]);
        rows = rows.filter((row) => String(row[column]) <= String(value));
        return query;
      }),
      or: vi.fn((value: string) => {
        filters.push([table, 'or', value]);
        return query;
      }),
      order: vi.fn(() => {
        rows.sort((left, right) => left.id.localeCompare(right.id));
        return query;
      }),
      range: vi.fn(async (fromIndex: number, toIndex: number) => {
        rangeCalls[table] = [...(rangeCalls[table] ?? []), [fromIndex, toIndex]];
        const data = truncateShopPrices && table === 'shop_ice_type_prices' && fromIndex > 0
          ? []
          : rows.slice(fromIndex, toIndex + 1);
        return { data, error: null, count: includeCount ? rows.length : null };
      }),
    };
    return query;
  });

  return { client: { from } as unknown as SupabaseClient, filters, rangeCalls };
}

const shop: ShopSetting = {
  id: 'shop-1', code: 'S001', name: 'ร้านเก่า', image_path: null,
  building_id: 'building-old', zone_id: 'zone-old', floor_or_zone: 'ชื่อเดิม',
  government_shop_code: null, contact_name: null, contact_phone: null,
  delivery_sequence: 1, normal_rounds_per_day: 1, access_note: null, status: 'inactive',
};

function exportTables() {
  return {
    buildings: [{ id: 'building-old', code: 'OLD', name: 'อาคารเดิม', is_active: false }],
    building_zones: [{ id: 'zone-old', building_id: 'building-old', code: 'OLD', name: 'โซนเดิม', sort_order: 1, is_active: false }],
    shop_payment_profiles: [{
      id: 'profile-1', shop_id: 'shop-1', allowed_payment_terms: ['immediate'],
      default_payment_term: 'immediate', credit_due_rule: null, credit_days: null,
      credit_collection_weekday: null,
    }],
    ice_type_prices: [{
      id: 'standard-1', ice_type_id: 'ice-1', unit_price: '30.00',
      valid_from: '2026-01-01', valid_to: null, is_active: true,
    }],
    shop_ice_type_prices: Array.from({ length: 501 }, (_, index) => ({
      id: `special-${String(index).padStart(3, '0')}`,
      shop_id: 'shop-1', ice_type_id: `ice-${index}`, unit_price: '35.00',
      valid_from: '2026-01-01', valid_to: null, is_active: true,
    })),
  } satisfies Record<string, FakeRow[]>;
}

describe('shop directory export data loading', () => {
  it('paginates effective prices and resolves inactive location records for loaded shops', async () => {
    const { client, filters, rangeCalls } = createFakeClient(exportTables());

    const data = await loadShopDirectoryExportData(client, [shop], '2026-08-11');

    expect(data.buildings).toEqual([expect.objectContaining({ id: 'building-old', name: 'อาคารเดิม' })]);
    expect(data.zones).toEqual([expect.objectContaining({ id: 'zone-old', name: 'โซนเดิม', is_active: false })]);
    expect(data.shopPrices).toHaveLength(501);
    expect(data.shopPrices[0].unit_price).toBe(35);
    expect(rangeCalls.shop_ice_type_prices).toEqual([[0, 499], [500, 999]]);
    expect(filters).toContainEqual(['shop_ice_type_prices', 'in:shop_id', ['shop-1']]);
    expect(filters).toContainEqual(['shop_ice_type_prices', 'lte:valid_from', '2026-08-11']);
    expect(filters).toContainEqual(['shop_ice_type_prices', 'or', 'valid_to.is.null,valid_to.gte.2026-08-11']);
  });

  it('fails instead of exporting when a later page is incomplete', async () => {
    const { client } = createFakeClient(exportTables(), true);

    await expect(loadShopDirectoryExportData(client, [shop], '2026-08-11'))
      .rejects.toThrow('ข้อมูลเปลี่ยนระหว่างส่งออก กรุณาลองใหม่');
  });
});
