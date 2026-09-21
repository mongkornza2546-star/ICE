import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CollectionDesk } from '../src/features/financial-operations/components/CollectionDesk';
import { PaymentModal } from '../src/features/financial-operations/components/PaymentModal';
import type { PaymentProfile, QueueShop } from '../src/features/financial-operations/types';
import { formatCollectionShopIdentity } from '../src/features/financial-operations/utils';

const paymentProfile: PaymentProfile = {
  allowed_payment_methods: ['cash', 'qr'],
  default_payment_method: 'cash',
  cash_reference_required: false,
  cash_evidence_required: false,
  bank_transfer_reference_required: false,
  bank_transfer_evidence_required: false,
  qr_reference_required: false,
  qr_evidence_required: false,
};

function makeQueueEntry(overrides: Partial<QueueShop>): QueueShop {
  return {
    queue_key: 'event:booth-1',
    destination_kind: 'event',
    shop_id: 'shop-uuid-1',
    shop_code: 'EV-6f498d54-4d05-4908-b6ff-90ab12cd34ef',
    shop_name: 'ศาลปกครองพิเศษ',
    image_path: null,
    outstanding_amount: 500,
    charge_count: 1,
    has_new_charges: false,
    payment_profile: paymentProfile,
    event_settlement_context_id: 'context-1',
    event_name: 'งานกาชาด',
    event_location: 'ตึก C',
    event_zone: 'โซนอาหาร',
    event_booth: 'ศาลปกครองพิเศษ',
    charges: [{
      charge_id: 'charge-1',
      charge_number: 'INV-E001',
      service_date: '2026-09-21',
      original_amount: 500,
      outstanding_amount: 500,
      items: [],
    }],
    ...overrides,
  };
}

describe('formatCollectionShopIdentity', () => {
  it('formats event booth with text name cleanly and strips EV UUIDs', () => {
    const identity = formatCollectionShopIdentity({
      shop_code: 'EV-6f498d54-4d05-4908-b6ff-90ab12cd34ef',
      shop_name: 'ศาลปกครองพิเศษ',
      destination_kind: 'event',
      event_booth: 'ศาลปกครองพิเศษ',
    });

    expect(identity.isEventOnly).toBe(true);
    expect(identity.title).toBe('บูธ ศาลปกครองพิเศษ');
    expect(identity.avatarText).toBe('ศา');
    expect(identity.title).not.toContain('EV-');
  });

  it('formats numeric booth correctly and shows booth number in avatar', () => {
    const identity = formatCollectionShopIdentity({
      shop_code: 'EV-numeric-18',
      shop_name: 'บูธ 18',
      destination_kind: 'event',
      event_booth: '18',
    });

    expect(identity.isEventOnly).toBe(true);
    expect(identity.title).toBe('บูธ 18');
    expect(identity.avatarText).toBe('18');
  });

  it('preserves code and name for regular shops participating in events', () => {
    const identity = formatCollectionShopIdentity({
      shop_code: 'BB43',
      shop_name: 'บัวลอยน้ำขิง',
      destination_kind: 'event',
      event_booth: 'A1',
    });

    expect(identity.isEventOnly).toBe(false);
    expect(identity.title).toBe('BB43 · บัวลอยน้ำขิง');
    expect(identity.avatarText).toBe('BB');
    expect(identity.boothText).toBe('บูธ A1');
  });
});

describe('CollectionDesk event booth display', () => {
  it('renders only booth identifier without internal EV- UUID or duplicated context label', () => {
    const eventShop = makeQueueEntry({});

    render(<CollectionDesk
      busy={false}
      historyDate="2026-09-21"
      onClearShop={vi.fn()}
      onHistoryDateChange={vi.fn()}
      onOpenReceipt={vi.fn()}
      onPrintReceipt={vi.fn()}
      onRefresh={vi.fn()}
      onSelectShop={vi.fn()}
      onVoidPayment={vi.fn()}
      paymentHistory={[]}
      paymentPanel={null}
      queue={[eventShop]}
      runId="run-1"
      selectedShop={null}
      serviceDate="2026-09-21"
      todayPayments={[]}
    />);

    // Should display clean title "บูธ ศาลปกครองพิเศษ"
    expect(screen.getByText('บูธ ศาลปกครองพิเศษ')).toBeTruthy();
    // Avatar text should be "ศา"
    expect(screen.getByText('ศา')).toBeTruthy();
    // Internal UUID EV-6f49... should NOT be visible anywhere
    expect(screen.queryByText(/EV-6f498d54/)).toBeNull();
    // Redundant context label that duplicates booth name should be suppressed
    expect(screen.queryByText(/ตึก C - บูธ ศาลปกครองพิเศษ/)).toBeNull();
  });
});

describe('PaymentModal event booth header', () => {
  it('renders clean booth title without duplicate subtitle or EV- code', () => {
    const eventShop = makeQueueEntry({});

    render(<PaymentModal
      busy={false}
      evidenceFile={null}
      evidencePreviewUrl={null}
      isDesktopPanel={true}
      isOpen={true}
      isSubmitting={false}
      onBankTransferEvidenceChange={vi.fn()}
      onCashEvidenceChange={vi.fn()}
      onCashReferenceChange={vi.fn()}
      onClose={vi.fn()}
      onEvidenceFileChange={vi.fn()}
      onMethodChange={vi.fn()}
      onPayFull={vi.fn()}
      onPayPartial={vi.fn()}
      onPaymentAmountChange={vi.fn()}
      onQrEvidenceChange={vi.fn()}
      onQrReferenceChange={vi.fn()}
      onSubmit={vi.fn()}
      onTransferReferenceChange={vi.fn()}
      paymentAmount="500"
      paymentMethod="cash"
      paymentProfile={paymentProfile}
      qrEvidenceRequired={false}
      qrReferenceRequired={false}
      selectedChargeIds={['charge-1']}
      selectedShop={eventShop}
      transferEvidenceRequired={false}
      transferReferenceRequired={false}
    />);

    // Title should be clean
    expect(screen.getAllByText('บูธ ศาลปกครองพิเศษ').length).toBeGreaterThanOrEqual(1);
    // Should NOT contain the EV- UUID
    expect(screen.queryByText(/EV-6f498d54/)).toBeNull();
  });
});
