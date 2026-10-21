import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: db }));
import { RoundWorkspace } from '../src/RoundWorkspace';
import { createRealtimeSync } from '../src/lib/realtimeSync';
import { toBangkokDateString } from '../src/lib/serviceDate';
import { publishDataChange } from '../src/lib/dataChange';
import { DailyAggregateStockClose } from '../src/features/stock-control/components/DailyAggregateStockClose';

let stockQuantity = 10;
let resolveRefresh: (() => void) | undefined;
let holdRefresh = false;

beforeEach(() => {
  stockQuantity = 10;
  holdRefresh = false;
  resolveRefresh = undefined;
  db.from.mockImplementation(() => {
    const query = {
      select: () => query, order: () => query, eq: () => query,
      then: (resolve: (data: unknown) => void) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return query;
  });
  db.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_daily_close_reconciliation') {
      if (holdRefresh) await new Promise<void>((resolve) => { resolveRefresh = resolve; });
      return { error: null, data: {
        stock: { service_date: toBangkokDateString(), status: 'open', items: [
          { ice_type_id: 'ice', name: 'หลอด', unit: 'ถุง', available_quantity: stockQuantity },
        ] },
        employees: [{ employee_id: 'employee', employee_name: 'สมชาย', is_active: true,
          expected_cash_amount: 100, actual_cash_amount: null, payment_ids: [] }],
        feature_enabled: true,
      } };
    }
    return { error: null, data: name === 'get_stock_control_summary' ? { service_date: toBangkokDateString(), locations: [] }
      : name === 'get_daily_stock_refill_history' ? [] : { service_date: toBangkokDateString(), status: 'open', items: [] } };
  });
});

afterEach(() => vi.useRealTimers());

async function enterCountDraft() {
  const user = userEvent.setup();
  render(<RoundWorkspace isActive />);
  await user.click(await screen.findByRole('button', { name: /ตรวจนับจริง/ }));
  const stock = await screen.findByLabelText(/^นับจริง/) as HTMLInputElement;
  await user.type(stock, '8');
  await user.type(screen.getByLabelText(/^หัวหน้านับจริง/), '90');
  await user.type(screen.getByLabelText('เหตุผลส่วนต่าง *'), 'เงินขาด');
  return { user, stock };
}

function expectCountDraft(stock: HTMLInputElement) {
  expect(screen.getByLabelText(/^นับจริง/)).toBe(stock);
  expect(stock.value).toBe('8');
  expect((screen.getByLabelText(/^หัวหน้านับจริง/) as HTMLInputElement).value).toBe('90');
  expect((screen.getByLabelText('เหตุผลส่วนต่าง *') as HTMLInputElement).value).toBe('เงินขาด');
}

it.each(['โอนระหว่างจุด', 'เสียหาย / ละลาย'])('preserves the count draft when switching to %s and back', async (tab) => {
  const { user, stock } = await enterCountDraft();
  const before = db.rpc.mock.calls.filter(([name]) => name === 'get_daily_close_reconciliation').length;
  await user.click(screen.getByRole('button', { name: tab }));
  expect(screen.queryByRole('spinbutton', { name: /^นับจริง/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: /ตรวจนับจริง/ }));
  await screen.findByLabelText(/^นับจริง/);
  expectCountDraft(stock);
  expect(db.rpc.mock.calls.filter(([name]) => name === 'get_daily_close_reconciliation')).toHaveLength(before);
});

it.each(['get_stock_control_summary', 'get_daily_aggregate_stock_summary', 'rejected request'])('preserves the count draft after a transient %s failure and retry', async (failure) => {
  const { stock } = await enterCountDraft();
  const originalRpc = db.rpc.getMockImplementation()!;
  let shouldFail = true;
  db.rpc.mockImplementation((name: string) => {
    if (shouldFail && name === (failure === 'rejected request' ? 'get_stock_control_summary' : failure)) {
      if (failure === 'rejected request') return Promise.reject(new Error('temporary network error'));
      return Promise.resolve({ data: null, error: { message: 'temporary network error' } });
    }
    return originalRpc(name);
  });
  await act(async () => { publishDataChange(['stock']); });
  expect(await screen.findByRole('alert')).not.toBeNull();
  expect(screen.getByText('temporary network error')).not.toBeNull();
  expectCountDraft(stock);
  shouldFail = false;
  fireEvent.click(screen.getByRole('button', { name: 'รีเฟรชข้อมูลสต๊อก' }));
  await waitFor(() => expect(screen.queryByText('temporary network error')).toBeNull());
  expectCountDraft(stock);
});

