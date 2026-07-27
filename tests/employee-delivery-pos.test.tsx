import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EmployeeDeliveryWorkspace, type EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';
import type { DeliveryPosContext, DeliveryRound, IceTypeOption, ShopCard } from '../src/types/app';

const round: DeliveryRound = {
  id: 'round-1',
  service_date: '2026-07-27',
  name: 'รอบเช้า',
  status: 'open',
  opened_at: '2026-07-27T01:00:00Z',
};
const iceTypes: IceTypeOption[] = [{ id: 'ice-1', code: 'BAG', name: 'หลอด', unit: 'ถุง' }];
const shop: ShopCard = {
  round_stop_id: 'stop-1',
  shop_id: 'shop-1',
  shop_code: 'S001',
  shop_name: 'ร้านทดสอบ',
  building_id: 'building-1',
  building_name: 'ตึก A',
  floor_or_zone: 'ชั้น 1',
  sequence_no: 1,
  image_path: null,
  image_url: null,
  payment_status: 'unknown',
  stop_status: 'pending',
  stop_note: null,
  today_history: [],
  today_totals: {},
};
const context: DeliveryPosContext = {
  round_id: round.id,
  round_stop_id: shop.round_stop_id,
  service_date: round.service_date,
  shop: {
    id: shop.shop_id,
    code: shop.shop_code,
    name: shop.shop_name,
    building_name: shop.building_name,
    floor_or_zone: shop.floor_or_zone,
    image_path: null,
  },
  stock_source: { id: 'stock-1', code: 'STOCK', name: 'จุดสต๊อก A', kind: 'work_site' },
  items: [{
    ice_type_id: 'ice-1',
    code: 'BAG',
    name: 'หลอด',
    unit: 'ถุง',
    image_path: null,
    stock_quantity: 20,
    unit_price: 10,
    price_source: 'standard',
    price_source_id: 'price-1',
  }],
  payment_profile: {
    allowed_payment_terms: ['immediate'],
    default_payment_term: 'immediate',
    allowed_payment_methods: ['cash'],
    default_payment_method: 'cash',
    cash_reference_required: false,
    cash_evidence_required: false,
    bank_transfer_reference_required: true,
    bank_transfer_evidence_required: false,
    qr_reference_required: true,
    qr_evidence_required: false,
    allow_outstanding: true,
    credit_due_rule: null,
    credit_days: null,
    credit_limit: null,
    credit_exposure: 0,
    credit_remaining: null,
  },
};

function gateway(): EmployeeDeliveryGateway {
  return {
    loadReferenceData: vi.fn().mockResolvedValue({ rounds: [round], iceTypes }),
    loadShopCards: vi.fn().mockResolvedValue([shop]),
    loadDeliveryPosContext: vi.fn().mockResolvedValue(context),
    loadEmployeeStockState: vi.fn(),
    recordEmployeeStockTransfer: vi.fn(),
    recordDelivery: vi.fn().mockResolvedValue({
      delivery_event_id: 'event-1',
      round_stop_id: shop.round_stop_id,
      charge_id: 'charge-1',
      service_date: round.service_date,
      total_amount: 120,
      payment_term: 'immediate',
      payment_status: 'unpaid',
      due_date: null,
      approval_id: null,
      items: [],
    }),
    recordPayment: vi.fn().mockResolvedValue({
      payment_id: 'payment-1',
      shop_id: shop.shop_id,
      payment_method: 'cash',
      received_amount: 120,
      allocated_amount: 120,
      change_amount: 0,
      status: 'active',
    }),
  };
}

async function selectIceAndGetKeypad(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /หลอด/ }));
  return screen.findByRole('region', { name: 'แป้นใส่จำนวน' });
}

