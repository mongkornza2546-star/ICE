import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CreditReceivablesManager } from '../src/features/financial-operations/components/CreditReceivablesManager';
import type { Receivable } from '../src/features/financial-operations/types';

it('shows net and VAT-inclusive balances from the summary even when bill details are not loaded', () => {
  const base: Receivable = {
    shop_id: 'mixed', shop_code: 'MIX', shop_name: 'ร้านบิลผสม', vat_enabled: false,
    credit_limit: null, available_credit_amount: null,
    outstanding_subtotal_amount: 682.71, outstanding_amount: 720,
    overdue_amount: 0, oldest_due_date: '2026-10-31', charges: [],
  };
  render(<CreditReceivablesManager busy={false} approvals={[]} dueDateRequests={[]}
    receivables={[base, { ...base, shop_id: 'no-vat', shop_code: 'NET',
      outstanding_subtotal_amount: 150, outstanding_amount: 150 },
    { ...base, shop_id: 'legacy-api', shop_code: 'OLD', outstanding_subtotal_amount: undefined }]}
    serviceDate="2026-10-12" onDecide={vi.fn()} onDecideDueDateRequest={vi.fn()} />);
  const table = screen.getByRole('table');
  const headers = within(table).getAllByRole('columnheader');
  const netIndex = headers.findIndex(cell => cell.textContent === 'ค่าน้ำแข็ง (ไม่รวม VAT)');
  const grossIndex = headers.findIndex(cell => cell.textContent === 'ยอดค้าง (รวม VAT)');
  expect(netIndex).toBeGreaterThan(-1);
  expect(grossIndex).toBe(netIndex + 1);
  const cells = (code: string) => within(screen.getByRole('button', { name: `เปิดรายละเอียด ${code}` }).closest('tr')!).getAllByRole('cell');
  expect(cells('MIX')[netIndex].textContent).toBe('฿682.71');
  expect(cells('MIX')[grossIndex].textContent).toBe('฿720.00');
  expect(cells('NET')[netIndex].textContent).toBe('฿150.00');
  expect(cells('NET')[grossIndex].textContent).toBe('฿150.00');
  // A server without the new projection must not silently label gross as net.
  expect(cells('OLD')[netIndex].textContent).toBe('—');
  expect(cells('OLD')[grossIndex].textContent).toBe('฿720.00');
});
