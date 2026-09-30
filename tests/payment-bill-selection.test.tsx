import { createRef } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaymentModal } from '../src/features/financial-operations/components/PaymentModal';
import type { QueueShop } from '../src/features/financial-operations/types';
import {
  allocateOldestFirst,
  isPaymentAmountValidForSelection,
  reconcileChargeSelection,
} from '../src/features/financial-operations/utils';

const serviceDate = '2026-09-30';
const shop: QueueShop = {
  shop_id: 'shop-1',
  shop_code: 'S001',
  shop_name: 'ร้านทดสอบ',
  image_path: null,
  outstanding_amount: 125,
  charge_count: 2,
  has_new_charges: true,
  payment_profile: {
    allowed_payment_methods: ['cash', 'bank_transfer', 'qr'],
    default_payment_method: 'cash',
    cash_reference_required: false,
    cash_evidence_required: false,
    bank_transfer_reference_required: false,
    bank_transfer_evidence_required: false,
    qr_reference_required: false,
    qr_evidence_required: false,
  },
  charges: [
    {
      charge_id: 'old-50',
      charge_number: 'INV-OLD',
      service_date: '2026-09-29',
      payment_term: 'credit',
      due_date: '2026-09-29',
      original_amount: 50,
      outstanding_amount: 50,
      items: [],
    },
    {
      charge_id: 'today-75',
      charge_number: 'INV-TODAY',
      service_date: serviceDate,
      payment_term: 'immediate',
      original_amount: 75,
      outstanding_amount: 75,
      items: [],
    },
  ],
};

function renderModal(overrides: Partial<Parameters<typeof PaymentModal>[0]> = {}) {
  const props: Parameters<typeof PaymentModal>[0] = {
    allocatedAmount: 75,
    amount: '100.00',
    busy: false,
    changeAmount: 25,
    closeButtonRef: createRef<HTMLButtonElement>(),
    dialogRef: createRef<HTMLDivElement>(),
    evidence: null,
    evidenceError: null,
    evidenceRequired: false,
    method: 'cash',
    onAmountChange: vi.fn(),
    onClearChargeSelection: vi.fn(),
    onClose: vi.fn(),
    onConfirmSelectionReview: vi.fn(),
    onEvidenceChange: vi.fn(),
    onPaymentMethodChange: vi.fn(),
    onPrintReceipt: vi.fn(),
    onRecordPayment: vi.fn(),
    onReferenceChange: vi.fn(),
    onRequestDueDate: vi.fn(),
    onSelectAllCharges: vi.fn(),
    onSelectTodayCharges: vi.fn(),
    onToggleCharge: vi.fn(),
    paymentReady: true,
    receipt: null,
    reference: '',
    remainingAmount: 50,
    selectedChargeIds: ['today-75'],
    selectedOutstandingAmount: 75,
    selectedShop: shop,
    selectionReviewRequired: false,
    serviceDate,
    ...overrides,
  };
  render(<PaymentModal {...props} />);
  return props;
}

describe('payment bill selection', () => {
  it('shows the selected total, cash change, and whole-shop balance separately', () => {
    const props = renderModal();

    expect((screen.getByRole('checkbox', { name: 'เลือกบิล INV-OLD' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'เลือกบิล INV-TODAY' }) as HTMLInputElement).checked).toBe(true);
    const summary = screen.getByRole('region', { name: 'สรุปยอดรับเงิน' });
    expect(summary.textContent).toContain('ยอดบิลที่เลือก฿75.00');
    expect(summary.textContent).toContain('ยอดรับชำระ฿75.00');
    expect(summary.textContent).toContain('ยอดค้างทั้งหมดหลังรับเงิน฿50.00');
    expect(screen.getByText('เงินทอน').parentElement?.textContent).toContain('฿25.00');

    fireEvent.click(screen.getByRole('button', { name: 'เฉพาะบิลวันนี้' }));
    expect(props.onSelectTodayCharges).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('checkbox', { name: 'เลือกบิล INV-OLD' }));
    expect(props.onToggleCharge).toHaveBeenCalledWith('old-50');
  });

  it('locks bill selection and payment fields while saving', () => {
    renderModal({ busy: true, paymentReady: false });

    expect(screen.getByRole('checkbox', { name: 'เลือกบิล INV-TODAY' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'เลือกทั้งหมด' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'เงินสด' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('textbox', { name: 'หมายเหตุ' }).hasAttribute('disabled')).toBe(true);
  });

  it('requires review after refreshed bill data changes', () => {
    const onConfirmSelectionReview = vi.fn();
    renderModal({ onConfirmSelectionReview, paymentReady: false, selectionReviewRequired: true });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('กรุณาตรวจสอบยอดก่อนบันทึก');
    fireEvent.click(within(alert).getByRole('button', { name: 'ตรวจสอบแล้ว' }));
    expect(onConfirmSelectionReview).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }).hasAttribute('disabled')).toBe(true);
  });

  it('disables recording when no bill is selected', () => {
    renderModal({
      allocatedAmount: 0,
      amount: '0.00',
      paymentReady: false,
      selectedChargeIds: [],
      selectedOutstandingAmount: 0,
    });

    expect(screen.getByText('กรุณาเลือกอย่างน้อย 1 บิลเพื่อรับชำระ')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }).hasAttribute('disabled')).toBe(true);
  });

  it('allocates only within selected bills and keeps their existing order', () => {
    expect(allocateOldestFirst([shop.charges[1]], 75)).toEqual([
      { charge_id: 'today-75', amount: 75 },
    ]);
    expect(allocateOldestFirst(shop.charges, 60)).toEqual([
      { charge_id: 'old-50', amount: 50 },
      { charge_id: 'today-75', amount: 10 },
    ]);
  });

  it('allows cash over tender but rejects transfer and QR above the selected total', () => {
    expect(isPaymentAmountValidForSelection('cash', 100, 75)).toBe(true);
    expect(isPaymentAmountValidForSelection('bank_transfer', 100, 75)).toBe(false);
    expect(isPaymentAmountValidForSelection('qr', 100, 75)).toBe(false);
    expect(isPaymentAmountValidForSelection('bank_transfer', 75, 75)).toBe(true);
  });

  it('preserves prior selections on refresh without auto-selecting a new bill', () => {
    const nextCharges = [
      shop.charges[0],
      { ...shop.charges[1], outstanding_amount: 70 },
      { ...shop.charges[1], charge_id: 'new-25', outstanding_amount: 25 },
    ];
    expect(reconcileChargeSelection(shop.charges, nextCharges, ['old-50', 'today-75'])).toEqual({
      changed: true,
      selectedChargeIds: ['old-50', 'today-75'],
    });
  });
});

it('does not allocate a floating-point remainder to another bill', () => {
  const charges = [10.20, 20.40, 5].map((outstanding_amount, index) => ({
    ...shop.charges[0], charge_id: `decimal-${index}`, outstanding_amount,
  }));
  expect(allocateOldestFirst(charges, 30.60)).toEqual([
    { charge_id: 'decimal-0', amount: 10.20 },
    { charge_id: 'decimal-1', amount: 20.40 },
  ]);
});
