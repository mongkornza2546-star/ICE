import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExecutiveReportsPage } from '../src/features/reports/ExecutiveReportsPage';
import { comparisonRange, comparisonRows, changePercent, rangeDays, weekToDate, comparisonTimeline, timelineProducts } from '../src/features/reports/comparisonData';
import type { ExecutiveReport } from '../src/features/reports/types';
import { reportRangeError } from '../src/features/reports/reportDates';
import { demoComparisonReport } from '../src/features/reports/demoComparisonReport';

const { rpc, writeXlsxFile } = vi.hoisted(() => ({ rpc: vi.fn(), writeXlsxFile: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('write-excel-file', () => ({ default: writeXlsxFile }));
function report(from = '2026-10-01', to = '2026-10-14', old = false): ExecutiveReport {
  return {
    from, to, asOf: '2026-10-14T10:00:00Z', previousFrom: '2026-09-17', previousTo: '2026-09-30',
    sales: old ? 100 : 200, receipts: 0, refunds: 0, netReceipts: 0, previousSales: 0, previousNetReceipts: 0,
    outstanding: 0, overdue: 0, debtors: 0, deliveryCount: old ? 5 : 10,
    trend: [{ date: from, sales: old ? 100 : 200, receipts: 0, refunds: 0 }], shops: [],
    areas: old ? [{ kind: 'building', id: 'old', name: 'อาคารเดิม', sales: 100 }]
      : [{ kind: 'building', id: 'new', name: 'อาคารใหม่', sales: 200 }],
    products: [{ id: 'ice', name: 'หลอดเล็ก', unit: 'ถุง', delivered: old ? 4 : 10, damaged: 0 },
      { id: 'block', name: 'น้ำแข็งก้อน', unit: 'แถว', delivered: old ? 0 : 2, damaged: 0 }],
    volumeAreas: [{ kind: 'building', id: old ? 'old' : 'new', name: old ? 'อาคารเดิม' : 'อาคารใหม่',
      products: [{ id: 'ice', name: 'หลอดเล็ก', unit: 'ถุง', delivered: old ? 4 : 10, damaged: 0 }] }],
  };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
  rpc.mockReset(); writeXlsxFile.mockReset();
  rpc.mockImplementation(async (name, args) => ({ error: null,
    data: name === 'get_executive_report' ? report(args.p_from, args.p_to, args.p_from < '2026-10-01') : { total: 0, rows: [] },
  }));
});
afterEach(() => vi.useRealTimers());
async function openComparison() {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByRole('button', { name: /ยอดขายสุทธิ/ });
  fireEvent.click(screen.getByRole('button', { name: 'ยอดขาย', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'เปรียบเทียบสองช่วง' }));
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
}

it('uses inclusive equal periods, Monday-based weeks and clamped leap/month dates', () => {
  expect(comparisonRange({ from: '2026-10-01', to: '2026-10-14' }, 'previous')).toEqual({ from: '2026-09-17', to: '2026-09-30' });
  expect(weekToDate('2026-10-14')).toEqual({ from: '2026-10-12', to: '2026-10-14' });
  expect(weekToDate('2026-10-18').from).toBe('2026-10-12');
  expect(comparisonRange({ from: '2026-03-01', to: '2026-03-31' }, 'month')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  expect(comparisonRange({ from: '2024-02-29', to: '2024-02-29' }, 'year')).toEqual({ from: '2023-02-28', to: '2023-02-28' });
  expect(rangeDays({ from: '2024-02-28', to: '2024-03-01' })).toBe(3);
  expect(changePercent(100, 0)).toBeNull();
  expect(changePercent(0, 100)).toBe(-100);
  expect(reportRangeError('2026-02-30', '2026-03-01')).toBe('วันที่ไม่ถูกต้อง');
});

it('merges stable IDs, preserves previous-only rows and does not turn missing breakdowns into zero', () => {
  const current = report(); const previous = report('2026-09-17', '2026-09-30', true);
  current.volumeAreas = undefined;
  const rows = comparisonRows(current, previous);
  expect(rows.areas.find((row) => row.area?.id === 'old')).toMatchObject({ current: 0, previous: 100 });
  expect(rows.volumeAreas[0]).toMatchObject({ current: null, previous: 4 });
  previous.products[0].unit = 'กระสอบ';
  expect(comparisonRows(current, previous).products.filter((row) => row.product === 'ice')).toHaveLength(2);
});

it('loads two independent ranges, compares all areas, switches unit-safe graphs and drills into B', async () => {
  await openComparison();
  expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-09-17', p_to: '2026-09-30' });
  const table = screen.getByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
  expect(within(table).getByText('อาคารเดิม')).not.toBeNull();
  expect(within(table).getByText('-100%')).not.toBeNull();
  expect(within(table).getByText('ฐานเป็น 0 · ไม่คิด %')).not.toBeNull();
  fireEvent.change(screen.getByLabelText('ข้อมูลบนกราฟ'), { target: { value: 'products' } });
  let chart = screen.getByRole('group', { name: 'กราฟปริมาณตามชนิดน้ำแข็ง' });
  expect(within(chart).getByText('หลอดเล็ก')).not.toBeNull();
  expect(within(chart).queryByText('น้ำแข็งก้อน')).toBeNull();
  fireEvent.change(screen.getByLabelText('หน่วยบนกราฟ'), { target: { value: 'แถว' } });
  chart = screen.getByRole('group', { name: 'กราฟปริมาณตามชนิดน้ำแข็ง' });
  expect(within(chart).getByText('น้ำแข็งก้อน')).not.toBeNull();
  expect(within(chart).queryByText('หลอดเล็ก')).toBeNull();
  fireEvent.click(within(table).getByRole('button', { name: 'อาคารเดิม · B · 100 บาท' }));
  await screen.findByRole('dialog');
  expect(rpc).toHaveBeenCalledWith('get_executive_report_details', expect.objectContaining({
    p_from: '2026-09-17', p_to: '2026-09-30', p_area_id: 'old', p_area_kind: 'building',
  }));
});

it('compares Monday to Wednesday with the same weekdays last week and allows unequal custom periods', async () => {
  await openComparison();
  fireEvent.click(screen.getByRole('button', { name: 'สัปดาห์นี้เทียบสัปดาห์ก่อน' }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-10-05', p_to: '2026-10-07' }));
  expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-10-12', p_to: '2026-10-14' });
  fireEvent.change(screen.getByLabelText('ช่วง B จาก'), { target: { value: '2026-10-01' } });
  fireEvent.change(screen.getByLabelText('ช่วง B ถึง'), { target: { value: '2026-10-02' } });
  await screen.findByText('ช่วงเวลายาวไม่เท่ากัน · แสดงยอดเฉลี่ยต่อวันควบคู่ยอดรวม');
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
  expect(screen.getByLabelText<HTMLSelectElement>('เปรียบเทียบกับ').value).toBe('custom');
  expect(within(screen.getByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' })).getByRole('columnheader', { name: 'เฉลี่ย/วัน B' })).not.toBeNull();
});

it('does not request or display comparisons for invalid dates and can recover', async () => {
  await openComparison(); rpc.mockClear();
  fireEvent.change(screen.getByLabelText('ช่วง B จาก'), { target: { value: '2026-10-10' } });
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'ช่วง B: วันเริ่มต้นต้องไม่เกินวันสิ้นสุด');
  expect(rpc).not.toHaveBeenCalled();
  expect(screen.queryByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' })).toBeNull();
  fireEvent.change(screen.getByLabelText('ช่วง B จาก'), { target: { value: '2026-09-17' } });
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
});

it('keeps comparison controls available while the main range is invalid', async () => {
  await openComparison();
  const base = screen.getByRole('region', { name: 'เลือกช่วงเวลารายงาน' });
  fireEvent.change(within(base).getByLabelText('จาก'), { target: { value: '' } });
  expect(screen.getByLabelText('ช่วง B จาก')).not.toBeNull();
  expect(screen.queryByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' })).toBeNull();
  fireEvent.change(within(base).getByLabelText('จาก'), { target: { value: '2026-10-01' } });
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
});

it('ignores a late response for an earlier comparison selection', async () => {
  await openComparison();
  let finish: (value: unknown) => void = () => {};
  const original = rpc.getMockImplementation()!;
  rpc.mockImplementation((name, args) => name === 'get_executive_report' && args.p_from === '2026-09-16'
    ? new Promise((resolve) => { finish = resolve; }) : original(name, args));
  fireEvent.change(screen.getByLabelText('ช่วง B จาก'), { target: { value: '2026-09-16' } });
  fireEvent.change(screen.getByLabelText('ช่วง B จาก'), { target: { value: '2026-09-15' } });
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
  finish({ error: null, data: { ...report('2026-09-16', '2026-09-30', true), sales: 999999 } });
  await waitFor(() => expect(screen.queryByText('999,999 บาท')).toBeNull());
  expect(screen.getByLabelText<HTMLInputElement>('ช่วง B จาก').value).toBe('2026-09-15');
});

it('reports comparison failures, hides stale totals, retries and refreshes both ranges', async () => {
  await openComparison();
  const original = rpc.getMockImplementation()!;
  rpc.mockImplementation((name, args) => name === 'get_executive_report' && args.p_from < '2026-10-01'
    ? Promise.resolve({ data: null, error: { message: 'Connection failed' } }) : original(name, args));
  fireEvent.click(screen.getByRole('button', { name: 'รีเฟรชรายงาน' }));
  await screen.findByText(/โหลดช่วง B ไม่สำเร็จ: Connection failed/);
  expect(screen.queryByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' })).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'ส่งออก Excel เปรียบเทียบ' }).disabled).toBe(true);
  rpc.mockImplementation(original);
  fireEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
  rpc.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'รีเฟรชรายงาน' }));
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
  expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-10-01', p_to: '2026-10-14' });
  expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-09-17', p_to: '2026-09-30' });
});

it('exports both selected ranges and matching joined totals without inventing percentages', async () => {
  await openComparison();
  fireEvent.click(screen.getByRole('button', { name: 'ส่งออก Excel เปรียบเทียบ' }));
  await waitFor(() => expect(writeXlsxFile).toHaveBeenCalledTimes(1));
  const [sheets, options] = writeXlsxFile.mock.calls[0];
  expect(options.fileName).toBe('sales-comparison-2026-10-01-2026-10-14-vs-2026-09-17-2026-09-30.xlsx');
  const values = sheets.map((sheet: Array<Array<{ value: unknown }>>) => sheet.map((row) => row.map((cell) => cell.value)));
  expect(values[0]).toContainEqual(['ช่วง B', '2026-09-17', '2026-09-30', 14]);
  expect(values[0]).toContainEqual(['ยอดขายสุทธิ', 'บาท', 200, 100, 100, 100, 200 / 14, 100 / 14]);
  expect(values[1]).toContainEqual(['อาคารใหม่', 'บาท', 200, 0, 200, '—', 200 / 14, 0]);
  expect(values[3]).toContainEqual(['อาคารเดิม · หลอดเล็ก', 'ถุง', 0, 4, -4, -100, 0, 4 / 14]);
  expect(options.sheets.slice(4)).toEqual(['ยอดขายรายวัน', 'น้ำแข็งรายวัน']);
  expect(values[5]).toContainEqual(['หลอดเล็ก', 'ถุง', 1, '2026-10-01', 'ข้อมูลไม่พร้อม', '2026-09-17', 'ข้อมูลไม่พร้อม']);
});

it('distinguishes unavailable volume detail from zero and blocks comparison loading after an A failure', async () => {
  const original = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (name, args) => {
    const result = await original(name, args);
    if (name === 'get_executive_report') result.data.volumeAreas = undefined;
    return result;
  });
  await openComparison();
  expect(screen.getByText('ข้อมูลแยกพื้นที่ไม่ครบทั้งสองช่วง · ไม่แสดงข้อมูลที่ขาดเป็นศูนย์')).not.toBeNull();
  expect(screen.queryByRole('table', { name: 'เปรียบเทียบน้ำแข็งแยกพื้นที่' })).toBeNull();
  rpc.mockImplementation((name, args) => name === 'get_executive_report' && args.p_from === '2026-10-01'
    ? Promise.resolve({ data: null, error: { message: 'A failed' } }) : original(name, args));
  fireEvent.click(screen.getByRole('button', { name: 'รีเฟรชรายงาน' }));
  await screen.findByText(/โหลดรายงานไม่สำเร็จ: A failed/);
  expect(screen.queryByText('กำลังโหลดข้อมูลสองช่วง…')).toBeNull();
  expect(screen.queryByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' })).toBeNull();
});

it('rejects future and excessive B ranges and restores the single-period view', async () => {
  await openComparison(); rpc.mockClear();
  fireEvent.change(screen.getByLabelText('ช่วง B ถึง'), { target: { value: '2026-10-15' } });
  await screen.findByText('ช่วง B: เลือกวันในอนาคตไม่ได้');
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('ช่วง B จาก'), { target: { value: '2024-01-01' } });
  fireEvent.change(screen.getByLabelText('ช่วง B ถึง'), { target: { value: '2026-09-30' } });
  await screen.findByText('ช่วง B: เลือกช่วงได้สูงสุด 366 วัน');
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'ช่วงเดียว' }));
  expect(screen.getByRole('table', { name: 'ตารางยอดขายตามพื้นที่' })).not.toBeNull();
  expect(screen.getByRole('button', { name: 'ส่งออก Excel ตามช่วงวันที่หลัก', exact: true })).not.toBeNull();
});

it('preserves custom B when returning from another report tab or single-period view', async () => {
  await openComparison();
  fireEvent.change(screen.getByLabelText('ช่วง B จาก'), { target: { value: '2026-09-01' } });
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
  fireEvent.click(screen.getByRole('button', { name: 'การเงิน', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'ยอดขาย', exact: true }));
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
  expect(screen.getByLabelText<HTMLInputElement>('ช่วง B จาก').value).toBe('2026-09-01');
  fireEvent.click(screen.getByRole('button', { name: 'ช่วงเดียว' }));
  fireEvent.click(screen.getByRole('button', { name: 'เปรียบเทียบสองช่วง' }));
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
  expect(screen.getByLabelText<HTMLInputElement>('ช่วง B จาก').value).toBe('2026-09-01');
});

it('advances this-week shortcut after Bangkok midnight', async () => {
  await openComparison();
  fireEvent.click(screen.getByRole('button', { name: 'สัปดาห์นี้เทียบสัปดาห์ก่อน' }));
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
  vi.setSystemTime(new Date('2026-10-14T17:05:00Z'));
  rpc.mockClear();
  fireEvent(window, new Event('focus'));
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
  expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-10-12', p_to: '2026-10-15' });
  expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-10-05', p_to: '2026-10-08' });
});

it('keeps manual dates fixed at midnight and rolls month shortcuts into the new month', async () => {
  await openComparison();
  const dates = screen.getByRole('region', { name: 'เลือกช่วงเวลารายงาน' });
  fireEvent.change(within(dates).getByLabelText('จาก'), { target: { value: '2026-10-02' } });
  fireEvent.change(screen.getByLabelText('ช่วง B จาก'), { target: { value: '2026-09-01' } });
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
  vi.setSystemTime(new Date('2026-10-15T01:00:00Z'));
  fireEvent(window, new Event('focus'));
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
  expect(within(dates).getByLabelText<HTMLInputElement>('ถึง').value).toBe('2026-10-14');
  expect(screen.getByLabelText<HTMLInputElement>('ช่วง B จาก').value).toBe('2026-09-01');
  fireEvent.click(screen.getByRole('button', { name: 'เดือนนี้เทียบเดือนก่อน' }));
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
  vi.setSystemTime(new Date('2026-11-01T01:00:00Z'));
  rpc.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'รีเฟรชรายงาน' }));
  await screen.findByRole('table', { name: 'เปรียบเทียบยอดขายแยกพื้นที่' });
  expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-11-01', p_to: '2026-11-01' });
  expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-10-01', p_to: '2026-10-01' });
});

