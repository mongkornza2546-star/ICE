import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EmployeeEventPage } from '../src/EmployeeEventPage';
import { LanguageProvider, LanguageSwitcher, translateUi } from '../src/i18n';
import type { EmployeeEventBooth, EmployeeEventDetail, EmployeeEventGateway, EmployeeEventSummary } from '../src/features/employee-events/types';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-04T04:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 }); });

const event: EmployeeEventSummary = {
  id: 'event-1', name: 'งานตลาดนัด', location: 'ฮอลล์ A',
  start_date: '2026-10-01', end_date: '2026-10-06', active_participation_count: 1,
};
function booth(overrides: Partial<EmployeeEventBooth> = {}): EmployeeEventBooth {
  return {
    id: 'booth-1', event_job_id: event.id, shop_id: 'shop-1', booth_number: 'A1',
    event_zone: 'อาหาร', shop_name: 'ร้านหนึ่ง', contact_name: null, contact_phone: null,
    start_date: event.start_date, end_date: event.end_date, tank_handoff_count: 3,
    tank_return_count: 1, tank_balance: 2, tank_rental_unit_price: 100, ...overrides,
  };
}
function detail(booths: EmployeeEventBooth[] = [booth()], summary = event): EmployeeEventDetail {
  return { event: summary, booths };
}
function gateway(): EmployeeEventGateway {
  return {
    loadEvents: vi.fn().mockResolvedValue([event]),
    loadEvent: vi.fn().mockResolvedValue(detail()),
    createBooth: vi.fn().mockResolvedValue({ created: true, duplicate: false, booth: booth({ id: 'new-booth', booth_number: 'A2', shop_name: 'บูธ A2' }) }),
    handoffTanks: vi.fn().mockResolvedValue({ id: 'movement-1', event_participation_id: 'booth-1', quantity: 1, service_date: '2026-10-04', rental_unit_price: 100 }),
  };
}
async function openEvent(user: ReturnType<typeof userEvent.setup>, name = event.name) {
  await user.click(await screen.findByRole('button', { name: new RegExp(name) }));
  await screen.findByRole('heading', { name, exact: true });
}

it('starts with today’s events, puts active before preparation, and loads booths only after choosing', async () => {
  const api = gateway();
  vi.mocked(api.loadEvents).mockResolvedValue([
    { ...event, id: 'prepared', name: 'งานเตรียม', start_date: '2026-10-05', preparation_start_date: '2026-10-04' },
    { ...event, id: 'old', name: 'งานเก่า', end_date: '2026-10-03' },
    event,
    { ...event, id: 'future', name: 'งานอนาคต', start_date: '2026-10-05' },
  ]);
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  const active = await screen.findByRole('button', { name: /งานตลาดนัด/ });
  expect(api.loadEvent).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /งานเก่า/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /งานอนาคต/ })).toBeNull();
  const list = screen.getByLabelText('เลือกงานอีเวนต์');
  expect(within(list).getAllByRole('button')[0]).toBe(active);
  expect(screen.getByRole('button', { name: 'วันนี้ 2' }).getAttribute('aria-pressed')).toBe('true');
  await openEvent(user);
  expect(api.loadEvent).toHaveBeenCalledWith(event.id);
  expect(screen.queryByLabelText('ค้นหางาน')).toBeNull();
});

it('does not automatically open an ended event when today is empty and sorts history newest first', async () => {
  const api = gateway();
  vi.mocked(api.loadEvents).mockResolvedValue([
    { ...event, id: 'old', name: 'งานเก่า', end_date: '2026-09-25' },
    { ...event, id: 'recent', name: 'งานล่าสุด', end_date: '2026-10-02' },
  ]);
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  await screen.findByText('วันนี้ยังไม่มีงานอีเวนต์');
  expect(api.loadEvent).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'ดูงานที่จบแล้ว' }));
  expect(within(screen.getByLabelText('เลือกงานอีเวนต์')).getAllByRole('button')[0].textContent).toContain('งานล่าสุด');
  await user.type(screen.getByLabelText('ค้นหางาน'), 'ฮอลล์ A');
  expect(within(screen.getByLabelText('เลือกงานอีเวนต์')).getAllByRole('button')).toHaveLength(2);
});

