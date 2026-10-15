import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { FactoryOrderSummary } from '../src/types/app';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: mocks }));
import { FactoryOrderPage } from '../src/FactoryOrderPage';

const truck = { id: 'truck', code: 'TRUCK', name: 'รถบรรทุก', kind: 'truck' as const };
const summary: FactoryOrderSummary = {
  service_date: '2026-10-15',
  order_count: 0,
  ordered_totals: [],
  recent_movements: [],
  locations: [{
    ...truck,
    balances: [
      { ice_type_id: 'small', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 92.5 },
      { ice_type_id: 'large', ice_type_name: 'หลอดใหญ่', unit: 'ถุง', quantity: 1.5 },
    ],
  }],
};

beforeEach(() => {
  const query = { select: vi.fn(), eq: vi.fn(), order: vi.fn() };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockResolvedValue({ data: [truck], error: null });
  mocks.from.mockReturnValue(query);
  mocks.rpc.mockResolvedValue({ data: summary, error: null });
});

it('lets users clear and retype a quantity without a zero reappearing', async () => {
  const user = userEvent.setup();
  render(<FactoryOrderPage />);
  const input = await screen.findByRole<HTMLInputElement>('spinbutton', { name: 'จำนวน หลอดเล็ก' });
  await user.clear(input);
  await user.type(input, '25');
  await user.clear(input);
  expect(input.value).toBe('');
  expect((screen.getByRole('button', { name: 'ยืนยันคำสั่งซื้อ' }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(input, '14');
  expect(input.value).toBe('14');
  expect(input.closest('.factory-order-line')?.querySelector('.stock-number--projected')?.textContent).toContain('106.5');
  await user.click(screen.getByRole('button', { name: 'ยืนยันคำสั่งซื้อ' }));
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('record_factory_order', expect.objectContaining({
    p_items: [{ ice_type_id: 'small', quantity: 14 }],
  })));
  await waitFor(() => expect(input.value).toBe(''));
});

it('starts empty and keeps stepper and quick-add quantities numeric', async () => {
  const user = userEvent.setup();
  render(<FactoryOrderPage />);
  const input = await screen.findByRole<HTMLInputElement>('spinbutton', { name: 'จำนวน หลอดเล็ก' });
  expect(input.value).toBe('');
  expect(input.placeholder).toBe('0');
  await user.type(input, '25');
  expect(input.value).toBe('25');
  await user.click(screen.getByRole('button', { name: 'เพิ่มจำนวน หลอดเล็ก' }));
  expect(input.value).toBe('35');
  await user.clear(input);
  await user.click(screen.getByRole('button', { name: 'เพิ่มจำนวน หลอดเล็ก' }));
  expect(input.value).toBe('10');
  await user.click(screen.getByRole('button', { name: 'ลดจำนวน หลอดเล็ก' }));
  expect(input.value).toBe('');
  expect((screen.getByRole('button', { name: 'ลดจำนวน หลอดเล็ก' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'หลอดเล็ก 50 ถุง' }));
  expect(input.value).toBe('50');
});
