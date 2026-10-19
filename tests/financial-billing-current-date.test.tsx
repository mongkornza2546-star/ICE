import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), print: vi.fn(() => true) }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('../src/lib/billingStatementPrint', () => ({ printBillingStatement: mocks.print }));
vi.mock('../src/lib/dataChange', () => ({ publishDataChange: vi.fn(), subscribeToDataChange: () => () => {} }));
import { FinancialOperations } from '../src/FinancialOperations';

it('issues from the credit screen using the server date even when its service date is stale', async () => {
  const charges = [60, 60, 120, 60, 60, 60, 60].map((amount, index) => ({
    charge_id: `charge-${index}`, charge_number: `INV-${index}`,
    service_date: '2026-10-01', due_date: '2026-10-15', original_amount: amount,
    outstanding_amount: amount, allocated_amount: 0, days_overdue: 0,
    payment_status: 'unpaid', due_status: 'due_today', assigned_collection_run_id: null,
  }));
  const receivable = {
    shop_id: 'shop-cc6', shop_code: 'CC6', shop_name: 'ขนมปราง',
    credit_limit: null, available_credit_amount: null, outstanding_amount: 480,
    overdue_amount: 0, oldest_due_date: '2026-10-15', charges,
  };
  const statement = {
    id: 'statement-1', statement_number: 'BIL2610-00004', shop_id: 'shop-cc6',
    status: 'active', issued_service_date: '2026-10-19', total_amount: 480,
    outstanding_amount: 480, items: charges,
  };
  const query = { select: vi.fn(), eq: vi.fn(), order: vi.fn().mockResolvedValue({ data: [], error: null }) };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  mocks.from.mockReturnValue(query);
  let issued = false;
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === 'get_credit_receivables') return { data: [receivable], error: null };
    if (name === 'get_credit_receivable_detail') return { data: { charges, payments: [], ice_types: [] }, error: null };
    if (name === 'get_billing_statements') return { data: issued ? [statement] : [], error: null };
    if (name === 'create_billing_statement') {
      if (args.p_issued_service_date) return { data: null, error: { code: 'P0001', message: 'Billing statements must be issued for today' } };
      issued = true;
      return { data: statement, error: null };
    }
    return { data: [], error: null };
  });
  const printWindow = { close: vi.fn() } as unknown as Window;
  vi.spyOn(window, 'open').mockReturnValue(printWindow);
  render(<FinancialOperations userRole="admin" managerPage="credit" serviceDate="2026-10-15" />);
  fireEvent.click(await screen.findByRole('button', { name: 'เปิดรายละเอียด CC6' }));
  const issue = await screen.findByRole('button', { name: 'ออกใบวางบิล' });
  await waitFor(() => expect(issue.hasAttribute('disabled')).toBe(false));
  fireEvent.click(issue);
  fireEvent.click(screen.getByRole('button', { name: 'ออกและพิมพ์ใบวางบิล' }));
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('create_billing_statement', {
    p_shop_id: 'shop-cc6', p_charge_ids: charges.map((charge) => charge.charge_id),
  }));
  await waitFor(() => expect(mocks.print).toHaveBeenCalledWith(statement, printWindow, charges));
  expect(screen.queryByRole('dialog', { name: 'ออกใบวางบิล' })).toBeNull();
  expect(screen.getByRole('button', { name: 'พิมพ์ BIL2610-00004' })).toBeTruthy();
});