it('retries an overview failure', async () => {
  const api = gateway();
  vi.mocked(api.loadEvents).mockRejectedValueOnce(new Error('เครือข่ายขัดข้อง'));
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  expect((await screen.findByRole('alert')).textContent).toContain('เครือข่ายขัดข้อง');
  await user.click(screen.getByRole('button', { name: 'ลองอีกครั้ง' }));
  await screen.findByRole('button', { name: /งานตลาดนัด/ });
});

it('sorts booth numbers naturally and retains event/search/zone/scroll across back and main-tab switches', async () => {
  const api = gateway();
  vi.mocked(api.loadEvent).mockResolvedValue(detail([
    booth({ id: 'b10', booth_number: '10' }), booth({ id: 'b2', booth_number: '2' }),
    booth({ id: 'other', booth_number: '1', event_zone: 'เครื่องดื่ม', shop_name: 'กาแฟ' }),
  ]));
  const user = userEvent.setup();
  const view = render(<EmployeeEventPage gateway={api} />);
  await user.type(await screen.findByLabelText('ค้นหางาน'), 'ตลาด');
  await openEvent(user);
  const rows = within(screen.getByLabelText('บูธในงาน')).getAllByRole('article');
  expect(rows.findIndex((row) => row.getAttribute('aria-label')?.startsWith('บูธ 2 ')))
    .toBeLessThan(rows.findIndex((row) => row.getAttribute('aria-label')?.startsWith('บูธ 10 ')));
  await user.selectOptions(screen.getByLabelText('กรองโซน'), 'อาหาร');
  await user.type(screen.getByLabelText('ค้นหาบูธ'), 'ร้านหนึ่ง');
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 450 });
  fireEvent.scroll(window);
  await user.click(screen.getByRole('button', { name: 'กลับไปเลือกงาน' }));
  expect((screen.getByLabelText('ค้นหางาน') as HTMLInputElement).value).toBe('ตลาด');
  await openEvent(user);
  expect((screen.getByLabelText('ค้นหาบูธ') as HTMLInputElement).value).toBe('ร้านหนึ่ง');
  expect((screen.getByLabelText('กรองโซน') as HTMLSelectElement).value).toBe('อาหาร');
  await waitFor(() => expect(window.scrollTo).toHaveBeenCalledWith({ top: 450, behavior: 'auto' }));
  view.rerender(<EmployeeEventPage gateway={api} isActive={false} />);
  view.rerender(<EmployeeEventPage gateway={api} isActive />);
  await waitFor(() => expect(api.loadEvent).toHaveBeenCalledTimes(3));
  expect((screen.getByLabelText('ค้นหาบูธ') as HTMLInputElement).value).toBe('ร้านหนึ่ง');
  await user.click(screen.getByRole('button', { name: 'ล้างตัวกรอง' }));
  expect(within(screen.getByLabelText('บูธในงาน')).getAllByRole('article')).toHaveLength(3);
});

it('does not keep stale actions while another event loads or fails, and retries the chosen event', async () => {
  const api = gateway();
  const nextEvent = { ...event, id: 'event-2', name: 'งานที่สอง' };
  vi.mocked(api.loadEvents).mockResolvedValue([event, nextEvent]);
  vi.mocked(api.loadEvent).mockResolvedValueOnce(detail())
    .mockRejectedValueOnce(new Error('โหลดงานที่สองไม่สำเร็จ'))
    .mockResolvedValueOnce(detail([], nextEvent));
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  await openEvent(user);
  await user.click(screen.getByRole('button', { name: 'กลับไปเลือกงาน' }));
  await user.click(screen.getByRole('button', { name: /งานที่สอง/ }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'เพิ่มบูธ' })).toBeNull();
  expect(screen.queryByRole('button', { name: /ส่งถัง บูธ/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'โหลดข้อมูลใหม่' }));
  await screen.findByRole('heading', { name: 'งานที่สอง' });
  await user.click(screen.getByRole('button', { name: 'เพิ่มบูธ' }));
  await user.type(screen.getByLabelText('เลขบูธ *'), 'B1');
  await user.click(screen.getByRole('button', { name: 'บันทึกบูธ' }));
  await waitFor(() => expect(api.createBooth).toHaveBeenCalledWith(expect.objectContaining({ eventJobId: 'event-2' })));
});

