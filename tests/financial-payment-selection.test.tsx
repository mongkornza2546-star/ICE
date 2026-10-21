import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({
  loadQueue: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  storage: { from: vi.fn() },
}));

vi.mock('../src/lib/supabase', () => ({ supabase: supabaseMock }));

vi.mock('../src/lib/collectionQueue', () => ({ loadCurrentCollectionQueue: supabaseMock.loadQueue }));

import { publishDataChange } from '../src/lib/dataChange';
import { toBangkokDateString, shiftServiceDate } from '../src/lib/serviceDate';
import { FinancialOperations } from '../src/FinancialOperations';
import type { QueueShop } from '../src/features/financial-operations/types';

const serviceDate = '2026-09-30';
const shop: QueueShop = {
  shop_id: '20000000-0000-4000-8000-000000000001',
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
      charge_id: '10000000-0000-4000-8000-000000000001',
      charge_number: 'INV-OLD',
      service_date: '2026-09-29',
      payment_term: 'credit',
      due_date: '2026-09-29',
      original_amount: 50,
      outstanding_amount: 50,
      items: [],
    },
    {
      charge_id: '10000000-0000-4000-8000-000000000002',
      charge_number: 'INV-TODAY',
      service_date: serviceDate,
      payment_term: 'immediate',
      original_amount: 75,
      outstanding_amount: 75,
      items: [],
    },
  ],
};

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  supabaseMock.rpc.mockResolvedValue({
    data: {
      payment_id: '30000000-0000-4000-8000-000000000001',
      receipt_number: 'REC-001',
      recorded_at: '2026-09-30T08:00:00+07:00',
      allocated_amount: 75,
      change_amount: 25,
    },
    error: null,
  });
});

function renderFinancialOperations() {
  return render(<FinancialOperations
    demoData={{
      serviceDate,
      runId: '40000000-0000-4000-8000-000000000001',
      queue: [shop],
      paymentHistory: [],
    }}
    userRole="round_lead"
  />);
}

it.each(['admin', 'courier'] as const)('shows closed-day debt and disables payment for %s', async (role) => {
  // Load the manager's lazy bundle before starting Testing Library's DOM timeout.
  if (role === 'admin') await import('../src/features/financial-operations/FinancialManagerWorkspace');
  supabaseMock.loadQueue.mockResolvedValue({ runId: null, isClosed: true, queue: [shop] });
  supabaseMock.rpc.mockResolvedValue({ data: [], error: null });
  render(<FinancialOperations userRole={role} serviceDate={serviceDate} />);
  const shopButton = await screen.findByRole('button', { name: /S001.*ร้านทดสอบ/ });
  expect(screen.getByText('ปิดรอบแล้ว ยังดูร้านค้าและยอดค้างชำระได้ แต่บันทึกรับเงินในวันนี้ไม่ได้')).toBeTruthy();
  fireEvent.click(shopButton);
  const record = await screen.findByRole('button', { name: 'บันทึกรับเงินทันที' });
  expect(record.hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('ปิดรอบแล้ว ดูยอดค้างได้ แต่บันทึกรับเงินในวันนี้ไม่ได้')).toBeTruthy();
});

it('keeps the selected shop visible when a refresh discovers that the day has closed', async () => {
  supabaseMock.loadQueue.mockResolvedValue({ runId: 'run-1', isClosed: false, queue: [shop] });
  supabaseMock.rpc.mockResolvedValue({ data: [], error: null });
  render(<FinancialOperations userRole="courier" serviceDate={serviceDate} />);
  fireEvent.click(await screen.findByRole('button', { name: /S001.*ร้านทดสอบ/ }));
  expect((await screen.findByRole('button', { name: 'บันทึกรับเงินทันที' })).hasAttribute('disabled')).toBe(false);
  supabaseMock.loadQueue.mockResolvedValue({ runId: null, isClosed: true, queue: [shop] });
  await act(async () => { publishDataChange(['payment']); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }).hasAttribute('disabled')).toBe(true));
  expect(screen.getByRole('button', { name: /S001.*ร้านทดสอบ/ })).toBeTruthy();
});

