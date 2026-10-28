import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { forecastQuantities, forecastWindow } from '../src/features/reports/quantityForecast';
import { ReportQuantityForecast } from '../src/features/reports/ReportQuantityForecast';
import { shiftServiceDate } from '../src/lib/serviceDate';
import type { ExecutiveReport } from '../src/features/reports/types';

const { rpc, catalogQuery, catalogResult, catalogSelect, catalogFilter, catalogOrder } = vi.hoisted(() => ({ rpc: vi.fn(), catalogQuery: vi.fn(), catalogResult: vi.fn(), catalogSelect: vi.fn(), catalogFilter: vi.fn(), catalogOrder: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc, from: catalogQuery } }));
const bag = { id: 'bag', name: 'หลอดเล็ก', unit: 'ถุง', delivered: 0, damaged: 0 };
const block = { id: 'block', name: 'น้ำแข็งก้อน', unit: 'แถว', delivered: 0, damaged: 0 };
const catalog = [bag, block].map(product => ({ ...product, created_at: '2024-01-01T00:00:00+07:00' }));
function report(from = '2026-09-22', to = '2026-10-20'): ExecutiveReport {
  return {
    from, to, asOf: '2026-10-20T11:00:00Z', previousFrom: from, previousTo: to,
    sales: 0, receipts: 0, refunds: 0, netReceipts: 0, previousSales: 0, previousNetReceipts: 0,
    outstanding: 0, overdue: 0, debtors: 0, deliveryCount: 0, trend: [], shops: [], areas: [],
    products: [bag, block],
    dailyTrend: Array.from({ length: (Date.parse(to) - Date.parse(from)) / 86400000 + 1 }, (_, index) => {
      const date = shiftServiceDate(from, index);
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      return { date, sales: 0, products: [{ ...bag, delivered: weekday === 3 ? 100 : 10 }, { ...block, delivered: 2.5 }] };
    }),
  };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T11:00:00Z'));
  rpc.mockReset();
  catalogResult.mockReset();
  catalogResult.mockResolvedValue({ data: catalog, error: null });
  catalogOrder.mockImplementation(() => ({ order: catalogResult }));
  catalogFilter.mockImplementation(() => ({ order: catalogOrder }));
  catalogSelect.mockImplementation(() => ({ eq: catalogFilter }));
  catalogQuery.mockImplementation(() => ({ select: catalogSelect }));
  rpc.mockImplementation(async (_name, args) => ({ data: report(args.p_from, args.p_to), error: null }));
});
afterEach(() => vi.useRealTimers());

