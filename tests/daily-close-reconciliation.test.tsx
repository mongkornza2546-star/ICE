import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: supabaseMock }));

import { DailyAggregateStockClose } from '../src/features/stock-control/components/DailyAggregateStockClose';

it('records manager-counted courier cash in the atomic daily close', async () => {
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
          cash_variance_amount: null, cash_reason: null, payment_ids: ['payment-1'],
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
  await user.clear(cashInput);
  await user.type(cashInput, '90');
  await user.type(screen.getByLabelText('เหตุผลส่วนต่าง *'), 'ลูกค้ายังค้างเงิน');
  await user.click(screen.getByRole('button', { name: 'ปิดยอดสต๊อกและเงินสดวันนี้' }));

  await waitFor(() => expect(supabaseMock.rpc).toHaveBeenCalledWith(
    'close_daily_reconciliation_v2',
    expect.objectContaining({
      p_service_date: '2026-08-26',
      p_stock_counts: [{ ice_type_id: 'ice-1', actual_quantity: 10, note: null }],
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
  await user.click(screen.getByRole('button', { name: 'ปิดสต๊อกและจบงานวันนี้' }));

  await waitFor(() => expect(supabaseMock.rpc).toHaveBeenCalledWith(
    'close_daily_aggregate_stock', expect.objectContaining({ p_service_date: '2026-08-26' }),
  ));
  expect(supabaseMock.rpc).not.toHaveBeenCalledWith('close_daily_reconciliation_v2', expect.anything());
});