it('records only today selected bill while keeping expected outstanding for the whole shop', async () => {
  renderFinancialOperations();

  expect((screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement).value).toBe('125.00');
  fireEvent.click(screen.getByRole('button', { name: 'เฉพาะบิลวันนี้' }));
  expect((screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement).value).toBe('75.00');
  fireEvent.click(screen.getByRole('button', { name: '100' }));
  expect(screen.getByText('เงินทอน').parentElement?.textContent).toContain('฿25.00');
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));

  await waitFor(() => expect(supabaseMock.rpc).toHaveBeenCalledWith('record_regular_collection_payment', expect.objectContaining({
    p_allocations: [{
      charge_id: '10000000-0000-4000-8000-000000000002',
      amount: 75,
    }],
    p_expected_outstanding_amount: 125,
    p_received_amount: 100,
  })));
  expect(await screen.findByText('บันทึกรับเงินเรียบร้อย')).not.toBeNull();
});

it('shows statement membership and submits selected billed and unbilled charges in one payment', async () => {
  const unified: QueueShop = {
    ...shop, collection_scope: 'shop',
    charges: [{ ...shop.charges[0], billing_statement_id: 'statement-1', billing_statement_number: 'BIL2610-00004' }, shop.charges[1]],
  };
  supabaseMock.loadQueue.mockResolvedValue({ runId: 'run-1', queue: [unified] });
  render(<FinancialOperations userRole="courier" serviceDate={serviceDate}
    focusRequest={{ requestId: 'unified-1', source: 'pos-shortcut', shopId: shop.shop_id, queueKey: `regular:${shop.shop_id}` }} />);
  expect(await screen.findByText('ใบวางบิล BIL2610-00004')).not.toBeNull();
  expect(screen.getAllByRole('checkbox', { name: /เลือกบิล INV/ })).toHaveLength(1);
  expect(screen.getByRole('checkbox', { name: 'เลือกใบวางบิล BIL2610-00004' })).toBeTruthy();
  expect((screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement).value).toBe('125.00');
  fireEvent.click(screen.getByRole('checkbox', { name: 'เลือกบิล INV-TODAY' }));
  expect((screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement).value).toBe('50.00');
  fireEvent.click(screen.getByRole('button', { name: 'เลือกทั้งหมด' }));
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));
  await waitFor(() => expect(supabaseMock.rpc).toHaveBeenCalledWith('record_shop_collection_payment', expect.objectContaining({
    p_allocations: [{ charge_id: shop.charges[0].charge_id, amount: 50 }, { charge_id: shop.charges[1].charge_id, amount: 75 }],
    p_expected_outstanding_amount: 125, p_received_amount: 125,
  })));
  expect(await screen.findByText('บันทึกรับเงินเรียบร้อย')).not.toBeNull();
});

it('supports old-only, multiple, all, and empty bill selections', () => {
  renderFinancialOperations();
  const amount = screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement;
  const record = screen.getByRole('button', { name: 'บันทึกรับเงินทันที' });

  fireEvent.click(screen.getByRole('button', { name: 'ล้างการเลือก' }));
  expect(amount.value).toBe('0.00');
  expect(record.hasAttribute('disabled')).toBe(true);

  fireEvent.click(screen.getByRole('checkbox', { name: 'เลือกบิล INV-OLD' }));
  expect(amount.value).toBe('50.00');
  fireEvent.click(screen.getByRole('checkbox', { name: 'เลือกบิล INV-TODAY' }));
  expect(amount.value).toBe('125.00');

  fireEvent.click(screen.getByRole('button', { name: 'เฉพาะบิลวันนี้' }));
  expect(amount.value).toBe('75.00');
  fireEvent.click(screen.getByRole('button', { name: 'เลือกทั้งหมด' }));
  expect(amount.value).toBe('125.00');
});