it('renders daily sales and product series, zero days and single-day sales drilldowns', async () => {
  const original = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (name, args) => {
    const result = await original(name, args);
    if (name === 'get_executive_report') result.data.dailyTrend = [
      { date: args.p_from, sales: result.data.sales, products: [{ id: 'ice', name: 'หลอดเล็ก', unit: 'ถุง', delivered: 4 }] },
      { date: args.p_to, sales: 0, products: [] },
    ];
    return result;
  });
  await openComparison();
  expect(screen.getByRole('img', { name: 'กราฟแนวโน้มยอดขายรายวัน A และ B' })).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'ดูตารางรายวัน' }));
  let daily = screen.getByRole('table', { name: 'ตารางเปรียบเทียบรายวัน' });
  fireEvent.click(within(daily).getByRole('button', { name: 'B · 2026-09-17 · 100 บาท' }));
  await screen.findByRole('dialog');
  expect(rpc).toHaveBeenCalledWith('get_executive_report_details', expect.objectContaining({ p_from: '2026-09-17', p_to: '2026-09-17', p_bucket: null }));
  fireEvent.click(screen.getByRole('button', { name: 'ปิดรายละเอียด' }));
  fireEvent.change(screen.getByLabelText('ข้อมูลแนวโน้ม'), { target: { value: 'volume' } });
  expect(screen.getByRole('img', { name: 'กราฟแนวโน้มปริมาณน้ำแข็งรายวัน A และ B' })).not.toBeNull();
  daily = screen.getByRole('table', { name: 'ตารางเปรียบเทียบรายวัน' });
  expect(within(daily).getAllByText('4 ถุง')).toHaveLength(2);
  expect(within(daily).getAllByText('0 ถุง')).toHaveLength(2);
  // Neither a missing day nor an absent daily endpoint is fabricated as zero.
  expect(within(daily).getAllByText('—').length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText('ชนิดน้ำแข็งในแนวโน้ม'), { target: { value: JSON.stringify(['block', 'แถว']) } });
  expect(within(daily).queryByText('4 ถุง')).toBeNull();
  expect(within(daily).getAllByText('0 แถว')).toHaveLength(4);
  fireEvent.click(screen.getByRole('button', { name: 'รีเฟรชรายงาน' }));
  await screen.findByRole('table', { name: 'ตารางเปรียบเทียบรายวัน' });
  expect(screen.getByLabelText<HTMLSelectElement>('ข้อมูลแนวโน้ม').value).toBe('volume');
  expect(screen.getByLabelText<HTMLSelectElement>('ชนิดน้ำแข็งในแนวโน้ม').value).toBe(JSON.stringify(['block', 'แถว']));
  fireEvent.click(screen.getByRole('button', { name: 'ส่งออก Excel เปรียบเทียบ' }));
  await waitFor(() => expect(writeXlsxFile).toHaveBeenCalledTimes(1));
  const dailySheets = writeXlsxFile.mock.calls[0][0].slice(4).map((sheet: Array<Array<{ value: unknown }>>) => sheet.map(row => row.map(cell => cell.value)));
  expect(dailySheets[0]).toContainEqual([1, '2026-10-01', 200, '2026-09-17', 100]);
  expect(dailySheets[1]).toContainEqual(['หลอดเล็ก', 'ถุง', 14, '2026-10-14', 0, '2026-09-30', 0]);
});

