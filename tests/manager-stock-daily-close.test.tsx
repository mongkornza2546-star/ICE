import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { DeliveryRound } from '../src/types/app';

const db = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: db }));
import { ManagerStockControl } from '../src/ManagerStockControl';

const serviceDate = '2026-10-20';
const round: DeliveryRound = { id: 'closed-round', name: 'วันนี้', service_date: serviceDate, status: 'closed' };
const closedStock = {
  service_date: serviceDate, status: 'closed', items: [
    { ice_type_id: 'small', code: '01', name: 'หลอดเล็ก', unit: 'ถุง', available_quantity: 0, actual_quantity: 23, variance_quantity: 6 },
    { ice_type_id: 'crushed', code: '02', name: 'โม่', unit: 'ถุง', available_quantity: 0, actual_quantity: 27, variance_quantity: 16.5 },
    { ice_type_id: 'clear', code: '03', name: 'หลอดเล็กถุงใส', unit: 'ถุง', available_quantity: 0, actual_quantity: 0, variance_quantity: -20 },
  ],
};
let isClosed = true;

beforeEach(() => {
  isClosed = true;
  db.rpc.mockImplementation(async (name: string, args: { p_round_id?: string | null; p_service_date: string }) => {
    const stock = { ...closedStock, service_date: args.p_service_date, status: isClosed ? 'closed' : 'open' };
    if (name === 'get_daily_aggregate_stock_summary') return { data: stock, error: null };
    if (name === 'get_daily_close_reconciliation') return { data: { stock, employees: [], feature_enabled: false }, error: null };
    if (name === 'get_daily_stock_refill_history') return { data: [], error: null };
    if (name === 'get_stock_control_summary') return args.p_round_id
      ? { data: null, error: { message: 'The closed delivery round does not have a stock snapshot' } }
      : { data: { service_date: args.p_service_date, locations: [], recent_movements: [] }, error: null };
    if (name === 'get_daily_stock_close_state') return { data: { is_closed: false }, error: null };
    throw new Error(`Unexpected RPC: ${name}`);
  });
});

it.each(['closed', 'open', 'no round'] as const)('shows the daily closing counts without a round snapshot (%s)', async (roundStatus) => {
  const selectedRound = roundStatus === 'no round' ? null : { ...round, status: roundStatus };
  render(<ManagerStockControl operationRound={null} round={selectedRound} serviceDate={serviceDate} />);

  expect(await screen.findByText(/ปิดสต๊อกรวมวันที่ 2026-10-20/)).toBeTruthy();
  const small = screen.getByText(/หลอดเล็ก: นับจริง 23 ถุง/).closest('.daily-stock-closed-item')! as HTMLElement;
  expect(within(small).getByText(/ตามระบบ 17 ถุง/)).toBeTruthy();
  expect(within(small).getByText(/ส่วนต่าง \+6/)).toBeTruthy();
  expect(screen.getByText(/ตามระบบ 10.5 ถุง/)).toBeTruthy();
  expect(screen.getByText(/ตามระบบ 20 ถุง/)).toBeTruthy();
  expect(screen.queryByText(/does not have a stock snapshot/)).toBeNull();
  expect(screen.queryByText('สต๊อกทั้งวัน ณ เวลาปิดงาน')).toBeNull();
  expect(screen.queryByRole('button', { name: 'โอนระหว่างจุด' })).toBeNull();
  expect(db.rpc.mock.calls.some(([name]) => name === 'get_stock_control_summary')).toBe(false);
  expect(db.rpc.mock.calls.some(([name]) => name === 'get_daily_stock_close_state')).toBe(false);
  expect(db.rpc.mock.calls.some(([name]) => name === 'get_daily_close_reconciliation')).toBe(false);
  expect(db.rpc.mock.calls.some(([name]) => name === 'get_daily_stock_refill_history')).toBe(false);
});

it('replaces an open stock page with the daily closure when the same round closes', async () => {
  isClosed = false;
  const view = render(<ManagerStockControl operationRound={{ ...round, status: 'open' }} round={{ ...round, status: 'open' }} serviceDate={serviceDate} />);
  await screen.findByRole('button', { name: 'โอนระหว่างจุด' });
  expect(db.rpc).toHaveBeenCalledWith('get_stock_control_summary', { p_round_id: null, p_service_date: serviceDate });
  isClosed = true;
  await act(async () => { view.rerender(<ManagerStockControl operationRound={null} round={round} serviceDate={serviceDate} />); });
  await screen.findByText(/ปิดสต๊อกรวมวันที่ 2026-10-20/);
  expect(screen.queryByRole('button', { name: 'โอนระหว่างจุด' })).toBeNull();
});

it('does not show the previous day closing counts while a different date is loading', async () => {
  const view = render(<ManagerStockControl operationRound={null} round={round} serviceDate={serviceDate} />);
  await screen.findByText(/ปิดสต๊อกรวมวันที่ 2026-10-20/);
  db.rpc.mockImplementation(() => new Promise(() => {}));
  view.rerender(<ManagerStockControl operationRound={null} round={null} serviceDate="2026-10-21" />);
  expect(screen.queryByText(/นับจริง 23 ถุง/)).toBeNull();
  expect(screen.queryByText(/ปิดสต๊อกรวมวันที่/)).toBeNull();
});

it('shows a failed refresh and allows retrying the closed-day data', async () => {
  render(<ManagerStockControl operationRound={null} round={round} serviceDate={serviceDate} />);
  await screen.findByText(/ปิดสต๊อกรวมวันที่ 2026-10-20/);
  const originalRpc = db.rpc.getMockImplementation()!;
  db.rpc.mockImplementation((name, args) => name === 'get_daily_aggregate_stock_summary'
    ? Promise.resolve({ data: null, error: { message: 'temporary network error' } })
    : originalRpc(name, args));
  fireEvent.click(screen.getByRole('button', { name: 'รีเฟรชข้อมูลสต๊อก' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'temporary network error');
  db.rpc.mockImplementation(originalRpc);
  fireEvent.click(screen.getByRole('button', { name: 'รีเฟรชข้อมูลสต๊อก' }));
  await waitFor(() => expect(screen.queryByText('temporary network error')).toBeNull());
  expect(screen.getByText(/นับจริง 23 ถุง/)).toBeTruthy();
});

it('uses the saved system quantity and close time from the initial stock response', async () => {
  db.rpc.mockResolvedValue({ error: null, data: {
    ...closedStock,
    closed_at: '2026-10-20T16:48:10Z',
    items: [{ ...closedStock.items[0], system_quantity: 17, variance_quantity: null, note: 'ตรวจนับแล้ว' }],
  } });
  render(<ManagerStockControl operationRound={null} round={round} serviceDate={serviceDate} />);
  await screen.findByText(/ตามระบบ 17 ถุง/);
  expect(screen.getByText(/23:48/)).toBeTruthy();
  expect(screen.getByText('ตรวจนับแล้ว')).toBeTruthy();
  expect(db.rpc).toHaveBeenCalledTimes(1);
  expect(db.rpc).toHaveBeenCalledWith('get_daily_aggregate_stock_summary', { p_service_date: serviceDate });
});
