import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { forecastQuantities, forecastWindow } from '../src/features/reports/quantityForecast';
import { ReportQuantityForecast } from '../src/features/reports/ReportQuantityForecast';
import { shiftServiceDate } from '../src/lib/serviceDate';
import type { ForecastContext } from '../src/features/reports/quantityForecast';
import type { ExecutiveReport } from '../src/features/reports/types';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }));
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
function context(anchor = '2026-10-20'): ForecastContext {
  const window = forecastWindow(anchor);
  return { basis: 'regular_only', dailyTrend: report(window.historyFrom, window.historyTo).dailyTrend!, products: catalog,
    events: [{ id: 'event', name: 'งานทดสอบ', start: shiftServiceDate(anchor, 2), end: shiftServiceDate(anchor, 3) }] };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T11:00:00Z'));
  rpc.mockReset();
  rpc.mockImplementation(async (_name, args) => ({ data: context(args.p_anchor), error: null }));
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

it('shows product cards, switches to a day and resets to total when the horizon changes', async () => {
  render(<ReportQuantityForecast report={report()} to="2026-10-20" loading={false} error={null} />);
  const summary = await screen.findByRole('list', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' });
  const bagCard = within(summary).getByRole('listitem', { name: 'หลอดเล็ก' });
  expect(bagCard.textContent).toContain('160');
  expect(screen.getByText('มีอีเวนต์ในช่วงที่เลือก 1 งาน')).not.toBeNull();
  expect(screen.getByText('ยังไม่มีจำนวนสั่ง')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /21 ต.ค./ }));
  expect(bagCard.textContent).toContain('100');
  expect(screen.getByText('ไม่พบอีเวนต์ที่ประกาศในช่วงที่เลือก')).not.toBeNull();
  fireEvent.change(screen.getByLabelText('คาดการณ์ล่วงหน้า'), { target: { value: '30' } });
  expect(screen.getByRole('button', { name: 'ภาพรวม รวม 30 วัน' }).getAttribute('aria-pressed')).toBe('true');
  expect(rpc).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('ดูคาดการณ์รายวันแบบตาราง'));
  expect(within(screen.getByRole('table', { name: 'คาดการณ์น้ำแข็งรายวัน' })).getAllByRole('row')).toHaveLength(31);
});

it('loads event-separated context even for a one-day report and retries failures', async () => {
  rpc.mockRejectedValueOnce(new Error('forecast unavailable'));
  render(<ReportQuantityForecast report={report('2026-10-20', '2026-10-20')} to="2026-10-20" loading={false} error={null} />);
  expect((await screen.findByRole('alert')).textContent).toContain('forecast unavailable');
  expect(rpc).toHaveBeenCalledWith('get_quantity_forecast_context', { p_anchor: '2026-10-20' });
  expect(screen.queryByRole('list', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'ลองโหลดคาดการณ์ใหม่' }));
  await screen.findByRole('list', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' });
});

it('hides stale forecasts during parent refresh and after a parent error', async () => {
  const data = report();
  const view = render(<ReportQuantityForecast report={data} to="2026-10-20" loading={false} error={null} />);
  await screen.findByRole('list', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' });
  view.rerender(<ReportQuantityForecast report={data} to="2026-10-20" loading error={null} />);
  expect(screen.queryByRole('list', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' })).toBeNull();
  view.rerender(<ReportQuantityForecast report={data} to="2026-10-20" loading={false} error="failed" />);
  expect(screen.queryByRole('list', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' })).toBeNull();
});

it('ignores an old response after the selected end date changes', async () => {
  let finish!: (value: { data: ForecastContext; error: null }) => void;
  rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const data = report();
  const view = render(<ReportQuantityForecast report={data} to="2026-10-20" loading={false} error={null} />);
  view.rerender(<ReportQuantityForecast report={data} to="2026-09-15" loading={false} error={null} />);
  await screen.findByRole('list', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' });
  finish({ data: context(), error: null });
  await waitFor(() => expect(screen.getByText(/ช่วงคาดการณ์/).textContent).toContain('16 ก.ย. 2569'));
});

it('rejects mixed history from an older server and shows insufficient data without fabricated quantities', async () => {
  rpc.mockResolvedValueOnce({ data: report(), error: null });
  render(<ReportQuantityForecast report={report()} to="2026-10-20" loading={false} error={null} />);
  expect((await screen.findByRole('alert')).textContent).toContain('ยังไม่มีข้อมูลแยกยอดปกติออกจากอีเวนต์');
  const sparse = context();
  sparse.dailyTrend = sparse.dailyTrend.slice(0, 2);
  rpc.mockResolvedValueOnce({ data: sparse, error: null });
  fireEvent.click(screen.getByRole('button', { name: 'ลองโหลดคาดการณ์ใหม่' }));
  const cards = await screen.findByRole('list', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' });
  expect(within(cards).getByRole('listitem', { name: 'หลอดเล็ก' }).textContent).toContain('ข้อมูลไม่พอ');
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
  const history = context();
  history.dailyTrend.forEach(day => { day.products = [{ ...bag, delivered: 100 }]; });
  rpc.mockResolvedValue({ data: history, error: null });
  const view = render(<ReportQuantityForecast report={report('2026-10-01')} to="2026-10-20" loading={false} error={null} />);
  const before = (await screen.findByRole('list', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' })).textContent;
  expect(before).toContain('น้ำแข็งก้อน');
  view.rerender(<ReportQuantityForecast report={report('2026-01-01')} to="2026-10-20" loading={false} error={null} />);
  const after = await screen.findByRole('list', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' });
  expect(after.textContent).toBe(before);
  expect(within(after).getByRole('listitem', { name: 'น้ำแข็งก้อน' }).textContent).toContain('0แถว');
});

it('does not resurrect inactive products from historical report totals', () => {
  const result = forecastQuantities(report(), [catalog[0]], '2026-10-20', 7);
  expect(result.rows.map(row => row.id)).toEqual(['bag']);
});

it('distinguishes zero ordinary demand from unknown event demand', async () => {
  const data = context();
  data.dailyTrend.forEach(day => { day.products = []; });
  rpc.mockResolvedValue({ data, error: null });
  render(<ReportQuantityForecast report={report()} to="2026-10-20" loading={false} error={null} />);
  const cards = await screen.findByRole('list', { name: 'สรุปคาดการณ์แยกชนิดน้ำแข็ง' });
  expect(within(cards).getByRole('listitem', { name: 'หลอดเล็ก' }).textContent).toContain('0ถุง');
  expect(screen.getByText(/ยอดด้านบนยังไม่รวมอีเวนต์/)).not.toBeNull();
  expect(screen.getByText('ยังไม่มีจำนวนสั่ง')).not.toBeNull();
});
