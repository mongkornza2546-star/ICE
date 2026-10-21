import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ReportDailyQuantities as ControlledDailyQuantities } from '../src/features/reports/ReportDailyQuantities';
import { ExecutiveReportsPage } from '../src/features/reports/ExecutiveReportsPage';
import { shiftServiceDate } from '../src/lib/serviceDate';
import { formatReportDate } from '../src/features/reports/reportDates';
import type { ExecutiveReport } from '../src/features/reports/types';

const { rpc, writeXlsxFile } = vi.hoisted(() => ({ rpc: vi.fn(), writeXlsxFile: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('write-excel-file', () => ({ default: writeXlsxFile }));
const bag = { id: 'bag', name: 'หลอดเล็ก', unit: 'ถุง', delivered: 0, damaged: 0 };
const block = { id: 'block', name: 'น้ำแข็งก้อน', unit: 'แถว', delivered: 0, damaged: 0 };

function ReportDailyQuantities({ report: data }: { report: ExecutiveReport }) {
  const [date, setDate] = useState(data.to);
  return <ControlledDailyQuantities report={data} selectedDate={date} onDateChange={setDate} />;
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

it('shows daily product quantities, differences, month totals, zero days and unknown future days separately', () => {
  render(<ReportDailyQuantities report={report()} />);
  expect(rpc).not.toHaveBeenCalled();
  const comparison = screen.getByRole('region', { name: 'ตารางเปรียบเทียบจำนวนขาย' });
  expect(within(comparison).getByRole('row', { name: /หลอดเล็ก/ }).textContent).toBe('หลอดเล็กถุง7.7510-2.25 ถุง');
  expect(within(comparison).getByRole('row', { name: /น้ำแข็งก้อน/ }).textContent).toBe('น้ำแข็งก้อนแถว03-3 แถว');
  const month = screen.getByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' });
  expect(within(month).getAllByRole('row')).toHaveLength(33);
  expect(within(month).getByRole('row', { name: /รวมเดือน/ }).textContent).toContain('17.753');
  expect(within(month).getByRole('row', { name: new RegExp(`^${formatReportDate('2026-10-02')}`) }).textContent).toContain('00');
  expect(within(month).getByRole('row', { name: new RegExp(`^${formatReportDate('2026-10-21')}`) }).textContent).toContain('——');
  fireEvent.click(within(month).getByRole('button', { name: formatReportDate('2026-10-19') }));
  expect(within(comparison).getByText('+10 ถุง')).not.toBeNull();
});

it('loads the prior month boundary when comparing the first day without adding it to month totals', async () => {
  render(<ReportDailyQuantities report={report()} />);
  fireEvent.change(screen.getByLabelText('วันที่เปรียบเทียบ'), { target: { value: '2026-10-01' } });
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-09-30', p_to: '2026-10-20' }));
  const comparison = await screen.findByRole('region', { name: 'ตารางเปรียบเทียบจำนวนขาย' });
  expect(within(comparison).getByText(formatReportDate('2026-09-30'))).not.toBeNull();
  expect(within(screen.getByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' }))
    .getByRole('row', { name: /รวมเดือน/ }).textContent).toContain('17.753');
});

it('keeps a missing day unknown rather than reporting zero or a complete monthly total', () => {
  const data = report();
  data.dailyTrend = data.dailyTrend?.filter((day) => day.date !== '2026-10-19');
  render(<ReportDailyQuantities report={data} />);
  expect(within(screen.getByRole('region', { name: 'ตารางเปรียบเทียบจำนวนขาย' }))
    .getByRole('row', { name: /หลอดเล็ก/ }).textContent).toBe('หลอดเล็กถุง7.75——');
  expect(within(screen.getByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' }))
    .getByRole('row', { name: /รวมเดือน/ }).textContent).toContain('——');
});

it('supports historical leap months and fetches the full month for a single-day parent report', async () => {
  render(<ReportDailyQuantities report={report('2026-10-20', '2026-10-20')} />);
  await screen.findByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' });
  expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-10-01', p_to: '2026-10-20' });
  fireEvent.change(screen.getByLabelText('เดือนที่ต้องการดู'), { target: { value: '2024-02' } });
  const month = await screen.findByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' });
  expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2024-02-01', p_to: '2024-02-29' });
  expect(within(month).getAllByRole('row')).toHaveLength(31);
  expect((screen.getByLabelText('วันที่เปรียบเทียบ') as HTMLInputElement).value).toBe('2024-02-29');
});

it('reports unavailable daily data and request failures explicitly, and retries', async () => {
  const data = report();
  delete data.dailyTrend;
  const view = render(<ReportDailyQuantities report={data} />);
  expect(screen.getByRole('status').textContent).toContain('ยังไม่พร้อมใช้งาน');
  rpc.mockResolvedValueOnce({ data: null, error: { message: 'โหลดข้อมูลไม่สำเร็จ' } });
  view.rerender(<ReportDailyQuantities report={report('2026-10-20', '2026-10-20')} />);
  expect((await screen.findByRole('alert')).textContent).toContain('โหลดข้อมูลไม่สำเร็จ');
  expect(screen.queryByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));
  await screen.findByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' });
});

it('discards a late month response after switching months', async () => {
  let resolveOld!: (value: { data: ExecutiveReport; error: null }) => void;
  rpc.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  render(<ReportDailyQuantities report={report('2026-10-20', '2026-10-20')} />);
  fireEvent.change(screen.getByLabelText('เดือนที่ต้องการดู'), { target: { value: '2026-09' } });
  await screen.findByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' });
  resolveOld({ data: report(), error: null });
  await waitFor(() => expect((screen.getByLabelText('เดือนที่ต้องการดู') as HTMLInputElement).value).toBe('2026-09'));
  expect(screen.getByRole('columnheader', { name: formatReportDate('2026-09-30') })).not.toBeNull();
});

const exportedRows = (sheetIndex: number) => writeXlsxFile.mock.calls[0][0][sheetIndex]
  .map((row: Array<{ value: string | number }>) => row.map((cell) => cell.value));

it('exports the displayed fractional quantities, unit-specific totals, comparison and future blanks', async () => {
  render(<ReportDailyQuantities report={report()} />);
  fireEvent.click(screen.getByRole('button', { name: 'ส่งออกจำนวนขายรายวัน (Excel)' }));
  await waitFor(() => expect(writeXlsxFile).toHaveBeenCalledTimes(1));
  expect(writeXlsxFile.mock.calls[0][1].fileName).toBe('ice-daily-quantities-2026-10-compare-2026-10-20.xlsx');
  expect(exportedRows(0)).toContainEqual(['วันที่', 'หลอดเล็ก (ถุง)', 'น้ำแข็งก้อน (แถว)']);
  expect(exportedRows(0)).toContainEqual(['2026-10-20', 7.75, 0]);
  expect(exportedRows(0)).toContainEqual(['2026-10-21', '—', '—']);
  expect(exportedRows(0)).toContainEqual(['รวมเดือน', 17.75, 3]);
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
  expect(screen.getByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' })).not.toBeNull();
  expect(exportedRows(0)).toContainEqual(['2026-10-19', '—', '—']);
  expect(exportedRows(0)).toContainEqual(['รวมเดือน', '—', '—']);
  expect(exportedRows(1)).toContainEqual(['หลอดเล็ก', 'ถุง', 7.75, '—', '—']);
  fireEvent.click(screen.getByRole('button', { name: 'ส่งออกจำนวนขายรายวัน (Excel)' }));
  await waitFor(() => expect(writeXlsxFile).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('disables export while the selected month is loading or daily data is unavailable', async () => {
  rpc.mockImplementationOnce(() => new Promise(() => {}));
  const view = render(<ReportDailyQuantities report={report('2026-10-20', '2026-10-20')} />);
  expect((screen.getByRole('button', { name: 'ส่งออกจำนวนขายรายวัน (Excel)' }) as HTMLButtonElement).disabled).toBe(true);
  const data = report();
  delete data.dailyTrend;
  view.rerender(<ReportDailyQuantities report={data} />);
  expect((screen.getByRole('button', { name: 'ส่งออกจำนวนขายรายวัน (Excel)' }) as HTMLButtonElement).disabled).toBe(true);
  expect(writeXlsxFile).not.toHaveBeenCalled();
});

it('retains the selected month/day across tabs and exports that month rather than the main range', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByRole('region', { name: 'ผลประกอบการตามช่วงวันที่' });
  expect(screen.queryByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' })).toBeNull();
  expect(screen.queryByLabelText('เดือนที่ต้องการดู')).toBeNull();
  expect(rpc).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'ปริมาณ', exact: true }));
  await screen.findByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' });
  expect(screen.queryByRole('region', { name: 'ผลประกอบการตามช่วงวันที่' })).toBeNull();
  fireEvent.change(screen.getByLabelText('เดือนที่ต้องการดู'), { target: { value: '2026-09' } });
  await screen.findByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' });
  fireEvent.change(screen.getByLabelText('วันที่เปรียบเทียบ'), { target: { value: '2026-09-15' } });
  fireEvent.click(screen.getByRole('button', { name: 'ยอดขาย', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'ภาพรวม', exact: true }));
  expect(screen.queryByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'ปริมาณ', exact: true }));
  await screen.findByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' });
  expect((screen.getByLabelText('เดือนที่ต้องการดู') as HTMLInputElement).value).toBe('2026-09');
  expect((screen.getByLabelText('วันที่เปรียบเทียบ') as HTMLInputElement).value).toBe('2026-09-15');
  expect((screen.getByLabelText('ถึง') as HTMLInputElement).value).toBe('2026-10-20');
  expect(screen.getByRole('button', { name: 'ส่งออก Excel ตามช่วงวันที่หลัก' })).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'ส่งออกจำนวนขายรายวัน (Excel)' }));
  await waitFor(() => expect(writeXlsxFile).toHaveBeenCalledTimes(1));
  expect(writeXlsxFile.mock.calls[0][1].fileName).toBe('ice-daily-quantities-2026-09-compare-2026-09-15.xlsx');
  expect(exportedRows(0)).toContainEqual(['จำนวนขายน้ำแข็งรายวัน', '2026-09']);
  expect(exportedRows(0)).toContainEqual(['2026-09-30', 0, 0]);
  expect(exportedRows(0).some((row: Array<string | number>) => row[0] === '2026-10-20')).toBe(false);
  expect(exportedRows(1)).toContainEqual(['ชนิดน้ำแข็ง', 'หน่วย', '2026-09-15', '2026-09-14', 'เพิ่ม / ลด']);
});

it('the independent month survives a main-range change', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByRole('region', { name: 'ผลประกอบการตามช่วงวันที่' });
  fireEvent.click(screen.getByRole('button', { name: 'ปริมาณ', exact: true }));
  fireEvent.change(screen.getByLabelText('เดือนที่ต้องการดู'), { target: { value: '2026-09' } });
  await screen.findByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' });
  fireEvent.change(screen.getByLabelText('วันที่เปรียบเทียบ'), { target: { value: '2026-09-15' } });
  fireEvent.change(screen.getByLabelText('ถึง'), { target: { value: '2026-10-19' } });
  await screen.findByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' });
  expect((screen.getByLabelText('เดือนที่ต้องการดู') as HTMLInputElement).value).toBe('2026-09');
  expect((screen.getByLabelText('วันที่เปรียบเทียบ') as HTMLInputElement).value).toBe('2026-09-15');
});

