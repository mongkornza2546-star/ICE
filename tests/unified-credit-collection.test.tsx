import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CreditReceivablesManager } from '../src/features/financial-operations/components/CreditReceivablesManager';
import type { BillingStatement, Receivable } from '../src/features/financial-operations/types';

it('opens the whole shop from credit details even when an active statement exists', async () => {
  const receivable: Receivable = {
    shop_id: 'shop-1', shop_code: 'BB27', shop_name: 'ร้านทดสอบ',
    credit_limit: null, available_credit_amount: null,
    outstanding_amount: 1920, overdue_amount: 1920, oldest_due_date: '2026-09-30',
    charges: [1800, 120].map((amount, index) => ({
      charge_id: `charge-${index}`, charge_number: `INV-${index}`,
      service_date: '2026-09-07', due_date: '2026-09-30',
      original_amount: amount, outstanding_amount: amount, allocated_amount: 0,
      days_overdue: 12, payment_status: 'unpaid', due_status: 'overdue', assigned_collection_run_id: null,
    })),
  };
  const statement: BillingStatement = {
    id: 'statement-1', statement_number: 'BIL2610-00004', shop_id: receivable.shop_id,
    shop_code: receivable.shop_code, shop_name: receivable.shop_name, shop_location: null,
    status: 'active', issued_service_date: '2026-10-12', issued_at: '2026-10-12T09:00:00+07:00',
    created_by_name: 'Admin', voided_at: null, void_reason: null, total_amount: 1800, outstanding_amount: 1800,
    items: [{ charge_id: 'charge-0', charge_number: 'INV-0', service_date: '2026-09-07',
      due_date: '2026-09-30', billed_amount: 1800, outstanding_amount: 1800 }],
  };
  const onOpenCollection = vi.fn();
  render(<CreditReceivablesManager busy={false} approvals={[]} dueDateRequests={[]} receivables={[receivable]}
    serviceDate="2026-10-12" userRole="admin" onDecide={vi.fn()} onDecideDueDateRequest={vi.fn()}
    onOpenCollection={onOpenCollection}
    onLoadDetail={async () => ({ charges: receivable.charges, payments: [], billing_statements: [statement] })} />);
  fireEvent.click(screen.getByRole('button', { name: 'เปิดรายละเอียด BB27' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'บันทึกรับเงิน' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกรับเงิน' }));
  expect(onOpenCollection).toHaveBeenCalledWith(receivable);
});