it.each([false, true])('shows the added/existing booth and a handoff shortcut (duplicate: %s)', async (duplicate) => {
  const api = gateway();
  const resultBooth = booth({ id: 'new-booth', booth_number: 'A2', shop_name: 'บูธ A2' });
  vi.mocked(api.createBooth).mockResolvedValue({ created: !duplicate, duplicate, booth: resultBooth });
  vi.mocked(api.loadEvent).mockResolvedValueOnce(detail([])).mockResolvedValue(detail([resultBooth]));
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  await openEvent(user);
  await user.click(screen.getByRole('button', { name: 'เพิ่มบูธ' }));
  expect(document.activeElement).toBe(screen.getByLabelText('เลขบูธ *'));
  await user.type(screen.getByLabelText('เลขบูธ *'), 'A2');
  await user.click(screen.getByRole('button', { name: 'บันทึกบูธ' }));
  await waitFor(() => expect(api.createBooth).toHaveBeenCalledWith(expect.objectContaining({ eventJobId: 'event-1', boothNumber: 'A2', requestId: expect.any(String) })));
  await screen.findByRole('button', { name: 'ส่งถังให้บูธนี้' });
  expect(screen.getByRole('status').textContent).toContain(duplicate ? 'มีอยู่แล้ว' : 'เพิ่มบูธ A2 แล้ว');
  expect(screen.getByRole('article', { name: 'บูธ A2 บูธ A2' }).className).toContain('is-highlighted');
  expect((screen.getByLabelText('ค้นหาบูธ') as HTMLInputElement).value).toBe('A2');
});

