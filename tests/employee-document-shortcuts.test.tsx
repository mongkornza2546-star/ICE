import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { EmployeeDeliveryWorkspace, createSupabaseGateway, type EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';
import type { ShopCard } from '../src/types/app';
const db = vi.hoisted(() => ({ rpc: vi.fn(), listeners: new Set<() => void>() }));
vi.mock('../src/lib/supabase', () => ({ supabase: {
  rpc: db.rpc,
  channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: vi.fn(),
} }));
vi.mock('../src/lib/dataChange', () => ({
  subscribeToDataChange: (_topics: string[], listener: () => void) => {
    db.listeners.add(listener);
    return () => db.listeners.delete(listener);
  },
  publishDataChange: () => { for (const listener of db.listeners) listener(); },
}));
beforeEach(() => { db.rpc.mockReset(); });
const deliveredShop: ShopCard = {
  round_stop_id: 'stop-bb44',
  shop_id: 'shop-bb44',
  shop_code: 'BB44',
  shop_name: 'ร้านใหม่น้ำปั่น (ปุ้ย)',
  building_id: 'building-b',
  building_name: 'B',
  floor_or_zone: 'ซุ้มโดม 3',
  sequence_no: 44,
  image_path: null,
  image_url: null,
  payment_status: 'unpaid',
  stop_status: 'delivered',
  stop_note: null,
  today_history: [],
  today_totals: {},
};

function createGateway(outstandingAmount: number): EmployeeDeliveryGateway {
  return {
    loadReferenceData: vi.fn().mockResolvedValue({
      rounds: [{
        id: 'round-1', service_date: '2026-09-25', name: 'รอบเช้า', status: 'open', opened_at: '2026-09-25T01:00:00Z',
      }],
      iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
    }),
    loadShopCards: vi.fn().mockResolvedValue([deliveredShop]),
    loadCollectionOutstanding: vi.fn().mockResolvedValue(outstandingAmount > 0 ? [{
      queueKey: 'regular:shop-bb44',
      shopId: 'shop-bb44',
      outstandingAmount,
    }] : []),
    loadEmployeeStockState: vi.fn(),
    recordEmployeeStockTransfer: vi.fn(),
    recordEmployeeStockReturn: vi.fn(),
    recordEmployeeStockDamage: vi.fn(),
    recordDelivery: vi.fn(),
    recordImmediateSale: vi.fn(),
  };
}


it('disables missing credit documents, checks the selected date, and refreshes after a new invoice', async () => {
  const user = userEvent.setup();
  let invoices: { charge_id: string }[] = [];
  db.rpc.mockImplementation(async (_name: string, args: { p_service_date: string }) => ({
    data: args.p_service_date === '2026-09-25' ? invoices : [], error: null,
  }));
  const gateway = createGateway(0);
  gateway.loadShopCreditEligibility = createSupabaseGateway().loadShopCreditEligibility;
  const { rerender } = render(<EmployeeDeliveryWorkspace gateway={gateway} serviceDate="2026-09-25" viewMode="pos" />);
  await user.click(await screen.findByRole('button', { name: 'เลือกร้าน BB44 ร้านใหม่น้ำปั่น (ปุ้ย)' }));
  const button = screen.getByRole('button', { name: 'ใบเซ็นเครดิต' });
  await waitFor(() => expect(db.rpc).toHaveBeenCalledWith('get_daily_credit_acknowledgement_details', {
    p_shop_id: 'shop-bb44', p_service_date: '2026-09-25',
  }));
  expect(button.hasAttribute('disabled')).toBe(true);
  invoices = [{ charge_id: 'invoice' }];
  act(() => { for (const listener of db.listeners) listener(); });
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  rerender(<EmployeeDeliveryWorkspace gateway={gateway} serviceDate="2026-09-26" viewMode="pos" />);
  await user.click(await screen.findByRole('button', { name: 'เลือกร้าน BB44 ร้านใหม่น้ำปั่น (ปุ้ย)' }));
  await waitFor(() => expect(db.rpc).toHaveBeenCalledWith('get_daily_credit_acknowledgement_details', {
    p_shop_id: 'shop-bb44', p_service_date: '2026-09-26',
  }));
  expect(screen.getByRole('button', { name: 'ใบเซ็นเครดิต' }).hasAttribute('disabled')).toBe(true);
});

it('reuses scoped billing data across the real document page and back, and refreshes explicitly', async () => {
  const user = userEvent.setup();
  db.rpc.mockResolvedValue({ data: [{ shop_id: 'shop-bb44', shop_code: 'BB44', shop_name: 'ร้านทดสอบ', charges: [], statements: [] }], error: null });
  const gateway = createGateway(0);
  gateway.loadShopBillingAccount = createSupabaseGateway().loadShopBillingAccount;
  render(<EmployeeDeliveryWorkspace gateway={gateway} serviceDate="2026-09-25" viewMode="pos" />);
  await user.click(await screen.findByRole('button', { name: 'เลือกร้าน BB44 ร้านใหม่น้ำปั่น (ปุ้ย)' }));
  const openBilling = async () => {
    const button = screen.getByRole('button', { name: 'ใบวางบิล', exact: true });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    await user.click(button);
    await screen.findByRole('heading', { name: 'BB44 · ร้านทดสอบ' });
  };
  await openBilling();
  await user.click(screen.getByRole('button', { name: 'กลับ', exact: true }));
  await openBilling();
  expect(db.rpc).toHaveBeenCalledTimes(1);
  expect(db.rpc).toHaveBeenCalledWith('get_employee_billing_accounts', { p_shop_id: 'shop-bb44' });
  db.rpc.mockResolvedValue({ data: [], error: null });
  await user.click(screen.getByRole('button', { name: 'รีเฟรชยอดล่าสุด' }));
  expect(await screen.findByText('ไม่มีบิลเครดิตสำหรับวางบิล')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'กลับ', exact: true }));
  expect(screen.getByRole('button', { name: 'ใบวางบิล', exact: true }).hasAttribute('disabled')).toBe(true);
  expect(db.rpc).toHaveBeenCalledTimes(2);
});
