import { IDBFactory } from 'fake-indexeddb';
import { runOnlineOnlyEmployeeWrite, offlineStore } from '../src/offline/runtime/client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EmployeeCasualCustomerPage } from '../src/features/employee-delivery/EmployeeCasualCustomerPage';

vi.mock('../src/lib/supabase', () => ({ supabase: null }));

function setup(available = 5, attribution = {}, guard = false, record = vi.fn(), scope = 'employee-1') {
  const upload = vi.fn().mockResolvedValue('proof.png');
  const view = render(<EmployeeCasualCustomerPage
    round={{ id: 'round-1', name: 'งานประจำวัน', service_date: '2026-09-25', round_type: 'daily', status: 'open', opened_at: '2026-09-25T00:00:00Z' }}
    requestScope={scope}
    serviceDateLabel="25 ก.ย. 2026"
    loadContext={vi.fn().mockResolvedValue({
      round_id: 'round-1', service_date: '2026-09-25', round_status: 'open', stock_closed: false,
      stock_source: { id: 'holding', code: 'holding', name: 'จุดถือครอง' },
      ...attribution,
      items: [{ ice_type_id: 'ice', code: 'ice', name: 'น้ำแข็ง', unit: 'ถุง', available_quantity: available }], history: [],
    })}
    recordTransaction={guard ? payload => runOnlineOnlyEmployeeWrite(() => record(payload), JSON.stringify({ kind: 'gateway', operation: 'casual', payload })) : record} deleteEvidence={vi.fn()} loadReceipt={vi.fn()}
    onBack={vi.fn()} uploadEvidence={upload} voidTransaction={vi.fn()}
  />);
  return { user: userEvent.setup(), record, upload, view };
}

async function selectIce(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: 'เลือกน้ำแข็ง' });
  await user.click(document.querySelector('.employee-pos-product-grid button') as HTMLButtonElement);
}


const result = { transaction: { receipt_number: 'REC-1' }, receipt: null };
const factory = new IDBFactory();
beforeEach(() => { vi.stubGlobal('indexedDB', factory); });
afterEach(async () => {
  cleanup();
  await offlineStore().close();
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase('ice-employee-work-v1');
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
  vi.unstubAllGlobals();
});
it.each([false, true])('locks an uncertain sale and replays its original payload (guarded: %s)', async (guard) => {
  const { user, record } = setup(5, {}, guard);
  const committed = new Set<string>();
  let first = true;
  record.mockImplementation(async payload => {
    committed.add(payload.idempotencyKey);
    if (first) { first = false; throw new TypeError('Failed to fetch'); }
    return result;
  });
  await selectIce(user);
  await user.type(screen.getByLabelText('ยอดขาย (บาท)'), '50');
  await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
  await screen.findByText('Failed to fetch');
  await user.type(screen.getByLabelText('หมายเหตุ (ไม่บังคับ)'), 'เพิ่มหมายเหตุ');
  await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
  await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
  expect(record.mock.calls[1][0]).toEqual(record.mock.calls[0][0]);
  expect(committed.size).toBe(1);
  await screen.findByText(/บันทึกสำเร็จ/);
  if (guard) expect(await offlineStore().hasPending()).toBe(false);
});
it('locks sale inputs while saving', async () => {
  const { user, record } = setup();
  let release!: (value: typeof result) => void;
  record.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await selectIce(user);
  await user.type(screen.getByLabelText('ยอดขาย (บาท)'), '50');
  await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
  const note = screen.getByLabelText('หมายเหตุ (ไม่บังคับ)') as HTMLTextAreaElement;
  await user.type(note, 'รายการถัดไป');
  expect(note.value).toBe('');
  for (const label of ['ยอดขาย (บาท)', 'หมายเหตุ (ไม่บังคับ)']) expect(screen.getByLabelText(label).hasAttribute('disabled')).toBe(true);
  for (const name of ['แจกฟรี', 'จ่ายทันที', 'โอนเงิน']) expect(screen.getByRole('button', { name, exact: true }).hasAttribute('disabled')).toBe(true);
  await act(async () => { release(result); });
  expect(note.hasAttribute('disabled')).toBe(false);
});
it('clears the evidence control and accepts the same file for the next sale', async () => {
  const { user, record } = setup();
  record.mockResolvedValue(result);
  await selectIce(user);
  await user.type(screen.getByLabelText('ยอดขาย (บาท)'), '50');
  await user.click(screen.getByRole('button', { name: 'โอนเงิน', exact: true }));
  const input = screen.getByLabelText('หลักฐานการชำระ') as HTMLInputElement;
  const sameProof = new File(['proof'], 'proof.png', { type: 'image/png' });
  await user.upload(input, sameProof);
  await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
  await screen.findByText(/บันทึกสำเร็จ/);
  expect(input.files?.length).toBe(0);
  await selectIce(user);
  await user.type(screen.getByLabelText('ยอดขาย (บาท)'), '50');
  await user.upload(input, sameProof);
  await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
  expect(record).toHaveBeenCalledTimes(2);
});

