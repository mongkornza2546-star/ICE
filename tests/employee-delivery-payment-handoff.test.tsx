import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { EmployeeDeliveryGateway, EmployeeDeliveryPayload } from '../src/EmployeeDeliveryWorkspace';
import { FinancialOperations } from '../src/FinancialOperations';
import { useEmployeeDeliveryData } from '../src/features/employee-delivery/useEmployeeDeliveryData';
import { usePendingRequests } from '../src/features/employee-delivery/usePendingRequests';
import type { QueueShop } from '../src/features/financial-operations/types';
import type { CollectionFocusRequest, DeliveryPosContext, ShopCard } from '../src/types/app';

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

function collectionFocus(chargeId = 'charge-1'): CollectionFocusRequest {
  return {
    requestId: `request-${chargeId}`,
    source: 'delivery',
    shopId: 'shop-1',
    queueKey: 'regular:shop-1',
    chargeId,
    returnContextId: `return-${chargeId}`,
  };
}

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
  card = shop,
  gateway,
  onOpenCollection,
  requestScope = 'employee-1',
}: {
  canCollectShopPayments?: boolean;
  card?: ShopCard;
  gateway: EmployeeDeliveryGateway;
  onOpenCollection: (request: CollectionFocusRequest) => void;
  requestScope?: string;
}) {
  const data = useEmployeeDeliveryData({
    canCollectShopPayments,
    gateway,
    onOpenCollection,
    requestScope,
    serviceDate: '2026-08-19',
  });

  if (data.loadingReference || data.loadingCards || data.cards.length === 0) return <div>กำลังโหลด</div>;
  if (!data.selectedCard) {
    return <button onClick={() => data.openCard(card)} type="button">เลือกร้าน</button>;
  }
  return (
    <div>
      <button onClick={() => data.setDeliveryQuantity('ice-1', 1)} type="button">ใส่จำนวน</button>
      <button onClick={() => { data.setDeliveryQuantity('ice-1', 2); data.setNote('แก้หลังคำขอแรก'); }} type="button">แก้รายการ</button>
      <button onClick={() => data.submitDeliveryChoice('end_of_day')} type="button">ส่งอย่างเดียว</button>
      <button onClick={() => data.submitDeliveryChoice('immediate')} type="button">ส่งและรับชำระ</button>
      {data.hasPendingDelivery ? <button onClick={data.retryPendingDelivery} type="button">ลองคำขอเดิมอีกครั้ง</button> : null}
      {data.entryError ? <p role="alert">{data.entryError}</p> : null}
    </div>
  );
}

