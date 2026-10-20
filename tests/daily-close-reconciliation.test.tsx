import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: supabaseMock }));

import { DailyAggregateStockClose } from '../src/features/stock-control/components/DailyAggregateStockClose';

it.each(['open', 'closed'])('prefers nicknames with full-name fallback on %s cash cards', async (status) => {
  supabaseMock.rpc.mockImplementation((name: string) => Promise.resolve({
    error: null,
    data: name === 'get_daily_close_reconciliation' ? {
      service_date: '2026-10-20', status, feature_enabled: true,
      stock: { service_date: '2026-10-20', status, items: [] },
      employees: [
        { employee_id: '1', employee_name: 'long.employee@example.com', employee_nickname: '  ชาย  ' },
        { employee_id: '2', employee_name: 'Empty nickname', employee_nickname: '   ' },
        { employee_id: '3', employee_name: 'Legacy response' },
        { employee_id: '4', employee_name: 'Null nickname', employee_nickname: null },
      ].map(employee => ({ ...employee, is_active: true, expected_cash_amount: 0, payment_ids: [] })),
    } : [],
  }));
  render(<DailyAggregateStockClose serviceDate="2026-10-20" />);
  const nickname = await screen.findByText('ชาย', { exact: true });
  expect(nickname.title).toBe('long.employee@example.com');
  expect(screen.queryByText('long.employee@example.com', { exact: true })).toBeNull();
  for (const name of ['Empty nickname', 'Legacy response', 'Null nickname']) {
    expect(screen.getByText(name, { exact: true })).toBeTruthy();
  }
});

it('requires explicit counts for courier, admin and lead, including zero and variance reasons', async () => {
  supabaseMock.rpc.mockImplementation((name: string) => Promise.resolve({
    error: null,
    data: name === 'get_daily_close_reconciliation' ? {
      service_date: '2026-10-20', status: 'open', feature_enabled: true,
      stock: { service_date: '2026-10-20', status: 'open', items: [
        { ice_type_id: 'ice-1', name: 'หลอด', unit: 'ถุง', available_quantity: 0 },
      ] },
      employees: [
        { employee_id: 'courier-1', employee_name: 'พนักงานส่งของ', expected_cash_amount: 100 },
        { employee_id: 'admin-1', employee_name: 'แอดมิน', expected_cash_amount: 50 },
        { employee_id: 'lead-1', employee_name: 'หัวหน้า', expected_cash_amount: 0 },
      ].map(employee => ({ ...employee, is_active: true, actual_cash_amount: null, payment_ids: [] })),
    } : name === 'get_daily_stock_refill_history' ? [] : { status: 'closed' },
  }));
  const user = userEvent.setup();
  render(<DailyAggregateStockClose serviceDate="2026-10-20" />);
  await screen.findByRole('heading', { name: 'เงินสดรายบุคคล' });
  const card = (name: string) => within(screen.getByText(name, { exact: true }).closest('article')!);
  const close = screen.getByRole('button', { name: 'ปิดยอดสต๊อกและเงินสดวันนี้' }) as HTMLButtonElement;
  expect(close.disabled).toBe(true);
  await user.type(card('พนักงานส่งของ').getByLabelText(/^หัวหน้านับจริง/), '100');
  expect(close.disabled).toBe(true);
  await user.type(card('แอดมิน').getByLabelText(/^หัวหน้านับจริง/), '40');
  expect(close.disabled).toBe(true);
  await user.type(card('หัวหน้า').getByLabelText(/^หัวหน้านับจริง/), '0');
  expect(close.disabled).toBe(true);
  await user.type(card('แอดมิน').getByLabelText('เหตุผลส่วนต่าง *'), 'เงินขาด 10 บาท');
  expect(close.disabled).toBe(false);
  await user.click(close);
  await waitFor(() => expect(supabaseMock.rpc).toHaveBeenCalledWith('close_daily_reconciliation_v2',
    expect.objectContaining({ p_cash_counts: [
      { employee_id: 'courier-1', actual_cash_amount: 100, reason: null },
      { employee_id: 'admin-1', actual_cash_amount: 40, reason: 'เงินขาด 10 บาท' },
      { employee_id: 'lead-1', actual_cash_amount: 0, reason: null },
    ] })));
});

