import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FinancialOperations } from '../src/FinancialOperations';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  createSignedUrls: vi.fn(),
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
    storage: {
      from: () => ({ createSignedUrls: mocks.createSignedUrls }),
    },
  },
}));

function queryResult(data: unknown, error: { message: string } | null = null) {
  const result = { data, error };
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit']) query[method] = vi.fn(() => query);
  query.maybeSingle = vi.fn().mockResolvedValue(result);
  query.then = (resolve: (value: typeof result) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return query;
}

const queueShop = {
  shop_id: 'shop-1',
  shop_code: 'S001',
  shop_name: 'ร้านเก็บเงิน',
  outstanding_amount: 100,
  charge_count: 2,
  has_new_charges: false,
  payment_profile: {
    allowed_payment_methods: ['cash'],
    default_payment_method: 'cash',
    cash_reference_required: false,
    cash_evidence_required: false,
    bank_transfer_reference_required: true,
    bank_transfer_evidence_required: false,
    qr_reference_required: true,
    qr_evidence_required: false,
  },
  charges: [
    { charge_id: 'charge-1', outstanding_amount: 60 },
    { charge_id: 'charge-2', outstanding_amount: 40 },
  ],
};

describe('FinancialOperations', () => {
  beforeEach(() => {
    mocks.from.mockReset();
    mocks.rpc.mockReset();
    mocks.createSignedUrls.mockReset();
    mocks.createSignedUrls.mockResolvedValue({ data: [], error: null });
  });

  it('lets an assigned courier record a partial collection oldest-first', async () => {
    const user = userEvent.setup();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_today_collection_run_queue') return { data: [queueShop], error: null };
      if (name === 'record_payment') return { data: { payment_id: 'payment-1' }, error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="courier" />);
    await user.click(await screen.findByRole('button', { name: /S001 · ร้านเก็บเงิน/ }));
    expect(mocks.rpc).toHaveBeenCalledWith('get_today_collection_run_queue', {
      p_collection_run_id: 'run-1',
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith('get_collection_run_queue', expect.anything());
    const amount = screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' });
    await user.clear(amount);
    await user.type(amount, '70');
    await user.click(screen.getByRole('button', { name: 'ยืนยันรับเงิน' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('record_payment', expect.objectContaining({
      p_allocations: [
        { charge_id: 'charge-1', amount: 60 },
        { charge_id: 'charge-2', amount: 10 },
      ],
      p_received_amount: 70,
      p_collection_run_id: 'run-1',
      p_approval_id: null,
    })));
  });

  it('opens a run with the selected collector assignment', async () => {
    const user = userEvent.setup();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult(null);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_credit_receivables') return { data: [], error: null };
      if (name === 'get_collection_collectors') return {
        data: [{ id: 'courier-1', code: 'C001', display_name: 'พนักงานหนึ่ง', nickname: 'น้องหนึ่ง', avatar_path: null }],
        error: null,
      };
      if (name === 'open_collection_run') return { data: { collection_run_id: 'run-1' }, error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="round_lead" />);
    await user.click(await screen.findByRole('checkbox', { name: /น้องหนึ่ง/ }));
    await user.click(screen.getByRole('button', { name: 'เปิดรอบและมอบหมาย' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('open_collection_run', expect.objectContaining({
      p_member_ids: [{ user_id: 'courier-1' }],
    })));
    expect(mocks.rpc).toHaveBeenCalledWith('get_collection_collectors');
    expect(mocks.from).not.toHaveBeenCalledWith('users');
  });

  it('shows a collector nickname and the configured profile photo', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult(null);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_credit_receivables') return { data: [], error: null };
      if (name === 'get_collection_collectors') return {
        data: [{ id: 'courier-1', code: 'C001', display_name: 'พนักงานหนึ่ง', nickname: 'น้องหนึ่ง', avatar_path: 'courier-1/avatar.webp' }],
        error: null,
      };
      return { data: [], error: null };
    });
    mocks.createSignedUrls.mockResolvedValue({
      data: [{ path: 'courier-1/avatar.webp', signedUrl: 'https://cdn.example.test/courier-1/avatar.webp' }],
      error: null,
    });

    const { container } = render(<FinancialOperations userRole="round_lead" />);

    await screen.findByText('น้องหนึ่ง');
    await waitFor(() => expect(mocks.createSignedUrls).toHaveBeenCalledWith(['courier-1/avatar.webp'], 3600));
    expect(container.querySelector('img[src="https://cdn.example.test/courier-1/avatar.webp"]')).not.toBeNull();
  });

  it('keeps the collector fallback visible when avatar signing rejects', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult(null);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_collectors') return {
        data: [{ id: 'courier-1', code: 'C001', display_name: 'พนักงานหนึ่ง', nickname: null, avatar_path: 'courier-1/avatar.webp' }],
        error: null,
      };
      return { data: [], error: null };
    });
    mocks.createSignedUrls.mockRejectedValue(new Error('storage unavailable'));

    const { container } = render(<FinancialOperations userRole="round_lead" />);

    await screen.findByText('พนักงานหนึ่ง');
    await waitFor(() => expect(mocks.createSignedUrls).toHaveBeenCalled());
    expect(container.querySelector('.financial-ops__collector-avatar img')).toBeNull();
    expect(container.querySelector('.financial-ops__collector-avatar svg')).not.toBeNull();
  });

  it('lets a manager void an active payment from recent history', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('บันทึกยอดผิด');
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult(null);
      if (table === 'payments') return queryResult([{
        id: 'payment-1',
        received_amount: 100,
        payment_method: 'cash',
        status: 'active',
        recorded_at: '2026-07-27T08:00:00Z',
        void_reason: null,
        shops: { code: 'S001', name: 'ร้านเก็บเงิน' },
      }]);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_credit_receivables') return { data: [], error: null };
      if (name === 'void_payment') return { data: { payment_id: 'payment-1' }, error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="round_lead" />);
    await user.click(await screen.findByRole('button', { name: 'ยกเลิกรายการ' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('void_payment', {
      p_payment_id: 'payment-1',
      p_reason: 'บันทึกยอดผิด',
    }));
  });
});
