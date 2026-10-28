import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ReportDailyQuantities as ControlledDailyQuantities } from '../src/features/reports/ReportDailyQuantities';
import { ExecutiveReportsPage } from '../src/features/reports/ExecutiveReportsPage';
import { shiftServiceDate } from '../src/lib/serviceDate';
import { formatReportDate } from '../src/features/reports/reportDates';
import type { ExecutiveReport } from '../src/features/reports/types';

const { rpc, writeXlsxFile } = vi.hoisted(() => ({ rpc: vi.fn(), writeXlsxFile: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc, from: () => ({ select: () => ({ eq: () => ({ order: () => ({ order: async () => ({ data: [], error: null }) }) }) }) }) } }));
vi.mock('write-excel-file', () => ({ default: writeXlsxFile }));
const bag = { id: 'bag', name: 'หลอดเล็ก', unit: 'ถุง', delivered: 0, damaged: 0 };
const block = { id: 'block', name: 'น้ำแข็งก้อน', unit: 'แถว', delivered: 0, damaged: 0 };

function ReportDailyQuantities({ report: data }: { report: ExecutiveReport }) {
  const [date, setDate] = useState(data.to);
  return <ControlledDailyQuantities report={data} from={data.from} to={data.to} selectedDate={date} onDateChange={setDate} />;
}

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

it('shows daily product quantities, differences, range totals and zero days separately', () => {
  render(<ReportDailyQuantities report={report()} />);
  expect(rpc).not.toHaveBeenCalled();
  const comparison = screen.getByRole('complementary', { name: 'เปรียบเทียบจำนวนขาย' });
  expect(within(comparison).getByRole('listitem', { name: 'หลอดเล็ก' }).textContent).toContain('7.75 ถุงวันก่อน 10 ถุง-2.25 ถุง');
  expect(within(comparison).getByRole('listitem', { name: 'น้ำแข็งก้อน' }).textContent).toContain('0 แถววันก่อน 3 แถว-3 แถว');
  fireEvent.click(screen.getByRole('button', { name: 'ดูทุกวันในช่วง' }));
  const month = screen.getByRole('region', { name: 'ตารางจำนวนขายรายวันตามช่วงวันที่' });
  expect(within(month).getAllByRole('row')).toHaveLength(22);
  expect(within(month).getByRole('row', { name: /รวมช่วง/ }).textContent).toContain('17.753');
  expect(within(month).getByRole('row', { name: new RegExp(`^${formatReportDate('2026-10-02')}`) }).textContent).toContain('00');
  expect(within(month).queryByRole('row', { name: new RegExp(`^${formatReportDate('2026-10-21')}`) })).toBeNull();
  fireEvent.click(within(month).getByRole('button', { name: formatReportDate('2026-10-19') }));
  expect(within(comparison).getByText('+10 ถุง')).not.toBeNull();
});

it('loads the prior month boundary when comparing the first day without adding it to month totals', async () => {
  render(<ReportDailyQuantities report={report()} />);
  fireEvent.keyDown(screen.getByRole('img', { name: /แนวโน้มจำนวนขาย/ }), { key: 'Home' });
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-09-30', p_to: '2026-09-30' }));
  const comparison = await screen.findByRole('complementary', { name: 'เปรียบเทียบจำนวนขาย' });
  expect(within(comparison).getAllByText(`เทียบ ${formatReportDate('2026-09-30')}`)).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'ดูทุกวันในช่วง' }));
  expect(within(screen.getByRole('region', { name: 'ตารางจำนวนขายรายวันตามช่วงวันที่' }))
    .getByRole('row', { name: /รวมช่วง/ }).textContent).toContain('17.753');
});

it('keeps a missing day unknown rather than reporting zero or a complete range total', () => {
  const data = report();
  data.dailyTrend = data.dailyTrend?.filter((day) => day.date !== '2026-10-19');
  render(<ReportDailyQuantities report={data} />);
  expect(within(screen.getByRole('complementary', { name: 'เปรียบเทียบจำนวนขาย' }))
    .getByRole('listitem', { name: 'หลอดเล็ก' }).textContent).toContain('7.75 ถุงวันก่อน — ถุง—');
  fireEvent.click(screen.getByRole('button', { name: 'ดูทุกวันในช่วง' }));
  expect(within(screen.getByRole('region', { name: 'ตารางจำนวนขายรายวันตามช่วงวันที่' }))
    .getByRole('row', { name: /รวมช่วง/ }).textContent).toContain('——');
});

