import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerStockControl } from '../src/ManagerStockControl';
import type {
  DailyStockCloseState,
  DeliveryRound,
  StockControlSummary,
  StockCountReadiness,
} from '../src/types/app';

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
  locations: [
    {
      id: 'truck-1',
      code: 'TRUCK',
      name: 'รถบรรทุก',
      kind: 'truck',
      holds_inventory: true,
      requires_daily_count: true,
      is_courier_source: true,
      balances: [{ ice_type_id: 'ice-1', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 20 }],
    },
    {
      id: 'site-1',
      code: 'A',
      name: 'A · จุดปฏิบัติงาน',
      kind: 'work_site',
      holds_inventory: false,
      requires_daily_count: false,
      is_courier_source: false,
      balances: [{ ice_type_id: 'ice-1', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 0 }],
    },
    {
      id: 'team-1',
      code: 'TEAM-1',
      name: 'รถเข็นสมชาย',
      kind: 'team',
      holds_inventory: true,
      requires_daily_count: true,
      is_courier_source: false,
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

const closeReadyState: DailyStockCloseState = {
  ...closeState,
  open_round_count: 0,
};

const currentReadiness: StockCountReadiness[] = summary.locations
  .filter((location) => location.holds_inventory && location.requires_daily_count)
  .map((location) => ({
  location_id: location.id,
  location_name: location.name,
  status: 'current',
  snapshot: {
    id: `count-${location.id}`,
    counted_at: '2026-07-20T18:00:00+07:00',
    note: null,
    location_id: location.id,
    location_name: location.name,
    counted_by: 'หัวหน้าทดสอบ',
    items: location.balances.map((balance) => ({
      ice_type_id: balance.ice_type_id,
      ice_type_name: balance.ice_type_name,
      unit: balance.unit,
      system_quantity: balance.quantity,
      actual_quantity: balance.quantity,
      variance_quantity: 0,
    })),
  },
  }));

describe('ManagerStockControl movement tabs', () => {
  beforeEach(() => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary' || name === 'record_stock_transfer_v2') {
        return { data: summary, error: null };
      }
      if (name === 'get_location_count_history') return { data: [], error: null };
      if (name === 'get_daily_stock_count_readiness') return { data: [], error: null };
      if (name === 'get_daily_stock_close_state') return { data: closeState, error: null };
      if (name === 'get_stock_count_variance_reviews') return { data: [], error: null };
      return { data: null, error: null };
    });
  });

  it('submits a transfer with different source and destination locations', async () => {
    const { user, form } = await renderMovementForm('โอนระหว่างจุด');
    await user.click(within(form).getByRole('button', { name: /รถเข็นสมชาย/ }));
    await user.type(within(form).getByRole('spinbutton'), '2');
    await user.click(within(form).getByRole('button', { name: 'ยืนยัน โอนระหว่างจุด' }));

    await expectMovementPayload({
      p_kind: 'transfer',
      p_from_location_id: 'truck-1',
      p_to_location_id: 'team-1',
    });
  });

  it('keeps only inventory holders available as transfer sources', async () => {
    const { user, form } = await renderMovementForm('โอนระหว่างจุด');
    const source = within(form).getByRole('combobox', { name: 'ต้นทาง (จาก)' }) as HTMLSelectElement;

    expect(Array.from(source.options).map((option) => option.value)).toEqual(['', 'truck-1', 'team-1']);
    expect(within(form).queryByRole('combobox', { name: 'ปลายทาง (ไปยัง)' })).toBeNull();

    await user.selectOptions(source, 'team-1');
    await user.click(within(form).getByRole('button', { name: /รถบรรทุก/ }));
    await user.type(within(form).getByRole('spinbutton'), '2');
    await user.click(within(form).getByRole('button', { name: 'ยืนยัน โอนระหว่างจุด' }));

    await expectMovementPayload({
      p_kind: 'transfer',
      p_from_location_id: 'team-1',
      p_to_location_id: 'truck-1',
    });
  });

  it('clears the selected destination after a successful transfer', async () => {
    const { user, form } = await renderMovementForm('โอนระหว่างจุด');
    await user.click(within(form).getByRole('button', { name: /รถเข็นสมชาย/ }));
    await user.type(within(form).getByRole('spinbutton'), '2');
    await user.click(within(form).getByRole('button', { name: 'ยืนยัน โอนระหว่างจุด' }));

    expect(await within(form).findByText('เลือกจุดรับสต๊อกเพื่อเริ่มรายการ')).toBeTruthy();
    expect((within(form).getByRole('button', { name: 'ยืนยัน โอนระหว่างจุด' }) as HTMLButtonElement).disabled).toBe(true);
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

  it('labels live stock as day-wide and refreshes it on demand', async () => {
    const user = userEvent.setup();
    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);

    await screen.findByRole('heading', { name: 'เลือกต้นทางและจุดรับสต๊อก' });
    await user.click(screen.getByRole('button', { name: 'เสียหาย / ละลาย' }));
    expect(await screen.findByRole('heading', { name: 'สต๊อกปัจจุบันของวัน' })).toBeTruthy();
    const summaryCallsBeforeRefresh = mocks.rpc.mock.calls.filter(([name]) => name === 'get_stock_control_summary').length;
    await user.click(screen.getByRole('button', { name: 'รีเฟรชข้อมูลสต๊อก' }));

    await waitFor(() => {
      const calls = mocks.rpc.mock.calls.filter(([name]) => name === 'get_stock_control_summary');
      expect(calls).toHaveLength(summaryCallsBeforeRefresh + 1);
    });
  });

  it('renders joined variance metadata and submits a final review', async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary') return { data: summary, error: null };
      if (name === 'get_location_count_history') return { data: [], error: null };
      if (name === 'get_daily_stock_count_readiness') return { data: [], error: null };
      if (name === 'get_daily_stock_close_state') return { data: closeState, error: null };
      if (name === 'get_stock_count_variance_reviews') {
        return {
          data: [{
            id: 'review-1',
            service_date: round.service_date,
            location_id: 'team-1',
            location_name: 'รถเข็นสมชาย',
            ice_type_id: 'ice-1',
            ice_type_name: 'หลอดเล็ก',
            unit: 'ถุง',
            system_quantity: 5,
            actual_quantity: 4.5,
            variance_quantity: -0.5,
            status: 'pending',
            created_at: '2026-07-20T18:00:00+07:00',
          }],
          error: null,
        };
      }
      return { data: null, error: null };
    });

    const user = userEvent.setup();
    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);

    await user.click(await screen.findByRole('button', { name: 'เปิดตรวจสอบ' }));
    expect(screen.getByRole('dialog').textContent).toContain('รถเข็นสมชาย · หลอดเล็ก');
    expect(screen.getByRole('dialog').textContent).toContain('-0.5 ถุง');
    await user.click(screen.getByRole('button', { name: 'อนุมัติยอด (Approve)' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'approve_stock_count_variance',
      { p_review_id: 'review-1', p_status: 'approved', p_note: null },
    ));
  });

  it('reuses the count idempotency key when the same count is retried', async () => {
    let countAttempts = 0;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary') return { data: summary, error: null };
      if (name === 'get_location_count_history') return { data: [], error: null };
      if (name === 'get_daily_stock_count_readiness') return { data: [], error: null };
      if (name === 'get_daily_stock_close_state') return { data: closeState, error: null };
      if (name === 'get_stock_count_variance_reviews') return { data: [], error: null };
      if (name === 'record_location_count_v2') {
        countAttempts += 1;
        return countAttempts === 1
          ? { data: null, error: { message: 'network timeout' } }
          : { data: summary, error: null };
      }
      return { data: null, error: null };
    });

    const user = userEvent.setup();
    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);
    await user.click(await screen.findByRole('button', { name: 'ตรวจนับจริง' }));
    const saveButton = screen.getByRole('button', { name: 'บันทึกผลการนับจริง' });

    await user.click(saveButton);
    expect(await screen.findByText(/network timeout/)).toBeTruthy();
    await user.click(saveButton);

    await waitFor(() => {
      const calls = mocks.rpc.mock.calls.filter(([name]) => name === 'record_location_count_v2');
      expect(calls).toHaveLength(2);
      expect(calls[0][1].p_idempotency_key).toEqual(expect.any(String));
      expect(calls[1][1].p_idempotency_key).toBe(calls[0][1].p_idempotency_key);
    });
  });
});

