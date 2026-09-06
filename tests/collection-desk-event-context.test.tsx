import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CollectionDesk } from '../src/features/financial-operations/components/CollectionDesk';
import type { PaymentProfile, QueueShop } from '../src/features/financial-operations/types';

const paymentProfile: PaymentProfile = {
  allowed_payment_methods: ['cash'],
  default_payment_method: 'cash',
  cash_reference_required: false,
  cash_evidence_required: false,
  bank_transfer_reference_required: false,
  bank_transfer_evidence_required: false,
  qr_reference_required: false,
  qr_evidence_required: false,
};

function queueEntry(overrides: Partial<QueueShop>): QueueShop {
  return {
    queue_key: 'regular:shop-1',
    destination_kind: 'regular',
    shop_id: 'shop-1',
    shop_code: 'S001',
    shop_name: 'ร้านน้ำแข็ง',
    image_path: null,
    outstanding_amount: 100,
    charge_count: 1,
    has_new_charges: false,
    payment_profile: paymentProfile,
    charges: [{
      charge_id: 'charge-1',
      charge_number: 'INV-001',
      service_date: '2026-09-03',
      original_amount: 100,
      outstanding_amount: 100,
      items: [],
    }],
    ...overrides,
  };
}

describe('CollectionDesk event queue identity', () => {
  it('shows and searches event context when one shop has regular and event debt', async () => {
    const onSelectShop = vi.fn();
    const regular = queueEntry({});
    const event = queueEntry({
      queue_key: 'event:context-1',
      destination_kind: 'event',
      event_settlement_context_id: 'context-1',
      event_name: 'งานแฟร์',
      event_location: 'Hall A',
      event_zone: 'Food',
      event_booth: 'A1',
      charges: [{
        charge_id: 'charge-2',
        charge_number: 'INV-E001',
        service_date: '2026-09-03',
        original_amount: 100,
        outstanding_amount: 100,
        items: [],
      }],
    });

    render(<CollectionDesk
      busy={false}
      historyDate="2026-09-03"
      onClearShop={vi.fn()}
      onHistoryDateChange={vi.fn()}
      onOpenReceipt={vi.fn()}
      onPrintReceipt={vi.fn()}
      onRefresh={vi.fn()}
      onSelectShop={onSelectShop}
      onVoidPayment={vi.fn()}
      paymentHistory={[]}
      paymentPanel={null}
      queue={[regular, event]}
      runId="run-1"
      selectedShop={null}
      serviceDate="2026-09-03"
      todayPayments={[]}
    />);

    expect(screen.getByText('งานแฟร์ · Hall A · Food · บูธ A1')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'เลือกรายการ S001 · ร้านน้ำแข็ง' })).toHaveLength(2);

    await userEvent.type(screen.getByPlaceholderText('ค้นหาร้านค้า / เลขที่เอกสาร'), 'Hall A');
    const matchingRow = screen.getByRole('button', { name: 'เลือกรายการ S001 · ร้านน้ำแข็ง' });
    await userEvent.click(matchingRow);

    expect(onSelectShop).toHaveBeenCalledWith(event, expect.any(HTMLButtonElement));
  });
});
