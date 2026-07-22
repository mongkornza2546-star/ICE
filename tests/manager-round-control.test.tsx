import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerRoundControl } from '../src/ManagerRoundControl';
import type { DeliveryRound, RoundControlSummary } from '../src/types/app';

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

const emptySummary: RoundControlSummary = {
  stop_counts: { total: 126, delivered: 0, pending: 126, problem: 0 },
  ice_counts: [{
    ice_type_id: 'ice-1',
    ice_type_name: 'หลอดเล็ก',
    unit: 'ถุง',
    loaded_quantity: 0,
    replenished_quantity: 0,
    remaining_quantity: 0,
    damaged_quantity: 0,
    expected_quantity: 0,
    delivered_quantity: 0,
    variance_quantity: 0,
  }],
};

describe('ManagerRoundControl cancellation', () => {
  beforeEach(() => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_round_control_summary') return { data: emptySummary, error: null };
      if (name === 'get_delivery_round_cancellation_state') {
        return { data: { can_cancel: true, blockers: [], status: 'open' }, error: null };
      }
      if (name === 'cancel_delivery_round') return { data: { status: 'cancelled' }, error: null };
      return { data: null, error: null };
    });
  });

  it('confirms an unused legacy record with an explicit reason', async () => {
    const user = userEvent.setup();
    const onCancelled = vi.fn(async () => undefined);
    render(<ManagerRoundControl onCancelled={onCancelled} onClosed={vi.fn()} round={round} />);

    await user.click(await screen.findByRole('button', { name: 'ยกเลิกรายการเดิม' }));
    expect(screen.getByRole('dialog', { name: 'ยกเลิกรายการเดิมนี้?' })).toBeTruthy();
    expect(screen.getByText('รายการส่ง').textContent).toContain('0');

    await user.selectOptions(screen.getByRole('combobox', { name: 'เหตุผลการยกเลิก' }), 'อื่น ๆ');
    await user.type(screen.getByRole('textbox', { name: 'รายละเอียด (จำเป็น)' }), 'ทดสอบเปิดรายการผิด');
    await user.click(screen.getByRole('button', { name: 'ยืนยันยกเลิกรายการเดิม' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('cancel_delivery_round', {
      p_round_id: round.id,
      p_reason: 'ทดสอบเปิดรายการผิด',
    }));
    expect(onCancelled).toHaveBeenCalledOnce();
  });

  it('explains why a legacy record with delivery activity cannot be cancelled', async () => {
    const user = userEvent.setup();
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_round_control_summary') {
        return { data: {
          ...emptySummary,
          stop_counts: { total: 126, delivered: 1, pending: 125, problem: 0 },
        }, error: null };
      }
      if (name === 'get_delivery_round_cancellation_state') {
        return { data: { can_cancel: false, blockers: ['delivery_events'], status: 'open' }, error: null };
      }
      return { data: null, error: null };
    });
    render(<ManagerRoundControl onCancelled={vi.fn()} onClosed={vi.fn()} round={round} />);

    await user.click(await screen.findByRole('button', { name: 'ยกเลิกรายการเดิม' }));
    expect(screen.getByRole('alert').textContent).toContain('มีการทำรายการแล้ว');
    expect(screen.queryByRole('button', { name: 'ยืนยันยกเลิกรายการเดิม' })).toBeNull();
  });

  it('uses database blockers that are not visible in delivered totals', async () => {
    const user = userEvent.setup();
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_round_control_summary') return { data: emptySummary, error: null };
      if (name === 'get_delivery_round_cancellation_state') {
        return { data: { can_cancel: false, blockers: ['stock_movements', 'round_ice_counts'], status: 'open' }, error: null };
      }
      return { data: null, error: null };
    });
    render(<ManagerRoundControl onCancelled={vi.fn()} onClosed={vi.fn()} round={round} />);

    await user.click(await screen.findByRole('button', { name: 'ยกเลิกรายการเดิม' }));
    expect(screen.getByRole('alert').textContent).toContain('มีรายการสต๊อก');
    expect(screen.getByRole('alert').textContent).toContain('มียอดน้ำแข็งที่บันทึกแล้ว');
    expect(screen.queryByRole('button', { name: 'ยืนยันยกเลิกรายการเดิม' })).toBeNull();
  });
});
