import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountingPage } from '../src/features/accounting/AccountingPage';
import { safeSpreadsheetText } from '../src/features/accounting/exportAccounting';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), exportTransactions: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../src/features/accounting/exportAccounting', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/features/accounting/exportAccounting')>(),
  exportAccountingTransactions: mocks.exportTransactions,
}));

const row = {
  occurred_at: '2026-08-08T03:00:00Z', service_date: '2026-08-08', type: 'INV',
  group_id: 'group-1', source_id: 'charge-1', source_table: 'delivery_charges',
  delivery_event_id: 'event-1', payment_id: null, document_number: 'INV2608-00001',
  reference_number: null, shop_id: 'shop-1', shop_code: 'A01', shop_name: 'ร้านทดสอบ',
  holder_name: 'จุด A', employee_id: 'user-1', employee_name: 'สมชาย',
  ice_type_id: 'ice-1', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity_in: 0,
  quantity_out: 2, sales_amount: 40, cash_in: 0, cash_out: 0, receivable_delta: 40,
  status: 'active', note: null, issue_code: null, issue_label: null, can_correct: true,
  details: { charge_id: 'charge-1' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('AccountingPage', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.exportTransactions.mockReset();
    mocks.exportTransactions.mockResolvedValue(undefined);
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_accounting_reconciliation') return { data: {
        service_date: '2026-08-08', aggregate: [], holders: [],
        financial: { effective_sales: 40, allocated_to_sales: 0, outstanding_collectible: 40, outstanding_credit: 0, cash_received: 0, cash_refunded: 0, net_cash: 0, pending_refunds: 0 },
      }, error: null };
      if (name === 'get_accounting_transactions') return { data: {
        rows: [row], total_count: 1,
        facets: { ice_types: [], shops: [], employees: [], types: [{ value: 'INV', label: 'INV', count: 1 }] },
      }, error: null };
      if (name === 'get_accounting_review_queue') return { data: { rows: [], total_count: 0 }, error: null };
      return { data: [], error: null };
    });
  });

  it('loads three read-only tabs, server ledger rows, and a lineage drawer', async () => {
    const user = userEvent.setup();
    render(<AccountingPage userRole="admin" />);
    expect(await screen.findByText('ยอดขาย effective')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'รายการแบบ Excel' }));
    expect(await screen.findByText('INV2608-00001')).not.toBeNull();
    expect(screen.getByText('ร้านทดสอบ')).not.toBeNull();
    expect(document.querySelector('.accounting-table-wrap--ledger')).not.toBeNull();
    expect(screen.queryByRole('textbox', { name: /แก้/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'INV2608-00001' }));
    expect(screen.getByLabelText('รายละเอียด INV2608-00001')).not.toBeNull();
    expect(screen.getByText(/delivery_charges · charge-1/)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'แก้ไขรายการส่ง' })).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'ปิด' }));
    await user.click(screen.getByRole('button', { name: 'รายการต้องตรวจสอบ' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_accounting_review_queue', expect.objectContaining({ p_limit: 100, p_offset: 0 })));
  });

  it('protects exported text from Excel formula injection', () => {
    expect(safeSpreadsheetText('=1+1')).toBe("'=1+1");
    expect(safeSpreadsheetText('+SUM(A:A)')).toBe("'+SUM(A:A)");
    expect(safeSpreadsheetText('@cmd')).toBe("'@cmd");
    expect(safeSpreadsheetText('INV2608-00001')).toBe('INV2608-00001');
  });

  it('exports every server page when matching rows exceed one RPC response', async () => {
    const user = userEvent.setup();
    const secondRow = { ...row, source_id: 'charge-2', document_number: 'INV2608-00002' };
    mocks.rpc.mockImplementation(async (name: string, args?: Record<string, number>) => {
      if (name === 'get_accounting_reconciliation') return { data: {
        service_date: '2026-08-08', aggregate: [], holders: [],
        financial: { effective_sales: 0, allocated_to_sales: 0, outstanding_collectible: 0, outstanding_credit: 0, cash_received: 0, cash_refunded: 0, net_cash: 0, pending_refunds: 0 },
      }, error: null };
      if (name === 'get_accounting_transactions' && args?.p_limit === 50_000) {
        return args.p_offset === 0
          ? { data: { rows: [row], total_count: 2, facets: { ice_types: [], shops: [], employees: [], types: [] } }, error: null }
          : { data: { rows: [secondRow], total_count: 2, facets: { ice_types: [], shops: [], employees: [], types: [] } }, error: null };
      }
      if (name === 'get_accounting_transactions') return { data: {
        rows: [row], total_count: 1, facets: { ice_types: [], shops: [], employees: [], types: [] },
      }, error: null };
      return { data: { rows: [], total_count: 0 }, error: null };
    });

    render(<AccountingPage userRole="admin" />);
    await user.click(await screen.findByRole('button', { name: 'รายการแบบ Excel' }));
    await screen.findByText('INV2608-00001');
    await user.click(screen.getByRole('button', { name: 'ส่งออก .xlsx' }));

    await waitFor(() => expect(mocks.exportTransactions).toHaveBeenCalledWith(
      [row, secondRow], expect.any(String), expect.any(String),
    ));
    expect(mocks.rpc).toHaveBeenCalledWith('get_accounting_transactions', expect.objectContaining({ p_limit: 50_000, p_offset: 0 }));
    expect(mocks.rpc).toHaveBeenCalledWith('get_accounting_transactions', expect.objectContaining({ p_limit: 50_000, p_offset: 1 }));
  });

  it('discards stale receipt details when a newer drawer request wins', async () => {
    const user = userEvent.setup();
    const receiptA = { ...row, type: 'REC', source_id: 'payment-a', payment_id: 'payment-a', document_number: 'REC-A', delivery_event_id: null };
    const receiptB = { ...row, type: 'REC', source_id: 'payment-b', payment_id: 'payment-b', document_number: 'REC-B', delivery_event_id: null };
    const requests = {
      'payment-a': { snapshot: deferred<unknown>(), targets: deferred<unknown>() },
      'payment-b': { snapshot: deferred<unknown>(), targets: deferred<unknown>() },
    };
    mocks.rpc.mockImplementation((name: string, args?: { p_payment_id?: 'payment-a' | 'payment-b' }) => {
      if (name === 'get_accounting_reconciliation') return Promise.resolve({ data: {
        service_date: '2026-08-08', aggregate: [], holders: [],
        financial: { effective_sales: 0, allocated_to_sales: 0, outstanding_collectible: 0, outstanding_credit: 0, cash_received: 0, cash_refunded: 0, net_cash: 0, pending_refunds: 0 },
      }, error: null });
      if (name === 'get_accounting_transactions') return Promise.resolve({ data: {
        rows: [receiptA, receiptB], total_count: 2, facets: { ice_types: [], shops: [], employees: [], types: [] },
      }, error: null });
      const paymentId = args?.p_payment_id;
      if (paymentId && name === 'get_payment_receipt_snapshot') return requests[paymentId].snapshot.promise;
      if (paymentId && name === 'get_payment_correction_targets') return requests[paymentId].targets.promise;
      return Promise.resolve({ data: [], error: null });
    });

    render(<AccountingPage userRole="admin" />);
    await user.click(await screen.findByRole('button', { name: 'รายการแบบ Excel' }));
    await user.click(await screen.findByRole('button', { name: 'REC-A' }));
    await user.click(screen.getByRole('button', { name: 'REC-B' }));

    await act(async () => {
      requests['payment-b'].snapshot.resolve({ data: { receipt: 'B' }, error: null });
      requests['payment-b'].targets.resolve({ data: [{ charge_id: 'charge-b', charge_number: 'INV-B', delivery_event_id: 'event-b' }], error: null });
    });
    expect(await screen.findByText(/"receipt": "B"/)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'แก้ไข INV-B' })).not.toBeNull();

    await act(async () => {
      requests['payment-a'].snapshot.resolve({ data: { receipt: 'A' }, error: null });
      requests['payment-a'].targets.resolve({ data: [{ charge_id: 'charge-a', charge_number: 'INV-A', delivery_event_id: 'event-a' }], error: null });
    });
    await waitFor(() => expect(screen.queryByText(/"receipt": "A"/)).toBeNull());
    expect(screen.queryByRole('button', { name: 'แก้ไข INV-A' })).toBeNull();
  });
});
