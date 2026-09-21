import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountingPage } from '../src/features/accounting/AccountingPage';
import {
  cleanAreaName,
  formatAccountingGroupTitle,
  formatAccountingShopFacetLabel,
  formatAccountingShopTitle,
  formatAccountingZoneFacetLabel,
} from '../src/features/accounting/utils';

const { rpcMock, writeXlsxFileMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), writeXlsxFileMock: vi.fn() }));

vi.mock('../src/lib/supabase', () => ({
  supabase: { rpc: rpcMock },
}));
vi.mock('write-excel-file', () => ({ default: writeXlsxFileMock }));

describe('Accounting formatting utils', () => {
  describe('formatAccountingShopTitle', () => {
    it('strips EV- uuid codes and shows only booth name', () => {
      expect(formatAccountingShopTitle({
        shop_code: 'EV-48fe246c-c4d8-44b3-86a3-7c8b3988d5f4',
        shop_name: 'บูธ 18',
      })).toBe('บูธ 18');

      expect(formatAccountingShopTitle({
        shop_code: 'EV-6f498d54-4d05-4908-b688-65cd3351c020',
        shop_name: 'บูธ ศาลปกครองพิเศษ',
      })).toBe('บูธ ศาลปกครองพิเศษ');
    });

    it('keeps shop code and name for regular shops', () => {
      expect(formatAccountingShopTitle({
        shop_code: 'S001',
        shop_name: 'ร้านสมใจ',
      })).toBe('S001 · ร้านสมใจ');
    });
  });

  describe('formatAccountingGroupTitle', () => {
    it('deduplicates building and zone when zone repeats building with uuid suffix', () => {
      expect(formatAccountingGroupTitle('ตึก c', 'ตึก c · 1c495ba3-fd94-4dc1-8833-50e4c6517a88')).toBe('ตึก c');
      expect(formatAccountingGroupTitle('ตึก c', 'ตึก c')).toBe('ตึก c');
    });

    it('keeps distinct building and zone while removing UUID suffix', () => {
      expect(formatAccountingGroupTitle('ตึก C', 'งานกาชาด · 1c495ba3-fd94-4dc1-8833-50e4c6517a88')).toBe('ตึก C · งานกาชาด');
      expect(formatAccountingGroupTitle('อาคาร A', 'ชั้น 1')).toBe('อาคาร A · ชั้น 1');
    });

    it('handles missing zone gracefully', () => {
      expect(formatAccountingGroupTitle('อาคาร A', null)).toBe('อาคาร A · ไม่มีโซน');
    });
  });

  describe('formatAccountingZoneFacetLabel', () => {
    it('cleans zone tab labels and removes uuid suffixes', () => {
      expect(formatAccountingZoneFacetLabel('ตึก c / ตึก c · 1c495ba3-fd94-4dc1-8833-50e4c6517a88')).toBe('ตึก c');
      expect(formatAccountingZoneFacetLabel('ตึก c · 1c495ba3-fd94-4dc1-8833-50e4c6517a88')).toBe('ตึก c');
      expect(formatAccountingZoneFacetLabel('อาคาร B / โซน 2')).toBe('อาคาร B โซน 2');
    });
  });

  describe('formatAccountingShopFacetLabel', () => {
    it('strips EV- uuid prefix from shop facet dropdown labels', () => {
      expect(formatAccountingShopFacetLabel('EV-48fe246c-c4d8-44b3-86a3-7c8b3988d5f4 บูธ 18')).toBe('บูธ 18');
      expect(formatAccountingShopFacetLabel('S001 ร้านสมใจ')).toBe('S001 ร้านสมใจ');
    });
  });
});