it('prevents transfer above the selected bill total', () => {
  renderFinancialOperations();
  fireEvent.click(screen.getByRole('button', { name: 'เฉพาะบิลวันนี้' }));
  fireEvent.click(screen.getByRole('button', { name: 'โอนเงิน' }));
  const amount = screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' });
  const record = screen.getByRole('button', { name: 'บันทึกรับเงินทันที' });

  fireEvent.change(amount, { target: { value: '100.00' } });
  expect(record.hasAttribute('disabled')).toBe(true);
  fireEvent.change(amount, { target: { value: '75.00' } });
  expect(record.hasAttribute('disabled')).toBe(false);
});

it('accepts an exact decimal transfer and rejects one satang over', async () => {
  const decimalShop = {
    ...shop,
    outstanding_amount: 30.60,
    charges: shop.charges.map((charge, index) => ({ ...charge, outstanding_amount: [10.20, 20.40][index] })),
  };
  render(<FinancialOperations
    userRole="round_lead"
    demoData={{ serviceDate, runId: 'run-1', queue: [decimalShop], paymentHistory: [] }}
  />);
  expect(screen.queryByRole('button', { name: 'QR', exact: true })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'โอนเงิน', exact: true }));
  const amount = screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement;
  const record = screen.getByRole('button', { name: 'บันทึกรับเงินทันที' });
  expect(amount.value).toBe('30.60');
  expect(record.hasAttribute('disabled')).toBe(false);
  fireEvent.change(amount, { target: { value: '30.61' } });
  expect(record.hasAttribute('disabled')).toBe(true);
  fireEvent.change(amount, { target: { value: '30.60' } });
  fireEvent.click(record);
  await waitFor(() => expect(supabaseMock.rpc).toHaveBeenCalledWith('record_regular_collection_payment', expect.objectContaining({
    p_allocations: [
      { charge_id: shop.charges[0].charge_id, amount: 10.20 },
      { charge_id: shop.charges[1].charge_id, amount: 20.40 },
    ],
    p_received_amount: 30.60,
    p_expected_outstanding_amount: 30.60,
  })));
});

it('keeps refreshed balances blocked through selection changes until explicitly acknowledged', async () => {
  supabaseMock.loadQueue.mockResolvedValue({ runId: 'run-1', queue: [shop] });
  render(<FinancialOperations
    userRole="courier"
    serviceDate={serviceDate}
    focusRequest={{ requestId: 'review-1', source: 'pos-shortcut', shopId: shop.shop_id, queueKey: `regular:${shop.shop_id}` }}
  />);
  const record = await screen.findByRole('button', { name: 'บันทึกรับเงินทันที' });
  await act(async () => {});
  const updatedShop = {
    ...shop,
    outstanding_amount: 120,
    charges: shop.charges.map((charge, index) => index === 1 ? { ...charge, outstanding_amount: 70 } : charge),
  };
  supabaseMock.loadQueue.mockResolvedValue({ runId: 'run-1', queue: [updatedShop] });
  act(() => publishDataChange(['payment']));
  await screen.findByRole('button', { name: 'ตรวจสอบแล้ว' });
  expect(record.hasAttribute('disabled')).toBe(true);
  for (const name of ['เลือกทั้งหมด', 'เฉพาะบิลวันนี้', 'ล้างการเลือก']) {
    fireEvent.click(screen.getByRole('button', { name }));
    expect(record.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'ตรวจสอบแล้ว' })).not.toBeNull();
  }
  fireEvent.click(screen.getByRole('checkbox', { name: 'เลือกบิล INV-TODAY' }));
  expect(record.hasAttribute('disabled')).toBe(true);
  expect((screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement).value).toBe('70.00');
  fireEvent.click(screen.getByRole('button', { name: 'ตรวจสอบแล้ว' }));
  expect(record.hasAttribute('disabled')).toBe(false);
  expect(screen.queryByRole('button', { name: 'ตรวจสอบแล้ว' })).toBeNull();
});

