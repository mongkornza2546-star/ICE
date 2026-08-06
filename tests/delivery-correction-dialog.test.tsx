import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryCorrectionDialog } from '../src/features/delivery-corrections/DeliveryCorrectionDialog';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../src/lib/supabase', () => ({
  supabase: { rpc: mocks.rpc },
}));

describe('DeliveryCorrectionDialog', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    vi.restoreAllMocks();
  });

  it('allows an admin to create a zero-total closed-period adjustment', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_delivery_correction_context') return { data: {
        delivery_event_id: 'event-1', charge_number: 'C260806-000001', shop_name: 'ร้านหนึ่ง',
        service_date: '2026-08-06', round_status: 'closed', day_closed: false,
        original_amount: 18, effective_amount: 18, allocated_amount: 0,
        can_correct: false, can_cancel: false, blocker_reason: 'รอบส่งปิดแล้ว',
        ice_types: [{ ice_type_id: 'ice-1', code: 'SMALL', name: 'น้ำแข็งหลอด', unit: 'ถุง', unit_price: 18 }],
        items: [{ ice_type_id: 'ice-1', name: 'น้ำแข็งหลอด', unit: 'ถุง', quantity: 1, unit_price: 18 }],
      }, error: null };
      if (name === 'create_closed_delivery_adjustment') return { data: {}, error: null };
      return { data: null, error: null };
    });

    render(<DeliveryCorrectionDialog
      eventId="event-1"
      onClose={vi.fn()}
      onSuccess={vi.fn()}
      userRole="admin"
    />);

    const quantity = await screen.findByRole('spinbutton', { name: 'น้ำแข็งหลอด (ถุง)' });
    await user.clear(quantity);
    await user.type(quantity, '0');
    await user.type(screen.getByRole('textbox', { name: 'เหตุผล' }), 'ยกเลิกรายการหลังปิดรอบ');
    await user.click(screen.getByRole('button', { name: 'คำนวณผลกระทบ' }));
    expect(screen.getAllByText('฿0.00').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'สร้างเอกสารปรับปรุง' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'create_closed_delivery_adjustment',
      expect.objectContaining({ p_event_id: 'event-1', p_items: [] }),
    ));
  });

  it('preserves the existing note and submits an approved credit correction', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_delivery_correction_context') return { data: {
        delivery_event_id: 'event-2', round_stop_id: 'stop-1', charge_number: 'C260806-000002',
        shop_name: 'ร้านเครดิต', service_date: '2026-08-06', round_status: 'open', day_closed: false,
        original_amount: 18, effective_amount: 18, allocated_amount: 0, payment_term: 'credit',
        note: 'รับถุงคืนจากร้าน', can_correct: true, can_cancel: true, blocker_reason: null,
        ice_types: [{ ice_type_id: 'ice-1', code: 'SMALL', name: 'น้ำแข็งหลอด', unit: 'ถุง', unit_price: 18 }],
        items: [{ ice_type_id: 'ice-1', name: 'น้ำแข็งหลอด', unit: 'ถุง', quantity: 1, unit_price: 18 }],
      }, error: null };
      if (name === 'preview_delivery_correction') return { data: {
        old_amount: 18, new_amount: 36, allocated_amount: 0, refund_amount: 0,
        outstanding_amount: 36,
        stock_deltas: [{ ice_type_id: 'ice-1', name: 'น้ำแข็งหลอด', unit: 'ถุง', quantity_delta: -1 }],
        approval_required: true,
      }, error: null };
      if (name === 'request_financial_approval') return { data: { id: 'approval-1', status: 'approved' }, error: null };
      if (name === 'apply_open_delivery_correction') return { data: {}, error: null };
      return { data: null, error: null };
    });

    render(<DeliveryCorrectionDialog eventId="event-2" onClose={vi.fn()} onSuccess={vi.fn()} userRole="admin" />);

    expect(await screen.findByRole('textbox', { name: 'หมายเหตุ' })).toHaveProperty('value', 'รับถุงคืนจากร้าน');
    const quantity = screen.getByRole('spinbutton', { name: 'น้ำแข็งหลอด (ถุง)' });
    await user.clear(quantity);
    await user.type(quantity, '2');
    await user.type(screen.getByRole('textbox', { name: 'เหตุผล' }), 'เพิ่มจำนวนที่ส่งจริง');
    await user.click(screen.getByRole('button', { name: 'คำนวณผลกระทบ' }));
    expect(await screen.findByText('น้ำแข็งหลอด: ส่งเพิ่มให้ร้าน 1 ถุง')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'ขออนุมัติวงเงิน' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ยืนยันแก้ไข' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'ขออนุมัติวงเงิน' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'ยืนยันแก้ไข' })).toHaveProperty('disabled', false));
    await user.click(screen.getByRole('button', { name: 'ยืนยันแก้ไข' }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('ใบเสร็จเดิมยังคงอยู่'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('ยอดค้างเพิ่ม ฿36.00'));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('request_financial_approval', expect.objectContaining({
      p_round_stop_id: 'stop-1', p_items: [{ ice_type_id: 'ice-1', quantity: 2 }], p_requested_amount: 36,
    })));
    expect(mocks.rpc).toHaveBeenCalledWith('apply_open_delivery_correction', expect.objectContaining({
      p_approval_id: 'approval-1', p_note: 'รับถุงคืนจากร้าน',
    }));
  });

  it('allows a voided immediate sale to be cancelled after its round closes', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_delivery_correction_context') return { data: {
        delivery_event_id: 'event-3', charge_number: null, shop_name: 'ร้านขายสด',
        service_date: '2026-08-06', round_status: 'closed', day_closed: false,
        original_amount: 18, effective_amount: 18, allocated_amount: 0,
        payment_term: 'immediate', can_correct: false, can_cancel: true, blocker_reason: null,
        ice_types: [{ ice_type_id: 'ice-1', code: 'SMALL', name: 'น้ำแข็งหลอด', unit: 'ถุง', unit_price: 18 }],
        items: [{ ice_type_id: 'ice-1', name: 'น้ำแข็งหลอด', unit: 'ถุง', quantity: 1, unit_price: 18 }],
      }, error: null };
      if (name === 'apply_open_delivery_correction') return { data: {}, error: null };
      return { data: null, error: null };
    });

    render(<DeliveryCorrectionDialog eventId="event-3" onClose={vi.fn()} onSuccess={vi.fn()} userRole="admin" />);

    const reason = await screen.findByRole('textbox', { name: 'เหตุผล' });
    expect(reason).toHaveProperty('disabled', false);
    await user.type(reason, 'ยกเลิกหลัง void ใบเสร็จ');
    await user.click(screen.getByRole('button', { name: 'ยกเลิกบิลส่งของ' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'apply_open_delivery_correction',
      expect.objectContaining({ p_event_id: 'event-3', p_action: 'cancel' }),
    ));
  });
});