it('shows quantity, rental and resulting balance, then returns to the same filtered booth', async () => {
  const api = gateway();
  vi.mocked(api.loadEvent).mockResolvedValueOnce(detail()).mockResolvedValue(detail([booth({ tank_handoff_count: 5, tank_balance: 4 })]));
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  await openEvent(user);
  await user.type(screen.getByLabelText('ค้นหาบูธ'), 'A1');
  const trigger = screen.getByRole('button', { name: 'ส่งถัง บูธ A1' });
  await user.click(trigger);
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('งานตลาดนัด · ร้านหนึ่ง');
  expect(within(dialog).getByText('ราคาต่อถัง').textContent).toContain('100 บาท');
  await user.click(within(dialog).getByRole('button', { name: 'เพิ่มจำนวนถัง' }));
  expect(within(dialog).getByText('200 บาท')).not.toBeNull();
  expect(within(dialog).getByText('4 ใบ')).not.toBeNull();
  await user.click(within(dialog).getByText('เพิ่มหมายเหตุ (ไม่บังคับ)'));
  await user.type(within(dialog).getByLabelText('หมายเหตุ'), 'หน้าร้าน');
  await user.click(within(dialog).getByRole('button', { name: 'ยืนยันส่งถัง' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.handoffTanks).toHaveBeenCalledWith(expect.objectContaining({ participationId: 'booth-1', quantity: 2, note: 'หน้าร้าน' }));
  expect(screen.getByRole('status').textContent).toContain('ส่งถัง 2 ใบให้บูธ A1 แล้ว');
  expect((screen.getByLabelText('ค้นหาบูธ') as HTMLInputElement).value).toBe('A1');
  expect(document.activeElement).toBe(trigger);
});

it('blocks duplicate submission and closing while saving', async () => {
  const api = gateway();
  let finish!: (value: Awaited<ReturnType<EmployeeEventGateway['handoffTanks']>>) => void;
  vi.mocked(api.handoffTanks).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  await openEvent(user);
  await user.click(screen.getByRole('button', { name: 'ส่งถัง บูธ A1' }));
  fireEvent.submit(screen.getByRole('dialog'));
  fireEvent.submit(screen.getByRole('dialog'));
  await user.keyboard('{Escape}');
  expect(api.handoffTanks).toHaveBeenCalledTimes(1);
  expect((screen.getByRole('button', { name: 'ปิดหน้าต่าง' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish({ id: 'saved', event_participation_id: 'booth-1', quantity: 1, service_date: '2026-10-04', rental_unit_price: 100 }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('retains the request id and form after a save failure so an unchanged retry is idempotent', async () => {
  const api = gateway();
  vi.mocked(api.handoffTanks).mockRejectedValueOnce(new Error('บันทึกไม่สำเร็จ กรุณาลองใหม่'));
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  await openEvent(user);
  await user.click(screen.getByRole('button', { name: 'ส่งถัง บูธ A1' }));
  await user.click(screen.getByRole('button', { name: 'ยืนยันส่งถัง' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('dialog')).not.toBeNull();
  await user.click(screen.getByRole('button', { name: 'ยืนยันส่งถัง' }));
  await waitFor(() => expect(api.handoffTanks).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.handoffTanks).mock.calls[0][0]).toEqual(vi.mocked(api.handoffTanks).mock.calls[1][0]);
});

it.each(['handoff', 'booth'] as const)('reports a saved %s even when reloading fails and retries only the read', async (kind) => {
  const api = gateway();
  vi.mocked(api.loadEvent).mockResolvedValueOnce(detail())
    .mockRejectedValueOnce(new Error('โหลดไม่สำเร็จ')).mockResolvedValue(detail());
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  await openEvent(user);
  if (kind === 'handoff') {
    await user.click(screen.getByRole('button', { name: 'ส่งถัง บูธ A1' }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งถัง' }));
  } else {
    await user.click(screen.getByRole('button', { name: 'เพิ่มบูธ' }));
    await user.type(screen.getByLabelText('เลขบูธ *'), 'A2');
    await user.click(screen.getByRole('button', { name: 'บันทึกบูธ' }));
  }
  expect((await screen.findByRole('alert')).textContent).toContain('บันทึกรายการแล้ว แต่โหลดข้อมูลล่าสุดไม่สำเร็จ');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('status')).not.toBeNull();
  await user.click(screen.getByRole('button', { name: 'โหลดข้อมูลใหม่' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(kind === 'handoff' ? api.handoffTanks : api.createBooth).toHaveBeenCalledTimes(1);
});

it.each([
  { job: true, booth: true, allowed: true },
  { job: true, booth: false, allowed: false },
  { job: false, booth: true, allowed: false },
])('respects both preparation windows: %j', async (prepared) => {
  const api = gateway();
  const upcoming = { ...event, start_date: '2026-10-05', preparation_start_date: prepared.job ? '2026-10-04' : null };
  vi.mocked(api.loadEvents).mockResolvedValue([upcoming]);
  vi.mocked(api.loadEvent).mockResolvedValue(detail([booth({ start_date: '2026-10-05', preparation_start_date: prepared.booth ? '2026-10-04' : null })], upcoming));
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  if (!prepared.job) await user.click(await screen.findByRole('button', { name: 'กำลังจะมา 1' }));
  await openEvent(user);
  expect(Boolean(screen.queryByRole('button', { name: 'ส่งถัง บูธ A1' }))).toBe(prepared.allowed);
  if (!prepared.allowed) expect(screen.getByText(/ส่งถังได้ตั้งแต่/)).not.toBeNull();
});

it.each(['2026-10-01', '2026-10-06'])('allows handoff on event boundary %s', async (date) => {
  vi.setSystemTime(new Date(`${date}T04:00:00Z`));
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={gateway()} />);
  await openEvent(user);
  expect(screen.getByRole('button', { name: 'ส่งถัง บูธ A1' })).not.toBeNull();
});

it('shows why an ended booth is unavailable while the event is still active', async () => {
  const api = gateway();
  vi.mocked(api.loadEvent).mockResolvedValue(detail([booth({ end_date: '2026-10-03' })]));
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  await openEvent(user);
  expect(screen.queryByRole('button', { name: 'ส่งถัง บูธ A1' })).toBeNull();
  expect(screen.getByText(/บูธสิ้นสุดรับถัง/)).not.toBeNull();
});

it('keeps an ended event readable and explains why adding booths and handoffs are unavailable', async () => {
  const api = gateway();
  const ended = { ...event, end_date: '2026-10-03' };
  vi.mocked(api.loadEvents).mockResolvedValue([ended]);
  vi.mocked(api.loadEvent).mockResolvedValue(detail([booth()], ended));
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  await user.click(await screen.findByRole('button', { name: 'จบแล้ว 1' }));
  await openEvent(user);
  expect(screen.queryByRole('button', { name: 'เพิ่มบูธ' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'ส่งถัง บูธ A1' })).toBeNull();
  expect(screen.getByText(/งานจบแล้ว ดูข้อมูลได้ · สิ้นสุด/)).not.toBeNull();
  expect(screen.getByText('ถังอยู่ที่ร้าน', { exact: false })).not.toBeNull();
});

it('rechecks the Bangkok date on submission and refreshes visible status when the app regains focus', async () => {
  vi.setSystemTime(new Date('2026-10-06T16:59:00Z'));
  const api = gateway();
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  await openEvent(user);
  await user.click(screen.getByRole('button', { name: 'ส่งถัง บูธ A1' }));
  vi.setSystemTime(new Date('2026-10-06T17:01:00Z'));
  await user.click(screen.getByRole('button', { name: 'ยืนยันส่งถัง' }));
  expect((await screen.findByRole('alert')).textContent).toContain('งานจบแล้ว');
  expect(api.handoffTanks).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  fireEvent.focus(window);
  await screen.findByText(/งานจบแล้ว ดูข้อมูลได้ · สิ้นสุด/);
  expect(screen.queryByRole('button', { name: 'เพิ่มบูธ' })).toBeNull();
});

it('traps keyboard focus, closes on Escape and restores focus to the handoff button', async () => {
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={gateway()} />);
  await openEvent(user);
  const trigger = screen.getByRole('button', { name: 'ส่งถัง บูธ A1' });
  await user.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole('dialog'));
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'ยืนยันส่งถัง' }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'ปิดหน้าต่าง' }));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).not.toBe('hidden');
});

it('searches an 83-booth event and distinguishes empty results from an empty event', async () => {
  const api = gateway();
  vi.mocked(api.loadEvent).mockResolvedValue(detail(Array.from({ length: 83 }, (_, index) => booth({ id: `b${index}`, booth_number: String(index + 1).padStart(3, '0') }))));
  const user = userEvent.setup();
  render(<EmployeeEventPage gateway={api} />);
  await openEvent(user);
  expect(screen.getByText('83 / 83 บูธ')).not.toBeNull();
  await user.type(screen.getByLabelText('ค้นหาบูธ'), '083');
  expect(screen.getByText('1 / 83 บูธ')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'ส่งถัง บูธ 083' })).not.toBeNull();
  await user.clear(screen.getByLabelText('ค้นหาบูธ'));
  await user.type(screen.getByLabelText('ค้นหาบูธ'), 'หาไม่พบ');
  expect(screen.getByText('ไม่พบบูธที่ค้นหา')).not.toBeNull();
  expect(screen.queryByRole('button', { name: 'เพิ่มบูธแรก' })).toBeNull();
});


it('localizes a real handoff and its success message while preserving booth data and draft across language changes', async () => {
  const api = gateway();
  const user = userEvent.setup();
  window.localStorage.setItem('ice-delivery.language.v1', 'my');
  render(<LanguageProvider><LanguageSwitcher /><EmployeeEventPage gateway={api} /></LanguageProvider>);
  await openEvent(user);
  await user.click(screen.getByRole('button', { name: translateUi('ส่งถัง บูธ {0}', { 0: 'A1' }) }));
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('งานตลาดนัด · ร้านหนึ่ง');
  expect(dialog.textContent).not.toContain('จำนวนถัง');
  const quantity = within(dialog).getByRole('spinbutton');
  fireEvent.change(quantity, { target: { value: '2' } });
  fireEvent.change(document.querySelector('.language-switcher select')!, { target: { value: 'th' } });
  expect(within(dialog).getByRole('spinbutton')).toBe(quantity);
  expect((quantity as HTMLInputElement).value).toBe('2');
  fireEvent.change(document.querySelector('.language-switcher select')!, { target: { value: 'my' } });
  await user.click(within(dialog).getByRole('button', { name: translateUi('ยืนยันส่งถัง') }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const toast = screen.getByRole('status');
  expect(toast.textContent).toContain(translateUi('ส่งถัง {quantity} ใบให้บูธ {booth} แล้ว', { quantity: 2, booth: 'A1' }));
  expect(toast.textContent).not.toMatch(/[ก-๙]/);
  expect(api.handoffTanks).toHaveBeenCalledWith(expect.objectContaining({ participationId: 'booth-1', quantity: 2 }));
  fireEvent.change(document.querySelector('.language-switcher select')!, { target: { value: 'th' } });
  expect(toast.textContent).toContain('ส่งถัง 2 ใบให้บูธ A1 แล้ว');
});