it('aligns unequal daily ranges, keeps missing history null and does not treat monthly buckets as daily', () => {
  const current = report('2026-10-01', '2026-10-03');
  const previous = report('2026-09-01', '2026-09-02');
  current.dailyTrend = [
    { date: '2026-10-01', sales: 10, products: [{ id: 'net-zero', name: 'มีการคืน', unit: 'ถุง', delivered: 2 }] },
    { date: '2026-10-02', sales: -10, products: [{ id: 'net-zero', name: 'มีการคืน', unit: 'ถุง', delivered: -2 }] },
    { date: '2026-10-03', sales: 0, products: [] },
  ];
  previous.dailyTrend = [{ date: '2026-09-01', sales: 0, products: [] }, { date: '2026-09-02', sales: 1, products: [] }];
  expect(comparisonTimeline(current, previous, { kind: 'sales' })).toEqual([
    { day: 1, currentDate: '2026-10-01', previousDate: '2026-09-01', current: 10, previous: 0 },
    { day: 2, currentDate: '2026-10-02', previousDate: '2026-09-02', current: -10, previous: 1 },
    { day: 3, currentDate: '2026-10-03', previousDate: null, current: 0, previous: null },
  ]);
  expect(timelineProducts(current, previous)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'net-zero' })]));
  expect(comparisonTimeline(current, previous, { kind: 'volume', productId: 'net-zero', unit: 'ถุง' }).map(point => point.current)).toEqual([2, -2, 0]);
  const legacy = report('2026-08-01', '2026-09-30');
  expect(comparisonTimeline(legacy, previous, { kind: 'sales' }).every(point => point.current === null)).toBe(true);
  expect(comparisonTimeline(report(), previous, { kind: 'volume', productId: 'ice', unit: 'ถุง' }).every(point => point.current === null)).toBe(true);
});

it('keeps demo daily quantities and sales reconciled to their explicitly simulated totals', () => {
  const fixture = report();
  const rebased = demoComparisonReport(fixture, { from: '2026-10-12', to: '2026-10-14' });
  expect(rebased.dailyTrend?.map(point => point.date)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
  expect(rebased.dailyTrend?.reduce((sum, point) => sum + point.sales, 0)).toBeCloseTo(fixture.sales);
  for (const product of fixture.products) expect(rebased.dailyTrend?.flatMap(point => point.products)
    .filter(item => item.id === product.id).reduce((sum, item) => sum + item.delivered, 0)).toBeCloseTo(product.delivered);
});
