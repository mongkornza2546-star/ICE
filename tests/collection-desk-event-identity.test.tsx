import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, vi } from 'vitest';
import { CollectionDesk } from '../src/features/financial-operations/components/CollectionDesk';
import type { QueueShop, PaymentHistoryItem } from '../src/features/financial-operations/types';

function entry(id: string, date: string): QueueShop {
  return {
    queue_key: `event:${id}`, destination_kind: 'event', event_participation_id: id,
    event_settlement_context_id: id, settlement_service_date: date,
    event_job_id: `job-${date}`, event_start_date: date, event_end_date: date,
    event_name: 'งานแฟร์', event_location: 'ตึก C', event_zone: 'อาหาร', event_booth: id,
    shop_id: id, shop_code: `EV-${id}`, shop_name: `บูธ ${id}`, image_path: null,
    outstanding_amount: 100, charge_count: 1, has_new_charges: false,
    payment_profile: { allowed_payment_methods: ['cash'], default_payment_method: 'cash',
      cash_reference_required: false, cash_evidence_required: false, bank_transfer_reference_required: false,
      bank_transfer_evidence_required: false, qr_reference_required: false, qr_evidence_required: false },
    charges: [{ charge_id: id, service_date: date, original_amount: 100, outstanding_amount: 100, items: [] }],
  };
}
function mount(queue: QueueShop[], history: PaymentHistoryItem[] = []) {
  render(<CollectionDesk queue={queue} paymentHistory={history} todayPayments={[]} historyDate="2026-10-27"
    serviceDate="2026-10-27" selectedShop={null} busy={false} runId="run-1" paymentPanel={null}
    onRefresh={vi.fn()} onHistoryDateChange={vi.fn()} onOpenReceipt={vi.fn()} onPrintReceipt={vi.fn()}
    onSelectShop={vi.fn()} onClearShop={vi.fn()} onVoidPayment={vi.fn()} />);
}
it('keeps recurring events at the same venue as separate location options', async () => {
  // Two event jobs from different months; current queue includes carry-forward debt.
  mount([entry('old-job-booth', '2026-09-27'), entry('current-job-booth', '2026-10-27')]);
  const location = screen.getByLabelText('เลือกตึกหรืออีเวนต์');
  expect(within(location).getAllByRole('option')).toHaveLength(3);
  const options = within(location).getAllByRole('option').slice(1);
  expect(options[0].textContent).not.toBe(options[1].textContent);
  await userEvent.selectOptions(location, 'event:job-2026-10-27');
  expect(screen.getAllByRole('button', { name: /^เลือกรายการ/ })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'เลือกรายการ บูธ current-job-booth' })).toBeTruthy();
});
it.each(['all', 'collected'] as const)('includes a rental-only event receipt when filtering %s by its event', async (tab) => {
  const shop = entry('current-job-booth', '2026-10-27');
  // Metadata contract is verified against get_payment_history in the SQL integration test.
  const receipt: PaymentHistoryItem = {
    id: 'payment-1', receipt_number: 'REC-RENTAL', received_amount: 100, allocated_amount: 100, change_amount: 0,
    payment_method: 'cash', status: 'active', recorded_at: '2026-10-27T08:00:00Z', void_reason: null,
    destination_kind: 'event', event_participation_id: shop.event_participation_id,
    event_settlement_context_id: shop.event_settlement_context_id, event_job_id: shop.event_job_id,
    event_start_date: shop.event_start_date, event_end_date: shop.event_end_date,
    event_name: shop.event_name, event_location: shop.event_location,
    event_zone: shop.event_zone, event_booth: shop.event_booth, shops: { code: shop.shop_code, name: shop.shop_name },
  };
  mount(tab === 'collected' ? [] : [shop], [receipt]);
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: tab === 'all' ? 'ทั้งหมด' : /ประวัติรับเงิน/ }));
  const select = screen.getByLabelText('เลือกตึกหรืออีเวนต์');
  await user.selectOptions(select, 'event:job-2026-10-27');
  expect(screen.getAllByRole('button', { name: /^เลือกรายการ/ })).toHaveLength(tab === 'all' ? 2 : 1);
});

it('groups different days and booths by the same event job', async () => {
  const first = entry('A1', '2026-10-27');
  const second = { ...entry('A2', '2026-10-26'), event_job_id: first.event_job_id,
    event_start_date: first.event_start_date, event_end_date: first.event_end_date };
  mount([first, second]);
  const location = screen.getByLabelText('เลือกตึกหรืออีเวนต์');
  expect(within(location).getAllByRole('option')).toHaveLength(2);
  await userEvent.selectOptions(location, 'event:job-2026-10-27');
  expect(screen.getAllByRole('button', { name: /^เลือกรายการ/ })).toHaveLength(2);
});
