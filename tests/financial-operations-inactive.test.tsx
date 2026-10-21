import { act, render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  storage: { from: vi.fn() },
}));

vi.mock('../src/lib/supabase', () => ({ supabase: supabaseMock }));

import { FinancialOperations } from '../src/FinancialOperations';
import { toBangkokDateString } from '../src/lib/serviceDate';

it('does not query Supabase while the keep-alive financial page is inactive', async () => {
  const serviceDate = toBangkokDateString();
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  supabaseMock.from.mockReturnValue(query);
  supabaseMock.rpc.mockImplementation((name: string) => {
    if (name === 'get_daily_shop_collection_queue') return Promise.resolve({
      data: { collection_run_id: 'run-1', status: 'open', queue: [] },
      error: null,
    });
    return Promise.resolve({ data: [], error: null });
  });
  const view = render(<FinancialOperations isActive={false} userRole="courier" />);

  await act(async () => Promise.resolve());

  expect(supabaseMock.from).not.toHaveBeenCalled();
  expect(supabaseMock.rpc).not.toHaveBeenCalled();
  expect(supabaseMock.storage.from).not.toHaveBeenCalled();

  view.rerender(<FinancialOperations isActive userRole="courier" />);
  await waitFor(() => expect(supabaseMock.rpc).toHaveBeenCalledWith('get_daily_shop_collection_queue', {
    p_service_date: serviceDate,
  }));
  expect(supabaseMock.from).not.toHaveBeenCalledWith('collection_runs');
  expect(supabaseMock.from).not.toHaveBeenCalledWith('payments');
});