it.each([
  { role: 'courier', fullyPaid: false, runId: 'run-1' },
  { role: 'courier', fullyPaid: true, runId: 'run-1' },
  { role: 'courier', fullyPaid: true, runId: null },
  { role: 'admin', fullyPaid: false, runId: 'run-1' },
  { role: 'admin', fullyPaid: true, runId: 'run-1' },
  { role: 'admin', fullyPaid: true, runId: null },
] as const)('returns to POS after receipt-time refresh ($role, fully paid: $fullyPaid, run: $runId)', async ({ role, fullyPaid, runId }) => {
  const onFocusedCollectionClose = vi.fn();
  supabaseMock.rpc.mockResolvedValue({ data: {
    payment_id: '30000000-0000-4000-8000-000000000001',
    receipt_number: 'REC-001', recorded_at: '2026-09-30T08:00:00+07:00',
    allocated_amount: fullyPaid ? 125 : 75, change_amount: 0,
  }, error: null });
  supabaseMock.loadQueue.mockResolvedValue({ runId: 'run-1', queue: [shop] });
  render(<FinancialOperations
    userRole={role}
    serviceDate={serviceDate}
    focusRequest={{ requestId: 'return-1', source: 'pos-shortcut', shopId: shop.shop_id, queueKey: `regular:${shop.shop_id}` }}
    onFocusedCollectionClose={onFocusedCollectionClose}
  />);
  await screen.findByRole('button', { name: 'บันทึกรับเงินทันที' });
  await act(async () => {});
  if (!fullyPaid) fireEvent.click(screen.getByRole('button', { name: 'เฉพาะบิลวันนี้' }));
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));
  await screen.findByText('บันทึกรับเงินเรียบร้อย');

  // Another payment update (or the manager's foreground refresh after printing)
  // removes settled charges from the live queue while the receipt is open.
  supabaseMock.loadQueue.mockResolvedValue({ runId, queue: fullyPaid ? [] : [{
    ...shop, outstanding_amount: 50, charge_count: 1, charges: [shop.charges[0]],
  }] });
  supabaseMock.loadQueue.mockClear();
  await act(async () => {
    if (role === 'admin') window.dispatchEvent(new Event('focus'));
    else publishDataChange(['payment']);
  });
  await waitFor(() => expect(supabaseMock.loadQueue).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'เสร็จสิ้น' }));
  expect(onFocusedCollectionClose).toHaveBeenCalledWith({
    status: 'completed', requestId: 'return-1', shopId: shop.shop_id,
    paymentId: '30000000-0000-4000-8000-000000000001',
  });
});

