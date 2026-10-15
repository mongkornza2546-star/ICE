import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CashReconciliationPanel } from '../src/features/accounting/CashReconciliationPanel';
import type { CashCloseReconciliation } from '../src/features/accounting/types';

const employee: CashCloseReconciliation['employees'][number] = {
  employee_id: 'one', employee_name: 'คนหนึ่ง', is_active: true,
  expected_cash_amount: 90, actual_cash_amount: null, cash_variance_amount: null,
  cash_reason: null, recorded_at: null,
};
const data: CashCloseReconciliation = { service_date: '2026-10-15', status: 'open', feature_enabled: true, employees: [employee] };

describe('manager cash reconciliation', () => {
  it('does not turn a missing or partially completed count into a received total', () => {
    render(<CashReconciliationPanel data={{ ...data, employees: [employee, { ...employee, employee_id: 'two', employee_name: 'คนสอง', expected_cash_amount: 0, actual_cash_amount: 0 }] }} error={null} />);
    expect(screen.getByText('หัวหน้าได้รับจริงตามยอดนับ').parentElement?.textContent).toContain('—');
    const table = screen.getByRole('table');
    expect(within(table).getByText('ตรงยอด')).toBeTruthy();
    expect(within(table).getByText('ยังไม่บันทึกยอดนับเงิน')).toBeTruthy();
  });

  it('shows recorded zero as a real count and retains an inactive employee from the snapshot', () => {
    render(<CashReconciliationPanel data={{ ...data, status: 'closed', employees: [{ ...employee, is_active: false, actual_cash_amount: 0, cash_reason: 'ยังไม่ได้ส่งเงิน' }] }} error={null} />);
    expect(screen.getByText('หัวหน้าได้รับจริงตามยอดนับ').parentElement?.textContent).toContain('฿0.00');
    expect(screen.getByText('บันทึกยอดนับเงินแล้ว')).toBeTruthy();
    expect(screen.getByText('พนักงานที่ยกเลิกแล้ว')).toBeTruthy();
    expect(screen.getByText('ยังไม่ได้ส่งเงิน')).toBeTruthy();
  });

  it('keeps shortages and surpluses visible even when their net difference is zero', () => {
    render(<CashReconciliationPanel data={{ ...data, status: 'closed', employees: [
      { ...employee, expected_cash_amount: 10.10, actual_cash_amount: 9.90, cash_reason: 'ขาด' },
      { ...employee, employee_id: 'two', employee_name: 'คนสอง', expected_cash_amount: 10.10, actual_cash_amount: 10.30, cash_reason: 'เกิน' },
    ] }} error={null} />);
    expect(screen.getByText('ส่วนต่างสุทธิ (นับจริง − ควรส่ง)').parentElement?.textContent).toContain('฿0.00');
    expect(screen.getByText(/เงินขาดรวม/).textContent).toContain('฿0.20');
    expect(screen.getByRole('cell', { name: 'เงินขาด', exact: true })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'เงินเกิน', exact: true })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '+฿0.20' })).toBeTruthy();
  });

  it('explains historical stock-only closing without inventing a cash count', () => {
    render(<CashReconciliationPanel data={{ ...data, status: 'closed', feature_enabled: false }} error={null} />);
    expect(screen.getByText('วันที่นี้ยังไม่เปิดใช้การบันทึกยอดนับเงิน')).toBeTruthy();
    expect(screen.getByText('หัวหน้าได้รับจริงตามยอดนับ').parentElement?.textContent).toContain('—');
  });
});
