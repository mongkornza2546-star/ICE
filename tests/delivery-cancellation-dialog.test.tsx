import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { DeliveryCorrectionDialog } from '../src/features/delivery-corrections/DeliveryCorrectionDialog';

const { rpc, publish } = vi.hoisted(() => ({ rpc: vi.fn(), publish: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../src/lib/dataChange', () => ({ publishDataChange: publish }));
const context = {
  destination_kind: 'regular', charge_number: 'INV-1', charge_id: 'charge-1',
  shop_name: 'ร้านทดสอบ', effective_amount: 60, allocated_amount: 0,
  round_status: 'open', day_closed: false, payment_term: 'end_of_day',
  can_correct: true, can_cancel: true, note: 'หมายเหตุเดิม', blocker_reason: null,
  items: [{ ice_type_id: 'ice-1', name: 'หลอดเล็ก', unit: 'ถุง', quantity: 1, unit_price: 60 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

function setup(overrides = {}, destination = 'regular') {
  rpc.mockImplementation(async (name: string) => ({ data: name === 'get_delivery_correction_route'
    ? { destination_kind: destination } : { ...context, destination_kind: destination, ...overrides }, error: null }));
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  render(<DeliveryCorrectionDialog eventId="event-1" onClose={onClose} onSuccess={onSuccess} userRole="courier" />);
  return { onClose, onSuccess };
}

it.each(['regular', 'event'])('cancels a %s slip without editable quantities or a replacement', async (destination) => {
  const user = userEvent.setup();
  const { onClose, onSuccess } = setup({}, destination);
  await screen.findByText('หลอดเล็ก 1 ถุง');
  expect(screen.queryByRole('spinbutton')).toBeNull();
  expect(screen.queryByRole('button', { name: 'ยืนยันแก้ไข' })).toBeNull();
  await user.type(screen.getByLabelText('เหตุผล'), 'ส่งผิด');
  await user.click(screen.getByRole('button', { name: 'ยืนยันยกเลิกใบส่งน้ำแข็ง' }));
  expect(rpc).toHaveBeenCalledWith(destination === 'event' ? 'apply_open_event_delivery_correction' : 'apply_open_delivery_correction', expect.objectContaining({
    p_action: 'cancel', p_items: [], p_event_id: 'event-1', p_reason: 'ส่งผิด', p_note: 'หมายเหตุเดิม',
  }));
  expect(onSuccess).toHaveBeenCalledWith('ยกเลิกใบส่งน้ำแข็งแล้ว สามารถบันทึกส่งใหม่ได้');
  expect(publish).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

it.each([
  { can_cancel: false, blocker_reason: 'ไม่ใช่รายการล่าสุด' },
  { round_status: 'closed' },
  { payment_term: 'immediate', allocated_amount: 60 },
])('does not allow cancellation when blocked: %j', async (blocked) => {
  setup(blocked);
  await screen.findByText('หลอดเล็ก 1 ถุง');
  expect(screen.queryByRole('button', { name: 'ยืนยันยกเลิกใบส่งน้ำแข็ง' })).toBeNull();
});

it('leaves the slip unchanged if the user declines confirmation', async () => {
  const user = userEvent.setup();
  const { onClose } = setup();
  await screen.findByText('หลอดเล็ก 1 ถุง');
  await user.type(screen.getByLabelText('เหตุผล'), 'ส่งผิด');
  vi.mocked(window.confirm).mockReturnValue(false);
  await user.click(screen.getByRole('button', { name: 'ยืนยันยกเลิกใบส่งน้ำแข็ง' }));
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(onClose).not.toHaveBeenCalled();
});