it.each([10, 9])('records courier cash with only employee reasons when stock count is %s', async (stockCount) => {
  supabaseMock.rpc.mockImplementation((name: string) => {
    if (name === 'get_daily_close_reconciliation') return Promise.resolve({
      data: {
        service_date: '2026-08-26',
        status: 'open',
        feature_enabled: true,
        enabled_from_service_date: '2026-08-26',
        stock: {
          service_date: '2026-08-26',
          status: 'open',
          items: [{
            ice_type_id: 'ice-1', code: 'ICE', name: 'น้ำแข็งหลอด', unit: 'ถุง',
            available_quantity: 10,
          }],
        },
        employees: [{
          employee_id: 'courier-1', employee_name: 'สมชาย', is_active: true,
          expected_cash_amount: 100, actual_cash_amount: null,
          cash_variance_amount: null, cash_reason: null, payment_ids: ['payment-1'], cash_source_count: 3,
        }],
      },
      error: null,
    });
    if (name === 'get_daily_stock_refill_history') return Promise.resolve({ data: [], error: null });
    if (name === 'close_daily_reconciliation_v2') return Promise.resolve({ data: { status: 'closed' }, error: null });
    return Promise.resolve({ data: null, error: null });
  });

  const user = userEvent.setup();
  render(<DailyAggregateStockClose serviceDate="2026-08-26" />);

  const cashInput = await screen.findByLabelText(/^หัวหน้านับจริง/);
  expect(screen.getByText('3 รายการเงินสด')).toBeTruthy();
  expect((cashInput as HTMLInputElement).value).toBe('');
  expect((screen.getByRole('button', { name: 'ปิดยอดสต๊อกและเงินสดวันนี้' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByLabelText(/^หมายเหตุ/)).toBeNull();
  await user.type(screen.getByLabelText(/^นับจริง/), String(stockCount));
  expect((screen.getByLabelText(/^นับจริง/) as HTMLInputElement).value).toBe(String(stockCount));
  await user.clear(cashInput);
  await user.type(cashInput, '90');
  expect((screen.getByRole('button', { name: 'ปิดยอดสต๊อกและเงินสดวันนี้' }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByLabelText('เหตุผลส่วนต่าง *'), 'ลูกค้ายังค้างเงิน');
  await user.click(screen.getByRole('button', { name: 'ปิดยอดสต๊อกและเงินสดวันนี้' }));

  await waitFor(() => expect(supabaseMock.rpc).toHaveBeenCalledWith(
    'close_daily_reconciliation_v2',
    expect.objectContaining({
      p_service_date: '2026-08-26',
      p_stock_counts: [{ ice_type_id: 'ice-1', actual_quantity: stockCount, note: stockCount === 10 ? null : 'ส่วนต่างยังไม่ทราบสาเหตุ' }],
      p_stock_note: null,
      p_cash_counts: [{
        employee_id: 'courier-1', actual_cash_amount: 90, reason: 'ลูกค้ายังค้างเงิน',
      }],
    }),
  ));
  expect(supabaseMock.rpc).not.toHaveBeenCalledWith('close_daily_aggregate_stock', expect.anything());
});

it('keeps the legacy stock close during dark launch without recording cash', async () => {
  supabaseMock.rpc.mockImplementation((name: string) => {
    if (name === 'get_daily_close_reconciliation') return Promise.resolve({
      data: {
        service_date: '2026-08-26', status: 'open', feature_enabled: false,
        enabled_from_service_date: null,
        stock: { service_date: '2026-08-26', status: 'open', items: [{
          ice_type_id: 'ice-1', code: 'ICE', name: 'น้ำแข็งหลอด', unit: 'ถุง', available_quantity: 10,
        }, {
          ice_type_id: 'ice-2', code: 'BLOCK', name: 'น้ำแข็งก้อน', unit: 'แถว', available_quantity: 0,
        }] },
        employees: [],
      },
      error: null,
    });
    return Promise.resolve({ data: [], error: null });
  });

  const user = userEvent.setup();
  render(<DailyAggregateStockClose serviceDate="2026-08-26" />);
  await screen.findByText('Dark launch');
  expect((screen.getByRole('button', { name: 'ปิดสต๊อกและจบงานวันนี้' }) as HTMLButtonElement).disabled).toBe(false);
  const stockInputs = screen.getAllByLabelText(/^นับจริง/);
  expect(stockInputs.map((input) => (input as HTMLInputElement).value)).toEqual(['0', '0']);
  await user.type(stockInputs[0], '10');
  expect((stockInputs[0] as HTMLInputElement).value).toBe('10');
  await user.click(screen.getByRole('button', { name: 'ปิดสต๊อกและจบงานวันนี้' }));

  await waitFor(() => expect(supabaseMock.rpc).toHaveBeenCalledWith(
    'close_daily_aggregate_stock', expect.objectContaining({
      p_service_date: '2026-08-26',
      p_counts: [
        { ice_type_id: 'ice-1', actual_quantity: 10, note: null },
        { ice_type_id: 'ice-2', actual_quantity: 0, note: null },
      ],
    }),
  ));
  expect(supabaseMock.rpc).not.toHaveBeenCalledWith('close_daily_reconciliation_v2', expect.anything());
});

it.each(['click', 'keyboard'])('replaces default zero without deletion via %s and restores an untouched zero', async (entry) => {
  supabaseMock.rpc.mockImplementation((name: string) => Promise.resolve({ error: null, data:
    name === 'get_daily_close_reconciliation' ? {
      stock: { service_date: '2026-08-26', status: 'open', items: [
        { ice_type_id: 'ice-1', name: 'หลอด', unit: 'ถุง', available_quantity: 10.5 },
        { ice_type_id: 'ice-2', name: 'ก้อน', unit: 'แถว', available_quantity: 0 },
      ] },
      employees: [], feature_enabled: false,
    } : [],
  }));
  const user = userEvent.setup();
  render(<DailyAggregateStockClose serviceDate="2026-08-26" />);
  const [stock, emptyStock] = await screen.findAllByLabelText(/^นับจริง/) as HTMLInputElement[];
  if (entry === 'keyboard') await user.tab();
  else await user.click(stock);
  expect(document.activeElement).toBe(stock);
  expect(stock.value).toBe('');
  await user.keyboard('10.5');
  expect(stock.value).toBe('10.5');
  await user.tab();
  expect(document.activeElement).toBe(emptyStock);
  expect(emptyStock.value).toBe('');
  await user.tab();
  expect(emptyStock.value).toBe('0');
  await user.click(stock);
  expect(stock.value).toBe('10.5');
  await user.click(screen.getByRole('button', { name: 'ปิดสต๊อกและจบงานวันนี้' }));
  await waitFor(() => expect(supabaseMock.rpc).toHaveBeenCalledWith('close_daily_aggregate_stock', expect.objectContaining({
    p_counts: [
      { ice_type_id: 'ice-1', actual_quantity: 10.5, note: null },
      { ice_type_id: 'ice-2', actual_quantity: 0, note: null },
    ],
  })));
});

it('defaults stock to zero, still requires cash counts, and rejects blank or invalid stock counts', async () => {
  supabaseMock.rpc.mockImplementation((name: string) => Promise.resolve({ error: null, data:
    name === 'get_daily_close_reconciliation' ? {
      service_date: '2026-08-26', status: 'open', feature_enabled: true,
      stock: { service_date: '2026-08-26', status: 'open', items: [
        { ice_type_id: 'ice-1', name: 'หลอด', unit: 'ถุง', available_quantity: 0 },
      ] },
      employees: [{ employee_id: 'courier-1', employee_name: 'สมชาย', is_active: true,
        expected_cash_amount: 0, actual_cash_amount: null, payment_ids: [] }],
    } : name === 'get_daily_stock_refill_history' ? [] : { status: 'closed' },
  }));
  const user = userEvent.setup();
  render(<DailyAggregateStockClose serviceDate="2026-08-26" />);
  const stock = await screen.findByLabelText(/^นับจริง/);
  const cash = screen.getByLabelText(/^หัวหน้านับจริง/);
  const close = screen.getByRole('button', { name: 'ปิดยอดสต๊อกและเงินสดวันนี้' }) as HTMLButtonElement;
  expect((stock as HTMLInputElement).value).toBe('0');
  expect((cash as HTMLInputElement).value).toBe('');
  expect(close.disabled).toBe(true);
  await user.type(cash, '0');
  expect(close.disabled).toBe(false);
  await user.clear(stock);
  expect(close.disabled).toBe(true);
  await user.type(stock, '0.1');
  expect(close.disabled).toBe(true);
  await user.clear(stock);
  await user.type(stock, '0');
  await user.click(close);
  await waitFor(() => expect(supabaseMock.rpc).toHaveBeenCalledWith('close_daily_reconciliation_v2', expect.objectContaining({
    p_stock_counts: [{ ice_type_id: 'ice-1', actual_quantity: 0, note: null }],
    p_cash_counts: [{ employee_id: 'courier-1', actual_cash_amount: 0, reason: null }],
  })));
});
