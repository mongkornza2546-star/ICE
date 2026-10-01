import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BillingStatementsSection } from '../src/features/financial-operations/components/BillingStatementsSection';
import type { BillingStatement, ReceivableCharge } from '../src/features/financial-operations/types';

vi.mock('../src/lib/billingStatementPrint', () => ({
  printBillingStatement: vi.fn(() => true),
}));

function charge(id: string, number: string, dueDate: string, outstanding: number): ReceivableCharge {
  return {
    charge_id: id,
    charge_number: number,
    service_date: '2026-10-01',
    due_date: dueDate,
    original_amount: outstanding,
    allocated_amount: 0,
    outstanding_amount: outstanding,
    days_overdue: 0,
    payment_status: 'unpaid',
    due_status: dueDate <= '2026-10-01' ? 'due_today' : 'not_due',
    assigned_collection_run_id: null,
  };
}

describe('BillingStatementsSection', () => {
  it('starts with due bills and lets an admin add a future-due bill to the same statement', async () => {
    const due = charge('charge-due', 'INV-DUE', '2026-10-01', 1920);
    const future = charge('charge-future', 'INV-FUTURE', '2026-10-04', 600);
    const alreadyBilled = charge('charge-existing', 'INV-EXISTING', '2026-10-05', 300);
    const existingStatement: BillingStatement = {
      id: 'statement-existing',
      statement_number: 'BIL2610-00001',
      shop_id: 'shop-1',
      shop_code: 'BB53',
      shop_name: 'พันไทย',
      shop_location: null,
      status: 'active',
      issued_service_date: '2026-10-01',
      issued_at: '2026-10-01T10:00:00+07:00',
      created_by_name: 'Admin',
      voided_at: null,
      void_reason: null,
      total_amount: 300,
      outstanding_amount: 300,
      items: [{
        charge_id: alreadyBilled.charge_id,
        charge_number: alreadyBilled.charge_number,
        service_date: alreadyBilled.service_date,
        due_date: alreadyBilled.due_date,
        billed_amount: 300,
        outstanding_amount: 300,
      }],
    };
    const createdStatement = { ...existingStatement, id: 'new', statement_number: 'BIL2610-00002' };
    const onCreate = vi.fn(async () => createdStatement);
    const printWindow = { close: vi.fn() } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(printWindow);

    render(<BillingStatementsSection
      busy={false}
      charges={[due, future, alreadyBilled]}
      onCreate={onCreate}
      onVoid={vi.fn(async () => undefined)}
      serviceDate="2026-10-01"
      statements={[existingStatement]}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'ออกใบวางบิล' }));
    expect(screen.getByText('INV-DUE')).toBeTruthy();
    expect(screen.getByText('INV-FUTURE')).toBeTruthy();
    expect(screen.queryByText('INV-EXISTING')).toBeNull();
    expect((screen.getByRole('checkbox', { name: /INV-DUE/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /INV-FUTURE/ }) as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole('checkbox', { name: /INV-FUTURE/ }));
    fireEvent.click(screen.getByRole('button', { name: 'ออกและพิมพ์ใบวางบิล' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(['charge-due', 'charge-future']));
  });
});
