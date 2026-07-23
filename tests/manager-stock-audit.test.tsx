import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerStockAudit } from '../src/ManagerStockAudit';
import type { StockCountSnapshot, StockMovementEntry } from '../src/types/app';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../src/lib/supabase', () => ({
  supabase: { rpc: mocks.rpc },
}));

const cancelledMovement: StockMovementEntry & { cancelled_by: string } = {
  id: 'movement-cancelled',
  kind: 'transfer',
  recorded_at: '2026-07-20T09:00:00+07:00',
  note: 'รายการเดิม',
  from_location_name: 'รถบรรทุก',
  to_location_name: 'จุด A',
  recorded_by: 'หัวหน้าทดสอบ',
  items: [{ ice_type_id: 'ice-1', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 3 }],
  status: 'cancelled',
  cancelled_by: 'แอดมินทดสอบ',
  cancelled_at: '2026-07-20T09:15:00+07:00',
  cancellation_reason: 'ลงจำนวนผิด',
  original_movement_id: null,
  replacement_movement_id: 'movement-replacement',
};

const countSnapshot: StockCountSnapshot = {
  id: 'count-1',
  counted_at: '2026-07-20T18:00:00+07:00',
  note: null,
  location_id: 'location-1',
  location_name: 'จุด A',
  counted_by: 'หัวหน้าทดสอบ',
  items: [{
    ice_type_id: 'ice-1',
    ice_type_name: 'หลอดเล็ก',
    unit: 'ถุง',
    system_quantity: 5,
    actual_quantity: 4,
    variance_quantity: -1,
  }],
};

describe('ManagerStockAudit', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_movement_history_v2') {
        return { data: { movements: [cancelledMovement], total_count: 21 }, error: null };
      }
      if (name === 'get_location_count_history_v2') {
        return { data: { snapshots: [countSnapshot], total_count: 1 }, error: null };
      }
      return { data: null, error: null };
    });
  });

  it('uses the paginated audit feeds and exposes cancellation details', async () => {
    const user = userEvent.setup();
    render(<ManagerStockAudit />);

    expect(await screen.findByText('ยกเลิกแล้ว')).toBeTruthy();
    expect(screen.getByText(/ยกเลิกโดย แอดมินทดสอบ/)).toBeTruthy();
    expect(screen.getByText(/ลงจำนวนผิด/)).toBeTruthy();
    expect(screen.getByText('21 รายการ')).toBeTruthy();
    expect(screen.getByText('1 ครั้ง')).toBeTruthy();

    expect(mocks.rpc).toHaveBeenCalledWith('get_stock_movement_history_v2', expect.objectContaining({
      p_limit: 20,
      p_offset: 0,
    }));
    expect(mocks.rpc).toHaveBeenCalledWith('get_location_count_history_v2', expect.objectContaining({
      p_limit: 20,
      p_offset: 0,
    }));

    await user.click(screen.getByRole('button', { name: 'หน้าถัดไปของรายการเคลื่อนไหว' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'get_stock_movement_history_v2',
      expect.objectContaining({ p_offset: 20 }),
    ));
  });

  it('ignores a stale response after the selected date changes', async () => {
    let resolveStale!: (value: { data: { movements: StockMovementEntry[]; total_count: number }; error: null }) => void;
    const staleResponse = new Promise<{ data: { movements: StockMovementEntry[]; total_count: number }; error: null }>(
      (resolve) => { resolveStale = resolve; },
    );
    const staleMovement = { ...cancelledMovement, id: 'stale', note: 'รายการเก่า' };
    const currentMovement = {
      ...cancelledMovement,
      id: 'current',
      note: 'รายการใหม่',
      status: 'active' as const,
      cancelled_at: null,
      cancellation_reason: null,
    };

    mocks.rpc.mockImplementation((name: string, params: { p_service_date: string }) => {
      if (name === 'get_location_count_history_v2') {
        return Promise.resolve({ data: { snapshots: [], total_count: 0 }, error: null });
      }
      if (params.p_service_date === '2026-07-20') {
        return Promise.resolve({ data: { movements: [currentMovement], total_count: 1 }, error: null });
      }
      return staleResponse;
    });

    render(<ManagerStockAudit />);
    fireEvent.change(screen.getByLabelText('วันที่ทำรายการ'), { target: { value: '2026-07-20' } });

    expect(await screen.findByText(/รายการใหม่/)).toBeTruthy();
    await act(async () => {
      resolveStale({ data: { movements: [staleMovement], total_count: 1 }, error: null });
      await Promise.resolve();
    });

    expect(screen.queryByText(/รายการเก่า/)).toBeNull();
    expect(screen.getByText(/รายการใหม่/)).toBeTruthy();
  });
});