it.each(['cash', 'bank_transfer'])('recovers an uncertain %s sale after remount despite changed stock', async method => {
  const record = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(result);
  const first = setup(5, {}, true, record);
  await selectIce(first.user);
  await first.user.click(screen.getByRole('button', { name: '1', exact: true }));
  await first.user.type(screen.getByLabelText('ยอดขาย (บาท)'), '50');
  if (method === 'bank_transfer') {
    await first.user.click(screen.getByRole('button', { name: 'โอนเงิน', exact: true }));
    await first.user.upload(screen.getByLabelText('หลักฐานการชำระ'), new File(['proof'], 'proof.png', { type: 'image/png' }));
  }
  await first.user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
  await screen.findByText('Failed to fetch');
  first.view.unmount();
  const second = setup(0, { stock_closed: true }, true, record);
  await screen.findByRole('heading', { name: 'เลือกน้ำแข็ง' });
  await second.user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
  await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
  expect(record.mock.calls[1][0]).toEqual(record.mock.calls[0][0]);
  expect(second.upload).not.toHaveBeenCalled();
  await screen.findByText(/บันทึกสำเร็จ/);
  expect(await offlineStore().hasPending()).toBe(false);
});

it('allows correcting a definitively rejected sale with a new identity', async () => {
  const { user, record } = setup();
  record.mockRejectedValueOnce({ code: 'P0001', message: 'สต๊อกไม่พอ' }).mockResolvedValue(result);
  await selectIce(user);
  await user.type(screen.getByLabelText('ยอดขาย (บาท)'), '50');
  await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
  await screen.findByText('สต๊อกไม่พอ');
  await user.type(screen.getByLabelText('หมายเหตุ (ไม่บังคับ)'), 'แก้ไข');
  await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
  await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
  expect(record.mock.calls[1][0].note).toBe('แก้ไข');
  expect(record.mock.calls[1][0].idempotencyKey).not.toBe(record.mock.calls[0][0].idempotencyKey);
});

it('keeps a failed evidence upload editable because no sale was sent', async () => {
  const { user, record, upload } = setup();
  upload.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await selectIce(user);
  await user.type(screen.getByLabelText('ยอดขาย (บาท)'), '50');
  await user.click(screen.getByRole('button', { name: 'โอนเงิน', exact: true }));
  await user.upload(screen.getByLabelText('หลักฐานการชำระ'), new File(['proof'], 'proof.png', { type: 'image/png' }));
  await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
  await screen.findByText('Failed to fetch');
  expect(record).not.toHaveBeenCalled();
  expect(screen.getByLabelText('หลักฐานการชำระ').hasAttribute('disabled')).toBe(false);
  await user.type(screen.getByLabelText('หมายเหตุ (ไม่บังคับ)'), 'แก้ไขหลักฐาน');
  expect((screen.getByLabelText('หมายเหตุ (ไม่บังคับ)') as HTMLTextAreaElement).value).toBe('แก้ไขหลักฐาน');
});

it('does not restore another account\'s uncertain sale', async () => {
  const record = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'));
  const first = setup(5, {}, false, record, 'employee-1');
  await selectIce(first.user);
  await first.user.type(screen.getByLabelText('ยอดขาย (บาท)'), '50');
  await first.user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
  await screen.findByText('Failed to fetch');
  first.view.unmount();
  setup(5, {}, false, record, 'employee-2');
  await screen.findByRole('heading', { name: 'เลือกน้ำแข็ง' });
  expect((screen.getByLabelText('ยอดขาย (บาท)') as HTMLInputElement).value).toBe('');
  expect(screen.getByLabelText('ยอดขาย (บาท)').hasAttribute('disabled')).toBe(false);
  expect(record).toHaveBeenCalledTimes(1);
});
