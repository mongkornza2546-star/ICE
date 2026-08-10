import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShopSettings } from '../src/ShopSettings';

const { fromMock, loadPOSReadinessReportMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  loadPOSReadinessReportMock: vi.fn(),
}));

vi.mock('../src/lib/env', () => ({
  env: { isDemoMode: false },
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: { from: fromMock },
}));

vi.mock('../src/features/admin-reference-settings/adminReferenceSettingsService', () => ({
  getShopImageSignedUrls: vi.fn().mockResolvedValue({}),
  loadPOSReadinessReport: loadPOSReadinessReportMock,
}));

function queryResult(data: unknown[]) {
  const result = Promise.resolve({ data, error: null });
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    order: vi.fn(),
    then: result.then.bind(result),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.order.mockReturnValue(query);
  return query;
}

describe('ShopSettings shop status summary and filter', () => {
  beforeEach(() => {
    const shops = [
      { id: 'shop-1', code: 'A01', name: 'ร้านเปิดหนึ่ง', image_path: null, building_id: 'building-1', zone_id: 'zone-1', floor_or_zone: 'ชั้น 1', government_shop_code: null, contact_name: null, contact_phone: null, delivery_sequence: 1, normal_rounds_per_day: 1, access_note: null, status: 'active' },
      { id: 'shop-2', code: 'A02', name: 'ร้านเปิดสอง', image_path: null, building_id: 'building-1', zone_id: 'zone-1', floor_or_zone: 'ชั้น 1', government_shop_code: null, contact_name: null, contact_phone: null, delivery_sequence: 2, normal_rounds_per_day: 1, access_note: null, status: 'active' },
      { id: 'shop-3', code: 'A03', name: 'ร้านปิดแล้ว', image_path: null, building_id: 'building-1', zone_id: 'zone-1', floor_or_zone: 'ชั้น 1', government_shop_code: null, contact_name: null, contact_phone: null, delivery_sequence: 3, normal_rounds_per_day: 1, access_note: null, status: 'inactive' },
    ];

    fromMock.mockImplementation((table: string) => queryResult({
      shops,
      buildings: [{ id: 'building-1', code: 'A', name: 'อาคาร A' }],
      building_zones: [{ id: 'zone-1', building_id: 'building-1', code: '1', name: 'ชั้น 1', sort_order: 1, is_active: true }],
      ice_types: [],
      shop_rented_tanks: [],
    }[table] ?? []));

    loadPOSReadinessReportMock.mockResolvedValue({
      total_active_shops: 2,
      shops_ready_count: 1,
      shops_missing_payment_profile: 1,
      ice_types_missing_standard_price: 0,
      items: [
        { shop_id: 'shop-1', shop_code: 'A01', shop_name: 'ร้านเปิดหนึ่ง', has_payment_profile: true, missing_special_prices_count: 0, has_issues: false, issue_details: [] },
        { shop_id: 'shop-2', shop_code: 'A02', shop_name: 'ร้านเปิดสอง', has_payment_profile: false, missing_special_prices_count: 0, has_issues: true, issue_details: ['ยังไม่มี Payment Profile'] },
      ],
    });
  });

  it('counts inactive shops in the total while keeping POS percentages active-only', async () => {
    render(<ShopSettings />);

    const totalCard = await screen.findByText('ร้านค้าทั้งหมด').then((label) => label.closest('article'));
    const readyCard = screen.getByText('พร้อมใช้งาน POS').closest('article');

    expect(totalCard).not.toBeNull();
    expect(readyCard).not.toBeNull();
    expect(within(totalCard!).getByText('3')).not.toBeNull();
    expect(within(readyCard!).getByText(/50%/)).not.toBeNull();
  });

  it('filters the directory by active or inactive shop status', async () => {
    const user = userEvent.setup();
    render(<ShopSettings />);

    const statusFilter = await screen.findByRole('combobox', { name: 'กรองสถานะร้าน' });
    await user.selectOptions(statusFilter, 'inactive');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'A03 ร้านปิดแล้ว' })).not.toBeNull();
      expect(screen.queryByRole('button', { name: 'A01 ร้านเปิดหนึ่ง' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'A02 ร้านเปิดสอง' })).toBeNull();
    });
  });
});
