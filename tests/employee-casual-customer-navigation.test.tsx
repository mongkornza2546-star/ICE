import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmployeeDeliveryWorkspace,
  type EmployeeDeliveryGateway,
} from '../src/EmployeeDeliveryWorkspace';

vi.mock('../src/lib/supabase', () => ({ supabase: null }));

function createGateway(): EmployeeDeliveryGateway {
  return {
    loadReferenceData: vi.fn().mockResolvedValue({
      rounds: [{
        id: 'round-1',
        service_date: '2026-08-20',
        name: 'งานประจำวัน',
        round_type: 'daily',
        status: 'open',
        opened_at: '2026-08-20T01:00:00Z',
      }],
      iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
    }),
    loadShopCards: vi.fn().mockResolvedValue([]),
    loadEmployeeStockState: vi.fn(),
    recordEmployeeStockTransfer: vi.fn(),
    recordEmployeeStockReturn: vi.fn(),
    recordEmployeeStockDamage: vi.fn(),
    recordDelivery: vi.fn(),
    loadCasualTransactionCapability: vi.fn().mockResolvedValue(true),
    loadCasualTransactionContext: vi.fn().mockResolvedValue({
      round_id: 'round-1',
      service_date: '2026-08-20',
      round_status: 'open',
      stock_closed: false,
      stock_source: { id: 'holding-1', code: 'HOLD-1', name: 'จุดถือครอง' },
      items: [{ ice_type_id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง', available_quantity: 10 }],
      history: [],
    }),
    recordCasualTransaction: vi.fn(),
    loadCasualReceiptSnapshot: vi.fn(),
    voidCasualTransaction: vi.fn(),
    uploadPaymentEvidence: vi.fn(),
    deletePaymentEvidence: vi.fn(),
  };
}

describe('casual-customer POS navigation', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the production entry hidden until the rollout capability is enabled', async () => {
    render(<EmployeeDeliveryWorkspace
      casualCustomerEnabled={false}
      gateway={createGateway()}
      serviceDate="2026-08-20"
    />);

    await screen.findByRole('searchbox', { name: 'ค้นหาร้าน' });
    expect(screen.queryByRole('button', { name: 'บันทึกลูกค้าขาจร' })).toBeNull();
  });

  it('keeps the entry hidden when the server does not advertise the measured RPC capability', async () => {
    const gateway = createGateway();
    vi.mocked(gateway.loadCasualTransactionCapability!).mockResolvedValue(false);
    render(<EmployeeDeliveryWorkspace
      casualCustomerEnabled
      gateway={gateway}
      serviceDate="2026-08-20"
    />);

    await screen.findByRole('searchbox', { name: 'ค้นหาร้าน' });
    await waitFor(() => expect(gateway.loadCasualTransactionCapability).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'บันทึกลูกค้าขาจร' })).toBeNull();
  });

  it('opens casual customers above shop search and returns to the shop picker', async () => {
    const user = userEvent.setup();
    let scrollY = 640;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    vi.spyOn(window, 'scrollTo').mockImplementation((options) => {
      scrollY = typeof options === 'object' ? options.top ?? 0 : Number(options);
    });
    render(<EmployeeDeliveryWorkspace
      casualCustomerEnabled
      gateway={createGateway()}
      serviceDate="2026-08-20"
    />);

    const casualButton = await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' });
    const search = screen.getByRole('searchbox', { name: 'ค้นหาร้าน' });
    expect(casualButton.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(casualButton);
    const heading = screen.getByRole('heading', { level: 1, name: 'ลูกค้าขาจร' });
    expect(document.activeElement).toBe(heading);
    expect(scrollY).toBe(0);
    expect(await screen.findByRole('heading', { level: 2, name: 'เลือกน้ำแข็ง' })).toBeTruthy();
    await user.click(document.querySelector('.employee-pos-product-grid button') as HTMLButtonElement);
    expect(document.querySelector('.employee-pos-product-grid button small')?.textContent).toBe('0 ถุง');

    await user.click(screen.getByRole('button', { name: 'กลับไปเลือกร้าน' }));
    const restoredButton = await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' });
    await waitFor(() => expect(document.activeElement).toBe(restoredButton));
    expect(scrollY).toBe(640);
  });

  it('defaults casual items to zero but allows half-unit quantities', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    vi.mocked(gateway.loadCasualTransactionContext!).mockResolvedValue({
      round_id: 'round-1',
      service_date: '2026-08-20',
      round_status: 'open',
      stock_closed: false,
      stock_source: { id: 'holding-1', code: 'HOLD-1', name: 'จุดถือครอง' },
      items: [{ ice_type_id: 'ice-1', code: 'ICE', name: 'น้ำแข็งก้อน', unit: 'แถว', available_quantity: 9 }],
      history: [],
    });
    render(<EmployeeDeliveryWorkspace casualCustomerEnabled gateway={gateway} serviceDate="2026-08-20" />);

    await user.click(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' }));
    await user.click(document.querySelector('.employee-pos-product-grid button') as HTMLButtonElement);
    expect(document.querySelector('.employee-pos-product-grid button small')?.textContent).toBe('0 แถว');
    await user.click(screen.getByRole('button', { name: 'เพิ่มครึ่งแถว' }));
    expect(document.querySelector('.employee-pos-quantity strong')?.textContent).toBe('0.5 แถว');
  });

  it('returns to the picker when the service date changes', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    vi.mocked(gateway.loadReferenceData).mockImplementation(async (serviceDate) => ({
      rounds: [{
        id: `round-${serviceDate}`,
        service_date: serviceDate,
        name: `งาน ${serviceDate}`,
        round_type: 'daily',
        status: 'open',
        opened_at: `${serviceDate}T01:00:00Z`,
      }],
      iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
    }));
    const view = render(<EmployeeDeliveryWorkspace
      casualCustomerEnabled
      gateway={gateway}
      serviceDate="2026-08-20"
    />);

    await user.click(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' }));
    expect(screen.getByRole('heading', { level: 1, name: 'ลูกค้าขาจร' })).toBeTruthy();

    view.rerender(<EmployeeDeliveryWorkspace
      casualCustomerEnabled
      gateway={gateway}
      serviceDate="2026-08-19"
    />);

    expect(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'ลูกค้าขาจร' })).toBeNull();
  });

  it('does not reopen the subpage after leaving and returning to POS', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    const view = render(<EmployeeDeliveryWorkspace
      casualCustomerEnabled
      gateway={gateway}
      serviceDate="2026-08-20"
      viewMode="pos"
    />);

    await user.click(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' }));
    expect(screen.getByRole('heading', { level: 1, name: 'ลูกค้าขาจร' })).toBeTruthy();

    view.rerender(<EmployeeDeliveryWorkspace
      casualCustomerEnabled
      enableAssignedStockFlow
      gateway={gateway}
      serviceDate="2026-08-20"
      viewMode="withdrawal"
    />);
    expect(screen.queryByRole('heading', { level: 1, name: 'ลูกค้าขาจร' })).toBeNull();

    view.rerender(<EmployeeDeliveryWorkspace
      casualCustomerEnabled
      gateway={gateway}
      serviceDate="2026-08-20"
      viewMode="pos"
    />);
    expect(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'ลูกค้าขาจร' })).toBeNull();
  });

  it('records a five-baht zero-quantity casual sale from the employee form', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    vi.mocked(gateway.recordCasualTransaction!).mockResolvedValue({
      transaction: {
        id: 'casual-1',
        ice_type_id: 'ice-1',
        ice_type_name: 'น้ำแข็ง',
        ice_type_unit: 'ถุง',
        transaction_kind: 'paid',
        fulfillment_mode: 'loose',
        quantity: null,
        sale_amount: 5,
        payment_method: 'cash',
        received_amount: 5,
        change_amount: 0,
        receipt_number: 'REC2608-00001',
        note: null,
        recorded_at: '2026-08-20T02:30:00Z',
        status: 'active',
        voided_at: null,
        void_reason: null,
      },
      receipt: null,
    });
    render(<EmployeeDeliveryWorkspace casualCustomerEnabled gateway={gateway} serviceDate="2026-08-20" />);

    await user.click(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' }));
    await user.click(document.querySelector('.employee-pos-product-grid button') as HTMLButtonElement);
    await user.type(await screen.findByLabelText('ยอดขาย (บาท)'), '5');
    await user.type(screen.getByLabelText('รับเงิน (บาท)'), '5');
    await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));

    await waitFor(() => expect(gateway.recordCasualTransaction).toHaveBeenCalledWith(expect.objectContaining({
      roundId: 'round-1',
      iceTypeId: 'ice-1',
      quantity: 0,
      transactionKind: 'paid',
      saleAmount: 5,
      paymentMethod: 'cash',
      receivedAmount: 5,
    })));
    expect(await screen.findByText(/REC2608-00001/)).toBeTruthy();
  });

  it('reuses the same request identity after an ambiguous record failure', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    vi.mocked(gateway.recordCasualTransaction!)
      .mockRejectedValueOnce(new Error('ขาดการเชื่อมต่อหลังบันทึก'))
      .mockResolvedValueOnce({
        transaction: {
          id: 'casual-1', ice_type_id: 'ice-1', ice_type_name: 'น้ำแข็ง', ice_type_unit: 'ถุง',
          transaction_kind: 'paid', fulfillment_mode: 'measured', quantity: 0.5,
          sale_amount: 75, payment_method: 'cash', received_amount: 75, change_amount: 0,
          receipt_number: 'REC2608-00001', note: null, recorded_at: '2026-08-20T02:30:00Z',
          status: 'active', voided_at: null, void_reason: null,
        },
        receipt: null,
      });
    render(<EmployeeDeliveryWorkspace casualCustomerEnabled gateway={gateway} serviceDate="2026-08-20" />);

    await user.click(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' }));
    await user.click(document.querySelector('.employee-pos-product-grid button') as HTMLButtonElement);
    await user.type(await screen.findByLabelText('ยอดขาย (บาท)'), '75');
    await user.type(screen.getByLabelText('รับเงิน (บาท)'), '75');
    await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
    expect(await screen.findByText('ขาดการเชื่อมต่อหลังบันทึก')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
    await waitFor(() => expect(gateway.recordCasualTransaction).toHaveBeenCalledTimes(2));
    const first = vi.mocked(gateway.recordCasualTransaction!).mock.calls[0][0];
    const second = vi.mocked(gateway.recordCasualTransaction!).mock.calls[1][0];
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.clientRecordedAt).toBe(first.clientRecordedAt);
  });

  it('reuses the same request identity after an ambiguous void failure', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    const transaction = {
      id: 'casual-1', ice_type_id: 'ice-1', ice_type_name: 'น้ำแข็ง', ice_type_unit: 'ถุง',
      transaction_kind: 'paid' as const, fulfillment_mode: 'measured' as const, quantity: 0.5,
      sale_amount: 75, payment_method: 'cash' as const, received_amount: 75, change_amount: 0,
      receipt_number: 'REC2608-00001', note: null, recorded_at: '2026-08-20T02:30:00Z',
      status: 'active' as const, voided_at: null, void_reason: null,
    };
    vi.mocked(gateway.loadCasualTransactionContext!).mockResolvedValue({
      round_id: 'round-1', service_date: '2026-08-20', round_status: 'open', stock_closed: false,
      stock_source: { id: 'holding-1', code: 'HOLD-1', name: 'จุดถือครอง' },
      items: [{ ice_type_id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง', available_quantity: 9.5 }],
      history: [transaction],
    });
    vi.mocked(gateway.voidCasualTransaction!)
      .mockRejectedValueOnce(new Error('ขาดการเชื่อมต่อหลังยกเลิก'))
      .mockResolvedValueOnce({ transaction: { ...transaction, status: 'voided', voided_at: '2026-08-20T03:00:00Z', void_reason: 'คืนสินค้า' }, receipt: null });
    render(<EmployeeDeliveryWorkspace casualCustomerEnabled gateway={gateway} serviceDate="2026-08-20" />);

    await user.click(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' }));
    await user.click(await screen.findByRole('button', { name: 'ยกเลิก' }));
    await user.type(screen.getByLabelText('เหตุผลการยกเลิก'), 'คืนสินค้า');
    await user.click(screen.getByRole('button', { name: 'ยืนยันยกเลิก' }));
    expect(await screen.findByText('ขาดการเชื่อมต่อหลังยกเลิก')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'ยืนยันยกเลิก' }));
    await waitFor(() => expect(gateway.voidCasualTransaction).toHaveBeenCalledTimes(2));
    const first = vi.mocked(gateway.voidCasualTransaction!).mock.calls[0][0];
    const second = vi.mocked(gateway.voidCasualTransaction!).mock.calls[1][0];
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('does not claim to restore stock when voiding a loose issue', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    const transaction = {
      id: 'casual-loose-1', ice_type_id: 'ice-1', ice_type_name: 'น้ำแข็ง', ice_type_unit: 'ถุง',
      transaction_kind: 'free' as const, fulfillment_mode: 'loose' as const, quantity: null,
      sale_amount: 0, payment_method: null, received_amount: null, change_amount: null,
      receipt_number: null, note: null, recorded_at: '2026-08-20T02:30:00Z',
      status: 'active' as const, voided_at: null, void_reason: null,
    };
    vi.mocked(gateway.loadCasualTransactionContext!).mockResolvedValue({
      round_id: 'round-1', service_date: '2026-08-20', round_status: 'open', stock_closed: false,
      stock_source: { id: 'holding-1', code: 'HOLD-1', name: 'จุดถือครอง' },
      items: [{ ice_type_id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง', available_quantity: 9.5 }],
      history: [transaction],
    });
    vi.mocked(gateway.voidCasualTransaction!).mockResolvedValue({
      transaction: { ...transaction, status: 'voided', voided_at: '2026-08-20T03:00:00Z', void_reason: 'บันทึกผิด' },
      receipt: null,
    });
    render(<EmployeeDeliveryWorkspace casualCustomerEnabled gateway={gateway} serviceDate="2026-08-20" />);

    await user.click(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' }));
    await user.click(await screen.findByRole('button', { name: 'ยกเลิก' }));
    await user.type(screen.getByLabelText('เหตุผลการยกเลิก'), 'บันทึกผิด');
    await user.click(screen.getByRole('button', { name: 'ยืนยันยกเลิก' }));

    expect(await screen.findByText('ยกเลิกรายการแล้ว')).toBeTruthy();
    expect(screen.queryByText('ยกเลิกรายการและคืนสต๊อกแล้ว')).toBeNull();
  });

  it('reloads the voided receipt before offering it for printing', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    const transaction = {
      id: 'casual-1', ice_type_id: 'ice-1', ice_type_name: 'น้ำแข็ง', ice_type_unit: 'ถุง',
      transaction_kind: 'paid' as const, fulfillment_mode: 'measured' as const, quantity: 0.5,
      sale_amount: 75, payment_method: 'cash' as const, received_amount: 75, change_amount: 0,
      receipt_number: 'REC2608-00001', note: null, recorded_at: '2026-08-20T02:30:00Z',
      status: 'active' as const, voided_at: null, void_reason: null,
    };
    vi.mocked(gateway.loadCasualTransactionContext!).mockResolvedValue({
      round_id: 'round-1', service_date: '2026-08-20', round_status: 'open', stock_closed: false,
      stock_source: { id: 'holding-1', code: 'HOLD-1', name: 'จุดถือครอง' },
      items: [{ ice_type_id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง', available_quantity: 9.5 }],
      history: [transaction],
    });
    vi.mocked(gateway.voidCasualTransaction!).mockResolvedValue({
      transaction: {
        ...transaction,
        status: 'voided',
        voided_at: '2026-08-20T03:00:00Z',
        void_reason: 'คืนสินค้า',
      },
      receipt: null,
    });
    vi.mocked(gateway.loadCasualReceiptSnapshot!).mockResolvedValue({
      document_type: 'REC',
      document_number: 'REC2608-00001',
      document_title: 'ใบรับเงิน',
      status: 'voided',
      shop_code: 'WALK-IN',
      shop_name: 'ลูกค้าขาจร',
      void_info: {
        voided_at: '2026-08-20T03:00:00Z',
        reason: 'คืนสินค้า',
      },
    });
    render(<EmployeeDeliveryWorkspace casualCustomerEnabled gateway={gateway} serviceDate="2026-08-20" />);

    await user.click(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' }));
    await user.click(await screen.findByRole('button', { name: 'ยกเลิก' }));
    await user.type(screen.getByLabelText('เหตุผลการยกเลิก'), 'คืนสินค้า');
    await user.click(screen.getByRole('button', { name: 'ยืนยันยกเลิก' }));

    await waitFor(() => expect(gateway.loadCasualReceiptSnapshot).toHaveBeenCalledWith('casual-1'));
    expect(document.querySelector('.employee-success__print')).toBeTruthy();
  });

  it('reuses uploaded transfer evidence after remounting an ambiguous request', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    vi.mocked(gateway.uploadPaymentEvidence!).mockResolvedValue('user-1/r2/request-proof.webp');
    vi.mocked(gateway.recordCasualTransaction!)
      .mockRejectedValueOnce(new Error('ขาดการเชื่อมต่อหลังบันทึก'))
      .mockResolvedValueOnce({
        transaction: {
          id: 'casual-1', ice_type_id: 'ice-1', ice_type_name: 'น้ำแข็ง', ice_type_unit: 'ถุง',
          transaction_kind: 'paid', fulfillment_mode: 'measured', quantity: 0.5,
          sale_amount: 75, payment_method: 'bank_transfer', received_amount: 75, change_amount: 0,
          receipt_number: 'REC2608-00001', note: null, recorded_at: '2026-08-20T02:30:00Z',
          status: 'active', voided_at: null, void_reason: null,
        },
        receipt: null,
      });
    const proof = new File(['proof'], 'proof.png', {
      type: 'image/png',
      lastModified: 123,
    });
    const firstView = render(
      <EmployeeDeliveryWorkspace casualCustomerEnabled gateway={gateway} serviceDate="2026-08-20" />,
    );

    await user.click(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' }));
    await user.click(document.querySelector('.employee-pos-product-grid button') as HTMLButtonElement);
    await user.type(await screen.findByLabelText('ยอดขาย (บาท)'), '75');
    await user.click(screen.getByRole('button', { name: 'โอนเงิน' }));
    await user.upload(screen.getByLabelText('หลักฐานการชำระ'), proof);
    await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
    expect(await screen.findByText('ขาดการเชื่อมต่อหลังบันทึก')).toBeTruthy();
    const firstPayload = vi.mocked(gateway.recordCasualTransaction!).mock.calls[0][0];
    firstView.unmount();

    render(<EmployeeDeliveryWorkspace casualCustomerEnabled gateway={gateway} serviceDate="2026-08-20" />);
    await user.click(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' }));
    await user.click(document.querySelector('.employee-pos-product-grid button') as HTMLButtonElement);
    await user.type(await screen.findByLabelText('ยอดขาย (บาท)'), '75');
    await user.click(screen.getByRole('button', { name: 'โอนเงิน' }));
    await user.upload(screen.getByLabelText('หลักฐานการชำระ'), proof);
    await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));

    await waitFor(() => expect(gateway.recordCasualTransaction).toHaveBeenCalledTimes(2));
    const secondPayload = vi.mocked(gateway.recordCasualTransaction!).mock.calls[1][0];
    expect(secondPayload.idempotencyKey).toBe(firstPayload.idempotencyKey);
    expect(secondPayload.evidencePath).toBe(firstPayload.evidencePath);
    expect(gateway.uploadPaymentEvidence).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized casual payment evidence', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    render(<EmployeeDeliveryWorkspace casualCustomerEnabled gateway={gateway} serviceDate="2026-08-20" />);

    await user.click(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' }));
    await user.click(document.querySelector('.employee-pos-product-grid button') as HTMLButtonElement);
    await user.type(await screen.findByLabelText('ยอดขาย (บาท)'), '75');
    await user.click(screen.getByRole('button', { name: 'โอนเงิน' }));
    await user.upload(screen.getByLabelText('หลักฐานการชำระ'), new File(
      [new Uint8Array(5 * 1024 * 1024 + 1)],
      'large.pdf',
      { type: 'application/pdf' },
    ));

    expect(await screen.findByText('หลักฐานต้องมีขนาดไม่เกิน 5 MB')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
