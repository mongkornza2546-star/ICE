import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExecutiveReportsPage } from '../src/features/reports/ExecutiveReportsPage';
import { shiftServiceDate } from '../src/lib/serviceDate';
import { formatReportDate } from '../src/features/reports/reportDates';
import type { ExecutiveReport } from '../src/features/reports/types';

const { rpc, writeXlsxFile } = vi.hoisted(() => ({ rpc: vi.fn(), writeXlsxFile: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('write-excel-file', () => ({ default: writeXlsxFile }));
const bag = { id: 'bag', name: 'หลอดเล็ก', unit: 'ถุง', delivered: 0, damaged: 0 };
const block = { id: 'block', name: 'น้ำแข็งก้อน', unit: 'แถว', delivered: 0, damaged: 0 };

function report(from = '2026-10-01', to = '2026-10-20'): ExecutiveReport {
  return {
    salesBasis: 'excluding_vat', agingDetailsVersion: 1,
    from, to, asOf: '2026-10-20T11:00:00Z', previousFrom: from, previousTo: to,
    sales: 0, receipts: 0, refunds: 0, netReceipts: 0, previousSales: 0, previousNetReceipts: 0,
    outstanding: 0, overdue: 0, debtors: 0, deliveryCount: 0, trend: [], shops: [], areas: [],
    products: [{ ...bag, delivered: 17.75 }, { ...block, delivered: 3 }],
    dailyTrend: Array.from({ length: (Date.parse(to) - Date.parse(from)) / 86400000 + 1 }, (_, index) => {
      const date = shiftServiceDate(from, index);
      return { date, sales: 0, products: date === '2026-10-19' ? [{ ...bag, delivered: 10 }, { ...block, delivered: 3 }]
        : date === '2026-10-20' ? [{ ...bag, delivered: 7.75 }] : [] };
    }),
  };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T11:00:00Z'));
  rpc.mockReset();
  writeXlsxFile.mockReset();
  rpc.mockImplementation(async (_name, args) => ({ data: report(args.p_from, args.p_to), error: null }));
});
afterEach(() => vi.useRealTimers());

it('uses one date for the entire volume page, including totals, buildings and both exports', async () => {
  rpc.mockImplementation(async (name, args) => {
    if (name === 'get_executive_report_details') return { data: { total: 0, rows: [] }, error: null };
    const data = report(args.p_from, args.p_to);
    const quantity = args.p_from.startsWith('2026-09') ? 91 : 42;
    data.deliveryCount = quantity;
    data.products = [{ ...bag, delivered: quantity }];
    data.volumeAreas = [{ kind: 'building', id: 'a', name: 'อาคาร A', products: data.products }];
    return { data, error: null };
  });
  const view = render(<ExecutiveReportsPage isActive />);
  await screen.findByRole('region', { name: 'ผลประกอบการตามช่วงวันที่' });
  fireEvent.click(screen.getByRole('button', { name: 'ปริมาณ', exact: true }));
  expect(view.container.querySelectorAll('input[type="date"]')).toHaveLength(1);
  expect(screen.queryByLabelText('จาก')).toBeNull();
  expect(screen.queryByLabelText('ถึง')).toBeNull();
  fireEvent.change(screen.getByLabelText('วันที่ต้องการดู'), { target: { value: '2026-09-15' } });
  await waitFor(() => expect(screen.getByRole('region', { name: 'จำนวนรายการส่ง' }).textContent).toContain('91 ครั้ง'));
  expect(screen.getByRole('region', { name: 'จำนวนรายการส่ง' }).textContent)
    .toContain(`${formatReportDate('2026-09-01')} – ${formatReportDate('2026-09-30')}`);
  expect(screen.getByRole('table', { name: 'ปริมาณน้ำแข็ง · อาคาร A' }).textContent).toContain('91');
  expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-09-01', p_to: '2026-09-30' });
  fireEvent.click(screen.getByRole('button', { name: 'ส่งออกจำนวนขายรายวัน (Excel)' }));
  await waitFor(() => expect(writeXlsxFile).toHaveBeenCalledTimes(1));
  expect(writeXlsxFile.mock.calls[0][1].fileName).toBe('ice-daily-quantities-2026-09-compare-2026-09-15.xlsx');
  fireEvent.click(screen.getByRole('button', { name: 'ส่งออก Excel ปริมาณเดือนที่เลือก' }));
  await waitFor(() => expect(writeXlsxFile).toHaveBeenCalledTimes(2));
  const rows = writeXlsxFile.mock.calls[1][0][0].map((row: Array<{ value: string | number }>) => row.map(cell => cell.value));
  expect(rows).toContainEqual(['ช่วงวันที่', '2026-09-01', '2026-09-30']);
  expect(rows).toContainEqual(['จำนวนรายการส่งช่วงนี้', 91]);
  fireEvent.click(screen.getByRole('button', { name: 'ภาพรวม', exact: true }));
  await screen.findByRole('region', { name: 'ผลประกอบการตามช่วงวันที่' });
  expect((screen.getByLabelText('ถึง') as HTMLInputElement).value).toBe('2026-10-20');
});

it('keeps the only date input usable through loading, failure and retry without showing the old totals', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByRole('region', { name: 'ผลประกอบการตามช่วงวันที่' });
  fireEvent.click(screen.getByRole('button', { name: 'ปริมาณ', exact: true }));
  let finish!: (result: { data: null; error: { message: string } }) => void;
  rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const input = screen.getByLabelText('วันที่ต้องการดู');
  input.focus();
  fireEvent.change(input, { target: { value: '2026-09-15' } });
  expect(screen.getByLabelText('วันที่ต้องการดู')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole('region', { name: 'จำนวนรายการส่ง' })).toBeNull();
  expect(screen.queryByRole('table', { name: 'ปริมาณงานและน้ำแข็ง' })).toBeNull();
  finish({ data: null, error: { message: 'quantity load failed' } });
  await screen.findByRole('alert');
  expect(screen.getByLabelText('วันที่ต้องการดู')).toBe(input);
  expect((screen.getByRole('button', { name: 'ส่งออกจำนวนขายรายวัน (Excel)' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'ส่งออก Excel ปริมาณเดือนที่เลือก' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));
  await screen.findByRole('table', { name: 'ปริมาณงานและน้ำแข็ง' });
  expect(screen.getByRole('region', { name: 'จำนวนรายการส่ง' }).textContent)
    .toContain(`${formatReportDate('2026-09-01')} – ${formatReportDate('2026-09-30')}`);
  expect(screen.getByLabelText('วันที่ต้องการดู')).toBe(input);
});
