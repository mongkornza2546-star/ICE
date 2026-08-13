import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShopSettings } from '../src/ShopSettings';

const {
  createSignedUrlMock,
  exportShopDirectoryMock,
  fromMock,
  loadPOSReadinessReportMock,
  loadShopDirectoryExportDataMock,
  shopRangeMock,
  storageFromMock,
} = vi.hoisted(() => ({
  createSignedUrlMock: vi.fn(),
  exportShopDirectoryMock: vi.fn(),
  fromMock: vi.fn(),
  loadPOSReadinessReportMock: vi.fn(),
  loadShopDirectoryExportDataMock: vi.fn(),
  shopRangeMock: vi.fn(),
  storageFromMock: vi.fn(),
}));

vi.mock('../src/lib/env', () => ({
  env: { isDemoMode: false },
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: { from: fromMock, storage: { from: storageFromMock } },
}));

vi.mock('../src/features/admin-reference-settings/adminReferenceSettingsService', () => ({
  getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
  getShopImagePublicUrls: vi.fn().mockResolvedValue({}),
  loadShopIcePrices: vi.fn().mockResolvedValue([]),
  loadShopPaymentProfile: vi.fn().mockResolvedValue(null),
  loadPOSReadinessReport: loadPOSReadinessReportMock,
}));

vi.mock('../src/features/shop-settings/exportShopDirectory', () => ({
  exportShopDirectory: exportShopDirectoryMock,
}));

vi.mock('../src/features/shop-settings/loadShopDirectoryExportData', () => ({
  loadShopDirectoryExportData: loadShopDirectoryExportDataMock,
}));

function queryResult(data: unknown[], trackRange = false, failedRange?: [number, number]) {
  let requestedRange: [number, number] | null = null;
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    ilike: vi.fn(),
    order: vi.fn(),
    range: vi.fn((from: number, to: number) => {
      requestedRange = [from, to];
      if (trackRange) shopRangeMock(from, to);
      return query;
    }),
    then: (onFulfilled: (value: { data: unknown[] | null; error: { message: string } | null; count: number }) => unknown, onRejected?: (reason: unknown) => unknown) => {
      if (requestedRange && failedRange && requestedRange[0] === failedRange[0] && requestedRange[1] === failedRange[1]) {
        return Promise.resolve({ data: null, error: { message: 'โหลดหน้าร้านไม่สำเร็จ' }, count: data.length }).then(onFulfilled, onRejected);
      }
      const rows = requestedRange ? data.slice(requestedRange[0], requestedRange[1] + 1) : data;
      return Promise.resolve({ data: rows, error: null, count: data.length }).then(onFulfilled, onRejected);
    },
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.ilike.mockReturnValue(query);
  query.order.mockReturnValue(query);
  return query;
}

