import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EmployeeDeliveryReview } from '../src/features/employee-delivery/EmployeeDeliveryReview';
import type { DeliveryPosContext, DeliveryRound, ShopCard } from '../src/types/app';

const round: DeliveryRound = {
  id: 'round-1',
  service_date: '2026-08-18',
  name: 'รอบเช้า',
  status: 'open',
  opened_at: '2026-08-18T01:00:00Z',
};

const shopCard: ShopCard = {
  round_stop_id: 'stop-1',
  shop_id: 'shop-1',
  shop_code: 'BB2',
  shop_name: 'ร้านผัดไทโบราณี',
  building_id: 'building-1',
  building_name: 'ศูนย์อาหารฝั่ง Top',
  floor_or_zone: 'B',
  sequence_no: 1,
  image_path: null,
  image_url: null,
  payment_status: 'unpaid',
  stop_status: 'pending',
  stop_note: null,
  today_history: [],
  today_totals: {},
};

const posContext: DeliveryPosContext = {
  round_id: round.id,
  round_stop_id: shopCard.round_stop_id,
  service_date: round.service_date,
  shop: {
    id: shopCard.shop_id,
    code: shopCard.shop_code,
    name: shopCard.shop_name,
    building_name: shopCard.building_name,
    floor_or_zone: shopCard.floor_or_zone,
    image_path: null,
  },
  stock_source: { id: 'stock-1', code: 'STOCK', name: 'สต๊อกรวมประจำวัน', kind: 'aggregate' },
  items: [{
    ice_type_id: 'ice-1',
    code: 'SMALL',
    name: 'หลอดเล็ก',
    unit: 'ถุง',
    image_path: null,
    stock_quantity: 167,
    unit_price: 60,
    price_source: 'standard',
    price_source_id: 'price-1',
  }],
  payment_profile: {
    allowed_payment_terms: ['end_of_day'],
    default_payment_term: 'end_of_day',
    allowed_payment_methods: ['cash'],
    default_payment_method: 'cash',
    cash_reference_required: false,
    cash_evidence_required: false,
    bank_transfer_reference_required: false,
    bank_transfer_evidence_required: false,
    qr_reference_required: false,
    qr_evidence_required: false,
    allow_outstanding: true,
    credit_due_rule: null,
    credit_days: null,
    credit_collection_weekday: null,
    credit_limit: null,
    credit_exposure: 0,
    credit_remaining: null,
    credit_suspended: false,
  },
};

function renderReview() {
  render(<EmployeeDeliveryReview
    round={round}
    shopCard={shopCard}
    atomicImmediateSale={false}
    assignedStockState={null}
    deliveryQuantities={{ 'ice-1': 2 }}
    posContext={posContext}
    posContextError={null}
    loadingPosContext={false}
    paymentTerm="end_of_day"
    paymentResult={null}
    paymentOpen={false}
    paymentMethod="cash"
    paymentAmount=""
    paymentReference=""
    paymentEvidence={null}
    paymentEvidenceUploaded={false}
    paymentSubmitting={false}
    approvalId={null}
    approvalReason=""
    approvalSubmitting={false}
    enableAssignedStockFlow={false}
    iceTypes={[]}
    items={[{ ice_type_id: 'ice-1', quantity: 2 }]}
    status="delivered"
    stockSourceLabel="สต๊อกรวมประจำวัน"
    shopCards={[shopCard]}
    note=""
    problemOpen={false}
    submitting={false}
    entryError={null}
    onBack={vi.fn()}
    onChangeShop={vi.fn()}
    onSubmit={vi.fn()}
    onChooseProblemStatus={vi.fn()}
    onSetQuantity={vi.fn()}
    onClearCart={vi.fn()}
    onPaymentTermChange={vi.fn()}
    onPaymentMethodChange={vi.fn()}
    onPaymentAmountChange={vi.fn()}
    onPaymentReferenceChange={vi.fn()}
    onPaymentEvidenceChange={vi.fn()}
    onPaymentCancel={vi.fn()}
    onPaymentSubmit={vi.fn()}
    onApprovalReasonChange={vi.fn()}
    onRequestApproval={vi.fn()}
    onNoteChange={vi.fn()}
    onReturnToDelivery={vi.fn()}
    onCorrectionSuccess={vi.fn()}
  />);
}

describe('employee delivery review navigation', () => {
  it('removes the review toggle after entering the confirmation step', async () => {
    const user = userEvent.setup();
    renderReview();

    await user.click(screen.getByRole('button', { name: 'ตรวจรายการ (1)' }));

    expect(screen.queryByRole('button', { name: 'ตรวจรายการ (1)' })).toBeNull();
    expect(screen.getByRole('button', { name: 'กลับไปแก้รายการ' })).toBeTruthy();
  });
});
