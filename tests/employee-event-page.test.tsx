import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { EmployeeEventPage } from '../src/EmployeeEventPage';
import type { EmployeeEventDetail, EmployeeEventGateway } from '../src/features/employee-events/types';
import { shiftServiceDate, toBangkokDateString } from '../src/lib/serviceDate';

const event = {
  id: 'event-1', name: 'งานตลาดนัด', location: 'ฮอลล์ A',
  start_date: '2026-09-29', end_date: '2099-09-30', active_participation_count: 0,
};

function detail(booths: EmployeeEventDetail['booths'] = []): EmployeeEventDetail {
  return { event, booths };
}

function gateway(): EmployeeEventGateway {
  return {
    loadEvents: vi.fn().mockResolvedValue([event]),
    loadEvent: vi.fn().mockResolvedValue(detail()),
    createBooth: vi.fn().mockResolvedValue({
      created: true,
      duplicate: false,
      booth: {
        id: 'booth-1', event_job_id: event.id, shop_id: 'shop-1', booth_number: 'A1',
        event_zone: null, shop_name: 'บูธ A1', contact_name: null, contact_phone: null,
        start_date: event.start_date, end_date: event.end_date, tank_handoff_count: 0,
        tank_return_count: 0, tank_balance: 0, tank_rental_unit_price: 100,
      },
    }),
    handoffTanks: vi.fn().mockResolvedValue({
      id: 'movement-1', event_participation_id: 'booth-1', quantity: 2,
      service_date: '2026-09-29', rental_unit_price: 100,
    }),
  };
}

it('creates the first booth in a published event without any round context', async () => {
  const api = gateway();
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);

  await user.click(await screen.findByRole('button', { name: 'เพิ่มบูธ' }));
  await user.type(screen.getByLabelText('เลขบูธ *'), 'A1');
  await user.click(screen.getByRole('button', { name: 'บันทึกบูธ' }));

  await waitFor(() => expect(api.createBooth).toHaveBeenCalledWith(expect.objectContaining({
    eventJobId: 'event-1', boothNumber: 'A1', requestId: expect.any(String),
  })));
  expect(await screen.findByRole('button', { name: 'ส่งถังให้บูธนี้' })).not.toBeNull();
});

it('shows the existing balance, price and calculated rental before handoff', async () => {
  const api = gateway();
  vi.mocked(api.loadEvent).mockResolvedValue(detail([{
    id: 'booth-1', event_job_id: event.id, shop_id: 'shop-1', booth_number: 'A1',
    event_zone: 'โซนอาหาร', shop_name: 'ร้านหนึ่ง', contact_name: null, contact_phone: null,
    start_date: event.start_date, end_date: event.end_date, tank_handoff_count: 3,
    tank_return_count: 1, tank_balance: 2, tank_rental_unit_price: 100,
  }]));
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);

  await user.click(await screen.findByRole('button', { name: 'ส่งเพิ่มถัง' }));
  expect(screen.getByText('ถังคงเหลือเดิม')).not.toBeNull();
  expect(screen.getByText('ราคาต่อถัง').textContent).toContain('100 บาท');
  await user.click(screen.getByRole('button', { name: 'เพิ่มจำนวนถัง' }));
  expect(screen.getByText('200 บาท')).not.toBeNull();
  await user.click(screen.getByRole('button', { name: 'ยืนยันส่งถัง' }));
  await waitFor(() => expect(api.handoffTanks).toHaveBeenCalledWith(expect.objectContaining({
    participationId: 'booth-1', quantity: 2, requestId: expect.any(String),
  })));
});

it.each([
  { eventPrepared: true, boothPrepared: true, allowed: true },
  { eventPrepared: true, boothPrepared: false, allowed: false },
  { eventPrepared: false, boothPrepared: true, allowed: false },
])('checks both preparation windows before offering a handoff: %j', async ({ eventPrepared, boothPrepared, allowed }) => {
  const api = gateway();
  const today = toBangkokDateString();
  const opening = shiftServiceDate(today, 1);
  const preparedEvent = { ...event, start_date: opening, preparation_start_date: eventPrepared ? today : null };
  const booth = {
    id: 'booth-1', event_job_id: event.id, shop_id: 'shop-1', booth_number: 'A1',
    event_zone: null, shop_name: 'บูธ A1', contact_name: null, contact_phone: null,
    start_date: opening, end_date: event.end_date, preparation_start_date: boothPrepared ? today : null,
    tank_handoff_count: 0, tank_return_count: 0, tank_balance: 0, tank_rental_unit_price: 100,
  };
  vi.mocked(api.loadEvents).mockResolvedValue([preparedEvent]);
  vi.mocked(api.loadEvent).mockResolvedValue({ event: preparedEvent, booths: [booth] });
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  await screen.findByText('บูธ A1');
  const button = screen.queryByRole('button', { name: 'ส่งเพิ่มถัง' });
  if (allowed) {
    expect(button).not.toBeNull();
    await user.click(button!);
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งถัง' }));
    await waitFor(() => expect(api.handoffTanks).toHaveBeenCalledWith(expect.objectContaining({ participationId: booth.id })));
  } else {
    expect(button).toBeNull();
  }
});

it('removes stale controls while switching events, including after a failed load, and allows retry', async () => {
  const api = gateway();
  const nextEvent = { ...event, id: 'event-2', name: 'งานที่สอง' };
  vi.mocked(api.loadEvents).mockResolvedValue([event, nextEvent]);
  let rejectLoad!: (error: Error) => void;
  vi.mocked(api.loadEvent)
    .mockResolvedValueOnce(detail())
    .mockResolvedValueOnce(detail())
    .mockImplementationOnce(() => new Promise((_, reject) => { rejectLoad = reject; }))
    .mockResolvedValue({ event: nextEvent, booths: [] });
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  // A success banner also contains a write shortcut that must not survive the switch.
  await user.click(await screen.findByRole('button', { name: 'เพิ่มบูธ' }));
  await user.type(screen.getByLabelText('เลขบูธ *'), 'A1');
  await user.click(screen.getByRole('button', { name: 'บันทึกบูธ' }));
  await screen.findByRole('button', { name: 'ส่งถังให้บูธนี้' });
  await waitFor(() => expect(screen.queryByText('กำลังโหลดรายละเอียด')).toBeNull());
  await user.click(screen.getByRole('button', { name: /งานที่สอง/ }));
  expect(screen.queryByRole('button', { name: 'เพิ่มบูธ' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'ส่งถังให้บูธนี้' })).toBeNull();
  rejectLoad(new Error('โหลดงานที่สองไม่สำเร็จ'));
  await screen.findByRole('alert');
  expect(screen.queryByRole('heading', { name: event.name })).toBeNull();
  expect(screen.queryByRole('button', { name: 'เพิ่มบูธ' })).toBeNull();

  await user.click(screen.getByRole('button', { name: /งานที่สอง/ }));
  await screen.findByRole('heading', { name: nextEvent.name });
  await user.click(screen.getByRole('button', { name: 'เพิ่มบูธ' }));
  const dialog = screen.getByRole('dialog');
  await user.type(within(dialog).getByLabelText('เลขบูธ *'), 'B1');
  await user.click(within(dialog).getByRole('button', { name: 'บันทึกบูธ' }));
  await waitFor(() => expect(api.createBooth).toHaveBeenLastCalledWith(expect.objectContaining({ eventJobId: nextEvent.id })));
});