describe('ShopSettings shop status summary and filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    }[table] ?? [], table === 'shops'));
    createSignedUrlMock.mockResolvedValue({ data: { signedUrl: 'https://example.com/tank.jpg' }, error: null });
    storageFromMock.mockReturnValue({ createSignedUrl: createSignedUrlMock });

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
    loadShopDirectoryExportDataMock.mockResolvedValue({
      buildings: [{ id: 'building-old', code: 'OLD', name: 'อาคารเดิม' }],
      zones: [{ id: 'zone-old', building_id: 'building-old', code: 'OLD', name: 'โซนเดิม', sort_order: 1, is_active: false }],
      paymentProfiles: [],
      standardPrices: [],
      shopPrices: [],
    });
    exportShopDirectoryMock.mockResolvedValue(undefined);
  });

  it('counts inactive shops in the total while keeping POS percentages active-only', async () => {
    render(<ShopSettings />);

    const totalCard = await screen.findByText('ร้านค้าทั้งหมด').then((label) => label.closest('article'));
    const readyCard = screen.getByText('พร้อมใช้งาน POS').closest('article');

    expect(totalCard).not.toBeNull();
    expect(readyCard).not.toBeNull();
    expect(within(totalCard!).getByText('3')).not.toBeNull();
    expect(within(readyCard!).getByText(/50%/)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'ส่งออก Excel' })).not.toBeNull();
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

  it('loads only the current shop page and fetches the next page on demand', async () => {
    const shops = Array.from({ length: 13 }, (_, index) => ({
      id: `shop-${index + 1}`,
      code: `A${String(index + 1).padStart(2, '0')}`,
      name: `ร้าน ${index + 1}`,
      image_path: null,
      building_id: 'building-1',
      zone_id: 'zone-1',
      floor_or_zone: 'ชั้น 1',
      government_shop_code: null,
      contact_name: null,
      contact_phone: null,
      delivery_sequence: index + 1,
      normal_rounds_per_day: 1,
      access_note: null,
      status: 'active',
    }));
    fromMock.mockImplementation((table: string) => queryResult({
      shops,
      buildings: [{ id: 'building-1', code: 'A', name: 'อาคาร A' }],
      building_zones: [{ id: 'zone-1', building_id: 'building-1', code: '1', name: 'ชั้น 1', sort_order: 1, is_active: true }],
      ice_types: [],
      shop_rented_tanks: [],
    }[table] ?? [], table === 'shops'));

    const user = userEvent.setup();
    render(<ShopSettings />);

    expect(await screen.findByRole('button', { name: 'A12 ร้าน 12' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'A13 ร้าน 13' })).toBeNull();
    expect(shopRangeMock).toHaveBeenCalledWith(0, 11);
    expect(fromMock.mock.calls.some(([table]) => table === 'shop_rented_tanks')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'ถัดไป ›' }));

    expect(await screen.findByRole('button', { name: 'A13 ร้าน 13' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'A12 ร้าน 12' })).toBeNull();
    expect(shopRangeMock).toHaveBeenCalledWith(12, 23);
  });

  it('keeps the committed page and shows a retryable error when the next page fails', async () => {
    const shops = Array.from({ length: 13 }, (_, index) => ({
      id: `shop-${index + 1}`,
      code: `A${String(index + 1).padStart(2, '0')}`,
      name: `ร้าน ${index + 1}`,
      image_path: null,
      building_id: 'building-1',
      zone_id: 'zone-1',
      floor_or_zone: 'ชั้น 1',
      government_shop_code: null,
      contact_name: null,
      contact_phone: null,
      delivery_sequence: index + 1,
      normal_rounds_per_day: 1,
      access_note: null,
      status: 'active',
    }));
    fromMock.mockImplementation((table: string) => queryResult({
      shops,
      buildings: [{ id: 'building-1', code: 'A', name: 'อาคาร A' }],
      building_zones: [{ id: 'zone-1', building_id: 'building-1', code: '1', name: 'ชั้น 1', sort_order: 1, is_active: true }],
      ice_types: [],
      shop_rented_tanks: [],
    }[table] ?? [], table === 'shops', table === 'shops' ? [12, 23] : undefined));

    const user = userEvent.setup();
    render(<ShopSettings />);
    await screen.findByRole('button', { name: 'A01 ร้าน 1' });

    await user.click(screen.getByRole('button', { name: 'ถัดไป ›' }));

    expect((await screen.findByRole('alert')).textContent).toContain('โหลดหน้าร้านไม่สำเร็จ');
    expect(screen.getByText('หน้า 1 / 2')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'A01 ร้าน 1' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'A13 ร้าน 13' })).toBeNull();
    expect(screen.getByRole('button', { name: 'ลองใหม่' })).not.toBeNull();
  });

  it('pages the complete directory before exporting', async () => {
    const shops = Array.from({ length: 501 }, (_, index) => ({
      id: `shop-${index + 1}`,
      code: `A${String(index + 1).padStart(3, '0')}`,
      name: `ร้าน ${index + 1}`,
      image_path: null,
      building_id: 'building-1',
      zone_id: 'zone-1',
      floor_or_zone: 'ชั้น 1',
      government_shop_code: null,
      contact_name: null,
      contact_phone: null,
      delivery_sequence: index + 1,
      normal_rounds_per_day: 1,
      access_note: null,
      status: 'active',
    }));
    fromMock.mockImplementation((table: string) => queryResult({
      shops,
      buildings: [{ id: 'building-1', code: 'A', name: 'อาคาร A' }],
      building_zones: [{ id: 'zone-1', building_id: 'building-1', code: '1', name: 'ชั้น 1', sort_order: 1, is_active: true }],
      ice_types: [],
      shop_rented_tanks: [],
    }[table] ?? [], table === 'shops'));

    const user = userEvent.setup();
    render(<ShopSettings />);
    await user.click(await screen.findByRole('button', { name: 'ส่งออก Excel' }));

    await waitFor(() => expect(exportShopDirectoryMock).toHaveBeenCalledTimes(1));
    expect(shopRangeMock).toHaveBeenCalledWith(0, 499);
    expect(shopRangeMock).toHaveBeenCalledWith(500, 999);
    expect(exportShopDirectoryMock.mock.calls[0][0].shops).toHaveLength(501);
  });

  it('opens a shop without loading every shop or tank image URLs', async () => {
    fromMock.mockImplementation((table: string) => queryResult({
      shops: [
        { id: 'shop-1', code: 'A01', name: 'ร้านเปิดหนึ่ง', image_path: null, building_id: 'building-1', zone_id: 'zone-1', floor_or_zone: 'ชั้น 1', government_shop_code: null, contact_name: null, contact_phone: null, delivery_sequence: 1, normal_rounds_per_day: 1, access_note: null, status: 'active' },
      ],
      buildings: [{ id: 'building-1', code: 'A', name: 'อาคาร A' }],
      building_zones: [{ id: 'zone-1', building_id: 'building-1', code: '1', name: 'ชั้น 1', sort_order: 1, is_active: true }],
      ice_types: [],
      shop_rented_tanks: [{ id: 'tank-1', shop_id: 'shop-1', tank_code: 'T01', image_path: 'shop-1/tank.jpg', rented_at: '2026-08-01' }],
    }[table] ?? [], table === 'shops'));

    const user = userEvent.setup();
    render(<ShopSettings />);
    await user.click(await screen.findByRole('button', { name: 'A01 ร้านเปิดหนึ่ง' }));

    expect(await screen.findByRole('dialog', { name: 'แก้ไข ร้านเปิดหนึ่ง' })).not.toBeNull();
    expect(fromMock.mock.calls.filter(([table]) => table === 'shops')).toHaveLength(1);
    expect(createSignedUrlMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'ถังเช่าและรูปภาพ' }));
    await waitFor(() => expect(createSignedUrlMock).toHaveBeenCalledTimes(1));
  });

  it('loads complete live export data before building the workbook', async () => {
    const user = userEvent.setup();
    render(<ShopSettings />);

    await user.click(await screen.findByRole('button', { name: 'ส่งออก Excel' }));

    await waitFor(() => expect(exportShopDirectoryMock).toHaveBeenCalledTimes(1));
    expect(loadShopDirectoryExportDataMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: fromMock }),
      expect.arrayContaining([expect.objectContaining({ id: 'shop-1' }), expect.objectContaining({ id: 'shop-3' })]),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
    expect(exportShopDirectoryMock).toHaveBeenCalledWith(expect.objectContaining({
      buildings: [{ id: 'building-old', code: 'OLD', name: 'อาคารเดิม' }],
      zones: [expect.objectContaining({ id: 'zone-old', is_active: false })],
    }));
    expect(await screen.findByText('ส่งออกข้อมูลร้านค้า 3 ร้านแล้ว')).not.toBeNull();
  });

  it('shows an error and skips the workbook when live export data cannot be completed', async () => {
    loadShopDirectoryExportDataMock.mockRejectedValueOnce(new Error('ข้อมูลเปลี่ยนระหว่างส่งออก กรุณาลองใหม่'));
    const user = userEvent.setup();
    render(<ShopSettings />);

    await user.click(await screen.findByRole('button', { name: 'ส่งออก Excel' }));

    expect((await screen.findByRole('alert')).textContent).toContain('ข้อมูลเปลี่ยนระหว่างส่งออก กรุณาลองใหม่');
    expect(exportShopDirectoryMock).not.toHaveBeenCalled();
  });
});
