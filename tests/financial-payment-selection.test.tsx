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
