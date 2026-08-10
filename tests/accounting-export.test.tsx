import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exportAccountingShopDaily } from '../src/features/accounting/exportAccounting';
import type { AccountingShopDailyResponse, AccountingShopSummaryRow } from '../src/features/accounting/types';

const { writeXlsxFileMock } = vi.hoisted(() => ({ writeXlsxFileMock: vi.fn() }));

vi.mock('write-excel-file', () => ({ default: writeXlsxFileMock }));

type CapturedCell = { value?: unknown; format?: string };
type CapturedWorkbook = CapturedCell[][][];

function shop(overrides: Partial<AccountingShopSummaryRow>): AccountingShopSummaryRow {
  return {
    shop_id: 'shop-1',
    shop_code: 'S001',
    shop_name: 'ร้านหนึ่ง',
    building_id: 'building-1',
    building_name: 'อาคาร A',
    current_zone_id: 'zone-1',
    current_zone_name: 'ชั้น 1',
    historical_zone_name: 'ชั้น 1',
    building_sort_order: 1,
    zone_sort_order: 1,
    delivery_sequence: 1,
    payment_term: 'credit',
    employee_names: null,
    sales_amount: 0,
    paid_amount: 0,
    outstanding_amount: 0,
    overdue_amount: 0,
    invoice_count: 0,
    due_date: null,
    cumulative_outstanding_amount: 0,
    cumulative_overdue_amount: 0,
    oldest_outstanding_due_date: null,
    payment_status: 'paid',
    ...overrides,
  };
}

function capturedExport() {
  const [data, options] = writeXlsxFileMock.mock.calls[0];
  return {
    data: data as CapturedWorkbook,
    options: options as { sheets: string[] },
  };
}

beforeEach(() => {
  writeXlsxFileMock.mockReset();
  writeXlsxFileMock.mockResolvedValue(undefined);
});