it('opens a new POS collection request after leaving an unclosed receipt', async () => {
  const firstRequest = {
    requestId: 'first', source: 'pos-shortcut' as const,
    shopId: shop.shop_id, queueKey: `regular:${shop.shop_id}`,
  };
  const nextShop = { ...shop, shop_id: 'next-shop', shop_code: 'S002', shop_name: 'ร้านถัดไป' };
  supabaseMock.loadQueue.mockResolvedValue({ runId: 'run-1', queue: [shop, nextShop] });
  const view = render(<FinancialOperations userRole="courier" serviceDate={serviceDate} focusRequest={firstRequest} />);
  fireEvent.click(await screen.findByRole('button', { name: 'บันทึกรับเงินทันที' }));
  await screen.findByText('บันทึกรับเงินเรียบร้อย');
  view.rerender(<FinancialOperations userRole="courier" serviceDate={serviceDate} focusRequest={null} isActive={false} />);
  view.rerender(<FinancialOperations userRole="courier" serviceDate={serviceDate} focusRequest={{
    ...firstRequest, requestId: 'next', shopId: nextShop.shop_id, queueKey: `regular:${nextShop.shop_id}`,
  }} />);
  expect(await screen.findByRole('dialog', { name: /รับเงิน S002/ })).not.toBeNull();
  expect(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' })).not.toBeNull();
  expect(screen.queryByText('บันทึกรับเงินเรียบร้อย')).toBeNull();
});


it('allows only admins to edit the received date and uses Bangkok today rather than the selected service day', () => {
  const props = { demoData: { serviceDate, runId: 'run-1', queue: [shop], paymentHistory: [] } };
  const view = render(<FinancialOperations {...props} userRole="admin" />);
  const date = screen.getByLabelText('วันที่รับเงิน') as HTMLInputElement;
  expect(date.type).toBe('date');
  expect(date.value).toBe(toBangkokDateString());
  expect(date.max).toBe(toBangkokDateString());
  for (const role of ['round_lead', 'courier'] as const) {
    view.rerender(<FinancialOperations {...props} userRole={role} />);
    expect(screen.queryByLabelText('วันที่รับเงิน')).toBeNull();
  }
});

it.each([
  { kind: 'record_shop_collection_payment', extra: { collection_scope: 'shop' as const } },
  { kind: 'record_regular_collection_payment', extra: {} },
  { kind: 'record_billing_statement_payment', extra: { billing_statement_id: 'statement-1' } },
  { kind: 'record_event_payment', extra: {
    destination_kind: 'event' as const, event_settlement_context_id: 'context-1',
    event_participation_id: 'participation-1', settlement_service_date: serviceDate,
    settlement_policy_fingerprint: 'policy-1',
  } },
])('submits the received date through the admin API for $kind', async ({ kind, extra }) => {
  render(<FinancialOperations userRole="admin" demoData={{
    serviceDate, runId: 'run-1', queue: [{ ...shop, ...extra }], paymentHistory: [],
  }} />);
  const yesterday = shiftServiceDate(toBangkokDateString(), -1);
  fireEvent.change(screen.getByLabelText('วันที่รับเงิน'), { target: { value: yesterday } });
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));
  await waitFor(() => expect(supabaseMock.rpc).toHaveBeenCalledWith('record_backdated_collection_payment', {
    p_payment_kind: kind, p_received_date: yesterday,
    p_payment_args: expect.objectContaining({ p_received_amount: 125, p_collection_run_id: 'run-1' }),
  }));
  expect(await screen.findByText('บันทึกรับเงินเรียบร้อย')).not.toBeNull();
});

it('blocks empty and future received dates and still requires a slip on a backdated transfer', () => {
  render(<FinancialOperations userRole="admin" demoData={{ serviceDate, runId: 'run-1', queue: [{
    ...shop, payment_profile: { ...shop.payment_profile, bank_transfer_evidence_required: true },
  }], paymentHistory: [] }} />);
  const date = screen.getByLabelText('วันที่รับเงิน');
  const record = screen.getByRole('button', { name: 'บันทึกรับเงินทันที' });
  for (const value of ['', shiftServiceDate(toBangkokDateString(), 1)]) {
    fireEvent.change(date, { target: { value } });
    expect(record.hasAttribute('disabled')).toBe(true);
    fireEvent.click(record);
  }
  expect(supabaseMock.rpc).not.toHaveBeenCalled();
  fireEvent.change(date, { target: { value: shiftServiceDate(toBangkokDateString(), -1) } });
  expect(record.hasAttribute('disabled')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'โอนเงิน', exact: true }));
  expect(record.hasAttribute('disabled')).toBe(true);
});