describe('AccountingPage event booth and area display', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('renders clean booth titles and deduplicated area titles without UUIDs', async () => {
    const eventSummary = {
      rows: [
        {
          shop_id: 'shop-uuid-1',
          shop_code: 'EV-48fe246c-c4d8-44b3-86a3-7c8b3988d5f4',
          shop_name: 'บูธ 18',
          building_id: 'b-1',
          building_name: 'ตึก c',
          current_zone_id: 'z-1',
          current_zone_name: 'ตึก c · 1c495ba3-fd94-4dc1-8833-50e4c6517a88',
          historical_zone_name: 'ตึก c',
          building_sort_order: 1,
          zone_sort_order: 1,
          delivery_sequence: 1,
          period_activity_status: 'purchased',
          payment_term: 'immediate',
          employee_names: 'ผู้ส่งหนึ่ง',
          sales_amount: 120,
          paid_amount: 0,
          outstanding_amount: 120,
          overdue_amount: 0,
          invoice_count: 1,
          due_date: '2026-09-20',
          cumulative_outstanding_amount: 120,
          cumulative_overdue_amount: 0,
          oldest_outstanding_due_date: '2026-09-20',
          payment_status: 'outstanding',
        },
      ],
      groups: [
        {
          building_id: 'b-1',
          building_name: 'ตึก c',
          current_zone_id: 'z-1',
          current_zone_name: 'ตึก c · 1c495ba3-fd94-4dc1-8833-50e4c6517a88',
          building_sort_order: 1,
          zone_sort_order: 1,
          total_shop_count: 1,
          purchased_shop_count: 1,
          closed_shop_count: 0,
          recorded_no_sale_shop_count: 0,
          not_recorded_shop_count: 0,
          sales_amount: 120,
          cumulative_outstanding_amount: 120,
        },
      ],
      total_count: 1,
      totals: {
        sales_amount: 120,
        paid_amount: 0,
        outstanding_amount: 120,
        overdue_amount: 0,
        outstanding_shop_count: 1,
        cumulative_outstanding_amount: 120,
        cumulative_overdue_amount: 0,
        cumulative_outstanding_shop_count: 1,
        cash_received_in_period: 0,
      },
      facets: {
        shops: [{ value: 'shop-uuid-1', label: 'EV-48fe246c-c4d8-44b3-86a3-7c8b3988d5f4 บูธ 18', count: 1 }],
        buildings: [{ value: 'b-1', label: 'ตึก c', count: 1 }],
        zones: [{ value: 'z-1', label: 'ตึก c / ตึก c · 1c495ba3-fd94-4dc1-8833-50e4c6517a88', count: 1 }],
      },
    };

    rpcMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_accounting_shop_summary') {
        return { data: eventSummary, error: null };
      }
      if (name === 'get_accounting_shop_daily_matrix') {
        const fromDate = String(args.p_from_date);
        const toDate = String(args.p_to_date);
        const start = Date.parse(`${fromDate}T00:00:00Z`);
        const end = Date.parse(`${toDate}T00:00:00Z`);
        const dates = Array.from(
          { length: Math.round((end - start) / 86_400_000) + 1 },
          (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10),
        );
        return {
          data: {
            ice_types: [{ ice_type_id: 'ice-1', name: 'โม่' }],
            rows: [
              {
                shop_id: 'shop-uuid-1',
                payment_condition: 'สด',
                days: dates.map((date) => ({
                  service_date: date,
                  status: 'purchased',
                  sales_amount: 120,
                  cash_received: 0,
                  invoice_count: 1,
                  items: [{ ice_type_id: 'ice-1', name: 'โม่', quantity: 2, unit: 'กระสอบ' }],
                })),
              },
            ],
          },
          error: null,
        };
      }
      if (name === 'get_accounting_review_queue') {
        return { data: { rows: [], total_count: 0 }, error: null };
      }
      return { data: null, error: null };
    });

    render(<AccountingPage role="admin" />);

    // Should display clean booth title "บูธ 18"
    const boothLink = await screen.findByRole('button', { name: 'บูธ 18' });
    expect(boothLink).toBeTruthy();

    // Should NOT display EV-48fe246c... anywhere in table text
    expect(screen.queryByText(/EV-48fe246c/)).toBeNull();

    // Group header and zone tab both render "ตึก c" without repetition or UUID
    const buttonsWithBuilding = screen.getAllByRole('button', { name: /ตึก c/ });
    expect(buttonsWithBuilding.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/ตึก c · ตึก c/)).toBeNull();
    expect(screen.queryByText(/1c495ba3/)).toBeNull();

    // Totals row should say "รวมร้านในหน้านี้ ตึก c"
    expect(screen.getByText('รวมร้านในหน้านี้ ตึก c')).toBeTruthy();
  });
});
