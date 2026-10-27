import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { EmployeeDeliveryWorkspace, type EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';
import { FinancialOperations } from '../src/FinancialOperations';
import type { QueueShop } from '../src/features/financial-operations/types';
import type { ShopCard, CollectionCloseResult, CollectionFocusRequest } from '../src/types/app';
const api = vi.hoisted(() => {
  const channel = { on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() };
  return { loadQueue: vi.fn(), rpc: vi.fn(), channel: vi.fn(() => channel), removeChannel: vi.fn() };
});
vi.mock('../src/lib/supabase', () => ({ supabase: api }));
vi.mock('../src/lib/collectionQueue', () => ({ loadCurrentCollectionQueue: api.loadQueue }));
beforeEach(() => {
  api.rpc.mockReset().mockResolvedValue({ data: { items: [] }, error: null });
  api.loadQueue.mockReset().mockResolvedValue({ runId: 'run', queue: [], isClosed: false });
});
const date = '2026-10-27';
const card: ShopCard = {
  destination_kind: 'event', round_stop_id: 'stop', shop_id: 'shop', shop_code: 'EV-1', shop_name: 'บูธ B1',
  building_id: 'event', building_name: 'เกษตร', floor_or_zone: '', sequence_no: 1,
  image_path: null, image_url: null, payment_status: 'unpaid', stop_status: 'delivered', stop_note: null,
  today_history: [], today_totals: {}, event_job_id: 'event', event_participation_id: 'participation',
  event_name: 'เกษตร', event_location: '', booth_number: 'B1', event_delivery_enabled: true, is_operational: true,
};
function row(id: string, amount: number, serviceDate: string): QueueShop {
  return {
    queue_key: `event:${id}`, destination_kind: 'event', shop_id: 'shop', shop_code: 'EV-1', shop_name: 'บูธ B1',
    image_path: null, outstanding_amount: amount, charge_count: 1, has_new_charges: false,
    event_participation_id: 'participation', event_settlement_context_id: id,
    event_name: 'เกษตร', event_booth: 'B1', settlement_service_date: serviceDate,
    payment_profile: { allowed_payment_methods: ['cash'], default_payment_method: 'cash',
      cash_reference_required: false, cash_evidence_required: false, bank_transfer_reference_required: false,
      bank_transfer_evidence_required: false, qr_reference_required: false, qr_evidence_required: false },
    charges: [{ charge_id: `charge-${id}`, charge_number: `INV-${id}`, service_date: serviceDate,
      original_amount: amount, outstanding_amount: amount, items: [] }],
  };
}
function gateway(queue: QueueShop[], override: Partial<ShopCard> = {}): EmployeeDeliveryGateway {
  return {
    loadReferenceData: vi.fn().mockResolvedValue({ rounds: [{ id: 'round', service_date: date, name: 'รอบ', status: 'open', opened_at: date }], iceTypes: [{ id: 'ice', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }] }),
    loadShopCards: vi.fn().mockResolvedValue([{ ...card, ...override }]),
    loadCollectionOutstanding: vi.fn().mockResolvedValue(queue.map(q => ({ queueKey: q.queue_key!, shopId: q.shop_id, eventParticipationId: q.event_participation_id, outstandingAmount: q.outstanding_amount }))),
    loadEmployeeStockState: vi.fn(), recordEmployeeStockTransfer: vi.fn(), recordEmployeeStockReturn: vi.fn(),
    recordEmployeeStockDamage: vi.fn(), recordDelivery: vi.fn(), recordImmediateSale: vi.fn(),
  };
}
it.each([false, true])('shows every event settlement before choosing a payment date (reversed: %s)', async reversed => {
  const queue = [row('old', 100.25, '2026-10-26'), row('new', 60.5, date)];
  if (reversed) queue.reverse();
  const gw = gateway(queue);
  function Harness() {
    const [request, setRequest] = useState<CollectionFocusRequest | null>(null);
    return request ? <FinancialOperations userRole="courier" canCollectShopPayments focusRequest={request}
      demoData={{ serviceDate: date, runId: 'run', queue, paymentHistory: [] }} />
      : <EmployeeDeliveryWorkspace gateway={gw} serviceDate={date} canCollectShopPayments onOpenCollection={setRequest} />;
  }
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(await screen.findByRole('button', { name: 'อีเว้น', exact: true }));
  expect(screen.getByText('ยอดรอรับชำระ ฿160.75')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /^เลือกร้าน บูธ B1/ }));
  expect(screen.getByText('ยอดรอรับชำระ').parentElement?.textContent).toContain('160.75');
  await user.click(screen.getByRole('button', { name: 'รับชำระ', exact: true }));
  const scope = await screen.findByRole('region', { name: 'บิลค้างของบูธ' });
  expect(within(scope).getByText(/ยอดรอรับชำระทั้งหมด/).textContent).toContain('160.75');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(within(scope).getByRole('button', { name: /INV-old/ })).toBeTruthy();
  expect(within(scope).getByRole('button', { name: /INV-new/ })).toBeTruthy();
  await user.click(within(scope).getByRole('button', { name: /INV-new/ }));
  const payment = await screen.findByRole('dialog');
  const received = within(payment).getByLabelText('ยอดรับเงินจริง') as HTMLInputElement;
  expect(received.value).toBe('60.50');
  expect(within(payment).queryByText('INV-old')).toBeNull();
  fireEvent.change(received, { target: { value: '60.50' } });
  expect(within(payment).getByText('เงินทอน').parentElement?.textContent).toContain('0.00');
});
it.each([{ event_delivery_enabled: false }, { is_operational: false }])('allows collecting debt when sending is disabled (%j)', async disabled => {
  const user = userEvent.setup();
  const onOpenCollection = vi.fn();
  const gw = gateway([row('old', 100.25, '2026-10-26')], { ...disabled, stop_status: 'pending' });
  render(<EmployeeDeliveryWorkspace gateway={gw} serviceDate={date} canCollectShopPayments onOpenCollection={onOpenCollection} />);
  await user.click(await screen.findByRole('button', { name: 'อีเว้น', exact: true }));
  expect(screen.getByText('ยอดรอรับชำระ ฿100.25')).toBeTruthy();
  const booth = screen.getByRole('button', { name: /^เลือกร้าน บูธ B1/ });
  expect(booth.hasAttribute('disabled')).toBe(false);
  await user.click(booth);
  expect(screen.getByRole('button', { name: 'ส่งเพิ่ม', exact: true }).hasAttribute('disabled')).toBe(true);
  await user.click(screen.getByRole('button', { name: 'รับชำระ', exact: true }));
  expect(onOpenCollection).toHaveBeenCalledWith(expect.objectContaining({ eventParticipationId: 'participation' }));
});