describe('ManagerStockControl daily close', () => {
  beforeEach(() => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary') return { data: summary, error: null };
      if (name === 'get_location_count_history') return { data: [], error: null };
      if (name === 'get_daily_stock_count_readiness') return { data: currentReadiness, error: null };
      if (name === 'get_daily_stock_close_state') return { data: closeReadyState, error: null };
      if (name === 'get_stock_count_variance_reviews') return { data: [], error: null };
      if (name === 'close_daily_stock_from_latest_counts') return { data: closeReadyState, error: null };
      return { data: null, error: null };
    });
  });

  it('closes from current server-side count snapshots without sending client-computed counts', async () => {
    const user = userEvent.setup();
    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);

    const closeButton = await screen.findByRole('button', { name: 'ปิดสต๊อกวันนี้' });
    expect((closeButton as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('checkbox', { name: /หัวหน้างานยืนยัน/ })).toBeNull();
    await user.click(closeButton);

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'close_daily_stock_from_latest_counts',
      expect.objectContaining({
        p_service_date: round.service_date,
        p_use_system_for_uncounted: false,
        p_idempotency_key: expect.any(String),
      }),
    ));
    const closeCall = mocks.rpc.mock.calls.find(([name]) => name === 'close_daily_stock_from_latest_counts');
    expect(closeCall?.[1]).not.toHaveProperty('p_counts');
  });

  it('requires an explicit override for missing or stale counts', async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary') return { data: summary, error: null };
      if (name === 'get_location_count_history') return { data: [], error: null };
      if (name === 'get_daily_stock_count_readiness') {
        return {
          data: [
            currentReadiness[0],
            { ...currentReadiness[1], status: 'stale' },
          ],
          error: null,
        };
      }
      if (name === 'get_daily_stock_close_state') return { data: closeReadyState, error: null };
      if (name === 'get_stock_count_variance_reviews') return { data: [], error: null };
      if (name === 'close_daily_stock_from_latest_counts') return { data: closeReadyState, error: null };
      return { data: null, error: null };
    });
    const user = userEvent.setup();
    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);

    expect(await screen.findByText(/ต้องตรวจใหม่/)).toBeTruthy();
    const closeButton = screen.getByRole('button', { name: 'ปิดสต๊อกวันนี้' });
    const override = screen.getByRole('checkbox', { name: /หัวหน้างานยืนยัน/ });
    expect((closeButton as HTMLButtonElement).disabled).toBe(true);
    await user.click(override);
    expect((closeButton as HTMLButtonElement).disabled).toBe(false);
    await user.click(closeButton);

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'close_daily_stock_from_latest_counts',
      expect.objectContaining({ p_use_system_for_uncounted: true }),
    ));
  });

  it('resets the uncounted override when the service date changes', async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary') return { data: summary, error: null };
      if (name === 'get_location_count_history') return { data: [], error: null };
      if (name === 'get_daily_stock_count_readiness') return { data: [], error: null };
      if (name === 'get_daily_stock_close_state') return { data: closeReadyState, error: null };
      if (name === 'get_stock_count_variance_reviews') return { data: [], error: null };
      return { data: null, error: null };
    });
    const user = userEvent.setup();
    const { rerender } = render(
      <ManagerStockControl operationRound={null} round={null} serviceDate={round.service_date} />,
    );

    const override = await screen.findByRole('checkbox', { name: /หัวหน้างานยืนยัน/ });
    await user.click(override);
    expect((override as HTMLInputElement).checked).toBe(true);

    rerender(<ManagerStockControl operationRound={null} round={null} serviceDate="2026-07-21" />);
    await waitFor(() => {
      const checkbox = screen.getByRole('checkbox', { name: /หัวหน้างานยืนยัน/ }) as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
    });
  });
});

async function renderMovementForm(tabName: string) {
  const user = userEvent.setup();
  render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);
  await screen.findByRole('heading', { name: 'เลือกต้นทางและจุดรับสต๊อก' });
  await user.click(screen.getByRole('button', { name: tabName }));
  const submitButton = screen.getByRole('button', { name: `ยืนยัน ${tabName}` });
  return { user, form: submitButton.closest('form') as HTMLFormElement };
}

async function expectMovementPayload(expected: Record<string, any>) {
  const { p_kind, ...rest } = expected;
  const expectedPurpose = p_kind === 'transfer' ? 'auto' : p_kind;

  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
    'record_stock_transfer_v2',
    expect.objectContaining({
      ...rest,
      p_purpose: expectedPurpose,
      p_service_date: round.service_date,
      p_items: [{ ice_type_id: 'ice-1', quantity: expect.any(Number) }],
      p_idempotency_key: expect.any(String),
    }),
  ));
}
