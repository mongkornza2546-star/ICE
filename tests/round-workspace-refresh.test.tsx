import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: db }));
import { RoundWorkspace } from '../src/RoundWorkspace';
import { toBangkokDateString } from '../src/lib/serviceDate';
import { publishDataChange } from '../src/lib/dataChange';

it.each([true, false])('refreshes stock on return and data changes (has round: %s)', async (hasRound) => {
  db.from.mockImplementation((table: string) => {
    const query = {
      select: () => query, order: () => query, eq: () => query,
      then: (resolve: (data: unknown) => void) => Promise.resolve({
        error: null,
        data: table === 'delivery_rounds' && hasRound ? [{
          id: 'same-round', service_date: toBangkokDateString(), name: 'Daily',
          round_type: 'daily', status: 'open',
        }] : [],
      }).then(resolve),
    };
    return query;
  });
  db.rpc.mockImplementation((name: string) => Promise.resolve({
    error: null, data: name === 'get_stock_control_summary' ? { locations: [] }
      : name === 'get_daily_close_reconciliation' ? {
        stock: { service_date: toBangkokDateString(), status: 'open', items: [] },
        employees: [], feature_enabled: false,
      } : name === 'get_daily_stock_refill_history' ? [] : { is_closed: false },
  }));
  const view = render(<RoundWorkspace isActive />);
  await waitFor(() => expect(db.rpc).toHaveBeenCalledWith('get_stock_control_summary', expect.anything()));
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /ตรวจนับจริง/ })); });
  const closeCalls = () => db.rpc.mock.calls.filter(([name]) => name === 'get_daily_close_reconciliation').length;
  const beforeClose = closeCalls();
  const summaryCalls = () => db.rpc.mock.calls.filter(([name]) => name === 'get_stock_control_summary').length;
  const before = summaryCalls();
  view.rerender(<RoundWorkspace isActive={false} />);
  await act(async () => { view.rerender(<RoundWorkspace isActive />); });
  expect(db.from.mock.calls.filter(([name]) => name === 'delivery_rounds')).toHaveLength(2);
  expect(summaryCalls()).toBeGreaterThan(before);
  expect(closeCalls()).toBeGreaterThan(beforeClose);
  const beforeChange = summaryCalls();
  await act(async () => { publishDataChange(['stock']); });
  expect(summaryCalls()).toBeGreaterThan(beforeChange);
});