it('still opens cancellation for an unpaid delivery from the collection queue', async () => {
  supabaseMock.rpc.mockImplementation(async (name: string) => ({
    data: name === 'get_delivery_correction_route' ? { destination_kind: 'regular' } : {
      delivery_event_id: 'unpaid-delivery', charge_id: shop.charges[0].charge_id,
      charge_number: 'INV-OLD', shop_name: shop.shop_name, payment_term: 'credit',
      round_status: 'open', day_closed: false, effective_amount: 50, allocated_amount: 0,
      can_cancel: true, items: [],
    }, error: null,
  }));
  render(<FinancialOperations userRole="admin" demoData={{ serviceDate, runId: 'run-1', queue: [{
    ...shop, charges: [{ ...shop.charges[0], delivery_event_id: 'unpaid-delivery' }],
  }], paymentHistory: [] }} />);
  const detailToggle = screen.queryByRole('button', { name: 'ดูรายละเอียดบิลส่งของ INV-OLD' });
  if (detailToggle?.getAttribute('aria-expanded') === 'false') fireEvent.click(detailToggle);
  fireEvent.click(screen.getByRole('button', { name: 'ยกเลิกใบส่งน้ำแข็ง INV-OLD' }));
  expect(await screen.findByRole('button', { name: 'ยืนยันยกเลิกใบส่งน้ำแข็ง' })).toBeTruthy();
  expect(supabaseMock.rpc).toHaveBeenCalledWith('get_delivery_correction_route', { p_event_id: 'unpaid-delivery' });
});

it.each([
  { lastBill: false, refreshAlreadyRunning: true, saveFails: false, refreshFails: false },
  { lastBill: true, refreshAlreadyRunning: true, saveFails: false, refreshFails: false },
  { lastBill: false, refreshAlreadyRunning: false, saveFails: false, refreshFails: false },
  { lastBill: false, refreshAlreadyRunning: true, saveFails: true, refreshFails: false },
  { lastBill: false, refreshAlreadyRunning: true, saveFails: false, refreshFails: true },
])('reconciles cancellation without waiting for a slow queue: %j', async ({ lastBill, refreshAlreadyRunning, saveFails, refreshFails }) => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const cancellableShop = {
    ...shop,
    outstanding_amount: lastBill ? 50 : 125,
    charge_count: lastBill ? 1 : 2,
    charges: (lastBill ? shop.charges.slice(0, 1) : shop.charges).map((charge, index) => ({
      ...charge, delivery_event_id: `delivery-${index}`,
    })),
  };
  let confirmCancellation!: (value: { data: null; error: Error | null }) => void;
  const cancellation = new Promise<{ data: null; error: Error | null }>((resolve) => { confirmCancellation = resolve; });
  supabaseMock.rpc.mockImplementation(async (name: string) => {
    if (name === 'apply_open_delivery_correction') return cancellation;
    if (name === 'get_delivery_correction_route') return { data: { destination_kind: 'regular' }, error: null };
    if (name === 'get_payment_history') return { data: { items: [] }, error: null };
    return { data: {
      delivery_event_id: 'delivery-0', charge_id: shop.charges[0].charge_id,
      charge_number: 'INV-OLD', shop_name: shop.shop_name, payment_term: 'credit',
      round_status: 'open', day_closed: false, effective_amount: 50, allocated_amount: 0,
      can_cancel: true, items: [],
    }, error: null };
  });
  supabaseMock.loadQueue.mockResolvedValue({ runId: 'run-1', queue: [cancellableShop] });
  render(<FinancialOperations userRole="admin" serviceDate={serviceDate} focusRequest={{
    requestId: 'cancel-slow', source: 'pos-shortcut', shopId: shop.shop_id, queueKey: `regular:${shop.shop_id}`,
  }} />);
  await screen.findByRole('checkbox', { name: 'เลือกบิล INV-OLD' });
  await act(async () => {});

  // Hold an already-running refresh, then return its pre-cancellation snapshot.
  let finishRefresh!: (value: { runId: string; queue: QueueShop[] }) => void;
  let rejectRefresh!: (error: Error) => void;
  supabaseMock.loadQueue.mockImplementation(() => new Promise((resolve, reject) => {
    finishRefresh = resolve;
    rejectRefresh = reject;
  }));
  if (refreshAlreadyRunning) act(() => publishDataChange(['payment']));
  const detailToggle = screen.queryByRole('button', { name: 'ดูรายละเอียดบิลส่งของ INV-OLD' });
  if (detailToggle?.getAttribute('aria-expanded') === 'false') fireEvent.click(detailToggle);
  fireEvent.click(screen.getByRole('button', { name: 'ยกเลิกใบส่งน้ำแข็ง INV-OLD' }));
  await screen.findByRole('button', { name: 'ยืนยันยกเลิกใบส่งน้ำแข็ง' });
  fireEvent.change(screen.getByLabelText('เหตุผล'), { target: { value: 'ส่งซ้ำ' } });
  fireEvent.click(screen.getByRole('button', { name: 'ยืนยันยกเลิกใบส่งน้ำแข็ง' }));
  expect(screen.getByRole('checkbox', { name: 'เลือกบิล INV-OLD' })).toBeTruthy();

  await act(async () => { confirmCancellation({ data: null, error: saveFails ? new Error('ยกเลิกไม่สำเร็จ') : null }); });
  if (saveFails) {
    expect(screen.getByText('ยกเลิกไม่สำเร็จ')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'เลือกบิล INV-OLD' })).toBeTruthy();
    expect((screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement).value).toBe('125.00');
    await act(async () => { finishRefresh({ runId: 'run-1', queue: [cancellableShop] }); });
    expect(screen.getByRole('checkbox', { name: 'เลือกบิล INV-OLD' })).toBeTruthy();
    return;
  }
  expect(screen.queryByRole('checkbox', { name: 'เลือกบิล INV-OLD' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'ยืนยันยกเลิกใบส่งน้ำแข็ง' })).toBeNull();
  if (lastBill) {
    expect(screen.queryByRole('button', { name: 'บันทึกรับเงินทันที' })).toBeNull();
  } else {
    expect((screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement).value).toBe('75.00');
    expect(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'ตรวจสอบแล้ว' })).toBeTruthy();
  }

  await act(async () => {
    if (refreshFails) rejectRefresh(new Error('โหลดคิวไม่สำเร็จ'));
    else finishRefresh({ runId: 'run-1', queue: [cancellableShop] });
  });
  expect(screen.queryByRole('checkbox', { name: 'เลือกบิล INV-OLD' })).toBeNull();
  if (!lastBill) {
    expect((screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement).value).toBe('75.00');
  }
});

