import { render, screen, within } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EmployeeDeliveryReview } from '../src/features/employee-delivery/EmployeeDeliveryReview';
import { sortPaymentTerms } from '../src/features/employee-delivery/utils';
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
    allowed_payment_terms: ['immediate', 'end_of_day'],
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

function renderReview(canCollectImmediatePayment = true, card = shopCard, overrides: Partial<ComponentProps<typeof EmployeeDeliveryReview>> = {}) {
  const onSubmit = vi.fn((event) => event.preventDefault());
  const onConfirmDelivery = vi.fn();
  function ReviewWithQuantities() {
    const [quantities, setQuantities] = useState<Record<string, number>>({ 'ice-1': 2 });
    return <EmployeeDeliveryReview
    round={round}
    shopCard={card}
    atomicImmediateSale={false}
    canCollectImmediatePayment={canCollectImmediatePayment}
    assignedStockState={null}
    deliveryQuantities={quantities}
    posContext={posContext}
    posContextError={null}
    loadingPosContext={false}
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
    items={Object.entries(quantities).filter(([, quantity]) => quantity > 0).map(([ice_type_id, quantity]) => ({ ice_type_id, quantity }))}
    status="delivered"
    stockSourceLabel="สต๊อกรวมประจำวัน"
    shopCards={[card]}
    note=""
    problemOpen={false}
    submitting={false}
    entryError={null}
    onBack={vi.fn()}
    onChangeShop={vi.fn()}
    onSubmit={onSubmit}
    onChooseProblemStatus={vi.fn()}
    onClearCart={vi.fn()}
    onConfirmDelivery={onConfirmDelivery}
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
    {...overrides}
    onSetQuantity={(id, quantity) => {
      overrides.onSetQuantity?.(id, quantity);
      setQuantities((current) => ({ ...current, [id]: Math.min(167, Math.max(0, Math.round(quantity * 2) / 2)) }));
    }}
  />;
  }
  render(<ReviewWithQuantities />);
  return { onSubmit, onConfirmDelivery };
}

