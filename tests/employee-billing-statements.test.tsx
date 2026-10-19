import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), print: vi.fn(), android: vi.fn(() => true) }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../src/lib/employeeBillingStatementPrint', () => ({ printEmployeeBillingStatement: mocks.print }));
vi.mock('../src/lib/thermalPrinter', () => ({ isAndroidApp: mocks.android }));
vi.mock('../src/lib/collectionContext', () => ({ invalidateCurrentCollectionContext: vi.fn() }));
vi.mock('../src/lib/dataChange', () => ({ publishDataChange: vi.fn(), subscribeToDataChange: () => () => {} }));
import { EmployeeBillingStatementsPanel } from '../src/features/financial-operations/components/EmployeeBillingStatementsPanel';

it('lets employees issue and reprint the saved statement after a printer failure without void controls', async () => {
  const charge = { charge_id: 'bill', charge_number: 'INV-1', service_date: '2026-10-01', due_date: '2026-10-01', outstanding_amount: 150 };
  const statement = { id: 'statement', statement_number: 'BIL-1', issued_service_date: '2026-10-15', total_amount: 150, outstanding_amount: 150, status: 'active', items: [charge] };
  mocks.rpc.mockImplementation(async (name: string) => ({
    data: name === 'get_employee_billing_accounts'
      ? [{ shop_id: 'shop', shop_code: 'BB1', shop_name: 'ร้านทดสอบ', charges: [charge], statements: [] }]
      : statement,
    error: null,
  }));
  mocks.print.mockRejectedValueOnce(new Error('เครื่องพิมพ์ไม่พร้อม')).mockResolvedValue(true);
  const open = vi.spyOn(window, 'open');
  render(<EmployeeBillingStatementsPanel />);
  await screen.findByRole('option', { name: 'BB1 · ร้านทดสอบ' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'shop' } });
  fireEvent.click(screen.getByRole('button', { name: 'ออกใบวางบิล' }));
  fireEvent.click(screen.getByRole('button', { name: 'ออกและพิมพ์ใบวางบิล' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'เครื่องพิมพ์ไม่พร้อม');
  expect(mocks.rpc).toHaveBeenCalledWith('create_billing_statement', { p_shop_id: 'shop', p_charge_ids: ['bill'] });
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'ยกเลิก BIL-1' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'พิมพ์ BIL-1' }));
  await waitFor(() => expect(mocks.print).toHaveBeenCalledTimes(2));
  expect(mocks.rpc.mock.calls.filter(([name]) => name === 'create_billing_statement')).toHaveLength(1);
});

it('does not fetch employee billing while its workspace is inactive', async () => {
  render(<EmployeeBillingStatementsPanel isActive={false} />);
  await Promise.resolve();
  expect(mocks.rpc).not.toHaveBeenCalled();
});
