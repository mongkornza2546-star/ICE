import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exportShopDirectory } from '../src/features/shop-settings/exportShopDirectory';
import type { ShopSetting } from '../src/types/app';

const { writeXlsxFileMock } = vi.hoisted(() => ({ writeXlsxFileMock: vi.fn() }));

vi.mock('write-excel-file', () => ({ default: writeXlsxFileMock }));

type CapturedCell = { value?: unknown; format?: string };

const shops: ShopSetting[] = [
  {
    id: 'shop-2', code: 'A10', name: 'ร้านสอง', image_path: null,
    building_id: 'building-1', zone_id: 'zone-1', floor_or_zone: 'โซนเก่า',
    government_shop_code: null, contact_name: null, contact_phone: null,
    delivery_sequence: 2, normal_rounds_per_day: 1, access_note: null, status: 'active',
  },
  {
    id: 'shop-1', code: '=A2', name: '+ร้านหนึ่ง', image_path: null,
    building_id: 'building-1', zone_id: 'zone-1', floor_or_zone: 'โซนเก่า',
    government_shop_code: null, contact_name: null, contact_phone: null,
    delivery_sequence: 1, normal_rounds_per_day: 1, access_note: null, status: 'active',
  },
];

beforeEach(() => {
  writeXlsxFileMock.mockReset();
  writeXlsxFileMock.mockResolvedValue(undefined);
});

describe('shop directory workbook export', () => {
  it('exports shop identity, payment conditions, effective prices, and price sources', async () => {
    await exportShopDirectory({
      shops,
      buildings: [{ id: 'building-1', code: 'A', name: 'อาคาร A' }],
      zones: [{ id: 'zone-1', building_id: 'building-1', code: '1', name: 'โซน 1', sort_order: 1, is_active: true }],
      iceTypes: [
        { id: 'ice-b', code: 'B', name: 'น้ำแข็ง B', unit: 'ถุง' },
        { id: 'ice-a', code: 'A', name: 'น้ำแข็ง A', unit: 'ถุง' },
      ],
      paymentProfiles: [{
        shop_id: 'shop-1',
        allowed_payment_terms: ['credit'],
        default_payment_term: 'credit',
        credit_due_rule: 'weekly',
        credit_days: null,
        credit_collection_weekday: 5,
      }],
      standardPrices: [
        { ice_type_id: 'ice-a', unit_price: 20, valid_from: '2026-01-01', valid_to: null, is_active: true },
        { ice_type_id: 'ice-b', unit_price: 40, valid_from: '2026-01-01', valid_to: null, is_active: true },
      ],
      shopPrices: [
        { shop_id: 'shop-1', ice_type_id: 'ice-a', unit_price: 25, valid_from: '2026-08-01', valid_to: null, is_active: true },
        { shop_id: 'shop-1', ice_type_id: 'ice-b', unit_price: 50, valid_from: '2026-01-01', valid_to: '2026-07-31', is_active: true },
      ],
      effectiveDate: '2026-08-11',
    });

    const [data, options] = writeXlsxFileMock.mock.calls[0] as [CapturedCell[][], Record<string, unknown>];
    expect(data[2].map((cell) => cell.value)).toEqual([
      'ตึก', 'ชื่อร้าน', 'โซน', 'รหัสร้าน', 'เงื่อนไขชำระ',
      'น้ำแข็ง A · ราคา (บาท/ถุง)', 'น้ำแข็ง A · แหล่งราคา',
      'น้ำแข็ง B · ราคา (บาท/ถุง)', 'น้ำแข็ง B · แหล่งราคา',
    ]);
    expect(data[3].map((cell) => cell.value)).toEqual([
      'อาคาร A', "'+ร้านหนึ่ง", 'โซน 1', "'=A2",
      'เครดิต (ค่าเริ่มต้น) · รอบเก็บเงิน: ทุกวันศุกร์',
      25, 'ราคาพิเศษร้าน', 40, 'ราคากลาง',
    ]);
    expect(data[3][5]).toMatchObject({ value: 25, format: '#,##0.00' });
    expect(data[4][4].value).toBe('ยังไม่ได้ตั้งค่า');
    expect(options).toMatchObject({
      fileName: 'ข้อมูลร้านค้า-2026-08-11.xlsx',
      sheet: 'ร้านค้า',
      stickyColumnsCount: 5,
      stickyRowsCount: 3,
    });
  });
});
