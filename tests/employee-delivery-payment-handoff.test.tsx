import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';
import { FinancialOperations } from '../src/FinancialOperations';
import { useEmployeeDeliveryData } from '../src/features/employee-delivery/useEmployeeDeliveryData';
import type { QueueShop } from '../src/features/financial-operations/types';
import type { CollectionFocusRequest, ShopCard } from '../src/types/app';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: rpcMock } }));

const shop: ShopCard = {
  round_stop_id: 'stop-1',
  shop_id: 'shop-1',
  shop_code: 'BB15',
  shop_name: 'ร้านทดสอบ',
  building_id: 'building-1',
  building_name: 'อาคาร B',
  floor_or_zone: '1',
  sequence_no: 15,
  image_path: null,
  image_url: null,
  payment_status: 'unpaid',
  stop_status: 'pending',
  stop_note: null,
  today_history: [],
  today_totals: {},
};

function createGateway(events: string[]): EmployeeDeliveryGateway {
  return {
    loadReferenceData: vi.fn().mockResolvedValue({
      rounds: [{
        id: 'round-1',
        service_date: '2026-08-19',
        name: 'งานประจำวัน',
        status: 'open',
        opened_at: '2026-08-19T01:00:00Z',
      }],
      iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
    }),
    loadShopCards: vi.fn().mockResolvedValue([shop]),
    loadEmployeeStockState: vi.fn(),
    recordEmployeeStockTransfer: vi.fn(),
    recordEmployeeStockReturn: vi.fn(),
    recordEmployeeStockDamage: vi.fn(),
    recordDelivery: vi.fn().mockImplementation(async () => {
      events.push('delivery');
      return {
        delivery_event_id: 'delivery-1',
        round_stop_id: shop.round_stop_id,
        charge_id: 'charge-1',
        service_date: '2026-08-19',
        total_amount: 30,
        payment_term: 'immediate',
        payment_status: 'unpaid',
        due_date: null,
        approval_id: null,
      };
    }),
    recordImmediateSale: vi.fn(),
  };
}

function DeliveryHarness({
  canCollectShopPayments = true,
  gateway,
  onOpenCollection,
}: {
  canCollectShopPayments?: boolean;
  gateway: EmployeeDeliveryGateway;
  onOpenCollection: (request: CollectionFocusRequest) => void;
}) {
  const data = useEmployeeDeliveryData({
    canCollectShopPayments,
    gateway,
    onOpenCollection,
    requestScope: 'employee-1',
    serviceDate: '2026-08-19',
  });

  if (data.loadingReference || data.loadingCards || data.cards.length === 0) return <div>กำลังโหลด</div>;
  if (!data.selectedCard) {
    return <button onClick={() => data.openCard(shop)} type="button">เลือกร้าน</button>;
  }
  return (
    <form onSubmit={data.handleSubmit}>
      <button onClick={() => data.setDeliveryQuantity('ice-1', 1)} type="button">ใส่จำนวน</button>
      <button type="submit">ยืนยันส่งร้านนี้</button>
      {data.entryError ? <p role="alert">{data.entryError}</p> : null}
    </form>
  );
}

