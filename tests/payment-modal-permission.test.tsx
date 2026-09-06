import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaymentModal } from '../src/features/financial-operations/components/PaymentModal';
import type { QueueShop } from '../src/features/financial-operations/types';

const selectedShop: QueueShop = {
  shop_id: 'shop-1',
  shop_code: 'S001',
  shop_name: 'ร้านทดสอบ',
  image_path: null,
  outstanding_amount: 120,
  charge_count: 1,
  has_new_charges: false,
  payment_profile: {
    allowed_payment_methods: ['cash'],
    default_payment_method: 'cash',
    cash_reference_required: false,
    cash_evidence_required: false,
    bank_transfer_reference_required: false,
    bank_transfer_evidence_required: false,
    qr_reference_required: false,
    qr_evidence_required: false,
  },
  charges: [{
    charge_id: 'charge-1',
    charge_number: 'INV001',
    service_date: '2026-08-27',
    payment_term: 'credit',
    due_date: '2026-08-27',
    original_amount: 120,
    outstanding_amount: 120,
    items: [],
  }],
};

describe('PaymentModal collection capability', () => {
  it('shows shop details but disables every payment input and the record action', () => {
    const onRecordPayment = vi.fn();
    const onRequestDueDate = vi.fn();
    render(<PaymentModal
      allocatedAmount={120}
      amount="120.00"
      busy={false}
      canRecordPayment={false}
      changeAmount={0}
      closeButtonRef={createRef<HTMLButtonElement>()}
      dialogRef={createRef<HTMLDivElement>()}
      evidence={null}
      evidenceError={null}
      evidenceRequired={false}
      method="cash"
      onAmountChange={vi.fn()}
      onClose={vi.fn()}
      onEvidenceChange={vi.fn()}
      onPaymentMethodChange={vi.fn()}
      onPrintReceipt={vi.fn()}
      onRecordPayment={onRecordPayment}
      onReferenceChange={vi.fn()}
      onRequestDueDate={onRequestDueDate}
      paymentReady
      receipt={null}
      reference=""
      remainingAmount={0}
      selectedShop={selectedShop}
      serviceDate="2026-08-27"
    />);

    expect(screen.getByRole('dialog', { name: 'รับเงิน ร้านทดสอบ' })).not.toBeNull();
    expect(screen.getByText('ดูข้อมูลได้ แต่ยังไม่ได้รับสิทธิ์บันทึกรับเงิน')).not.toBeNull();
    expect(screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'เงินสด' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('textbox', { name: 'หมายเหตุ' }).hasAttribute('disabled')).toBe(true);
    const dueDateButton = screen.getByRole('button', { name: /ขอเลื่อนกำหนด/ });
    expect(dueDateButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(dueDateButton);
    expect(onRequestDueDate).not.toHaveBeenCalled();
    const recordButton = screen.getByRole('button', { name: 'บันทึกรับเงินทันที' });
    expect(recordButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(recordButton);
    expect(onRecordPayment).not.toHaveBeenCalled();
  });

  it('separates the latest delivery from the prior balance when opened from POS', () => {
    render(<PaymentModal
      allocatedAmount={150}
      amount="150.00"
      busy={false}
      changeAmount={0}
      closeButtonRef={createRef<HTMLButtonElement>()}
      dialogRef={createRef<HTMLDivElement>()}
      evidence={null}
      evidenceError={null}
      evidenceRequired={false}
      focusedChargeId="charge-latest"
      method="cash"
      onAmountChange={vi.fn()}
      onClose={vi.fn()}
      onEvidenceChange={vi.fn()}
      onPaymentMethodChange={vi.fn()}
      onPrintReceipt={vi.fn()}
      onRecordPayment={vi.fn()}
      onReferenceChange={vi.fn()}
      onRequestDueDate={vi.fn()}
      paymentReady
      receipt={null}
      reference=""
      remainingAmount={0}
      selectedShop={{
        ...selectedShop,
        outstanding_amount: 150,
        charge_count: 2,
        charges: [
          { ...selectedShop.charges[0], charge_id: 'charge-prior', outstanding_amount: 120 },
          {
            ...selectedShop.charges[0],
            charge_id: 'charge-latest',
            charge_number: 'INV002',
            original_amount: 30,
            outstanding_amount: 30,
          },
        ],
      }}
      serviceDate="2026-08-27"
    />);

    const summary = screen.getByRole('region', { name: 'สรุปยอดหลังส่งรอบล่าสุด' });
    expect(summary.textContent).toContain('ยอดค้างก่อนหน้า฿120.00');
    expect(summary.textContent).toContain('ยอดส่งรอบล่าสุด฿30.00');
    expect(summary.textContent).toContain('ยอดรับชำระทั้งหมด฿150.00');
  });

  it('shows zero prior balance when the latest delivery is the only unpaid charge', () => {
    render(<PaymentModal
      allocatedAmount={120}
      amount="120.00"
      busy={false}
      changeAmount={0}
      closeButtonRef={createRef<HTMLButtonElement>()}
      dialogRef={createRef<HTMLDivElement>()}
      evidence={null}
      evidenceError={null}
      evidenceRequired={false}
      focusedChargeId="charge-1"
      method="cash"
      onAmountChange={vi.fn()}
      onClose={vi.fn()}
      onEvidenceChange={vi.fn()}
      onPaymentMethodChange={vi.fn()}
      onPrintReceipt={vi.fn()}
      onRecordPayment={vi.fn()}
      onReferenceChange={vi.fn()}
      onRequestDueDate={vi.fn()}
      paymentReady
      receipt={null}
      reference=""
      remainingAmount={0}
      selectedShop={selectedShop}
      serviceDate="2026-08-27"
    />);

    const summary = screen.getByRole('region', { name: 'สรุปยอดหลังส่งรอบล่าสุด' });
    expect(summary.textContent).toContain('ยอดค้างก่อนหน้า฿0.00');
    expect(summary.textContent).toContain('ยอดส่งรอบล่าสุด฿120.00');
  });
});
