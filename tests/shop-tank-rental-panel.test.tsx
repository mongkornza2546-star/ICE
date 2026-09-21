import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShopTankRentalPanel } from '../src/features/shop-settings/components/ShopTankRentalPanel';
import { toBangkokDateString } from '../src/lib/serviceDate';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../src/lib/env', () => ({ env: { isDemoMode: false } }));
vi.mock('../src/lib/thermalPrinter', () => ({ isAndroidApp: () => false }));
vi.mock('../src/lib/salesDocumentPrint', () => ({ printSalesDocumentForCurrentPlatform: vi.fn(), salesDocumentFromStored: vi.fn() }));
const today = toBangkokDateString();
const rental = { id: 'rental-1', charge_id: 'charge-1', charge_number: 'INV-001', quantity: 3, unit_price: 100,
  total_amount: 300, outstanding_quantity: 2, outstanding_amount: 300, handed_out_on: today, due_on: today, note: '',
  returns: [{ id: 'return-1', quantity: 1, returned_on: today }] };
beforeEach(() => { rpc.mockReset(); rpc.mockResolvedValue({ data: [], error: null }); });
describe('shop one-time tank rentals', () => {
  it('opens a rental with fee total and retries uncertain writes with the same request id', async () => {
    let attempts = 0;
    rpc.mockImplementation(async (name: string) => name === 'create_shop_tank_rental'
      ? (++attempts === 1 ? { error: { message: 'เครือข่ายขัดข้อง' } } : { data: 'r1', error: null })
      : { data: [], error: null });
    const user = userEvent.setup();
    render(<ShopTankRentalPanel shopId="shop-1" isActive shopActive />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'เช่าถังรายครั้ง' }).hasAttribute('disabled')).toBe(false));
    await user.click(screen.getByRole('button', { name: 'เช่าถังรายครั้ง' }));
    await user.clear(screen.getByLabelText('จำนวนถังรายครั้ง')); await user.type(screen.getByLabelText('จำนวนถังรายครั้ง'), '3');
    expect(screen.getByText('ค่าเช่ารวม 300.00 บาท')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'บันทึกเช่าและออกบิล' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('เครือข่ายขัดข้อง'));
    await user.click(screen.getByRole('button', { name: 'บันทึกเช่าและออกบิล' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('ออกบิลแล้ว'));
    const calls = rpc.mock.calls.filter(([name]) => name === 'create_shop_tank_rental');
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0][1]).toMatchObject({ p_shop_id: 'shop-1', p_quantity: 3, p_unit_price: 100, p_handed_out_on: today });
  });
  it('allows partial returns for inactive shops and retains the rental fee', async () => {
    rpc.mockResolvedValue({ data: [rental], error: null });
    const user = userEvent.setup(); render(<ShopTankRentalPanel shopId="shop-1" isActive shopActive={false} />);
    await screen.findByText('INV-001 · ค้าง 2 ใบ');
    expect(screen.getByRole('button', { name: 'เช่าถังรายครั้ง' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'รับคืนถังรายครั้ง' }));
    await user.clear(screen.getByLabelText('จำนวนรับคืน')); await user.type(screen.getByLabelText('จำนวนรับคืน'), '1');
    await user.click(screen.getByRole('button', { name: 'บันทึกรับคืน' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('return_shop_tank_rental', expect.objectContaining({ p_rental_id: 'rental-1', p_quantity: 1, p_returned_on: today })));
    expect(screen.getByText(/ค้างชำระ 300.00 บาท/)).toBeTruthy();
  });
  it('does not load hidden tabs', () => {
    render(<ShopTankRentalPanel shopId="shop-1" isActive={false} shopActive />);
    expect(rpc).not.toHaveBeenCalled();
  });
});