describe('daily accounting workbook export', () => {
  it('uses area IDs, deterministic sort order, and XML-safe case-insensitive sheet names', async () => {
    const laterArea = shop({
      shop_id: 'shop-later', shop_code: 'S-LATER', building_id: 'building-later', building_name: 'A&B"',
      current_zone_id: 'zone-later', current_zone_name: 'Zone', building_sort_order: 2,
    });
    const firstArea = shop({
      shop_id: 'shop-first', shop_code: 'S-FIRST', building_id: 'building-first', building_name: 'a&b"',
      current_zone_id: 'zone-first', current_zone_name: 'Zone', building_sort_order: 1,
    });

    await exportAccountingShopDaily(
      [laterArea, firstArea],
      { ice_types: [], rows: [] },
      '2026-08-01',
      '2026-08-01',
    );

    const { data, options } = capturedExport();
    expect(options.sheets).toEqual(['สรุปทุกพื้นที่', 'a-b--Zone', 'A-B--Zone-2']);
    expect(new Set(options.sheets.map((name) => name.toLowerCase())).size).toBe(options.sheets.length);
    expect(options.sheets.every((name) => name.length <= 31 && !/[&<>"'\u0000-\u001F]/.test(name))).toBe(true);
    expect(data).toHaveLength(3);
    expect(data[1][3][1].value).toBe('S-FIRST');
    expect(data[2][3][1].value).toBe('S-LATER');
  });

  it('writes canonical ice columns, semantic formats, safe text, statuses, and complete totals', async () => {
    const firstShop = shop({
      shop_id: 'shop-1', shop_code: '=S001', shop_name: '+ร้านหนึ่ง', delivery_sequence: 3,
      sales_amount: 100.25, outstanding_amount: 20.25, cumulative_outstanding_amount: 30.5,
      cumulative_overdue_amount: 10.1, payment_status: 'overdue',
    });
    const secondShop = shop({
      shop_id: 'shop-2', shop_code: 'S002', shop_name: 'ร้านสอง', delivery_sequence: 4,
      sales_amount: 0, outstanding_amount: 5.75, cumulative_outstanding_amount: 15.25,
      cumulative_overdue_amount: 4.5, payment_status: 'outstanding',
    });
    const recordedNoSaleStatus = 'recorded_no_sale' as AccountingShopDailyResponse['rows'][number]['days'][number]['status'];
    const daily: AccountingShopDailyResponse = {
      ice_types: [
        { ice_type_id: 'ice-b', code: 'B', name: 'น้ำแข็ง B', unit: 'ถุง' },
        { ice_type_id: 'ice-a', code: 'A', name: 'น้ำแข็ง A', unit: 'ถุง' },
      ],
      rows: [
        {
          shop_id: 'shop-1', payment_condition: '@credit', days: [{
            service_date: '2026-08-01', status: 'purchased',
            items: [{ ice_type_id: 'ice-b', quantity: 2 }, { ice_type_id: 'ice-a', quantity: 1.5 }],
            sales_amount: 100.25, cash_received: 80.05, invoice_count: 1,
          }],
        },
        {
          shop_id: 'shop-2', payment_condition: 'credit', days: [{
            service_date: '2026-08-01', status: recordedNoSaleStatus, items: [],
            sales_amount: 0, cash_received: 5.15, invoice_count: 0,
          }],
        },
      ],
    };

    await exportAccountingShopDaily([firstShop, secondShop], daily, '2026-08-01', '2026-08-01');

    const { data } = capturedExport();
    const header = data[0][2];
    const firstRow = data[0][3];
    const secondRow = data[0][4];
    const totals = data[0][5];

    expect(header.slice(4, 8).map((cell) => cell.value)).toEqual([
      '2026-08-01 · น้ำแข็ง A', '2026-08-01 · น้ำแข็ง B',
      '2026-08-01 · ยอดขาย', '2026-08-01 · รับเงินจริง',
    ]);
    expect(firstRow[0]).toMatchObject({ value: 3, format: '#,##0' });
    expect(firstRow[1].value).toBe("'=S001");
    expect(firstRow[2].value).toBe("'+ร้านหนึ่ง");
    expect(firstRow[3].value).toBe("'@credit");
    expect(firstRow[4]).toMatchObject({ value: 1.5, format: '#,##0.0' });
    expect(firstRow[5]).toMatchObject({ value: 2, format: '#,##0.0' });
    expect(firstRow[6]).toMatchObject({ value: 100.25, format: '#,##0.00' });
    expect(firstRow[7]).toMatchObject({ value: 80.05, format: '#,##0.00' });
    expect(firstRow[8]).toMatchObject({ value: 100.25, format: '#,##0.00' });
    expect(secondRow[4].value).toBe('มีบันทึกแต่ไม่มีการขาย');

    expect(totals).toHaveLength(header.length);
    expect(totals[0].value).toBe('รวม');
    expect(totals[4]).toMatchObject({ value: 1.5, format: '#,##0.0' });
    expect(totals[5]).toMatchObject({ value: 2, format: '#,##0.0' });
    expect(totals[6]).toMatchObject({ value: 100.25, format: '#,##0.00' });
    expect(Number(totals[7].value)).toBeCloseTo(85.2);
    expect(totals[8]).toMatchObject({ value: 100.25, format: '#,##0.00' });
    expect(Number(totals[9].value)).toBeCloseTo(85.2);
    expect(totals[10].value).toBe(26);
    expect(totals[11].value).toBe(45.75);
    expect(totals[12].value).toBe(14.6);
    expect(totals[13].value).toBe('');
    expect(totals[14].value).toBe('');
  });

  it('marks missing daily coverage and dependent totals as unavailable', async () => {
    const daily: AccountingShopDailyResponse = {
      ice_types: [{ ice_type_id: 'ice-a', code: 'A', name: 'น้ำแข็ง A', unit: 'ถุง' }],
      rows: [{ shop_id: 'shop-1', payment_condition: 'เครดิต', days: [] }],
    };

    await exportAccountingShopDaily([shop({ sales_amount: 10 })], daily, '2026-08-01', '2026-08-01');

    const { data } = capturedExport();
    const row = data[0][3];
    const totals = data[0][4];

    expect(row[4].value).toBe('ไม่มีข้อมูล');
    expect(row[5].value).toBe('ไม่มีข้อมูล');
    expect(row[6].value).toBe('ไม่มีข้อมูล');
    expect(row[8].value).toBe('ไม่มีข้อมูล');
    expect(totals[4].value).toBe('ไม่มีข้อมูล');
    expect(totals[5].value).toBe('ไม่มีข้อมูล');
    expect(totals[6].value).toBe('ไม่มีข้อมูล');
    expect(totals[8].value).toBe('ไม่มีข้อมูล');
  });
});