it.each(['courier', 'admin'] as const)('refreshes all contexts for the requested booth only (%s)', async userRole => {
  const target = [row('old', 100.25, '2026-10-26'), row('new', 60.5, date)];
  api.loadQueue.mockResolvedValue({ runId: 'run', queue: [
    { ...row('regular', 800, date), destination_kind: 'regular', event_participation_id: null },
    { ...row('other-booth', 900, date), event_participation_id: 'other-participation' },
    { ...row('other-shop', 1000, date), shop_id: 'other-shop' },
    ...target,
  ] });
  const onClose = vi.fn();
  render(<FinancialOperations userRole={userRole} serviceDate={date}
    focusRequest={{ requestId: 'scope-1', source: 'pos-shortcut', shopId: 'shop',
      queueKey: 'event-participation:participation', eventParticipationId: 'participation', returnContextId: 'scope-1' }}
    onFocusedCollectionClose={onClose} />);
  const scope = await screen.findByRole('region', { name: 'บิลค้างของบูธ' });
  expect(within(scope).getAllByRole('button')).toHaveLength(2);
  expect(within(scope).getByText(/ยอดรอรับชำระทั้งหมด/).textContent).toContain('160.75');
  expect(within(scope).queryByRole('button', { name: /INV-other|INV-regular/ })).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: 'กลับ POS' }));
  expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'scope-1', status: 'cancelled' }));
});