it('uses complete days before today, predicts each weekday and keeps units separate', () => {
  const data = report();
  data.dailyTrend!.at(-1)!.products[0].delivered = 99999;
  const result = forecastQuantities(data, catalog, '2026-10-20', 7);
  expect(result.historyTo).toBe('2026-10-19');
  expect(result.days).toEqual(['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
  expect(result.rows[0]).toMatchObject({ unit: 'ถุง', total: 160, observedDays: 28, method: 'weekday' });
  expect(result.rows[0].values[0].quantity).toBe(100);
  expect(result.rows[1]).toMatchObject({ unit: 'แถว', total: 17.5 });
});

it('does not leak later history when forecasting after a historical date', () => {
  const result = forecastQuantities(report(), catalog, '2026-10-05', 1);
  expect(result.historyTo).toBe('2026-10-05');
  expect(result.rows[0].observedDays).toBe(14);
  expect(result.days).toEqual(['2026-10-06']);
  expect(result.rows[0].values[0].quantity).toBe(10);
});

it('requires seven observed days and never treats missing dates as zero', () => {
  const data = report('2026-10-01', '2026-10-19');
  data.dailyTrend = data.dailyTrend!.slice(0, 6);
  expect(forecastQuantities(data, catalog, '2026-10-20', 7).rows[0]).toMatchObject({ total: null, observedDays: 6, method: 'insufficient' });
  data.dailyTrend[0].products[0].delivered = 100;
  data.dailyTrend.push({ date: '2026-10-19', sales: 0, products: [{ ...bag, delivered: 10 }] });
  const row = forecastQuantities(data, catalog, '2026-10-20', 1).rows[0];
  expect(row.method).toBe('average');
  expect(row.values[0].quantity).toBe(22.86);
});

it('uses actual zero-sale days and preserves fractional units and leap-day boundaries', () => {
  const data = report('2024-02-01', '2024-02-28');
  data.dailyTrend!.forEach(day => { day.products = [{ ...block, delivered: 0.25 }]; });
  const forecast = forecastQuantities(data, catalog, '2024-02-28', 30);
  expect(forecast.days[0]).toBe('2024-02-29');
  expect(forecast.days[29]).toBe('2024-03-29');
  expect(forecast.rows[0].total).toBe(0);
  expect(forecast.rows[1].total).toBe(7.5);
  expect(forecastWindow('2026-10-20').historyFrom).toBe('2026-09-22');
});

it('shows the forecast, changes horizon without fetching again and exposes daily quantities', async () => {
  render(<ReportQuantityForecast report={report()} to="2026-10-20" loading={false} error={null} />);
  const summary = await screen.findByRole('table', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' });
  expect(within(summary).getByRole('row', { name: /หลอดเล็ก/ }).textContent).toContain('160');
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('คาดการณ์ล่วงหน้า'), { target: { value: '30' } });
  expect(within(summary).getByRole('columnheader', { name: 'รวม 30 วัน' })).not.toBeNull();
  fireEvent.click(screen.getByText('ดูคาดการณ์รายวัน'));
  expect(within(screen.getByRole('table', { name: 'คาดการณ์น้ำแข็งรายวัน' })).getAllByRole('row')).toHaveLength(31);
});

it('loads the fixed historical window even for a one-day report and retries failures', async () => {
  rpc.mockRejectedValueOnce(new Error('forecast unavailable'));
  render(<ReportQuantityForecast report={report('2026-10-20', '2026-10-20')} to="2026-10-20" loading={false} error={null} />);
  expect((await screen.findByRole('alert')).textContent).toContain('forecast unavailable');
  expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-09-22', p_to: '2026-10-19' });
  expect(screen.queryByRole('table', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'ลองโหลดคาดการณ์ใหม่' }));
  await screen.findByRole('table', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' });
});

it('hides stale forecasts during parent refresh and after a parent error', async () => {
  const data = report();
  const view = render(<ReportQuantityForecast report={data} to="2026-10-20" loading={false} error={null} />);
  expect(await screen.findByRole('table', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' })).not.toBeNull();
  view.rerender(<ReportQuantityForecast report={data} to="2026-10-20" loading error={null} />);
  expect(screen.queryByRole('table', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' })).toBeNull();
  view.rerender(<ReportQuantityForecast report={data} to="2026-10-20" loading={false} error="failed" />);
  expect(screen.queryByRole('table', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' })).toBeNull();
});

it('ignores an old history response after the selected end date changes', async () => {
  let finish!: (value: { data: ExecutiveReport; error: null }) => void;
  rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<ReportQuantityForecast report={report('2026-10-20', '2026-10-20')} to="2026-10-20" loading={false} error={null} />);
  view.rerender(<ReportQuantityForecast report={report('2026-09-15', '2026-09-15')} to="2026-09-15" loading={false} error={null} />);
  const table = await screen.findByRole('table', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' });
  finish({ data: report(), error: null });
  await waitFor(() => expect(within(table).getByRole('row', { name: /หลอดเล็ก/ }).textContent).toContain('28 / 28'));
  expect(screen.getByText(/ช่วงคาดการณ์/).textContent).toContain('16 ก.ย. 2569');
});

it('shows unavailable history and insufficient data instead of fabricated forecasts', async () => {
  const data = report();
  delete data.dailyTrend;
  const view = render(<ReportQuantityForecast report={data} to="2026-10-20" loading={false} error={null} />);
  expect((await screen.findByText('ยังไม่มีข้อมูลรายวันสำหรับคาดการณ์')).textContent).toContain('ยังไม่มีข้อมูลรายวัน');
  const sparse = report();
  sparse.dailyTrend = sparse.dailyTrend!.slice(0, 2);
  view.rerender(<ReportQuantityForecast report={sparse} to="2026-10-20" loading={false} error={null} />);
  const table = await screen.findByRole('table', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' });
  expect(within(table).getByRole('row', { name: /หลอดเล็ก/ }).textContent).toContain('ข้อมูลไม่พอ');
});

it('counts only six days for a new product despite SQL filling 28 calendar rows', () => {
  const data = report('2026-09-22', '2026-10-19');
  data.dailyTrend!.forEach(day => { day.products = day.date >= '2026-10-14' ? [{ ...bag, delivered: 100 }] : []; });
  const products = [{ ...catalog[0], created_at: '2026-10-13T18:00:00Z' }]; // October 14 in Bangkok.
  const row = forecastQuantities(data, products, '2026-10-20', 7).rows[0];
  expect(row).toMatchObject({ observedDays: 6, total: null, method: 'insufficient' });
  expect(row.values.every(value => value.quantity === null)).toBe(true);
});

it('shows products launched today as insufficient, not zero demand', () => {
  const data = report();
  data.dailyTrend!.forEach(day => { day.products = []; });
  const row = forecastQuantities(data, [{ ...catalog[0], created_at: '2026-10-20T01:00:00Z' }], '2026-10-20', 7).rows[0];
  expect(row).toMatchObject({ observedDays: 0, total: null, method: 'insufficient' });
});

it('recognizes imported sales before catalog creation without counting earlier unknown days', () => {
  const data = report('2026-09-22', '2026-10-19');
  data.dailyTrend!.forEach(day => { day.products = day.date === '2026-10-10' ? [{ ...bag, delivered: 100 }] : []; });
  const row = forecastQuantities(data, [{ ...catalog[0], created_at: '2026-10-19T00:00:00Z' }], '2026-10-20', 7).rows[0];
  expect(row.observedDays).toBe(10); // Includes genuine zero-sale days after the observed sale.
  expect(row.total).not.toBeNull();
});

it('keeps catalog products and predictions identical for month and year report ranges', async () => {
  const history = report('2026-09-22', '2026-10-19');
  history.products = [bag];
  history.dailyTrend!.forEach(day => { day.products = [{ ...bag, delivered: 100 }]; });
  const month = { ...history, from: '2026-10-01', to: '2026-10-20' };
  const year = { ...history, from: '2026-01-01', to: '2026-10-20', products: [bag, block] };
  rpc.mockResolvedValue({ data: history, error: null });
  const view = render(<ReportQuantityForecast report={month} to="2026-10-20" loading={false} error={null} />);
  const before = (await screen.findByRole('table', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' })).textContent;
  expect(before).toContain('น้ำแข็งก้อน');
  view.rerender(<ReportQuantityForecast report={year} to="2026-10-20" loading={false} error={null} />);
  const after = await screen.findByRole('table', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' });
  expect(after.textContent).toBe(before);
  expect(within(after).getByRole('row', { name: /น้ำแข็งก้อน/ }).textContent).toContain('แถว00');
  expect(catalogQuery).toHaveBeenCalledWith('ice_types');
  expect(catalogSelect).toHaveBeenCalledWith('id, name, unit, created_at');
  expect(catalogFilter).toHaveBeenCalledWith('is_active', true);
  expect(catalogOrder).toHaveBeenCalledWith('name');
  expect(catalogResult).toHaveBeenCalledWith('id');
});

it('does not resurrect inactive products from historical report totals', () => {
  const result = forecastQuantities(report(), [catalog[0]], '2026-10-20', 7);
  expect(result.rows.map(row => row.id)).toEqual(['bag']);
});

it('blocks forecasts on catalog failure and retries both data sources', async () => {
  catalogResult.mockResolvedValueOnce({ data: null, error: { message: 'catalog unavailable' } });
  render(<ReportQuantityForecast report={report()} to="2026-10-20" loading={false} error={null} />);
  expect((await screen.findByRole('alert')).textContent).toContain('catalog unavailable');
  expect(screen.queryByRole('table', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'ลองโหลดคาดการณ์ใหม่' }));
  await screen.findByRole('table', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' });
});
