import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { DeliveryRound, StockControlSummary } from '../src/types/app';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
import { ManagerStockControl } from '../src/ManagerStockControl';

const round: DeliveryRound = { id: 'round-1', name: 'วันนี้', service_date: '2026-10-15', status: 'open' };
const balances = [
  { ice_type_id: 'small', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 3.5 },
  { ice_type_id: 'large', ice_type_name: 'หลอดใหญ่', unit: 'ถุง', quantity: 4 },
];
const summary: StockControlSummary = {
  service_date: round.service_date,
  recent_movements: [],
  locations: [
    { id: 'truck', code: 'TRUCK', name: 'รถหลัก', kind: 'truck', holds_inventory: true, is_courier_source: true, balances },
    { id: 'team', code: 'TEAM', name: 'จุดพนักงาน', kind: 'team', holds_inventory: true,
      assigned_employee: { id: 'user', code: 'U', display_name: 'สมชาย' },
      assigned_work_sites: [{ id: 'site', code: 'SITE', name: 'จุดขาย' }],
      balances: balances.map((ice) => ({ ...ice, quantity: 1.5 })) },
  ],
};
const options = [
  { id: 'small', code: 'S', name: 'หลอดเล็ก', unit: 'ถุง', allowHalf: true },
  { id: 'large', code: 'L', name: 'หลอดใหญ่', unit: 'ถุง', allowHalf: false },
];

beforeEach(() => {
  mocks.rpc.mockImplementation(async (name: string) => ({
    data: name === 'get_stock_control_summary' ? summary : name === 'get_daily_aggregate_stock_summary' ? { status: 'open' } : {},
    error: null,
  }));
});

async function openTransfer(selectedRound = round) {
  render(<ManagerStockControl operationRound={selectedRound} round={selectedRound} serviceDate={round.service_date} iceTypeOptions={options} />);
  await screen.findByRole('button', { name: 'เพิ่มเต็มถุง หลอดเล็ก' });
}

it('keeps full and half bag counts separate and submits their combined quantity', async () => {
  const user = userEvent.setup();
  await openTransfer();
  await user.click(screen.getByRole('button', { name: /สมชาย/ }));
  await user.click(screen.getByRole('button', { name: 'เพิ่มเต็มถุง หลอดเล็ก' }));
  await user.click(screen.getByRole('button', { name: 'เพิ่มครึ่งถุง หลอดเล็ก' }));
  await user.click(screen.getByRole('button', { name: 'เพิ่มครึ่งถุง หลอดเล็ก' }));
  expect((screen.getByLabelText('เต็มถุง หลอดเล็ก') as HTMLInputElement).value).toBe('1');
  expect((screen.getByLabelText('ครึ่งถุง หลอดเล็ก') as HTMLInputElement).value).toBe('2');
  expect(screen.getByText('เหลือบนรถ 1.5 ถุง')).toBeTruthy();
  expect(screen.queryByLabelText('ครึ่งถุง หลอดใหญ่')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'ยืนยัน โอนระหว่างจุด' }));
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('record_stock_transfer_v2', expect.objectContaining({
    p_from_location_id: 'truck', p_to_location_id: 'team',
    p_items: [{ ice_type_id: 'small', quantity: 2 }],
  })));
  await waitFor(() => expect((screen.getByLabelText('เต็มถุง หลอดเล็ก') as HTMLInputElement).value).toBe('0'));
  expect((screen.getByLabelText('ครึ่งถุง หลอดเล็ก') as HTMLInputElement).value).toBe('0');
});

