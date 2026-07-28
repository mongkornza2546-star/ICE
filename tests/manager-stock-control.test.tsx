import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerStockControl } from '../src/ManagerStockControl';
import type {
  DailyStockCloseState,
  DeliveryRound,
  StockControlSummary,
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
      assigned_employees: [{ id: 'employee-1', code: 'EMP-1', display_name: 'สมชาย ใจดี' }],
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
      assigned_employee: { id: 'employee-1', code: 'EMP-1', display_name: 'สมชาย ใจดี' },
      assigned_work_sites: [{ id: 'site-1', code: 'A', name: 'A · จุดปฏิบัติงาน' }],
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

const aggregateSummary = {
  service_date: round.service_date,
  status: 'open',
  items: [{
    ice_type_id: 'ice-1',
    code: 'SMALL',
    name: 'หลอดเล็ก',
    unit: 'ถุง',
    ordered_quantity: 30,
    sold_quantity: 5,
    refill_quantity: 0,
    damaged_quantity: 0,
    returned_quantity: 0,
    available_quantity: 25,
  }],
};

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
      if (name === 'get_daily_aggregate_stock_summary') {
        return { data: aggregateSummary, error: null };
      }
      return { data: null, error: null };
    });
  });

  it('submits a transfer with different source and destination locations', async () => {
    const { user, form } = await renderMovementForm('โอนระหว่างจุด');
    await user.click(within(form).getByRole('button', { name: /สมชาย ใจดี/ }));
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

  it('returns stock from the responsible person to the truck', async () => {
    const { user, form } = await renderMovementForm('โอนระหว่างจุด');

    await user.click(within(form).getByRole('button', { name: 'คืนของ' }));

    const source = within(form).getByRole('combobox', { name: 'คืนจาก (ผู้รับผิดชอบ)' }) as HTMLSelectElement;
    expect(source.value).toBe('team-1');

    await user.type(within(form).getByRole('spinbutton'), '2');
    await user.click(within(form).getByRole('button', { name: 'ยืนยัน คืนของเข้ารถบรรทุก' }));

    await expectMovementPayload({
      p_kind: 'transfer',
      p_from_location_id: 'team-1',
      p_to_location_id: 'truck-1',
    });
  });

  it('returns to the normal transfer flow from the return-to-truck flow', async () => {
    const { user, form } = await renderMovementForm('โอนระหว่างจุด');

    await user.click(within(form).getByRole('button', { name: 'คืนของ' }));
    await user.click(within(form).getByRole('button', { name: 'กลับไปโอนของปกติ' }));

    expect(within(form).getByRole('combobox', { name: 'ต้นทาง (จาก)' })).toBeTruthy();
    expect(within(form).getByRole('button', { name: 'คืนของ' })).toBeTruthy();
  });

  it('selects the configured courier-source truck before another truck', async () => {
    const otherTruck = {
      ...summary.locations[0],
      id: 'truck-2',
      code: 'TRUCK-2',
      name: 'รถสำรอง',
      is_courier_source: false,
    };
    const summaryWithAnotherTruck = {
      ...summary,
      locations: [otherTruck, ...summary.locations],
    };
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary') return { data: summaryWithAnotherTruck, error: null };
      if (name === 'get_location_count_history') return { data: [], error: null };
      if (name === 'get_daily_stock_count_readiness') return { data: [], error: null };
      if (name === 'get_daily_stock_close_state') return { data: closeState, error: null };
      if (name === 'get_stock_count_variance_reviews') return { data: [], error: null };
      return { data: null, error: null };
    });

    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);

    const source = await screen.findByRole('combobox', { name: 'ต้นทาง (จาก)' }) as HTMLSelectElement;
    expect(source.value).toBe('truck-1');
    expect(Array.from(source.options).map((option) => option.value)).not.toContain('truck-2');
    expect(screen.getByRole('button', { name: /สมชาย ใจดี/ })).toBeTruthy();
  });

  it('selects an eligible employee holder when no courier-source truck is configured', async () => {
    const secondTeam = {
      ...summary.locations[2],
      id: 'team-2',
      code: 'TEAM-2',
      name: 'รถเข็นสมหญิง',
      assigned_employee: { id: 'employee-2', code: 'EMP-2', display_name: 'สมหญิง จันทร์' },
      balances: [{ ice_type_id: 'ice-1', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 3 }],
    };
    const secondTruck = {
      ...summary.locations[0],
      id: 'truck-2',
      code: 'TRUCK-2',
      name: 'รถสำรอง',
      is_courier_source: false,
    };
    const summaryWithoutCourierSource = {
      ...summary,
      locations: [
        secondTruck,
        { ...summary.locations[0], is_courier_source: false },
        summary.locations[1],
        summary.locations[2],
        secondTeam,
      ],
    };
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary') return { data: summaryWithoutCourierSource, error: null };
      if (name === 'get_location_count_history') return { data: [], error: null };
      if (name === 'get_daily_stock_count_readiness') return { data: [], error: null };
      if (name === 'get_daily_stock_close_state') return { data: closeState, error: null };
      if (name === 'get_stock_count_variance_reviews') return { data: [], error: null };
      return { data: summaryWithoutCourierSource, error: null };
    });

    const user = userEvent.setup();
    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);

    const source = await screen.findByRole('combobox', { name: 'ต้นทาง (จาก)' }) as HTMLSelectElement;
    expect(Array.from(source.options).map((option) => option.value)).toEqual(['', 'team-1', 'team-2']);
    expect(source.value).toBe('team-1');

    await user.click(screen.getByRole('button', { name: /สมหญิง จันทร์/ }));
    await user.type(screen.getByRole('spinbutton'), '1');
    await user.click(screen.getByRole('button', { name: 'ยืนยัน โอนระหว่างจุด' }));

    await expectMovementPayload({
      p_kind: 'transfer',
      p_from_location_id: 'team-1',
      p_to_location_id: 'team-2',
    });
  });

  it('keeps an unassigned holder return-only', async () => {
    const retiredHolder = {
      ...summary.locations[2],
      id: 'team-retired',
      code: 'TEAM-RETIRED',
      name: 'จุดถือครองที่ยกเลิก',
      assigned_employee: undefined,
      assigned_work_sites: [],
    };
    const summaryWithRetiredHolder = {
      ...summary,
      locations: [...summary.locations, retiredHolder],
    };
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary') return { data: summaryWithRetiredHolder, error: null };
      if (name === 'get_location_count_history') return { data: [], error: null };
      if (name === 'get_daily_stock_count_readiness') return { data: [], error: null };
      if (name === 'get_daily_stock_close_state') return { data: closeState, error: null };
      if (name === 'get_stock_count_variance_reviews') return { data: [], error: null };
      return { data: summaryWithRetiredHolder, error: null };
    });

    const user = userEvent.setup();
    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);

    expect(await screen.findByRole('button', { name: /สมชาย ใจดี/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /จุดถือครองที่ยกเลิก/ })).toBeNull();

    const source = screen.getByRole('combobox', { name: 'ต้นทาง (จาก)' });
    await user.selectOptions(source, 'team-retired');
    expect(screen.getByRole('button', { name: /รถบรรทุก/ })).toBeTruthy();
  });

  it('shows a holder nickname without exposing its code or email', async () => {
    const holder = {
      ...summary.locations[2],
      code: 'HOLDER-SECRET-123',
      name: 'holder@example.com',
      assigned_employee: { id: 'employee-1', code: 'EMP-1', display_name: 'สมชาย ใจดี', nickname: 'ชาย' },
    };
    const summaryWithNamedHolder = { ...summary, locations: [summary.locations[0], summary.locations[1], holder] };
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary') return { data: summaryWithNamedHolder, error: null };
      if (name === 'get_location_count_history') return { data: [], error: null };
      if (name === 'get_daily_stock_count_readiness') return { data: [], error: null };
      if (name === 'get_daily_stock_close_state') return { data: closeState, error: null };
      if (name === 'get_stock_count_variance_reviews') return { data: [], error: null };
      return { data: null, error: null };
    });

    const user = userEvent.setup();
    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);

    const recipient = await screen.findByRole('button', { name: /ชาย/ });
    expect(within(recipient).queryByText('HOLDER-SECRET-123')).toBeNull();
    expect(within(recipient).queryByText('holder@example.com')).toBeNull();

    await user.click(recipient);
    expect(screen.queryByText('HOLDER-SECRET-123')).toBeNull();
    expect(screen.queryByText('holder@example.com')).toBeNull();
    expect(screen.getAllByText('ชาย').length).toBeGreaterThan(0);
  });

  it('clears the selected destination after a successful transfer', async () => {
    const { user, form } = await renderMovementForm('โอนระหว่างจุด');
    await user.click(within(form).getByRole('button', { name: /สมชาย ใจดี/ }));
    await user.type(within(form).getByRole('spinbutton'), '2');
    await user.click(within(form).getByRole('button', { name: 'ยืนยัน โอนระหว่างจุด' }));

    expect(await within(form).findByText('เลือกจุดรับสต๊อกเพื่อเริ่มรายการ')).toBeTruthy();
    expect((within(form).getByRole('button', { name: 'ยืนยัน โอนระหว่างจุด' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('submits damage with a source and no destination or required note', async () => {
    const { user, form } = await renderMovementForm('เสียหาย / ละลาย');
    expect(within(form).queryByRole('combobox', { name: 'ปลายทาง (ไปยัง)' })).toBeNull();
    await user.type(within(form).getByRole('spinbutton'), '1');
    await user.click(within(form).getByRole('button', { name: 'ยืนยัน เสียหาย / ละลาย' }));

    await expectMovementPayload({
      p_kind: 'damage',
      p_from_location_id: 'truck-1',
      p_to_location_id: null,
      p_note: null,
    });
  });

  it('allows damage to be recorded from an inventory holder without a transfer destination', async () => {
    const otherTruck = {
      ...summary.locations[0],
      id: 'truck-2',
      code: 'TRUCK-2',
      name: 'รถสำรอง',
      is_courier_source: false,
    };
    const summaryWithAnotherTruck = {
      ...summary,
      locations: [otherTruck, ...summary.locations],
    };
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary') return { data: summaryWithAnotherTruck, error: null };
      if (name === 'get_location_count_history') return { data: [], error: null };
      if (name === 'get_daily_stock_count_readiness') return { data: [], error: null };
      if (name === 'get_daily_stock_close_state') return { data: closeState, error: null };
      if (name === 'get_stock_count_variance_reviews') return { data: [], error: null };
      return { data: summaryWithAnotherTruck, error: null };
    });

    const { user, form } = await renderMovementForm('เสียหาย / ละลาย');
    await user.click(within(form).getByRole('button', { name: /รถสำรอง/ }));
    await user.type(within(form).getByRole('spinbutton'), '1');
    await user.click(within(form).getByRole('button', { name: 'ยืนยัน เสียหาย / ละลาย' }));

    await expectMovementPayload({
      p_kind: 'damage',
      p_from_location_id: 'truck-2',
      p_to_location_id: null,
    });
  });

  it('clears a transfer draft when switching to damage', async () => {
    const { user, form } = await renderMovementForm('โอนระหว่างจุด');
    await user.type(within(form).getByRole('spinbutton'), '2');
    await user.type(within(form).getByPlaceholderText('ระบุหมายเหตุเพิ่มเติม...'), 'ส่งให้ทีม');

    await user.click(screen.getByRole('button', { name: 'เสียหาย / ละลาย' }));

    expect((within(form).getByRole('spinbutton') as HTMLInputElement).value).toBe('');
    expect((within(form).getByPlaceholderText('เช่น ถุงแตกหรือละลายระหว่างรอส่ง') as HTMLTextAreaElement).value).toBe('');
    expect((within(form).getByRole('button', { name: 'ยืนยัน เสียหาย / ละลาย' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('labels damage stock as belonging to the selected source', async () => {
    const { user, form } = await renderMovementForm('เสียหาย / ละลาย');
    await user.click(within(form).getByRole('button', { name: /สมชาย ใจดี/ }));

    expect(within(form).getByText(/คงเหลือที่จุดนี้ 5 ถุง/)).toBeTruthy();
  });

  it('does not show a manual factory-return tab', async () => {
    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);

    await screen.findByRole('heading', { name: 'เลือกต้นทางและจุดรับสต๊อก' });
    expect(screen.queryByRole('button', { name: 'ส่งคืนโรงงาน' })).toBeNull();
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

});

describe('ManagerStockControl daily close', () => {
  beforeEach(() => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary') return { data: summary, error: null };
      if (name === 'get_location_count_history') return { data: [], error: null };
      if (name === 'get_daily_stock_close_state') return { data: closeReadyState, error: null };
      if (name === 'get_stock_count_variance_reviews') return { data: [], error: null };
      if (name === 'get_daily_aggregate_stock_summary') {
        return { data: aggregateSummary, error: null };
      }
      if (name === 'get_daily_stock_refill_history') return { data: [], error: null };
      if (name === 'close_daily_aggregate_stock') {
        return { data: { ...aggregateSummary, status: 'closed' }, error: null };
      }
      return { data: null, error: null };
    });
  });

  it('shows the daily close workflow only on the actual-count tab', async () => {
    const user = userEvent.setup();
    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);

    expect(screen.queryByRole('heading', { name: 'ตรวจนับและปิดสต๊อกสิ้นวัน' })).toBeNull();

    await user.click(await screen.findByRole('button', { name: 'ตรวจนับจริง' }));
    expect(await screen.findByRole('heading', { name: 'ตรวจนับและปิดสต๊อกสิ้นวัน' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'จุดที่ต้องการตรวจนับ' })).toBeNull();
    expect(screen.getByText(/นับน้ำแข็งที่เหลือรวมจากรถและทุกจุด/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'โอนระหว่างจุด' }));
    expect(screen.queryByRole('heading', { name: 'ตรวจนับและปิดสต๊อกสิ้นวัน' })).toBeNull();
  });

  it('closes aggregate stock from one count per ice type', async () => {
    const user = userEvent.setup();
    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);

    await user.click(await screen.findByRole('button', { name: 'ตรวจนับจริง' }));
    expect(await screen.findByText(/สั่ง 30 · ขาย 5 · เติม 0 · เสีย 0 · คืน 0/)).toBeTruthy();

    const count = screen.getByRole('spinbutton');
    await user.clear(count);
    await user.type(count, '24.5');
    const closeButton = screen.getByRole('button', { name: 'ปิดสต๊อกและจบงานวันนี้' });
    expect((closeButton as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByRole('textbox'), 'ส่วนต่างยังไม่ทราบสาเหตุ');
    await user.click(closeButton);

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'close_daily_aggregate_stock',
      expect.objectContaining({
        p_service_date: round.service_date,
        p_counts: [{
          ice_type_id: 'ice-1',
          actual_quantity: 24.5,
          note: 'ส่วนต่างยังไม่ทราบสาเหตุ',
        }],
        p_note: 'ส่วนต่างยังไม่ทราบสาเหตุ',
        p_idempotency_key: expect.any(String),
      }),
    ));
  });

  it('lets a manager cancel a refill with an audited reason', async () => {
    let cancelled = false;
    vi.spyOn(window, 'prompt').mockReturnValue('บันทึกผิด');
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary') return { data: summary, error: null };
      if (name === 'get_daily_stock_close_state') return { data: closeReadyState, error: null };
      if (name === 'get_daily_aggregate_stock_summary') {
        return {
          data: {
            ...aggregateSummary,
            items: [{
              ...aggregateSummary.items[0],
              refill_quantity: cancelled ? 0 : 0.5,
              available_quantity: cancelled ? 25 : 24.5,
            }],
          },
          error: null,
        };
      }
      if (name === 'get_daily_stock_refill_history') {
        return {
          data: [{
            id: 'refill-1',
            status: cancelled ? 'cancelled' : 'active',
            note: 'เติมให้จุดบริการ',
            recorded_at: '2026-07-20T08:00:00+07:00',
            recorded_by: 'พนักงานทดสอบ',
            cancelled_at: cancelled ? '2026-07-20T09:00:00+07:00' : null,
            cancelled_by: cancelled ? 'หัวหน้าทดสอบ' : null,
            cancellation_reason: cancelled ? 'บันทึกผิด' : null,
            items: [{
              ice_type_id: 'ice-1',
              ice_type_name: 'หลอดเล็ก',
              unit: 'ถุง',
              quantity: 0.5,
            }],
          }],
          error: null,
        };
      }
      if (name === 'cancel_daily_stock_refill') {
        cancelled = true;
        return { data: null, error: null };
      }
      return { data: null, error: null };
    });

    const user = userEvent.setup();
    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);
    await user.click(await screen.findByRole('button', { name: 'ตรวจนับจริง' }));
    expect(await screen.findByRole('heading', { name: 'ประวัติเติมน้ำแข็ง' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'ยกเลิกรายการ' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('cancel_daily_stock_refill', {
      p_use_id: 'refill-1',
      p_reason: 'บันทึกผิด',
    }));
    expect(await screen.findByText(/ยกเลิกโดย หัวหน้าทดสอบ · บันทึกผิด/)).toBeTruthy();
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
