import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CollectionDesk } from '../src/features/financial-operations/components/CollectionDesk';
import type { QueueCharge, QueueShop } from '../src/features/financial-operations/types';

const billedCharge: QueueCharge = {
  charge_id: 'charge-1', charge_number: 'INV-1', service_date: '2026-10-12',
  payment_term: 'credit', due_date: '2026-10-30', original_amount: 500, outstanding_amount: 500,
  billing_statement_id: 'statement-1', billing_statement_number: 'BIL2610-00004', items: [],
};

function renderShop(charges: QueueCharge[], legacy = false) {
  const shop: QueueShop = {
    destination_kind: 'regular', queue_key: 'regular:shop-1', collection_scope: 'shop',
    shop_id: 'shop-1', shop_code: 'TEST', shop_name: 'Test shop', image_path: null,
    billing_statement_id: legacy ? 'statement-1' : null,
    billing_statement_number: legacy ? 'BIL2610-00004' : null,
    outstanding_amount: charges.reduce((sum, charge) => sum + charge.outstanding_amount, 0),
    charge_count: charges.length, has_new_charges: false, charges,
    payment_profile: {
      allowed_payment_methods: ['cash'], default_payment_method: 'cash',
      cash_reference_required: false, cash_evidence_required: false,
      bank_transfer_reference_required: false, bank_transfer_evidence_required: false,
      qr_reference_required: false, qr_evidence_required: false,
    },
  };
  render(<CollectionDesk busy={false} historyDate="2026-10-12" serviceDate="2026-10-12"
    onClearShop={vi.fn()} onHistoryDateChange={vi.fn()} onOpenReceipt={vi.fn()}
    onPrintReceipt={vi.fn()} onRefresh={vi.fn()} onSelectShop={vi.fn()} onVoidPayment={vi.fn()}
    paymentHistory={[]} paymentPanel={null} queue={[shop]} runId="run-1"
    selectedShop={null} todayPayments={[]} />);
}

it.each([true, false])('labels future-due statement bills without an overdue warning (legacy=%s)', (legacy) => {
  renderShop([{ ...billedCharge, ...(legacy ? { billing_statement_id: null, billing_statement_number: null } : {}) }], legacy);
  fireEvent.click(screen.getByRole('button', { name: 'ตาราง' }));
  expect(screen.getByText('ตามใบวางบิล')).toBeTruthy();
  expect(screen.queryByText(/เกินกำหนด/)).toBeNull();
});

it('keeps the overdue warning when future statement bills share a shop with overdue debt', () => {
  renderShop([billedCharge, {
    ...billedCharge, charge_id: 'charge-2', charge_number: 'INV-2', due_date: '2026-10-07',
    billing_statement_id: null, billing_statement_number: null,
  }]);
  fireEvent.click(screen.getByRole('button', { name: 'ตาราง' }));
  expect(screen.getByText('เกินกำหนด 5 วัน')).toBeTruthy();
});

it('keeps the today label for an ordinary bill due today', () => {
  renderShop([{ ...billedCharge, due_date: '2026-10-12', billing_statement_id: null, billing_statement_number: null }]);
  fireEvent.click(screen.getByRole('button', { name: 'ตาราง' }));
  expect(document.querySelector('.collection-desk__status--today')?.textContent).toBe('วันนี้');
});

it.each([true, false])('finds outstanding bills by their statement number (legacy=%s)', (legacy) => {
  renderShop([{ ...billedCharge, ...(legacy ? { billing_statement_id: null, billing_statement_number: null } : {}) }], legacy);
  fireEvent.change(screen.getByRole('searchbox', { name: 'ค้นหาร้านค้า' }), { target: { value: 'bil2610-00004' } });
  expect(screen.getByRole('button', { name: 'เลือกรายการ TEST · Test shop' })).toBeTruthy();
});

it('searches every statement in a combined shop and preserves invoice-number search', () => {
  renderShop([billedCharge, {
    ...billedCharge, charge_id: 'charge-2', charge_number: 'INV-2',
    billing_statement_id: 'statement-2', billing_statement_number: 'BIL2610-00005',
  }]);
  const search = screen.getByRole('searchbox', { name: 'ค้นหาร้านค้า' });
  for (const value of ['BIL2610-00004', 'BIL2610-00005', 'INV-2']) {
    fireEvent.change(search, { target: { value } });
    expect(screen.getByRole('button', { name: 'เลือกรายการ TEST · Test shop' })).toBeTruthy();
  }
  fireEvent.change(search, { target: { value: 'BIL2610-99999' } });
  expect(screen.getByText('ไม่พบรายการที่ค้นหา')).toBeTruthy();
});