describe('employee delivery to collection handoff', () => {
  it('records an unpaid delivery before opening the existing collection screen', async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    const gateway = createGateway(events);
    const onOpenCollection = vi.fn((request: CollectionFocusRequest) => {
      events.push('collection');
      expect(request).toEqual({ queueKey: 'regular:shop-1', chargeId: 'charge-1' });
    });
    render(<DeliveryHarness gateway={gateway} onOpenCollection={onOpenCollection} />);

    await user.click(await screen.findByRole('button', { name: 'เลือกร้าน' }));
    await user.click(screen.getByRole('button', { name: 'ใส่จำนวน' }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));

    await waitFor(() => expect(onOpenCollection).toHaveBeenCalledTimes(1));
    expect(gateway.recordDelivery).toHaveBeenCalledTimes(1);
    expect(gateway.recordImmediateSale).not.toHaveBeenCalled();
    expect(events).toEqual(['delivery', 'collection']);
  });

  it('leaves the saved delivery unpaid when the focused collection screen is cancelled', async () => {
    const user = userEvent.setup();
    const onFocusedCollectionClose = vi.fn();
    const queueShop: QueueShop = {
      queue_key: 'regular:shop-1',
      destination_kind: 'regular',
      shop_id: 'shop-1',
      shop_code: 'BB15',
      shop_name: 'ร้านทดสอบ',
      image_path: null,
      outstanding_amount: 30,
      charge_count: 1,
      has_new_charges: true,
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
        delivery_event_id: 'delivery-1',
        charge_number: 'INV001',
        service_date: '2026-08-19',
        payment_term: 'immediate',
        due_date: null,
        original_amount: 30,
        outstanding_amount: 30,
        items: [],
      }],
    };
    render(<FinancialOperations
      demoData={{
        serviceDate: '2026-08-19',
        queue: [queueShop],
        paymentHistory: [],
        runId: 'run-1',
      }}
      focusRequest={{ queueKey: 'regular:shop-1', chargeId: 'charge-1' }}
      onFocusedCollectionClose={onFocusedCollectionClose}
      userRole="courier"
    />);

    expect(await screen.findByRole('dialog', { name: 'รับเงิน ร้านทดสอบ' })).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'ยกเลิก' }));

    expect(onFocusedCollectionClose).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('dialog', { name: 'รับเงิน ร้านทดสอบ' })).toBeNull();
    expect(queueShop.charges[0].outstanding_amount).toBe(30);
  });

  it('blocks send-and-collect before delivery for a courier without collection permission', async () => {
    const user = userEvent.setup();
    const gateway = createGateway([]);
    const onOpenCollection = vi.fn();
    render(<DeliveryHarness
      canCollectShopPayments={false}
      gateway={gateway}
      onOpenCollection={onOpenCollection}
    />);

    await user.click(await screen.findByRole('button', { name: 'เลือกร้าน' }));
    await user.click(screen.getByRole('button', { name: 'ใส่จำนวน' }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));

    expect(await screen.findByRole('alert')).not.toBeNull();
    expect(gateway.recordDelivery).not.toHaveBeenCalled();
    expect(onOpenCollection).not.toHaveBeenCalled();
  });

  it('returns from the focused collection when the dialog is dismissed with Escape', async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    const onFocusedCollectionClose = vi.fn();
    const queueShop: QueueShop = {
      queue_key: 'regular:shop-1',
      destination_kind: 'regular',
      shop_id: 'shop-1',
      shop_code: 'BB15',
      shop_name: 'ร้านทดสอบ',
      image_path: null,
      outstanding_amount: 30,
      charge_count: 1,
      has_new_charges: true,
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
        delivery_event_id: 'delivery-1',
        charge_number: 'INV001',
        service_date: '2026-08-19',
        payment_term: 'immediate',
        due_date: null,
        original_amount: 30,
        outstanding_amount: 30,
        items: [],
      }],
    };
    try {
      render(<FinancialOperations
        demoData={{ serviceDate: '2026-08-19', queue: [queueShop], paymentHistory: [], runId: 'run-1' }}
        focusRequest={{ queueKey: 'regular:shop-1', chargeId: 'charge-1' }}
        onFocusedCollectionClose={onFocusedCollectionClose}
        userRole="courier"
      />);

      expect(await screen.findByRole('dialog', { name: 'รับเงิน ร้านทดสอบ' })).not.toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });

      expect(onFocusedCollectionClose).toHaveBeenCalledWith(false);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
    }
  });

  it('retries the same focus request after the queue becomes available', async () => {
    const focusRequest = { queueKey: 'regular:shop-1', chargeId: 'charge-1' };
    const queueShop: QueueShop = {
      queue_key: focusRequest.queueKey,
      destination_kind: 'regular',
      shop_id: 'shop-1',
      shop_code: 'BB15',
      shop_name: 'ร้านทดสอบ',
      image_path: null,
      outstanding_amount: 30,
      charge_count: 1,
      has_new_charges: true,
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
        charge_id: focusRequest.chargeId,
        charge_number: 'INV001',
        service_date: '2026-08-19',
        original_amount: 30,
        outstanding_amount: 30,
        items: [],
      }],
    };
    const emptyData = { serviceDate: '2026-08-19', queue: [], paymentHistory: [], runId: 'run-1' };
    const { rerender } = render(<FinancialOperations
      demoData={emptyData}
      focusRequest={focusRequest}
      userRole="courier"
    />);

    expect((await screen.findByRole('alert')).textContent).toContain('ไม่พบร้านนี้ในคิวรับเงินล่าสุด');
    rerender(<FinancialOperations
      demoData={{ ...emptyData, queue: [queueShop] }}
      focusRequest={focusRequest}
      userRole="courier"
    />);

    expect(await screen.findByRole('dialog', { name: 'รับเงิน ร้านทดสอบ' })).not.toBeNull();
  });

  it('keeps separate deferred immediate deliveries in receipt history', async () => {
    const user = userEvent.setup();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({
      data: {
        payment_id: 'payment-1',
        receipt_number: 'REC001',
        shop_code: 'BB15',
        shop_name: 'ร้านทดสอบ',
        payment_method: 'cash',
        received_amount: 30,
        allocated_amount: 30,
        change_amount: 0,
        recorded_at: '2026-08-19T03:00:00Z',
        charges: [{
          charge_number: null,
          payment_term: 'immediate',
          received_amount: 10,
          items: [{
            ice_type_name: 'น้ำแข็งถุงเล็ก',
            ice_type_unit: 'ถุง',
            quantity: 1,
            line_total: 10,
          }],
        }, {
          charge_number: null,
          payment_term: 'immediate',
          received_amount: 20,
          items: [{
            ice_type_name: 'น้ำแข็งถุงใหญ่',
            ice_type_unit: 'ถุง',
            quantity: 1,
            line_total: 20,
          }],
        }],
      },
      error: null,
    });

    render(<FinancialOperations
      demoData={{
        serviceDate: '2026-08-19',
        queue: [],
        paymentHistory: [{
          id: 'payment-1',
          receipt_number: 'REC001',
          received_amount: 30,
          allocated_amount: 30,
          change_amount: 0,
          payment_method: 'cash',
          status: 'active',
          recorded_at: '2026-08-19T03:00:00Z',
          void_reason: null,
          shops: { code: 'BB15', name: 'ร้านทดสอบ' },
        }],
        runId: 'run-1',
      }}
      userRole="courier"
    />);

    await user.click(screen.getByRole('button', { name: 'ประวัติรับเงิน' }));
    await user.click(await screen.findByRole('button', { name: 'ดูบิล REC001 ของ ร้านทดสอบ' }));

    const paidCharges = await screen.findByRole('region', { name: 'บิลที่ชำระ' });
    expect(within(paidCharges).getAllByText('ขายสด')).toHaveLength(2);
    expect(rpcMock).toHaveBeenCalledWith('get_payment_receipt_snapshot', { p_payment_id: 'payment-1' });
  });
});
