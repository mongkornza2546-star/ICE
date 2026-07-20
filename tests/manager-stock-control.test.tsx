import { render, screen, waitFor, within } from '@testing-library/react';
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

const closedOperationRound: DeliveryRound = {
  ...round,
  id: 'round-closed',
  status: 'closed',
  closed_at: '2026-07-20T08:00:00+07:00',
};

const summary: StockControlSummary = {
  service_date: round.service_date,
  is_snapshot: false,
  snapshot_at: null,
  locations: [
    {
      id: 'truck-1',
      code: 'TRUCK',
      name: 'รถบรรทุก',
      kind: 'truck',
      balances: [{ ice_type_id: 'ice-1', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 20 }],
    },
    {
      id: 'site-1',
      code: 'A',
      name: 'A · จุดปฏิบัติงาน',
      kind: 'work_site',
      balances: [{ ice_type_id: 'ice-1', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 5 }],
    },
  ],
  recent_movements: [],
};

const closeState: DailyStockCloseState = {
  service_date: round.service_date,
  open_round_count: 1,
  is_closed: false,
  closed_at: null,
  closed_by: null,
  note: null,
  counts: [],
};

describe('ManagerStockControl movement tabs', () => {
  beforeEach(() => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary' || name === 'record_stock_movement') {
        return { data: summary, error: null };
      }
      if (name === 'get_location_count_history') return { data: [], error: null };
      if (name === 'get_daily_stock_close_state') return { data: closeState, error: null };
      return { data: null, error: null };
    });
  });

  it('submits a transfer with different source and destination locations', async () => {
    const { user, form } = await renderMovementForm('โอนระหว่างจุด');
    await user.type(within(form).getByRole('spinbutton'), '2');
    await user.click(within(form).getByRole('button', { name: 'ยืนยัน โอนระหว่างจุด' }));

    await expectMovementPayload({
      p_kind: 'transfer',
      p_from_location_id: 'truck-1',
      p_to_location_id: 'site-1',
    });
  });

  it('submits a factory receipt with no source and an active truck destination', async () => {
    const { user, form } = await renderMovementForm('รับจากโรงงาน');
    expect(within(form).queryByRole('combobox', { name: 'ต้นทาง (จาก)' })).toBeNull();
    expect((within(form).getByRole('combobox', { name: 'รถบรรทุกที่รับน้ำแข็ง' }) as HTMLSelectElement).value).toBe('truck-1');
    await user.type(within(form).getByRole('spinbutton'), '3');
    await user.click(within(form).getByRole('button', { name: 'ยืนยัน รับจากโรงงาน' }));

    await expectMovementPayload({
      p_kind: 'factory_order',
      p_from_location_id: null,
      p_to_location_id: 'truck-1',
    });
  });

  it('submits damage with a source, no destination, and a required note', async () => {
    const { user, form } = await renderMovementForm('เสียหาย / ละลาย');
    expect(within(form).queryByRole('combobox', { name: 'ปลายทาง (ไปยัง)' })).toBeNull();
    await user.type(within(form).getByRole('spinbutton'), '1');
    await user.type(within(form).getByPlaceholderText('เช่น ถุงแตกหรือละลายระหว่างรอส่ง'), 'ถุงแตก');
    await user.click(within(form).getByRole('button', { name: 'ยืนยัน เสียหาย / ละลาย' }));

    await expectMovementPayload({
      p_kind: 'damage',
      p_from_location_id: 'truck-1',
      p_to_location_id: null,
      p_note: 'ถุงแตก',
    });
  });

  it('keeps manual factory returns available and limits the source to trucks', async () => {
    const { user, form } = await renderMovementForm('ส่งคืนโรงงาน');
    const source = within(form).getByRole('combobox', { name: 'ต้นทาง (จาก)' }) as HTMLSelectElement;
    expect(Array.from(source.options).map((option) => option.value)).toEqual(['', 'truck-1']);
    await user.type(within(form).getByRole('spinbutton'), '4');
    await user.click(within(form).getByRole('button', { name: 'ยืนยัน ส่งคืนโรงงาน' }));

    await expectMovementPayload({
      p_kind: 'return_to_factory',
      p_from_location_id: 'truck-1',
      p_to_location_id: null,
    });
  });

  it('explains that the integrated factory receipt requires an open round', async () => {
    const user = userEvent.setup();
    render(<ManagerStockControl operationRound={closedOperationRound} round={null} serviceDate={round.service_date} />);
    await screen.findByRole('heading', { name: 'สต๊อกปัจจุบันของวัน' });
    await user.click(screen.getByRole('button', { name: 'รับจากโรงงาน' }));
    const submitButton = screen.getByRole('button', { name: 'ยืนยัน รับจากโรงงาน' });
    const form = submitButton.closest('form') as HTMLFormElement;
    await user.type(within(form).getByRole('spinbutton'), '2');
    await user.click(submitButton);

    expect(await within(form).findByText('ต้องมีรอบส่งที่เปิดอยู่ก่อนรับน้ำแข็งจากโรงงานในหน้านี้')).toBeTruthy();
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'record_stock_movement')).toBe(false);
  });

  it('labels live stock as day-wide and refreshes it on demand', async () => {
    const user = userEvent.setup();
    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);

    expect(await screen.findByRole('heading', { name: 'สต๊อกปัจจุบันของวัน' })).toBeTruthy();
    const summaryCallsBeforeRefresh = mocks.rpc.mock.calls.filter(([name]) => name === 'get_stock_control_summary').length;
    await user.click(screen.getByRole('button', { name: 'รีเฟรชข้อมูลสต๊อก' }));

    await waitFor(() => {
      const calls = mocks.rpc.mock.calls.filter(([name]) => name === 'get_stock_control_summary');
      expect(calls).toHaveLength(summaryCallsBeforeRefresh + 1);
    });
  });
});

async function renderMovementForm(tabName: string) {
  const user = userEvent.setup();
  render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);
  await screen.findByRole('heading', { name: 'สต๊อกปัจจุบันของวัน' });
  await user.click(screen.getByRole('button', { name: tabName }));
  const submitButton = screen.getByRole('button', { name: `ยืนยัน ${tabName}` });
  return { user, form: submitButton.closest('form') as HTMLFormElement };
}

async function expectMovementPayload(expected: Record<string, unknown>) {
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
    'record_stock_movement',
    expect.objectContaining({
      ...expected,
      p_round_id: round.id,
      p_items: [{ ice_type_id: 'ice-1', quantity: expect.any(Number) }],
      p_idempotency_key: expect.any(String),
    }),
  ));
}
