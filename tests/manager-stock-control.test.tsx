import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerStockControl } from '../src/ManagerStockControl';
import type { DailyStockCloseState, DeliveryRound, StockControlSummary } from '../src/types/app';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../src/lib/supabase', () => ({
  supabase: { rpc: mocks.rpc },
}));

const round: DeliveryRound = {
  id: 'round-1',
  service_date: '2026-07-20',
  name: '04:00',
  status: 'open',
  opened_at: '2026-07-20T04:00:00+07:00',
};

const summary: StockControlSummary = {
  service_date: round.service_date,
  is_snapshot: false,
  snapshot_at: null,
  recent_movements: [],
  locations: [{
    id: 'truck-1',
    code: 'TRUCK',
    name: 'รถบรรทุก',
    kind: 'truck',
    holds_inventory: true,
    requires_daily_count: true,
    is_courier_source: true,
    balances: [{ ice_type_id: 'ice-1', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 20 }],
  }],
};

const openCloseState: DailyStockCloseState = {
  service_date: round.service_date,
  open_round_count: 0,
  is_closed: false,
  closed_at: null,
  closed_by: null,
  note: null,
  counts: [],
};

function mockWorkspace(closeState: DailyStockCloseState = openCloseState) {
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_stock_control_summary') return { data: summary, error: null };
    if (name === 'get_daily_stock_close_state') return { data: closeState, error: null };
    if (name === 'record_location_count_v2') return { data: summary, error: null };
    return { data: null, error: null };
  });
}

describe('ManagerStockControl actual-count workspace', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
  });

  it('loads only the data required by the actual-count page', async () => {
    mockWorkspace();

    render(<ManagerStockControl round={round} serviceDate={round.service_date} />);

    expect(await screen.findByRole('combobox', { name: 'จุดที่ต้องการตรวจนับ' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'ตรวจนับสต๊อกจริง' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'โอนระหว่างจุด' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ปิดสต๊อกและจบงานวันนี้' })).toBeNull();

    const rpcNames = mocks.rpc.mock.calls.map(([name]) => name);
    expect(rpcNames).toEqual([
      'get_stock_control_summary',
      'get_daily_stock_close_state',
    ]);
  });

  it('submits the actual count with an idempotency key', async () => {
    mockWorkspace();
    const user = userEvent.setup();

    render(<ManagerStockControl round={round} serviceDate={round.service_date} />);

    await user.click(await screen.findByRole('button', { name: 'บันทึกผลการนับจริง' }));

    await waitFor(() => {
      expect(mocks.rpc).toHaveBeenCalledWith('record_location_count_v2', {
        p_service_date: round.service_date,
        p_location_id: 'truck-1',
        p_counts: [{ ice_type_id: 'ice-1', actual_quantity: 20 }],
        p_note: null,
        p_idempotency_key: expect.any(String),
      });
    });
    expect(await screen.findByText('บันทึกยอดนับจริงของ “รถบรรทุก” แล้ว')).toBeTruthy();
  });

  it.each([
    ['0.5', 0.5],
    ['1.5', 1.5],
  ])('preserves a typed half-bag count of %s', async (typedValue, expectedValue) => {
    mockWorkspace();
    const user = userEvent.setup();

    render(<ManagerStockControl round={round} serviceDate={round.service_date} />);

    const countInput = await screen.findByRole('textbox', { name: 'ยอดนับจริง หลอดเล็ก' });
    await user.clear(countInput);
    await user.type(countInput, typedValue);
    expect((countInput as HTMLInputElement).value).toBe(typedValue);

    await user.click(screen.getByRole('button', { name: 'บันทึกผลการนับจริง' }));

    await waitFor(() => {
      expect(mocks.rpc).toHaveBeenCalledWith('record_location_count_v2', expect.objectContaining({
        p_counts: [{ ice_type_id: 'ice-1', actual_quantity: expectedValue }],
      }));
    });
  });

  it('keeps a closed day read-only', async () => {
    mockWorkspace({ ...openCloseState, is_closed: true });
    const user = userEvent.setup();

    render(<ManagerStockControl round={round} serviceDate={round.service_date} />);

    const saveButton = await screen.findByRole('button', { name: 'บันทึกผลการนับจริง' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    expect(screen.getByText('สต๊อกของวันนี้ปิดแล้ว ข้อมูลนี้ดูได้อย่างเดียว')).toBeTruthy();

    await user.click(saveButton);
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'record_location_count_v2')).toBe(false);
  });

  it('retries after the close state cannot be verified', async () => {
    let closeStateUnavailable = true;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary') return { data: summary, error: null };
      if (name === 'get_daily_stock_close_state') {
        return closeStateUnavailable
          ? { data: null, error: { message: 'close state unavailable' } }
          : { data: openCloseState, error: null };
      }
      return { data: null, error: null };
    });
    const user = userEvent.setup();

    render(<ManagerStockControl round={round} serviceDate={round.service_date} />);

    expect(await screen.findByRole('combobox', { name: 'จุดที่ต้องการตรวจนับ' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'บันทึกผลการนับจริง' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('ตรวจสอบสถานะการปิดสต๊อกไม่ได้: close state unavailable')).toBeTruthy();

    closeStateUnavailable = false;
    await user.click(screen.getByRole('button', { name: 'ลองตรวจสอบสถานะอีกครั้ง' }));

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'บันทึกผลการนับจริง' }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('reloads stock state whenever its keep-alive view becomes active', async () => {
    mockWorkspace();

    const { rerender } = render(
      <ManagerStockControl isActive round={round} serviceDate={round.service_date} />,
    );
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));

    rerender(<ManagerStockControl isActive={false} round={round} serviceDate={round.service_date} />);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);

    rerender(<ManagerStockControl isActive round={round} serviceDate={round.service_date} />);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(4));
  });

  it('keeps demo counts local instead of writing to Supabase', async () => {
    const user = userEvent.setup();

    render(
      <ManagerStockControl
        demoSummary={summary}
        round={round}
        serviceDate={round.service_date}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'บันทึกผลการนับจริง' }));

    expect(await screen.findByText('บันทึกยอดนับจริงในโหมดตัวอย่างแล้ว')).toBeTruthy();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
