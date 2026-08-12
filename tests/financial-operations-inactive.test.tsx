import { act, render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  storage: { from: vi.fn() },
}));

vi.mock('../src/lib/supabase', () => ({ supabase: supabaseMock }));

import { FinancialOperations } from '../src/FinancialOperations';

it('does not query Supabase while the keep-alive financial page is inactive', async () => {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  supabaseMock.from.mockReturnValue(query);
  const view = render(<FinancialOperations isActive={false} userRole="courier" />);

  await act(async () => Promise.resolve());

  expect(supabaseMock.from).not.toHaveBeenCalled();
  expect(supabaseMock.rpc).not.toHaveBeenCalled();
  expect(supabaseMock.storage.from).not.toHaveBeenCalled();

  view.rerender(<FinancialOperations isActive userRole="courier" />);
  await waitFor(() => expect(supabaseMock.from).toHaveBeenCalledWith('collection_runs'));
  expect(supabaseMock.from).not.toHaveBeenCalledWith('payments');
});