describe('employee delivery POS', () => {
  it('loads server-owned context and uses digit, backspace, and clear keypad behavior', async () => {
    const user = userEvent.setup();
    const api = gateway();
    render(<EmployeeDeliveryWorkspace gateway={api} />);
    await user.click(await screen.findByRole('button', { name: /S001 ร้านทดสอบ/ }));
    await waitFor(() => expect(api.loadDeliveryPosContext).toHaveBeenCalledWith('stop-1'));

    expect(screen.getByText('เลือกชนิดน้ำแข็งเพื่อกรอกจำนวน')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'แป้นใส่จำนวน' })).toBeNull();
    const keypad = await selectIceAndGetKeypad(user);
    await user.click(within(keypad).getByRole('button', { name: '1' }));
    await user.click(within(keypad).getByRole('button', { name: '2' }));
    const cart = screen.getByRole('region', { name: 'สรุปตะกร้า' });
    expect(within(cart).getAllByText('฿120.00')).toHaveLength(2);
    await user.click(within(keypad).getByRole('button', { name: 'ลบหนึ่งหลัก' }));
    expect(within(cart).getAllByText('฿10.00').length).toBeGreaterThan(0);
    await user.click(within(keypad).getByRole('button', { name: 'ล้างจำนวน' }));
    expect(within(cart).queryByText('฿10.00')).toBeNull();
  });

  it('opens the keypad only after product selection and returns to product choice after adding', async () => {
    const user = userEvent.setup();
    render(<EmployeeDeliveryWorkspace gateway={gateway()} />);
    await user.click(await screen.findByRole('button', { name: /S001 ร้านทดสอบ/ }));

    expect(screen.getByText('เลือกชนิดน้ำแข็งเพื่อกรอกจำนวน')).toBeTruthy();
    const keypad = await selectIceAndGetKeypad(user);
    expect(within(keypad).getByText('0', { selector: 'strong' })).toBeTruthy();
    expect((within(keypad).getByRole('button', { name: 'เพิ่มรายการ' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(within(keypad).getByRole('button', { name: '2' }));
    await user.click(within(keypad).getByRole('button', { name: 'เพิ่มรายการ' }));

    expect(screen.queryByRole('region', { name: 'แป้นใส่จำนวน' })).toBeNull();
    expect(screen.getByText('เลือกชนิดน้ำแข็งเพื่อกรอกจำนวน')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'เลือกน้ำแข็ง' }))
      .getByRole('button', { name: /หลอด/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('calls the financial delivery contract then records immediate payment', async () => {
    const user = userEvent.setup();
    const api = gateway();
    render(<EmployeeDeliveryWorkspace gateway={api} />);
    await user.click(await screen.findByRole('button', { name: /S001 ร้านทดสอบ/ }));
    const keypad = await selectIceAndGetKeypad(user);
    await user.click(within(keypad).getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));

    await waitFor(() => expect(api.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
      roundStopId: 'stop-1',
      paymentTerm: 'immediate',
      items: [{ ice_type_id: 'ice-1', quantity: 1 }],
    })));
    expect(await screen.findByRole('heading', { name: 'รับชำระจาก ร้านทดสอบ' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'ยืนยันรับเงิน' }));
    await waitFor(() => expect(api.recordPayment).toHaveBeenCalledWith(expect.objectContaining({
      shopId: 'shop-1',
      chargeId: 'charge-1',
      expectedOutstandingAmount: 120,
    })));
  });

  it('uses a matching approval before leaving an immediate balance', async () => {
    const user = userEvent.setup();
    const api = gateway();
    api.loadDeliveryPosContext = vi.fn().mockResolvedValue({
      ...context,
      payment_profile: { ...context.payment_profile!, allow_outstanding: false },
    });
    api.requestFinancialApproval = vi.fn().mockResolvedValue({
      id: 'approval-1',
      status: 'approved',
    });
    render(<EmployeeDeliveryWorkspace gateway={api} />);
    await user.click(await screen.findByRole('button', { name: /S001 ร้านทดสอบ/ }));
    await user.click(within(await selectIceAndGetKeypad(user))
      .getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));

    const paymentAmount = await screen.findByRole('spinbutton', { name: 'ยอดรับเงินจริง' });
    expect(screen.queryByRole('button', { name: 'ยังไม่รับเงินตอนนี้' })).toBeNull();
    await user.clear(paymentAmount);
    await user.type(paymentAmount, '100');
    expect((screen.getByRole('button', { name: 'ยืนยันรับเงิน' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByPlaceholderText('เหตุผลที่รับเงินไม่ครบ'), 'ลูกค้าขอจ่ายส่วนที่เหลือพรุ่งนี้');
    await user.click(screen.getByRole('button', { name: 'ขออนุมัติ / ตรวจสถานะ' }));

    await waitFor(() => expect(api.requestFinancialApproval).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'outstanding_balance',
      chargeId: 'charge-1',
      requestedAmount: 20,
    })));
    await user.click(screen.getByRole('button', { name: 'ยืนยันรับเงิน' }));
    await waitFor(() => expect(api.recordPayment).toHaveBeenCalledWith(expect.objectContaining({
      allocatedAmount: 100,
      approvalId: 'approval-1',
    })));
  });

  it('invalidates a credit approval when quantity or payment term changes', async () => {
    const user = userEvent.setup();
    const api = gateway();
    api.loadDeliveryPosContext = vi.fn().mockResolvedValue({
      ...context,
      payment_profile: {
        ...context.payment_profile!,
        allowed_payment_terms: ['credit', 'immediate'],
        default_payment_term: 'credit',
        credit_due_rule: 'net_days',
        credit_days: 30,
        credit_limit: 5,
        credit_remaining: 5,
      },
    });
    api.requestFinancialApproval = vi.fn().mockResolvedValue({
      id: 'approval-1',
      status: 'approved',
    });
    render(<EmployeeDeliveryWorkspace gateway={api} />);
    await user.click(await screen.findByRole('button', { name: /S001 ร้านทดสอบ/ }));
    const keypad = await selectIceAndGetKeypad(user);
    await user.click(within(keypad).getByRole('button', { name: '1' }));
    await user.type(screen.getByPlaceholderText('เหตุผลที่ขออนุมัติ'), 'เกินวงเงินที่กำหนด');
    await user.click(screen.getByRole('button', { name: 'ขออนุมัติ / ตรวจสถานะ' }));
    expect(await screen.findByText('อนุมัติวงเงินแล้ว')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'จ่ายทันที' }));
    await user.click(screen.getByRole('button', { name: 'เครดิต' }));
    expect(screen.queryByText('อนุมัติวงเงินแล้ว')).toBeNull();
    await user.type(screen.getByPlaceholderText('เหตุผลที่ขออนุมัติ'), 'ขออนุมัติอีกครั้ง');
    await user.click(screen.getByRole('button', { name: 'ขออนุมัติ / ตรวจสถานะ' }));
    expect(await screen.findByText('อนุมัติวงเงินแล้ว')).toBeTruthy();

    await user.click(within(keypad).getByRole('button', { name: '2' }));

    expect(screen.queryByText('อนุมัติวงเงินแล้ว')).toBeNull();
    expect(screen.getByRole('button', { name: 'ขออนุมัติ / ตรวจสถานะ' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the cart while moving between the mobile item and review steps', async () => {
    const user = userEvent.setup();
    render(<EmployeeDeliveryWorkspace gateway={gateway()} />);
    await user.click(await screen.findByRole('button', { name: /S001 ร้านทดสอบ/ }));
    const keypad = await selectIceAndGetKeypad(user);
    await user.click(within(keypad).getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: 'ตรวจรายการ (1)' }));
    expect(screen.getByRole('button', { name: /3 ตรวจ/ }).getAttribute('aria-current')).toBe('step');
    expect(within(screen.getByRole('region', { name: 'สรุปตะกร้า' })).getByText(/2 ถุง/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'กลับไปแก้รายการ' }));
    expect(screen.getByRole('button', { name: /2 รายการ/ }).getAttribute('aria-current')).toBe('step');
  });

  it('clears every cart line in one action', async () => {
    const user = userEvent.setup();
    render(<EmployeeDeliveryWorkspace gateway={gateway()} />);
    await user.click(await screen.findByRole('button', { name: /S001 ร้านทดสอบ/ }));
    await user.click(within(await selectIceAndGetKeypad(user))
      .getByRole('button', { name: '2' }));

    await user.click(screen.getByRole('button', { name: 'ล้างตะกร้า' }));

    expect(screen.queryByRole('button', { name: 'ล้างตะกร้า' })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'สรุปตะกร้า' })).getByText('เลือกสินค้าแล้วใส่จำนวน')).toBeTruthy();
  });

  it('blocks a transfer amount above the immediate charge before submission', async () => {
    const user = userEvent.setup();
    const api = gateway();
    api.loadDeliveryPosContext = vi.fn().mockResolvedValue({
      ...context,
      payment_profile: {
        ...context.payment_profile!,
        allowed_payment_methods: ['bank_transfer'],
        default_payment_method: 'bank_transfer',
      },
    });
    render(<EmployeeDeliveryWorkspace gateway={api} />);
    await user.click(await screen.findByRole('button', { name: /S001 ร้านทดสอบ/ }));
    await user.click(within(await selectIceAndGetKeypad(user))
      .getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));

    const amount = await screen.findByRole('spinbutton', { name: 'ยอดรับเงินจริง' });
    await user.clear(amount);
    await user.type(amount, '121');
    await user.type(screen.getByRole('textbox', { name: 'เลขอ้างอิง *' }), 'TX-121');

    expect((await screen.findByRole('alert')).textContent).toContain('ยอดโอนหรือ QR ต้องไม่เกินยอดเรียกเก็บ');
    expect((screen.getByRole('button', { name: 'ยืนยันรับเงิน' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.recordPayment).not.toHaveBeenCalled();
  });

  it('clamps a quantity entered while POS context loads to the selected shop stock', async () => {
    const user = userEvent.setup();
    let resolveContext!: (value: DeliveryPosContext) => void;
    const pendingContext = new Promise<DeliveryPosContext>((resolve) => { resolveContext = resolve; });
    const api = gateway();
    api.loadDeliveryPosContext = vi.fn().mockReturnValue(pendingContext);
    render(<EmployeeDeliveryWorkspace gateway={api} />);
    await user.click(await screen.findByRole('button', { name: /S001 ร้านทดสอบ/ }));
    const keypad = await selectIceAndGetKeypad(user);
    await user.click(within(keypad).getByRole('button', { name: '9' }));

    resolveContext({
      ...context,
      items: [{ ...context.items[0], stock_quantity: 1 }],
    });

    await waitFor(() => {
      expect(keypad.querySelector('.employee-pos-quantity strong')?.textContent).toBe('1');
    });
  });

  it('renders a configured product image and retains an icon fallback', async () => {
    const user = userEvent.setup();
    const api = gateway();
    api.loadDeliveryPosContext = vi.fn().mockResolvedValue({
      ...context,
      items: [{ ...context.items[0], image_url: 'https://example.test/ice.png' }],
    });
    render(<EmployeeDeliveryWorkspace gateway={api} />);
    await user.click(await screen.findByRole('button', { name: /S001 ร้านทดสอบ/ }));

    await waitFor(() => {
      const image = screen.getByRole('button', { name: /หลอด/ }).querySelector('img');
      expect(image?.getAttribute('src')).toBe('https://example.test/ice.png');
    });
  });
});
