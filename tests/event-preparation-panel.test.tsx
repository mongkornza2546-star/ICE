import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EventPreparationPanel } from '../src/features/event-management/EventPreparationPanel';
import { toBangkokDateString, shiftServiceDate } from '../src/lib/serviceDate';
import type { EventManagementDetail, EventManagementGateway } from '../src/features/event-management/types';
const today = toBangkokDateString();
const opening = shiftServiceDate(today, 1);
function fixture() {
  const detail = {
    event: { id: 'event-1', start_date: opening, end_date: shiftServiceDate(opening, 4), status: 'published' },
    participations: [
      { id: 'p1', shop_name: 'ร้านผลไม้', booth_number: '001', status: 'active', start_date: opening, end_date: opening, preparation_start_date: today },
      { id: 'p2', shop_name: 'ร้านกาแฟ', booth_number: '002', status: 'active', start_date: opening, end_date: opening },
    ], tank_movements: [],
  } as unknown as EventManagementDetail;
  const gateway = {
    prepareShops: vi.fn().mockResolvedValue({ prepared_count: 1 }),
    cancelTankHandoff: vi.fn().mockResolvedValue({}),
    recordTankMovement: vi.fn().mockResolvedValue({ id: 'm1' }),
  } as unknown as EventManagementGateway;
  return { detail, gateway, onSaved: vi.fn().mockResolvedValue(undefined) };
}
describe('event preparation panel', () => {
  it('saves only selected shops and leaves the event dates unchanged', async () => {
    const props = fixture(); const user = userEvent.setup();
    render(<EventPreparationPanel {...props} />);
    await user.click(screen.getByText('เลือกร้านที่รับของก่อนวันเปิดงาน'));
    await user.click(screen.getByRole('checkbox', { name: /ร้านกาแฟ/ }));
    await user.click(screen.getByRole('button', { name: 'เปิดรับของล่วงหน้า 1 ร้าน' }));
    await waitFor(() => expect(props.gateway.prepareShops).toHaveBeenCalledWith('event-1', today, ['p2']));
    expect(props.detail.event.start_date).toBe(opening);
    expect(props.onSaved).toHaveBeenCalled();
  });
  it('offers only eligible shops for today and retries a failed movement with the same ID', async () => {
    const props = fixture(); const user = userEvent.setup();
    vi.mocked(props.gateway.recordTankMovement).mockRejectedValueOnce(new Error('ลองใหม่'));
    render(<EventPreparationPanel {...props} />);
    await user.click(screen.getByText(/บันทึกตั้งถัง \/ รับคืนถัง/));
    expect(screen.queryByRole('option', { name: /ร้านกาแฟ/ })).toBeNull();
    await user.selectOptions(screen.getByLabelText('ร้านค้า'), 'p1');
    await user.click(screen.getByRole('button', { name: 'บันทึกรายการถัง' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'ลองใหม่');
    await user.click(screen.getByRole('button', { name: 'บันทึกรายการถัง' }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
    const calls = vi.mocked(props.gateway.recordTankMovement).mock.calls;
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0][0]).toMatchObject({ participationId: 'p1', serviceDate: today, kind: 'handoff', quantity: 1 });
    expect(screen.getByText(new RegExp(`เริ่มค่าเช่า ${opening}`))).toBeTruthy();
  });
  it('requires a reason, cancels the selected handoff and refreshes the balances', async () => {
    const props = fixture(); const user = userEvent.setup();
    props.detail.tank_movements = [{ id: 'm1', event_participation_id: 'p1', movement_kind: 'handoff', quantity: 1, service_date: today, rental_start_date: opening, rental_unit_price: 100, note: '' }];
    render(<EventPreparationPanel {...props} />);
    await user.click(screen.getByText(/บันทึกตั้งถัง \/ รับคืนถัง/));
    await user.click(screen.getByRole('button', { name: 'ยกเลิกรายการถัง' }));
    expect(screen.getByRole('button', { name: 'ยืนยันยกเลิกรายการถัง' }).hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByLabelText('เหตุผลในการยกเลิก *'), 'เพิ่มผิดร้าน');
    await user.click(screen.getByRole('button', { name: 'ยืนยันยกเลิกรายการถัง' }));
    await waitFor(() => expect(props.gateway.cancelTankHandoff).toHaveBeenCalledWith('m1', 'เพิ่มผิดร้าน'));
    expect(props.onSaved).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('keeps the dialog open and shows the server reason when a paid invoice cannot be cancelled', async () => {
    const props = fixture(); const user = userEvent.setup();
    props.detail.tank_movements = [{ id: 'm1', event_participation_id: 'p1', movement_kind: 'handoff', quantity: 1, service_date: today, rental_start_date: opening, rental_unit_price: 100, note: '' }];
    vi.mocked(props.gateway.cancelTankHandoff).mockRejectedValue(new Error('บิลค่าเช่านี้รับเงินแล้ว'));
    render(<EventPreparationPanel {...props} />);
    await user.click(screen.getByText(/บันทึกตั้งถัง \/ รับคืนถัง/));
    await user.click(screen.getByRole('button', { name: 'ยกเลิกรายการถัง' }));
    await user.type(screen.getByLabelText('เหตุผลในการยกเลิก *'), 'ผิดร้าน');
    await user.click(screen.getByRole('button', { name: 'ยืนยันยกเลิกรายการถัง' }));
    expect((await screen.findByRole('alert')).textContent).toContain('รับเงินแล้ว');
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('shows cancelled history without another cancel button or an active invoice', async () => {
    const props = fixture(); const user = userEvent.setup();
    props.detail.tank_movements = [
      { id: 'm1', event_participation_id: 'p1', movement_kind: 'handoff', quantity: 1, service_date: today, rental_start_date: opening, rental_unit_price: 100, note: '', cancelled: true, charge_id: 'c1', charge_number: 'INV-1', charge_status: 'voided', outstanding_amount: 100 },
      { id: 'r1', event_participation_id: 'p1', movement_kind: 'return', quantity: 1, service_date: today, rental_start_date: null, rental_unit_price: null, note: 'ผิดร้าน', reverses_movement_id: 'm1' },
    ];
    render(<EventPreparationPanel {...props} />);
    await user.click(screen.getByText(/ค้างทั้งหมด 0 ถัง/));
    expect(screen.getByText('ส่งมอบ · ยกเลิกแล้ว')).toBeTruthy();
    expect(screen.getByText('ยกเลิกบิลแล้ว')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ยกเลิกรายการถัง' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'พิมพ์บิล' })).toBeNull();
  });
  it('allows returns on a cancelled job and shows custody balance', async () => {
    const props = fixture(); const user = userEvent.setup();
    props.detail.event.status = 'cancelled';
    props.detail.tank_movements = [{ id: 'm1', event_participation_id: 'p1', movement_kind: 'handoff', quantity: 2, service_date: today, rental_start_date: opening, rental_unit_price: 100, note: '' }];
    render(<EventPreparationPanel {...props} />);
    expect(screen.queryByText('เลือกร้านที่รับของก่อนวันเปิดงาน')).toBeNull();
    await user.click(screen.getByText(/ค้างทั้งหมด 2 ถัง/));
    await user.selectOptions(screen.getByLabelText('รายการ'), 'return');
    await user.selectOptions(screen.getByLabelText('ร้านค้า'), 'p1');
    await user.click(screen.getByRole('button', { name: 'บันทึกรายการถัง' }));
    await waitFor(() => expect(props.gateway.recordTankMovement).toHaveBeenCalledWith(expect.objectContaining({ kind: 'return', quantity: 1 })));
  });
});