it('limits increments, blocks typed overstock, and clears counts when changing source', async () => {
  const user = userEvent.setup();
  await openTransfer();
  await user.click(screen.getByRole('button', { name: /สมชาย/ }));
  fireEvent.change(screen.getByLabelText('เต็มถุง หลอดเล็ก'), { target: { value: '3' } });
  expect((screen.getByRole('button', { name: 'เพิ่มเต็มถุง หลอดเล็ก' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'เพิ่มครึ่งถุง หลอดเล็ก' }));
  expect((screen.getByRole('button', { name: 'เพิ่มครึ่งถุง หลอดเล็ก' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('เต็มถุง หลอดเล็ก'), { target: { value: '4' } });
  expect(screen.getByText('จำนวนเกินสต๊อกคงเหลือ ไม่สามารถบันทึกได้')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'ยืนยัน โอนระหว่างจุด' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(screen.getByRole('button', { name: 'ยืนยัน โอนระหว่างจุด' }).closest('form')!);
  expect(mocks.rpc.mock.calls.some(([name]) => name === 'record_stock_transfer_v2')).toBe(false);
  await user.selectOptions(screen.getByLabelText('ต้นทาง (จาก)'), 'team');
  expect((screen.getByLabelText('เต็มถุง หลอดเล็ก') as HTMLInputElement).value).toBe('0');
  expect((screen.getByLabelText('ครึ่งถุง หลอดเล็ก') as HTMLInputElement).value).toBe('0');
  expect(screen.getAllByText('เหลือที่ถือ 1.5 ถุง')).toHaveLength(2);
});

it('replaces bag selection with the daily closing summary after stock is closed', async () => {
  const stock = { service_date: round.service_date, status: 'closed', items: [] };
  mocks.rpc.mockImplementation(async (name: string) => ({
    data: name === 'get_daily_aggregate_stock_summary' ? stock
      : name === 'get_daily_close_reconciliation' ? { stock, employees: [], feature_enabled: false } : [],
    error: null,
  }));
  render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);
  await screen.findByText(/ปิดสต๊อกรวมวันที่/);
  expect(screen.queryByLabelText('เต็มถุง หลอดเล็ก')).toBeNull();
  expect(screen.queryByRole('button', { name: 'ยืนยัน โอนระหว่างจุด' })).toBeNull();
});

it('replays the exact pending request after a lost response even when refreshed stock is lower', async () => {
  const user = userEvent.setup();
  let committed = false;
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'record_stock_transfer_v2') {
      if (committed) return { data: {}, error: null };
      committed = true;
      throw new Error('Network response lost');
    }
    if (name === 'get_stock_control_summary') return {
      data: committed ? { ...summary, locations: summary.locations.map((location) => location.id === 'truck'
        ? { ...location, balances: location.balances.map((ice) => ice.ice_type_id === 'small' ? { ...ice, quantity: 0.5 } : ice) }
        : location) } : summary,
      error: null,
    };
    return { data: { status: 'open' }, error: null };
  });
  const view = render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} iceTypeOptions={options} refreshId={0} />);
  await screen.findByRole('button', { name: 'เพิ่มเต็มถุง หลอดเล็ก' });
  await user.click(screen.getByRole('button', { name: /สมชาย/ }));
  fireEvent.change(screen.getByLabelText('เต็มถุง หลอดเล็ก'), { target: { value: '3' } });
  await user.click(screen.getByRole('button', { name: 'ยืนยัน โอนระหว่างจุด' }));
  await screen.findByText('Network response lost');
  view.rerender(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} iceTypeOptions={options} refreshId={1} />);
  await screen.findByText('เหลือบนรถ -2.5 ถุง');

  // A different payload must not inherit the old request's overstock exemption.
  fireEvent.change(screen.getByLabelText('หมายเหตุเพิ่มเติม (ถ้ามี)'), { target: { value: 'changed' } });
  const changedSubmit = screen.getByRole('button', { name: 'ยืนยัน โอนระหว่างจุด' });
  expect((changedSubmit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(changedSubmit.closest('form')!);
  expect(mocks.rpc.mock.calls.filter(([name]) => name === 'record_stock_transfer_v2')).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('หมายเหตุเพิ่มเติม (ถ้ามี)'), { target: { value: '' } });

  const retry = screen.getByRole('button', { name: 'ตรวจสอบผลรายการเดิม' });
  expect((retry as HTMLButtonElement).disabled).toBe(false);
  await user.click(retry);
  await waitFor(() => expect((screen.getByLabelText('เต็มถุง หลอดเล็ก') as HTMLInputElement).value).toBe('0'));
  const calls = mocks.rpc.mock.calls.filter(([name]) => name === 'record_stock_transfer_v2');
  expect(calls).toHaveLength(2);
  expect(calls[0][1].p_idempotency_key).toBeTruthy();
  expect(calls[1][1]).toEqual(calls[0][1]);
});

it('uses the real stock unit in the picker and summary without changing the submitted quantity', async () => {
  const user = userEvent.setup();
  const rowSummary = { ...summary, locations: summary.locations.map((location) => ({ ...location,
    balances: location.balances.filter((ice) => ice.ice_type_id === 'small').map((ice) => ({ ...ice, unit: 'แถว', ice_type_name: 'น้ำแข็งก้อน', quantity: 4 })),
  })) };
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name === 'get_stock_control_summary' ? rowSummary : { status: 'open' }, error: null }));
  render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} iceTypeOptions={options.map((ice) => ({ ...ice, allowHalf: false }))} />);
  await screen.findByRole('button', { name: 'เพิ่มเต็มแถว น้ำแข็งก้อน' });
  await user.click(screen.getByRole('button', { name: /สมชาย/ }));
  await user.click(screen.getByRole('button', { name: 'เพิ่มเต็มแถว น้ำแข็งก้อน' }));
  expect(screen.getByText('เหลือบนรถ 3 แถว')).toBeTruthy();
  expect(screen.queryByLabelText('ครึ่งแถว น้ำแข็งก้อน')).toBeNull();
  expect(screen.queryByText(/ถุง/)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'ยืนยัน โอนระหว่างจุด' }));
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('record_stock_transfer_v2', expect.objectContaining({
    p_items: [{ ice_type_id: 'small', quantity: 1 }],
  })));
});