it('selects whole statements, keeps unbilled invoices separate, and allocates a partial payment only inside the selected statement', async () => {
  const billed = shop.charges.map((charge) => ({ ...charge, billing_statement_id: 'statement-1', billing_statement_number: 'BIL-001' }));
  const otherStatement = { ...shop.charges[0], charge_id: 'other-statement', charge_number: 'INV-OTHER', outstanding_amount: 60, billing_statement_id: 'statement-2', billing_statement_number: 'BIL-002' };
  const unbilled = { ...shop.charges[1], charge_id: 'unbilled', charge_number: 'INV-UNBILLED', outstanding_amount: 20 };
  const groupedShop: QueueShop = { ...shop, collection_scope: 'shop', outstanding_amount: 205, charge_count: 4,
    charges: [billed[0], otherStatement, billed[1], unbilled] };
  render(<FinancialOperations userRole="round_lead" demoData={{ serviceDate, runId: 'run-1', queue: [groupedShop], paymentHistory: [] }} />);
  const amount = screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement;
  expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  expect(screen.getByText('เลือกแล้ว 3 จาก 3 บิล')).toBeTruthy();
  expect(screen.queryByRole('checkbox', { name: 'เลือกบิล INV-OLD' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'เลือกบิล INV-TODAY' })).toBeNull();
  const statement = screen.getByRole('checkbox', { name: 'เลือกใบวางบิล BIL-001' }) as HTMLInputElement;
  expect(statement.closest('article')?.textContent).toContain('฿125.00');
  fireEvent.click(statement);
  expect(amount.value).toBe('80.00');
  fireEvent.click(statement);
  expect(amount.value).toBe('205.00');
  fireEvent.click(screen.getByRole('button', { name: 'เฉพาะบิลวันนี้' }));
  expect(amount.value).toBe('20.00');
  expect(statement.checked).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'ล้างการเลือก' }));
  fireEvent.click(statement);
  expect(amount.value).toBe('125.00');
  expect(screen.getByText('เลือกแล้ว 1 จาก 3 บิล')).toBeTruthy();
  fireEvent.change(amount, { target: { value: '60' } });
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));
  await waitFor(() => expect(supabaseMock.rpc).toHaveBeenCalledWith('record_shop_collection_payment', expect.objectContaining({
    p_allocations: [{ charge_id: billed[0].charge_id, amount: 50 }, { charge_id: billed[1].charge_id, amount: 10 }],
    p_expected_outstanding_amount: 205, p_received_amount: 60,
  })));
});