it('reports unavailable daily data and request failures explicitly, and retries', async () => {
  const data = report();
  delete data.dailyTrend;
  const view = render(<ReportDailyQuantities report={data} />);
  expect(screen.getByRole('status').textContent).toContain('ยังไม่พร้อมใช้งาน');
  rpc.mockResolvedValueOnce({ data: null, error: { message: 'โหลดข้อมูลไม่สำเร็จ' } });
  view.rerender(<ReportDailyQuantities report={report('2026-10-20', '2026-10-20')} />);
  expect((await screen.findByRole('alert')).textContent).toContain('โหลดข้อมูลไม่สำเร็จ');
  expect(screen.queryByRole('region', { name: 'ตารางจำนวนขายรายวันตามช่วงวันที่' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));
  await screen.findByRole('region', { name: 'ตารางจำนวนขายรายวันตามช่วงวันที่' });
});

const exportedRows = (sheetIndex: number) => writeXlsxFile.mock.calls[0][0][sheetIndex]
  .map((row: Array<{ value: string | number }>) => row.map((cell) => cell.value));

it('exports the displayed fractional quantities, unit-specific totals, comparison and selected range', async () => {
  render(<ReportDailyQuantities report={report()} />);
  fireEvent.click(screen.getByRole('button', { name: 'ส่งออกจำนวนขายรายวัน (Excel)' }));
  await waitFor(() => expect(writeXlsxFile).toHaveBeenCalledTimes(1));
  expect(writeXlsxFile.mock.calls[0][1].fileName).toBe('ice-daily-quantities-2026-10-01-2026-10-20-compare-2026-10-20.xlsx');
  expect(exportedRows(0)).toContainEqual(['วันที่', 'หลอดเล็ก (ถุง)', 'น้ำแข็งก้อน (แถว)']);
  expect(exportedRows(0)).toContainEqual(['2026-10-20', 7.75, 0]);
  expect(exportedRows(0).some((row: Array<string | number>) => row[0] === '2026-10-21')).toBe(false);
  expect(exportedRows(0)).toContainEqual(['รวมช่วง', 17.75, 3]);
  expect(exportedRows(1)).toContainEqual(['หลอดเล็ก', 'ถุง', 7.75, 10, -2.25]);
  expect(exportedRows(1)).toContainEqual(['น้ำแข็งก้อน', 'แถว', 0, 3, -3]);
});

it('preserves missing data in export and keeps the table usable after an export failure', async () => {
  const data = report();
  data.dailyTrend = data.dailyTrend?.filter((day) => day.date !== '2026-10-19');
  writeXlsxFile.mockRejectedValueOnce(new Error('สร้างไฟล์ไม่สำเร็จ'));
  render(<ReportDailyQuantities report={data} />);
  fireEvent.click(screen.getByRole('button', { name: 'ส่งออกจำนวนขายรายวัน (Excel)' }));
  expect((await screen.findByRole('alert')).textContent).toContain('สร้างไฟล์ไม่สำเร็จ');
  expect(screen.getByRole('region', { name: 'ตารางจำนวนขายรายวันตามช่วงวันที่' })).not.toBeNull();
  expect(exportedRows(0)).toContainEqual(['2026-10-19', '—', '—']);
  expect(exportedRows(0)).toContainEqual(['รวมช่วง', '—', '—']);
  expect(exportedRows(1)).toContainEqual(['หลอดเล็ก', 'ถุง', 7.75, '—', '—']);
  fireEvent.click(screen.getByRole('button', { name: 'ส่งออกจำนวนขายรายวัน (Excel)' }));
  await waitFor(() => expect(writeXlsxFile).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('daily export is blocked when the parent refresh fails', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByRole('region', { name: 'ผลประกอบการตามช่วงวันที่' });
  fireEvent.click(screen.getByRole('button', { name: 'ปริมาณ', exact: true }));
  rpc.mockResolvedValueOnce({ data: null, error: { message: 'network unavailable' } });
  fireEvent.click(screen.getByRole('button', { name: 'รีเฟรชรายงาน' }));
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: 'ส่งออก Excel ปริมาณช่วงที่เลือก' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'ส่งออกจำนวนขายรายวัน (Excel)' }) as HTMLButtonElement).disabled).toBe(true);
});