describe('employee delivery review navigation', () => {
  it.each(['', '1.1', '3', '168'])('blocks delivery and review while quantity %s is uncommitted', async (value) => {
    const user = userEvent.setup();
    const { onConfirmDelivery } = renderReview();
    await user.click(screen.getByRole('button', { name: /หลอดเล็ก.*คงเหลือ/ }));
    const input = screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' });
    await user.clear(input);
    if (value) await user.type(input, value);

    for (const name of ['ส่งอย่างเดียว', 'ส่งและรับชำระ', 'ตรวจรายการ (1)', '3 ตรวจ']) {
      const button = screen.getByRole('button', { name });
      expect(button.hasAttribute('disabled')).toBe(true);
      await user.click(button);
    }
    expect(onConfirmDelivery).not.toHaveBeenCalled();
    expect(screen.getByText('2 ถุง × ฿60.00')).toBeTruthy();
  });

  it('allows delivery with the original cart after cancelling a quantity edit', async () => {
    const user = userEvent.setup();
    const { onConfirmDelivery } = renderReview();
    await user.click(screen.getByRole('button', { name: /หลอดเล็ก.*คงเหลือ/ }));
    await user.clear(screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' }));
    await user.click(screen.getByRole('button', { name: 'ยกเลิกการแก้จำนวน' }));
    expect(screen.getByText('2 ถุง × ฿60.00')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }));
    expect(onConfirmDelivery).toHaveBeenCalledWith('end_of_day');
  });

  it('offers only the frozen-request retry when a delivery is unresolved, even without a valid new cart', async () => {
    const user = userEvent.setup();
    const onRetryDelivery = vi.fn();
    const { onConfirmDelivery } = renderReview(true, shopCard, {
      hasPendingDelivery: true, onRetryDelivery, items: [], posContext: null,
      posContextError: 'โหลดเงื่อนไขไม่สำเร็จ',
    });
    expect(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'ส่งและรับชำระ' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'ตรวจผล / ลองคำขอเดิมอีกครั้ง' }));
    expect(onRetryDelivery).toHaveBeenCalledTimes(1);
    expect(onConfirmDelivery).not.toHaveBeenCalled();
  });

  it('types a half-unit quantity and uses Enter to finish entry without submitting delivery', async () => {
    const user = userEvent.setup();
    const { onSubmit, onConfirmDelivery } = renderReview();
    await user.click(screen.getByRole('button', { name: /หลอดเล็ก.*คงเหลือ/ }));
    const quantity = screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' });
    await user.clear(quantity);
    await user.type(quantity, '2.5');
    await user.keyboard('{Enter}');
    expect(screen.getByText('2.5 ถุง × ฿60.00')).toBeTruthy();
    expect(screen.queryByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' })).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }));
    expect(onConfirmDelivery).toHaveBeenCalledWith('end_of_day');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('uses Enter to save each quantity and continue through other ice types for the same shop', async () => {
    const user = userEvent.setup();
    const otherItems = [
      { ...posContext.items[0], ice_type_id: 'ice-2', code: 'LARGE', name: 'หลอดใหญ่' },
      { ...posContext.items[0], ice_type_id: 'ice-3', code: 'CRUSHED', name: 'น้ำแข็งบด' },
    ];
    const { onSubmit } = renderReview(true, shopCard, {
      posContext: { ...posContext, items: [...posContext.items, ...otherItems] },
    });

    await user.click(screen.getByRole('button', { name: /หลอดเล็ก.*คงเหลือ/ }));
    await user.clear(screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' }));
    await user.type(screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' }), '2.5{Enter}');
    expect(screen.getByText('2.5 ถุง × ฿60.00')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('spinbutton', { name: 'จำนวนหลอดใหญ่' }));

    await user.type(screen.getByRole('spinbutton', { name: 'จำนวนหลอดใหญ่' }), '1{Enter}');
    expect(screen.getByText('1 ถุง × ฿60.00')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('spinbutton', { name: 'จำนวนน้ำแข็งบด' }));

    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' }));
    expect(screen.getByText('2 รายการ')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('skips ice types that cannot be added when Enter advances', async () => {
    const user = userEvent.setup();
    const unavailable = { ...posContext.items[0], ice_type_id: 'ice-2', name: 'หลอดใหญ่', unit_price: null };
    const available = { ...posContext.items[0], ice_type_id: 'ice-3', name: 'น้ำแข็งบด' };
    renderReview(true, shopCard, {
      posContext: { ...posContext, items: [posContext.items[0], unavailable, available] },
    });

    await user.click(screen.getByRole('button', { name: /หลอดเล็ก.*คงเหลือ/ }));
    await user.click(screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' }));
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('spinbutton', { name: 'จำนวนน้ำแข็งบด' }));
  });

  it.each([[ '½', 0.5 ], [ '1', 1 ], [ '2', 2 ], [ '3', 3 ]])('sets the quick quantity %s without appending digits', async (label, quantity) => {
    const user = userEvent.setup();
    const onSetQuantity = vi.fn();
    renderReview(true, shopCard, { onSetQuantity });
    await user.click(screen.getByRole('button', { name: /หลอดเล็ก.*คงเหลือ/ }));
    const quick = screen.getByRole('group', { name: 'เลือกจำนวนด่วน' });
    await user.click(within(quick).getByRole('button', { name: String(label), exact: true }));
    expect(onSetQuantity).toHaveBeenLastCalledWith('ice-1', quantity);
    expect((screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' }) as HTMLInputElement).value).toBe(String(quantity));
  });

  it.each(['', '0'])('commits an erased quantity (%s) as zero and advances on Enter', async (value) => {
    const user = userEvent.setup();
    const onSetQuantity = vi.fn();
    const { onSubmit } = renderReview(true, shopCard, {
      onSetQuantity,
      posContext: {
        ...posContext,
        items: [...posContext.items, { ...posContext.items[0], ice_type_id: 'ice-2', name: 'หลอดใหญ่' }],
      },
    });
    await user.click(screen.getByRole('button', { name: /หลอดเล็ก.*คงเหลือ/ }));
    const quantity = screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' });
    await user.clear(quantity);
    if (value) await user.type(quantity, value);
    expect((quantity as HTMLInputElement).checkValidity()).toBe(true);
    expect(document.activeElement).toBe(quantity);
    await user.keyboard('{Enter}');
    expect(onSetQuantity).toHaveBeenLastCalledWith('ice-1', 0);
    expect(screen.queryByText('2 ถุง × ฿60.00')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('spinbutton', { name: 'จำนวนหลอดใหญ่' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(['0.1', '1.1'])('keeps invalid fractional quantity %s open and out of the cart', async (value) => {
    const user = userEvent.setup();
    const { onSubmit } = renderReview();
    await user.click(screen.getByRole('button', { name: /หลอดเล็ก.*คงเหลือ/ }));
    const quantity = screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' });
    await user.clear(quantity);
    await user.type(quantity, value);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('spinbutton', { name: 'จำนวนหลอดเล็ก' })).toBeTruthy();
    expect(screen.getByText('2 ถุง × ฿60.00')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('filters the round shops by code, name and booth without Enter submitting delivery', async () => {
    const user = userEvent.setup();
    const onChangeShop = vi.fn();
    const otherCard = { ...shopCard, round_stop_id: 'stop-2', shop_code: 'SW-03', shop_name: 'ร้านน้ำปั่น', booth_number: 'C12' };
    const { onSubmit } = renderReview(true, shopCard, { shopCards: [shopCard, otherCard], onChangeShop });
    const search = screen.getByRole('searchbox', { name: 'ค้นหาร้านในรอบ' });
    for (const query of ['sw-03', 'น้ำปั่น', 'c12']) {
      await user.clear(search);
      await user.type(search, query);
      expect(screen.queryByRole('button', { name: /BB2 ร้านผัด/ })).toBeNull();
      expect(screen.getByRole('button', { name: 'SW-03 ร้านน้ำปั่น' })).toBeTruthy();
    }
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'SW-03 ร้านน้ำปั่น' }));
    expect(onChangeShop).toHaveBeenCalledWith(otherCard);
    await user.clear(search);
    await user.type(search, 'ไม่มีร้านนี้');
    expect(screen.getByText('ไม่พบร้านที่ค้นหา')).toBeTruthy();
  });

  it('offers two direct delivery actions without a preselected payment term', async () => {
    const user = userEvent.setup();
    const { onConfirmDelivery } = renderReview();

    const paymentButtons = screen.getAllByRole('button', { name: /(ส่งอย่างเดียว|ส่งและรับชำระ)/ });
    expect(paymentButtons).toHaveLength(2);
    expect(paymentButtons[0].textContent).toContain('ส่งอย่างเดียว');
    expect(paymentButtons[1].textContent).toContain('ส่งและรับชำระ');
    expect(screen.queryByText('เงื่อนไขชำระ')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ยืนยันส่งร้านนี้' })).toBeNull();
    await user.click(paymentButtons[1]);
    expect(onConfirmDelivery).toHaveBeenCalledWith('immediate');
  });

  it('removes the review toggle after entering the confirmation step', async () => {
    const user = userEvent.setup();
    renderReview();

    await user.click(screen.getByRole('button', { name: 'ตรวจรายการ (1)' }));

    expect(screen.queryByRole('button', { name: 'ตรวจรายการ (1)' })).toBeNull();
    expect(screen.getByRole('button', { name: 'กลับไปแก้รายการ' })).toBeTruthy();
  });

  it('does not offer send-and-collect to a courier without collection permission', () => {
    renderReview(false);

    expect(screen.getByRole('button', { name: 'ส่งและรับชำระ' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('บัญชีนี้ยังไม่ได้รับสิทธิ์รับชำระเงิน')).not.toBeNull();
  });

  it('sends credit customers through their credit billing term', async () => {
    const user = userEvent.setup();
    const { onConfirmDelivery } = renderReview(true, shopCard, {
      posContext: { ...posContext, payment_profile: {
        ...posContext.payment_profile!, allowed_payment_terms: ['credit'], default_payment_term: 'credit',
      } },
    });
    expect(screen.getByRole('button', { name: 'ส่งและรับชำระ' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }));
    expect(onConfirmDelivery).toHaveBeenCalledWith('credit');
  });

  it('opens cancellation for an eligible event delivery in employee history', async () => {
    const user = userEvent.setup();
    renderReview(true, {
      ...shopCard,
      destination_kind: 'event',
      today_history: [{
        event_id: 'event-delivery-1',
        recorded_at: '2026-08-18T01:00:00Z',
        round_name: 'งานทดสอบ',
        recorded_by: 'พนักงาน',
        stop_status: 'delivered',
        note: null,
        items: { 'ice-1': 2 },
        can_cancel: true,
      }],
    });

    await user.click(screen.getByRole('button', { name: 'ยกเลิกใบส่งน้ำแข็ง' }));
    expect(screen.getByRole('dialog', { name: /ยกเลิกใบส่งน้ำแข็ง/ })).toBeTruthy();
  });

  it('guarantees end_of_day is always placed on the left and immediate on the right regardless of input order', () => {
    expect(sortPaymentTerms(['immediate', 'end_of_day'])).toEqual(['end_of_day', 'immediate']);
    expect(sortPaymentTerms(['end_of_day', 'immediate'])).toEqual(['end_of_day', 'immediate']);
    expect(sortPaymentTerms(['credit', 'immediate', 'end_of_day'])).toEqual(['end_of_day', 'immediate', 'credit']);
    expect(sortPaymentTerms(['immediate', 'end_of_day', 'immediate'])).toEqual(['end_of_day', 'immediate']);
  });
});