it('requires review and selects the whole statement when refreshed invoices become grouped', async () => {
  supabaseMock.loadQueue.mockResolvedValue({ runId: 'run-1', queue: [shop] });
  render(<FinancialOperations userRole="courier" serviceDate={serviceDate}
    focusRequest={{ requestId: 'group-refresh', source: 'pos-shortcut', shopId: shop.shop_id, queueKey: `regular:${shop.shop_id}` }} />);
  await screen.findByRole('button', { name: 'บันทึกรับเงินทันที' });
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'เฉพาะบิลวันนี้' }));
  supabaseMock.loadQueue.mockResolvedValue({ runId: 'run-1', queue: [{ ...shop, collection_scope: 'shop',
    charges: shop.charges.map((charge) => ({ ...charge, billing_statement_id: 'statement-1', billing_statement_number: 'BIL-001' })),
  }] });
  act(() => publishDataChange(['receivable']));
  await screen.findByRole('button', { name: 'ตรวจสอบแล้ว' });
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  expect((screen.getByRole('checkbox', { name: 'เลือกใบวางบิล BIL-001' }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement).value).toBe('125.00');
  expect(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }).hasAttribute('disabled')).toBe(true);
});

it('requests a due-date extension for the chosen invoice inside a statement without changing the payment draft', async () => {
  const groupedShop: QueueShop = { ...shop, collection_scope: 'shop',
    charges: shop.charges.map((charge) => ({ ...charge, payment_term: 'credit', due_date: serviceDate,
      billing_statement_id: 'statement-1', billing_statement_number: 'BIL-001' })),
  };
  const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('2026-10-15').mockReturnValueOnce('ขอขยายเวลา');
  try {
    render(<FinancialOperations userRole="round_lead" demoData={{ serviceDate, runId: 'run-1', queue: [groupedShop], paymentHistory: [] }} />);
    const amount = screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement;
    fireEvent.change(amount, { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'ดูรายละเอียดใบวางบิล BIL-001' }));
    fireEvent.click(screen.getByRole('button', { name: 'ขอเลื่อนกำหนดบิล INV-TODAY' }));
    await screen.findByText('ส่งคำขอเลื่อนกำหนดชำระแล้ว');
    expect(supabaseMock.rpc).toHaveBeenCalledExactlyOnceWith('request_credit_due_date_change', {
      p_charge_id: groupedShop.charges[1].charge_id,
      p_requested_due_date: '2026-10-15',
      p_reason: 'ขอขยายเวลา',
    });
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect((screen.getByRole('checkbox', { name: 'เลือกใบวางบิล BIL-001' }) as HTMLInputElement).checked).toBe(true);
    expect(amount.value).toBe('60');
  } finally {
    prompt.mockRestore();
  }
});