it('blocks reused daily export during refresh and re-enables it after recovery with updated quantities', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByRole('region', { name: 'ผลประกอบการตามช่วงวันที่' });
  fireEvent.click(screen.getByRole('button', { name: 'ปริมาณ', exact: true }));
  let finishRefresh!: (result: { data: ExecutiveReport; error: null }) => void;
  rpc.mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'รีเฟรชรายงาน' }));
  const exportButton = screen.getByRole('button', { name: 'ส่งออกจำนวนขายรายวัน (Excel)' }) as HTMLButtonElement;
  expect(exportButton.disabled).toBe(true);
  fireEvent.click(exportButton);
  expect(writeXlsxFile).not.toHaveBeenCalled();
  const refreshed = report();
  refreshed.dailyTrend!.find(day => day.date === '2026-10-20')!.products[0].delivered = 12;
  finishRefresh({ data: refreshed, error: null });
  await waitFor(() => expect(exportButton.disabled).toBe(false));
  fireEvent.click(exportButton);
  await waitFor(() => expect(writeXlsxFile).toHaveBeenCalledTimes(1));
  expect(exportedRows(0)).toContainEqual(['2026-10-20', 12, 0]);
});

it('switches the chart unit independently and selects comparison dates with keyboard controls', () => {
  render(<ReportDailyQuantities report={report()} />);
  const chart = screen.getByRole('img', { name: /แนวโน้มจำนวนขาย.*หลอดเล็ก/ });
  expect(within(screen.getByRole('region', { name: 'ตารางจำนวนขายรายวันตามช่วงวันที่' })).getAllByRole('row')).toHaveLength(6);
  fireEvent.change(screen.getByLabelText('ชนิดน้ำแข็งในกราฟ'), { target: { value: 'block' } });
  expect(screen.getByRole('img', { name: /น้ำแข็งก้อน \(แถว\)/ })).not.toBeNull();
  fireEvent.keyDown(chart, { key: 'ArrowLeft' });
  expect(screen.getByRole('button', { name: formatReportDate('2026-10-19') }).getAttribute('aria-pressed')).toBe('true');
  const comparison = screen.getByRole('complementary', { name: 'เปรียบเทียบจำนวนขาย' });
  expect(within(comparison).getByRole('listitem', { name: 'น้ำแข็งก้อน' }).textContent).toContain('3 แถววันก่อน 0 แถว+3 แถว');
  fireEvent.keyDown(chart, { key: 'End' });
  expect(screen.getByRole('button', { name: /20 ต.ค. 2569/ }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.keyDown(chart, { key: 'ArrowRight' });
  expect(screen.getByRole('button', { name: /20 ต.ค. 2569/ }).getAttribute('aria-pressed')).toBe('true');
});


it.each(['unavailable', 'empty'])('keeps the main delivery count when monthly quantities are %s', (state) => {
  const data = { ...report(), deliveryCount: 1726 };
  if (state === 'unavailable') delete data.dailyTrend;
  else { data.products = []; data.dailyTrend = []; }
  render(<ReportDailyQuantities report={data} />);
  const summary = screen.getByRole('region', { name: 'จำนวนรายการส่ง' });
  expect(summary.textContent).toContain('1,726 ครั้ง');
  expect(summary.textContent).toContain(`${formatReportDate(data.from)} – ${formatReportDate(data.to)}`);
  expect(screen.queryByRole('region', { name: 'ตารางจำนวนขายรายวันตามช่วงวันที่' })).toBeNull();
});