describe('employee delivery to collection handoff', () => {
  it.each([
    ['ส่งอย่างเดียว', 'ส่งและรับชำระ'],
    ['ส่งและรับชำระ', 'ส่งอย่างเดียว'],
  ])('keeps the original request after %s commits but its response is lost', async (original, alternate) => {
    const user = userEvent.setup();
    const gateway = createGateway([]);
    const committed = new Set<string>();
    const recordDelivery = vi.fn(async (payload: EmployeeDeliveryPayload) => {
      const wasCommitted = committed.has(payload.idempotencyKey);
      committed.add(payload.idempotencyKey);
      if (!wasCommitted && committed.size === 1) throw new TypeError('Failed to fetch');
      return {
        delivery_event_id: 'delivery-1', round_stop_id: shop.round_stop_id,
        charge_id: 'charge-1', service_date: '2026-08-19', total_amount: 30,
        payment_term: payload.paymentTerm!, payment_status: 'unpaid' as const,
        due_date: null, approval_id: null,
      };
    });
    gateway.recordDelivery = recordDelivery;
    const onOpenCollection = vi.fn();
    render(<DeliveryHarness gateway={gateway} onOpenCollection={onOpenCollection} requestScope={`retry-${original}`} />);
    await user.click(await screen.findByRole('button', { name: 'เลือกร้าน' }));
    await user.click(screen.getByRole('button', { name: 'ใส่จำนวน' }));
    await user.click(screen.getByRole('button', { name: original }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: alternate }));
    expect(recordDelivery).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toContain('วิธีส่งเดิม');

    await user.click(screen.getByRole('button', { name: original }));
    await screen.findByRole('button', { name: 'เลือกร้าน' });
    expect(recordDelivery).toHaveBeenCalledTimes(2);
    expect(recordDelivery.mock.calls[1][0]).toEqual(recordDelivery.mock.calls[0][0]);
    expect(committed.size).toBe(1);
    expect(onOpenCollection).toHaveBeenCalledTimes(original === 'ส่งและรับชำระ' ? 1 : 0);

    await user.click(screen.getByRole('button', { name: 'เลือกร้าน' }));
    await user.click(screen.getByRole('button', { name: 'ใส่จำนวน' }));
    await user.click(screen.getByRole('button', { name: alternate }));
    await waitFor(() => expect(recordDelivery).toHaveBeenCalledTimes(3));
    expect(recordDelivery.mock.calls[2][0].idempotencyKey).not.toBe(recordDelivery.mock.calls[0][0].idempotencyKey);
  });

  it('allows an edited request after the database explicitly rejects the original transaction', async () => {
    const user = userEvent.setup();
    const gateway = createGateway([]);
    const recordDelivery = vi.fn()
      .mockRejectedValueOnce({ code: 'P0001', message: 'Insufficient stock' })
      .mockResolvedValue(undefined);
    gateway.recordDelivery = recordDelivery;
    render(<DeliveryHarness gateway={gateway} onOpenCollection={vi.fn()} requestScope="rejected-delivery" />);
    await user.click(await screen.findByRole('button', { name: 'เลือกร้าน' }));
    await user.click(screen.getByRole('button', { name: 'ใส่จำนวน' }));
    await user.click(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'ส่งและรับชำระ' }));
    await waitFor(() => expect(recordDelivery).toHaveBeenCalledTimes(2));
    expect(recordDelivery.mock.calls[1][0].idempotencyKey).not.toBe(recordDelivery.mock.calls[0][0].idempotencyKey);
  });

  it.each(['08006', 'EPIPE'])('retains the original request after ambiguous connection error %s', async (code) => {
    const user = userEvent.setup();
    const gateway = createGateway([]);
    const recordDelivery = vi.fn()
      .mockRejectedValueOnce({ code, message: 'Connection lost' })
      .mockResolvedValue(undefined);
    gateway.recordDelivery = recordDelivery;
    render(<DeliveryHarness gateway={gateway} onOpenCollection={vi.fn()} requestScope={`connection-${code}`} />);
    await user.click(await screen.findByRole('button', { name: 'เลือกร้าน' }));
    await user.click(screen.getByRole('button', { name: 'ใส่จำนวน' }));
    await user.click(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'แก้รายการ' }));
    await user.click(screen.getByRole('button', { name: 'ส่งและรับชำระ' }));
    expect(recordDelivery).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'ลองคำขอเดิมอีกครั้ง' }));
    await screen.findByRole('button', { name: 'เลือกร้าน' });
    expect(recordDelivery).toHaveBeenCalledTimes(2);
    expect(recordDelivery.mock.calls[1][0]).toEqual(recordDelivery.mock.calls[0][0]);
  });

  it('does not release an earlier ambiguous commit when a later retry is rejected by the database', async () => {
    const user = userEvent.setup();
    const gateway = createGateway([]);
    const recordDelivery = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce({ code: 'P0001', message: 'The request cannot currently be viewed' })
      .mockResolvedValue(undefined);
    gateway.recordDelivery = recordDelivery;
    render(<DeliveryHarness gateway={gateway} onOpenCollection={vi.fn()} requestScope="rejected-retry" />);
    await user.click(await screen.findByRole('button', { name: 'เลือกร้าน' }));
    await user.click(screen.getByRole('button', { name: 'ใส่จำนวน' }));
    await user.click(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'ลองคำขอเดิมอีกครั้ง' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('cannot currently be viewed'));
    await user.click(screen.getByRole('button', { name: 'ส่งและรับชำระ' }));
    expect(recordDelivery).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'ลองคำขอเดิมอีกครั้ง' }));
    await screen.findByRole('button', { name: 'เลือกร้าน' });
    expect(recordDelivery).toHaveBeenCalledTimes(3);
    expect(recordDelivery.mock.calls[1][0]).toEqual(recordDelivery.mock.calls[0][0]);
    expect(recordDelivery.mock.calls[2][0]).toEqual(recordDelivery.mock.calls[0][0]);
  });

  it('replays the frozen request after remounting even when the refreshed context cannot create a new delivery', async () => {
    const user = userEvent.setup();
    const gateway = createGateway([]);
    const recordDelivery = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(undefined);
    gateway.recordDelivery = recordDelivery;
    const props = { gateway, onOpenCollection: vi.fn(), requestScope: 'remounted-delivery' };
    const view = render(<DeliveryHarness {...props} />);
    await user.click(await screen.findByRole('button', { name: 'เลือกร้าน' }));
    await user.click(screen.getByRole('button', { name: 'ใส่จำนวน' }));
    await user.click(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }));
    await screen.findByRole('alert');
    const storedRequests = JSON.parse(window.localStorage.getItem('ice-delivery.pending-requests.v1')!);
    expect(storedRequests['remounted-delivery:delivery:2026-08-19:stop-1'].key).toBe(recordDelivery.mock.calls[0][0].idempotencyKey);
    expect(storedRequests['remounted-delivery:delivery:2026-08-19:stop-1'].payloadSignature).toContain('"quantity":1');
    view.unmount();

    const context: DeliveryPosContext = {
      round_id: 'round-1', round_stop_id: shop.round_stop_id, service_date: '2026-08-19',
      shop: { id: shop.shop_id, code: shop.shop_code, name: shop.shop_name,
        building_name: shop.building_name, floor_or_zone: shop.floor_or_zone, image_path: null },
      stock_source: { id: 'stock-1', code: 'STOCK', name: 'สต๊อก', kind: 'aggregate' },
      items: [{ ice_type_id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง', image_path: null,
        stock_quantity: 0, unit_price: null, price_source: null, price_source_id: null }],
      payment_profile: null,
    };
    gateway.loadDeliveryPosContext = vi.fn().mockResolvedValue(context);
    render(<DeliveryHarness {...props} />);
    await user.click(await screen.findByRole('button', { name: 'ลองคำขอเดิมอีกครั้ง' }));
    await screen.findByRole('button', { name: 'เลือกร้าน' });
    expect(recordDelivery).toHaveBeenCalledTimes(2);
    expect(recordDelivery.mock.calls[1][0]).toEqual(recordDelivery.mock.calls[0][0]);
  });

  it('keeps the original key when a stale retry button is pressed after another workspace confirms the request', async () => {
    const user = userEvent.setup();
    const gateway = createGateway([]);
    const recordDelivery = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch again'))
      .mockResolvedValue(undefined);
    gateway.recordDelivery = recordDelivery;
    render(<DeliveryHarness gateway={gateway} onOpenCollection={vi.fn()} requestScope="stale-retry" />);
    await user.click(await screen.findByRole('button', { name: 'เลือกร้าน' }));
    await user.click(screen.getByRole('button', { name: 'ใส่จำนวน' }));
    await user.click(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }));
    await screen.findByRole('alert');

    function ConfirmFromAnotherWorkspace() {
      const { clearPendingRequest } = usePendingRequests();
      return <button type="button" onClick={() => clearPendingRequest(
        'stale-retry:delivery:2026-08-19:stop-1', recordDelivery.mock.calls[0][0].idempotencyKey,
      )}>ยืนยันจากอีกหน้า</button>;
    }
    render(<ConfirmFromAnotherWorkspace />);
    await user.click(screen.getByRole('button', { name: 'ยืนยันจากอีกหน้า' }));
    await user.click(screen.getByRole('button', { name: 'ลองคำขอเดิมอีกครั้ง' }));
    await waitFor(() => expect(recordDelivery).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: 'ลองคำขอเดิมอีกครั้ง' }));
    await screen.findByRole('button', { name: 'เลือกร้าน' });
    expect(recordDelivery).toHaveBeenCalledTimes(3);
    expect(recordDelivery.mock.calls[1][0]).toEqual(recordDelivery.mock.calls[0][0]);
    expect(recordDelivery.mock.calls[2][0]).toEqual(recordDelivery.mock.calls[0][0]);
  });

  it('opens event collection after recording an event delivery with end-of-day settlement', async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    const eventShop: ShopCard = {
      ...shop,
      destination_kind: 'event',
      event_job_id: 'event-1',
      event_participation_id: 'participation-1',
      event_delivery_enabled: true,
      is_operational: true,
    };
    const gateway = createGateway(events);
    gateway.loadShopCards = vi.fn().mockResolvedValue([eventShop]);
    gateway.recordDelivery = vi.fn().mockImplementation(async () => {
      events.push('delivery');
      return {
        delivery_event_id: 'delivery-1',
        round_stop_id: eventShop.round_stop_id,
        charge_id: 'charge-1',
        service_date: '2026-08-19',
        total_amount: 30,
        payment_term: 'end_of_day',
        payment_status: 'unpaid',
        due_date: null,
        approval_id: null,
      };
    });
    const onOpenCollection = vi.fn(() => events.push('collection'));
    render(<DeliveryHarness card={eventShop} gateway={gateway} onOpenCollection={onOpenCollection} />);

    await user.click(await screen.findByRole('button', { name: 'เลือกร้าน' }));
    await user.click(screen.getByRole('button', { name: 'ใส่จำนวน' }));
    await user.click(screen.getByRole('button', { name: 'ส่งและรับชำระ' }));

    await waitFor(() => expect(onOpenCollection).toHaveBeenCalledWith(expect.objectContaining({
      source: 'delivery', shopId: 'shop-1', queueKey: 'event:event-1', chargeId: 'charge-1',
    })));
    expect(gateway.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
      destinationKind: 'event', paymentTerm: 'immediate',
    }));
    expect(gateway.recordImmediateSale).not.toHaveBeenCalled();
    expect(events).toEqual(['delivery', 'collection']);
  });

  it('records an unpaid delivery before opening the existing collection screen', async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    const gateway = createGateway(events);
    const onOpenCollection = vi.fn((request: CollectionFocusRequest) => {
      events.push('collection');
      expect(request).toEqual(expect.objectContaining({
        source: 'delivery', shopId: 'shop-1', queueKey: 'regular:shop-1', chargeId: 'charge-1',
      }));
    });
    render(<DeliveryHarness gateway={gateway} onOpenCollection={onOpenCollection} />);

    await user.click(await screen.findByRole('button', { name: 'เลือกร้าน' }));
    await user.click(screen.getByRole('button', { name: 'ใส่จำนวน' }));
    await user.click(screen.getByRole('button', { name: 'ส่งและรับชำระ' }));

    await waitFor(() => expect(onOpenCollection).toHaveBeenCalledTimes(1));
    expect(gateway.recordDelivery).toHaveBeenCalledTimes(1);
    expect(gateway.recordImmediateSale).not.toHaveBeenCalled();
    expect(events).toEqual(['delivery', 'collection']);
  });

  it('records send-only immediately without opening collection', async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    const gateway = createGateway(events);
    gateway.recordDelivery = vi.fn().mockResolvedValue({
      delivery_event_id: 'delivery-1', round_stop_id: shop.round_stop_id,
      charge_id: 'charge-1', service_date: '2026-08-19', total_amount: 30,
      payment_term: 'end_of_day', payment_status: 'unpaid', due_date: null, approval_id: null,
    });
    const onOpenCollection = vi.fn();
    render(<DeliveryHarness gateway={gateway} onOpenCollection={onOpenCollection} />);

    await user.click(await screen.findByRole('button', { name: 'เลือกร้าน' }));
    await user.click(screen.getByRole('button', { name: 'ใส่จำนวน' }));
    await user.click(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }));

    await waitFor(() => expect(gateway.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
      paymentTerm: 'end_of_day',
    })));
    expect(onOpenCollection).not.toHaveBeenCalled();
  });

  it('does not record twice when both delivery actions are tapped during one request', async () => {
    const user = userEvent.setup();
    const gateway = createGateway([]);
    let resolveDelivery!: (value: Awaited<ReturnType<NonNullable<EmployeeDeliveryGateway['recordDelivery']>>>) => void;
    gateway.recordDelivery = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveDelivery = resolve;
    }));
    render(<DeliveryHarness gateway={gateway} onOpenCollection={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'เลือกร้าน' }));
    await user.click(screen.getByRole('button', { name: 'ใส่จำนวน' }));
    await user.click(screen.getByRole('button', { name: 'ส่งอย่างเดียว' }));
    await user.click(screen.getByRole('button', { name: 'ส่งและรับชำระ' }));
    expect(gateway.recordDelivery).toHaveBeenCalledTimes(1);
    resolveDelivery();
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
      focusRequest={collectionFocus()}
      onFocusedCollectionClose={onFocusedCollectionClose}
      userRole="courier"
    />);

    expect(await screen.findByRole('dialog', { name: /รับเงิน.*ร้านทดสอบ/ })).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'ยกเลิก' }));

    expect(onFocusedCollectionClose).toHaveBeenCalledWith({
      status: 'cancelled', requestId: 'request-charge-1', shopId: 'shop-1', paymentId: undefined,
    });
    expect(screen.queryByRole('dialog', { name: /รับเงิน.*ร้านทดสอบ/ })).toBeNull();
    expect(queueShop.charges[0].outstanding_amount).toBe(30);
  });

  it('opens the existing collection screen for a POS shortcut without a new charge', async () => {
    const queueShop: QueueShop = {
      queue_key: 'regular:shop-1',
      destination_kind: 'regular',
      shop_id: 'shop-1',
      shop_code: 'BB15',
      shop_name: 'ร้านทดสอบ',
      image_path: null,
      outstanding_amount: 80,
      charge_count: 2,
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
        charge_id: 'old-charge-1',
        charge_number: 'INV-OLD-1',
        service_date: '2026-08-18',
        original_amount: 30,
        outstanding_amount: 30,
        items: [],
      }, {
        charge_id: 'old-charge-2',
        charge_number: 'INV-OLD-2',
        service_date: '2026-08-17',
        original_amount: 50,
        outstanding_amount: 50,
        items: [],
      }],
    };
    const focusRequest: CollectionFocusRequest = {
      requestId: 'request-pos-shortcut',
      source: 'pos-shortcut',
      shopId: 'shop-1',
      queueKey: 'regular:shop-1',
      returnContextId: 'return-pos-shortcut',
    };

    render(<FinancialOperations
      demoData={{
        serviceDate: '2026-08-19',
        queue: [queueShop],
        paymentHistory: [],
        runId: 'run-1',
      }}
      focusRequest={focusRequest}
      userRole="courier"
    />);

    expect(await screen.findByRole('dialog', { name: /รับเงิน.*ร้านทดสอบ/ })).not.toBeNull();
    expect((screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement).value).toBe('80.00');
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
    await user.click(screen.getByRole('button', { name: 'ส่งและรับชำระ' }));

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
        focusRequest={collectionFocus()}
        onFocusedCollectionClose={onFocusedCollectionClose}
        userRole="courier"
      />);

      expect(await screen.findByRole('dialog', { name: /รับเงิน.*ร้านทดสอบ/ })).not.toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });

      expect(onFocusedCollectionClose).toHaveBeenCalledWith({
        status: 'cancelled', requestId: 'request-charge-1', shopId: 'shop-1', paymentId: undefined,
      });
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
    }
  });

  it('retries the same focus request after the queue becomes available', async () => {
    const focusRequest = collectionFocus();
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

    expect(await screen.findByRole('dialog', { name: /รับเงิน.*ร้านทดสอบ/ })).not.toBeNull();
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

  it('includes prior unpaid bills and latest delivery bill in total due when collecting immediate payment', async () => {
    const queueShop: QueueShop = {
      queue_key: 'regular:shop-1',
      destination_kind: 'regular',
      shop_id: 'shop-1',
      shop_code: 'BB1',
      shop_name: 'ร้านข้าวแกง CK',
      image_path: null,
      outstanding_amount: 100, // 50 old bill + 50 latest bill
      charge_count: 2,
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
      charges: [
        {
          charge_id: 'old-charge-1',
          charge_number: 'INV-OLD',
          service_date: '2026-08-18',
          original_amount: 50,
          outstanding_amount: 50,
          items: [],
        },
        {
          charge_id: 'latest-charge-2',
          charge_number: 'INV-NEW',
          service_date: '2026-08-19',
          original_amount: 50,
          outstanding_amount: 50,
          items: [],
        },
      ],
    };

    render(<FinancialOperations
      demoData={{
        serviceDate: '2026-08-19',
        queue: [queueShop],
        paymentHistory: [],
        runId: 'run-1',
      }}
      focusRequest={collectionFocus('latest-charge-2')}
      userRole="admin"
    />);

    expect(await screen.findByRole('dialog', { name: /รับเงิน.*ร้านข้าวแกง CK/ })).not.toBeNull();
    // Total amount due includes all bills (50 + 50 = 100)
    const amountDueSection = screen.getByRole('region', { name: 'ยอดที่ต้องชำระ' });
    expect(amountDueSection.textContent).toContain('100.00');

    // Breakdown shows prior bills and latest delivery bill
    const breakdownSection = screen.getByRole('region', { name: 'สรุปยอดหลังส่งรอบล่าสุด' });
    expect(breakdownSection.textContent).toContain('ยอดค้างก่อนหน้า');
    expect(breakdownSection.textContent).toContain('50.00');
    expect(breakdownSection.textContent).toContain('ยอดส่งรอบล่าสุด');
    expect(breakdownSection.textContent).toContain('ยอดบิลที่เลือก');

    // Input default payment amount is pre-filled with the total 100.00
    const paymentInput = screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement;
    expect(paymentInput.value).toBe('100.00');
  });
});