it.each(['completed', 'cancelled'] as const)('preserves the scope through actual payment and POS return (%s)', async status => {
  let liveQueue = [row('old', 100.25, '2026-10-26'), row('new', 60.5, date)];
  const gw = gateway(liveQueue);
  vi.mocked(gw.loadCollectionOutstanding!).mockImplementation(async () => liveQueue.map(q => ({
    queueKey: q.queue_key!, shopId: q.shop_id, eventParticipationId: q.event_participation_id, outstandingAmount: q.outstanding_amount,
  })));
  api.loadQueue.mockImplementation(async () => ({ runId: 'run', queue: liveQueue, isClosed: false }));
  api.rpc.mockImplementation(async (name, args) => {
    if (name === 'record_event_payment') {
      liveQueue = liveQueue.filter(q => q.event_settlement_context_id !== args.p_expected_settlement_context_id);
      return { data: { payment_id: 'payment-old', receipt_number: 'REC-old', recorded_at: `${date}T06:00:00Z`,
        allocated_amount: 100.25, change_amount: 0 }, error: null };
    }
    return { data: { items: [] }, error: null };
  });
  const closed = vi.fn();
  function Harness() {
    const [request, setRequest] = useState<CollectionFocusRequest | null>(null);
    const [result, setResult] = useState<CollectionCloseResult | null>(null);
    return <>
      <div style={{ display: request ? 'none' : undefined }}>
        <EmployeeDeliveryWorkspace gateway={gw} serviceDate={date} canCollectShopPayments
          isActive={!request} onOpenCollection={setRequest} collectionCloseResult={result} requestScope="scoped-return" />
      </div>
      {request ? <FinancialOperations userRole="courier" serviceDate={date} focusRequest={request}
        onFocusedCollectionClose={result => { closed(result); setResult(result); setRequest(null); }} /> : null}
    </>;
  }
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(await screen.findByRole('button', { name: 'อีเว้น', exact: true }));
  await user.click(screen.getByRole('button', { name: /^เลือกร้าน บูธ B1/ }));
  await user.click(screen.getByRole('button', { name: 'รับชำระ', exact: true }));
  const scope = await screen.findByRole('region', { name: 'บิลค้างของบูธ' });
  await user.click(within(scope).getByRole('button', { name: /INV-old/ }));
  const payment = await screen.findByRole('dialog');
  expect((within(payment).getByLabelText('ยอดรับเงินจริง') as HTMLInputElement).value).toBe('100.25');
  if (status === 'completed') {
    await user.click(within(payment).getByRole('button', { name: 'บันทึกรับเงินทันที' }));
    await user.click(await within(payment).findByRole('button', { name: 'เสร็จสิ้น' }));
    expect(api.rpc).toHaveBeenCalledWith('record_event_payment', expect.objectContaining({
      p_expected_settlement_context_id: 'old', p_expected_participation_id: 'participation',
      p_expected_outstanding_amount: 100.25, p_received_amount: 100.25,
      p_allocations: [{ charge_id: 'charge-old', amount: 100.25 }],
    }));
  } else {
    await user.click(within(payment).getByRole('button', { name: 'ปิดหน้ารับเงิน' }));
    expect(api.rpc).not.toHaveBeenCalledWith('record_event_payment', expect.anything());
  }
  expect(closed).toHaveBeenCalledWith(expect.objectContaining({ status, shopId: 'shop' }));
  const booth = await screen.findByRole('button', { name: /^เลือกร้าน บูธ B1/ });
  await waitFor(() => expect(document.activeElement).toBe(booth));
  expect(await within(booth).findByText(status === 'completed' ? 'ยอดรอรับชำระ ฿60.5' : 'ยอดรอรับชำระ ฿160.75')).toBeTruthy();
  expect(gw.recordDelivery).not.toHaveBeenCalled();
  expect(gw.recordImmediateSale).not.toHaveBeenCalled();
});

it('can retry after the selected booth disappears from the queue without opening another booth', async () => {
  api.loadQueue.mockResolvedValueOnce({ runId: 'run', queue: [{ ...row('other', 100, date), event_participation_id: 'other' }] })
    .mockResolvedValue({ runId: 'run', queue: [row('new', 60.5, date)] });
  render(<FinancialOperations userRole="courier" serviceDate={date} focusRequest={{
    requestId: 'scope-retry', source: 'pos-shortcut', shopId: 'shop', queueKey: 'event-participation:participation',
    eventParticipationId: 'participation', returnContextId: 'scope-retry',
  }} />);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('ไม่พบร้านนี้ในคิวรับเงินล่าสุด');
  expect(screen.queryByRole('dialog')).toBeNull();
  await userEvent.setup().click(within(alert).getByRole('button', { name: 'ลองใหม่' }));
  const payment = await screen.findByRole('dialog');
  expect((within(payment).getByLabelText('ยอดรับเงินจริง') as HTMLInputElement).value).toBe('60.50');
});


it('shows the task choice with both actions disabled for an unsendable booth without debt', async () => {
  const user = userEvent.setup();
  const gw = gateway([], { event_delivery_enabled: false, stop_status: 'pending' });
  render(<EmployeeDeliveryWorkspace gateway={gw} serviceDate={date} canCollectShopPayments onOpenCollection={vi.fn()} />);
  await user.click(await screen.findByRole('button', { name: 'อีเว้น', exact: true }));
  await user.click(screen.getByRole('button', { name: /^เลือกร้าน บูธ B1/ }));
  expect(screen.getByRole('button', { name: 'ส่งเพิ่ม' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'รับชำระ' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('ไม่มียอดถึงกำหนด')).toBeTruthy();
});