it.each(['browser', 'workspace', 'data change'])('keeps count inputs mounted and preserves drafts on %s refresh', async (trigger) => {
  const view = render(<RoundWorkspace isActive />);
  fireEvent.click(await screen.findByRole('button', { name: /ตรวจนับจริง/ }));
  const stock = await screen.findByLabelText(/^นับจริง/) as HTMLInputElement;
  const cash = screen.getByLabelText(/^หัวหน้านับจริง/) as HTMLInputElement;
  fireEvent.change(stock, { target: { value: '8' } });
  fireEvent.change(cash, { target: { value: '90' } });
  fireEvent.change(screen.getByLabelText('เหตุผลส่วนต่าง *'), { target: { value: 'เงินขาด' } });
  stock.focus();
  stockQuantity = 12;
  holdRefresh = true;

  // Use the actual browser-focus -> global sync -> workspace -> count form chain.
  const channel = { on: vi.fn().mockReturnThis(), subscribe: vi.fn() };
  const stopSync = createRealtimeSync({ channel: () => channel, removeChannel: vi.fn() } as never);
  try {
    if (trigger === 'browser') {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await act(async () => {
        fireEvent(window, new Event('focus'));
        fireEvent(document, new Event('visibilitychange'));
        vi.advanceTimersByTime(250);
      });
      vi.useRealTimers();
    } else if (trigger === 'workspace') {
      view.rerender(<RoundWorkspace isActive={false} />);
      await act(async () => { view.rerender(<RoundWorkspace isActive />); });
    } else {
      await act(async () => { publishDataChange(['stock']); });
    }
    await waitFor(() => expect(resolveRefresh).toBeDefined());
    expect(screen.queryByText('กำลังโหลดยอดสต๊อกรวม...')).toBeNull();
    expect(screen.getByLabelText(/^นับจริง/)).toBe(stock);
    expect(document.activeElement).toBe(stock);
    expect((screen.getByRole('button', { name: 'ปิดยอดสต๊อกและเงินสดวันนี้' }) as HTMLButtonElement).disabled).toBe(true);
    // Edits made while the server response is pending must survive too.
    fireEvent.change(stock, { target: { value: '7' } });
    await act(async () => { resolveRefresh?.(); });
    expect(stock.value).toBe('7');
    expect(cash.value).toBe('90');
    expect((screen.getByLabelText('เหตุผลส่วนต่าง *') as HTMLInputElement).value).toBe('เงินขาด');
    expect(screen.getByText(/ตามระบบ 12 ถุง/)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ปิดยอดสต๊อกและเงินสดวันนี้' }));
    await waitFor(() => expect(db.rpc).toHaveBeenCalledWith('close_daily_reconciliation_v2', expect.objectContaining({
      p_stock_counts: [{ ice_type_id: 'ice', actual_quantity: 7, note: 'ส่วนต่างยังไม่ทราบสาเหตุ' }],
      p_cash_counts: [{ employee_id: 'employee', actual_cash_amount: 90, reason: 'เงินขาด' }],
    })));
  } finally {
    stopSync();
    await act(async () => { resolveRefresh?.(); });
  }
});

it('starts a fresh count and note when changing the service date', async () => {
  const view = render(<DailyAggregateStockClose serviceDate="2026-10-15" />);
  fireEvent.change(await screen.findByLabelText(/^นับจริง/), { target: { value: '8' } });
  fireEvent.change(screen.getByLabelText(/^หัวหน้านับจริง/), { target: { value: '90' } });
  fireEvent.change(screen.getByLabelText('เหตุผลส่วนต่าง *'), { target: { value: 'เงินขาด' } });

  await act(async () => { view.rerender(<DailyAggregateStockClose serviceDate="2026-10-16" />); });

  expect((screen.getByLabelText(/^นับจริง/) as HTMLInputElement).value).toBe('0');
  expect((screen.getByLabelText(/^หัวหน้านับจริง/) as HTMLInputElement).value).toBe('');
  expect(screen.queryByLabelText('เหตุผลส่วนต่าง *')).toBeNull();
});

it('replaces an open draft with the server snapshot when another manager closes the day', async () => {
  const view = render(<DailyAggregateStockClose serviceDate="2026-10-15" />);
  fireEvent.change(await screen.findByLabelText(/^นับจริง/), { target: { value: '8' } });
  db.rpc.mockResolvedValueOnce({ error: null, data: {
    stock: { service_date: '2026-10-15', status: 'closed', items: [
      { ice_type_id: 'ice', name: 'หลอด', unit: 'ถุง', available_quantity: 0, actual_quantity: 6, variance_quantity: -4 },
    ] },
    employees: [], feature_enabled: true,
  } });
  await act(async () => { view.rerender(<DailyAggregateStockClose serviceDate="2026-10-15" refreshId={1} />); });
  expect(screen.queryByLabelText(/^นับจริง/)).toBeNull();
  expect(screen.getByText(/ปิดสต๊อกรวมวันที่ 2026-10-15/)).not.toBeNull();
  expect(screen.getByRole('row', { name: /หลอด 10 ถุง 6 ถุง ขาด 4 ถุง/ })).not.toBeNull();
});
