import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EmployeeCasualCustomerPage } from '../src/features/employee-delivery/EmployeeCasualCustomerPage';

function setup(available = 5, attribution = {}) {
  const record = vi.fn().mockRejectedValue({ code: 'P0001', message: 'test request' });
  render(<EmployeeCasualCustomerPage
    round={{ id: 'round-1', name: 'งานประจำวัน', service_date: '2026-09-25', round_type: 'daily', status: 'open', opened_at: '2026-09-25T00:00:00Z' }}
    serviceDateLabel="25 ก.ย. 2026"
    loadContext={vi.fn().mockResolvedValue({
      round_id: 'round-1', service_date: '2026-09-25', round_status: 'open', stock_closed: false,
      stock_source: { id: 'holding', code: 'holding', name: 'จุดถือครอง' },
      ...attribution,
      items: [{ ice_type_id: 'ice', code: 'ice', name: 'น้ำแข็ง', unit: 'ถุง', available_quantity: available }], history: [],
    })}
    recordTransaction={record} deleteEvidence={vi.fn()} loadReceipt={vi.fn()}
    onBack={vi.fn()} uploadEvidence={vi.fn()} voidTransaction={vi.fn()}
  />);
  return { user: userEvent.setup(), record };
}

async function selectIce(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: 'เลือกน้ำแข็ง' });
  await user.click(document.querySelector('.employee-pos-product-grid button') as HTMLButtonElement);
}

describe('casual customer form', () => {
  it('shows the keypad on selection and records a small cash sale with no quantity', async () => {
    const { user, record } = setup();
    await selectIce(user);
    expect(screen.getByRole('region', { name: 'แป้นใส่จำนวน' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ระบุจำนวน' })).toBeNull();
    await user.type(screen.getByLabelText('ยอดขาย (บาท)'), '5');
    await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
    await waitFor(() => expect(record).toHaveBeenCalledWith(expect.objectContaining({ quantity: 0, saleAmount: 5, receivedAmount: 5, transactionKind: 'paid' })));
  });

  it('allows a free unmeasured issue with no stock and explains its stock effect', async () => {
    const { user, record } = setup(0);
    await selectIce(user);
    await user.click(screen.getByRole('button', { name: 'แจกฟรี', exact: true }));
    expect(screen.getByText('แจกเล็กน้อย ไม่ต้องระบุจำนวน ระบบจะบันทึกแจกฟรีโดยไม่หักสต๊อก')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'ยืนยันแจกฟรี' }));
    await waitFor(() => expect(record).toHaveBeenCalledWith(expect.objectContaining({ quantity: 0, transactionKind: 'free', saleAmount: 0, paymentMethod: null })));
  });

  it('keeps an over-stock quantity visible and blocks submission until corrected', async () => {
    const { user, record } = setup(5);
    await selectIce(user);
    await user.click(screen.getByRole('button', { name: '8', exact: true }));
    expect(document.querySelector('.employee-pos-quantity strong')?.textContent).toBe('8 ถุง');
    expect(screen.getByRole('alert').textContent).toContain('จำนวนเกินสต๊อกคงเหลือ 5 ถุง');
    await user.type(screen.getByLabelText('ยอดขาย (บาท)'), '80');
    await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
    expect(record).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'ลบหนึ่งหลัก' }));
    await user.click(screen.getByRole('button', { name: '4', exact: true }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
    await waitFor(() => expect(record).toHaveBeenCalledWith(expect.objectContaining({ quantity: 4 })));
  });

  it('keeps half a bag when zero is appended and submits the same quantity', async () => {
    const { user, record } = setup(10);
    await selectIce(user);
    await user.click(screen.getByRole('button', { name: 'เพิ่มครึ่งถุง' }));
    await user.click(screen.getByRole('button', { name: '0', exact: true }));
    expect(document.querySelector('.employee-pos-quantity strong')?.textContent).toBe('0.50 ถุง');
    await user.click(screen.getByRole('button', { name: 'แจกฟรี', exact: true }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันแจกฟรี' }));
    await waitFor(() => expect(record).toHaveBeenCalledWith(expect.objectContaining({ quantity: 0.5, transactionKind: 'free' })));
  });

  it('does not round an invalid fractional quantity into a valid sale', async () => {
    const { user, record } = setup();
    await selectIce(user);
    await user.click(screen.getByRole('button', { name: 'เพิ่มครึ่งถุง' }));
    await user.click(screen.getByRole('button', { name: '2', exact: true }));
    expect(document.querySelector('.employee-pos-quantity strong')?.textContent).toBe('0.52 ถุง');
    expect(screen.getByRole('alert').textContent).toContain('ระบุจำนวนทีละ 0.5 ถุง');
    await user.click(screen.getByRole('button', { name: 'แจกฟรี', exact: true }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันแจกฟรี' }));
    expect(record).not.toHaveBeenCalled();
  });

  it('shows the actionable PostgREST error instead of a generic failure', async () => {
    const { user, record } = setup();
    record.mockRejectedValue({ code: 'P0001', message: 'สต๊อกไม่พอสำหรับจำนวนถุงที่รวมจากยอดขายขายสด', details: null, hint: null });
    await selectIce(user);
    await user.type(screen.getByLabelText('ยอดขาย (บาท)'), '100');
    await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
    expect((await screen.findByRole('alert')).textContent).toBe('สต๊อกไม่พอสำหรับจำนวนถุงที่รวมจากยอดขายขายสด');
  });
});


describe('casual building attribution', () => {
  it('requires a building for multi-building work and includes the chosen receiver in a new retry request', async () => {
    const { user, record } = setup(5, {
      sale_buildings: [{ id: 'a', name: 'ตึก A' }, { id: 'b', name: 'ตึก B' }],
      cash_receivers: [{ id: 'admin', name: 'แอดมิน' }, { id: 'courier', name: 'พนักงาน' }],
      default_receiver_id: 'admin',
    });
    await selectIce(user);
    await user.type(screen.getByLabelText('ยอดขาย (บาท)'), '50');
    await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
    expect(record).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText('ตึกที่ขาย'), 'a');
    await user.selectOptions(screen.getByLabelText('ผู้รับเงินจริง'), 'courier');
    await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
    await waitFor(() => expect(record).toHaveBeenCalledWith(expect.objectContaining({ saleBuildingId: 'a', cashReceivedBy: 'courier' })));
    const firstKey = record.mock.calls[0][0].idempotencyKey;
    await user.selectOptions(screen.getByLabelText('ตึกที่ขาย'), 'b');
    await user.click(screen.getByRole('button', { name: 'ยืนยันขายและรับเงิน' }));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
    expect(record.mock.calls[1][0]).toMatchObject({ saleBuildingId: 'b', cashReceivedBy: 'courier' });
    expect(record.mock.calls[1][0].idempotencyKey).not.toBe(firstKey);
  });

  it('defaults the only building and removes the receiver for a free issue', async () => {
    const { user, record } = setup(5, {
      sale_buildings: [{ id: 'a', name: 'ตึก A' }],
      cash_receivers: [{ id: 'courier', name: 'พนักงาน' }], default_receiver_id: 'courier',
    });
    await selectIce(user);
    expect((screen.getByLabelText('ตึกที่ขาย') as HTMLSelectElement).value).toBe('a');
    await user.click(screen.getByRole('button', { name: 'แจกฟรี', exact: true }));
    expect(screen.queryByLabelText('ผู้รับเงินจริง')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'ยืนยันแจกฟรี' }));
    await waitFor(() => expect(record).toHaveBeenCalledWith(expect.objectContaining({ saleBuildingId: 'a', cashReceivedBy: null })));
  });
});