it('daily export is blocked when the parent refresh fails', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByRole('region', { name: 'ผลประกอบการตามช่วงวันที่' });
  fireEvent.click(screen.getByRole('button', { name: 'ปริมาณ', exact: true }));
  rpc.mockResolvedValueOnce({ data: null, error: { message: 'network unavailable' } });
  fireEvent.click(screen.getByRole('button', { name: 'รีเฟรชรายงาน' }));
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: 'ส่งออก Excel ตามช่วงวันที่หลัก' }) as HTMLButtonElement).disabled).toBe(true);
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

it('keeps independently loaded monthly data exportable after a main-range refresh error', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByRole('region', { name: 'ผลประกอบการตามช่วงวันที่' });
  fireEvent.click(screen.getByRole('button', { name: 'ปริมาณ', exact: true }));
  fireEvent.change(screen.getByLabelText('เดือนที่ต้องการดู'), { target: { value: '2026-09' } });
  await screen.findByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' });
  rpc.mockResolvedValueOnce({ data: null, error: { message: 'network unavailable' } });
  fireEvent.click(screen.getByRole('button', { name: 'รีเฟรชรายงาน' }));
  await screen.findByRole('alert');
  const exportButton = screen.getByRole('button', { name: 'ส่งออกจำนวนขายรายวัน (Excel)' }) as HTMLButtonElement;
  expect(exportButton.disabled).toBe(false);
  fireEvent.click(exportButton);
  await waitFor(() => expect(writeXlsxFile).toHaveBeenCalledTimes(1));
  expect(writeXlsxFile.mock.calls[0][1].fileName).toBe('ice-daily-quantities-2026-09-compare-2026-09-30.xlsx');
});

it('preserves an explicitly selected historical month when the main preset rolls over at midnight', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByRole('region', { name: 'ผลประกอบการตามช่วงวันที่' });
  fireEvent.click(screen.getByRole('button', { name: 'ปริมาณ', exact: true }));
  fireEvent.change(screen.getByLabelText('เดือนที่ต้องการดู'), { target: { value: '2026-09' } });
  await screen.findByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' });
  fireEvent.change(screen.getByLabelText('วันที่เปรียบเทียบ'), { target: { value: '2026-09-15' } });
  vi.setSystemTime(new Date('2026-10-21T00:01:00+07:00'));
  fireEvent.click(screen.getByRole('button', { name: 'รีเฟรชรายงาน' }));
  await screen.findByRole('region', { name: 'ตารางจำนวนขายรายวันทั้งเดือน' });
  expect((screen.getByLabelText('ถึง') as HTMLInputElement).value).toBe('2026-10-21');
  expect((screen.getByLabelText('เดือนที่ต้องการดู') as HTMLInputElement).value).toBe('2026-09');
  expect((screen.getByLabelText('วันที่เปรียบเทียบ') as HTMLInputElement).value).toBe('2026-09-15');
});
