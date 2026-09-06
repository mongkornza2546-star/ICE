import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const client = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: client }));
import { ManagerDashboard } from '../src/ManagerDashboard';

afterEach(() => vi.useRealTimers());

function setup(status = 'open') {
  client.rpc.mockImplementation((name: string, args: { p_service_date: string }) => Promise.resolve({ error: null, data:
    name === 'get_daily_work_dashboard' ? {
      session: { status: status === 'closed' ? 'completed' : 'in_progress', service_date: args.p_service_date },
      deliverySummary: { regularShopCount: 0, eventParticipationCount: 0, activeDeliveryCount: 0 },
      salesSummary: { netSalesValue: 800 }, cancellationState: { can_cancel: false }, problems: [],
      readiness: [{ status: 'uncounted', location_id: 'legacy-location' }],
    } : name === 'get_stock_control_summary' ? { locations: [] } : {
      service_date: args.p_service_date, status, items: [{ ice_type_id: 'ice', name: 'หลอด', unit: 'ถุง', available_quantity: status === 'closed' ? 0 : 10 }],
    } }));
}

it('shows the aggregate closure instead of obsolete per-location count warnings', async () => {
  setup('closed');
  render(<ManagerDashboard isActive profileRole="round_lead" onNavigate={vi.fn()} />);
  await screen.findByText('ยอดขายสุทธิ');
  expect(screen.queryByText('มีจุดถือครองที่ต้องตรวจนับ')).toBeNull();
  expect(screen.queryByText('รอตรวจนับใหม่ก่อนปิดวัน')).toBeNull();
  expect(screen.getAllByText('ปิดยอดรวมแล้ว').length).toBeGreaterThan(0);
});

it('refreshes visible dashboards from the server and pauses while inactive', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-09-06T16:59:45Z'));
  setup();
  const props = { profileRole: 'round_lead' as const, onNavigate: vi.fn() };
  const { rerender } = render(<ManagerDashboard {...props} isActive />);
  await act(async () => {});
  client.rpc.mockClear();
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(client.rpc).toHaveBeenCalledWith('get_daily_work_dashboard', { p_service_date: '2026-09-07' });
  expect(screen.getByText(/อัปเดตล่าสุด/)).not.toBeNull();
  client.rpc.mockClear();
  fireEvent.click(screen.getByRole('button', { name: /รีเฟรช/ }));
  await act(async () => {});
  expect(client.rpc).toHaveBeenCalled();
  rerender(<ManagerDashboard {...props} isActive={false} />);
  client.rpc.mockClear();
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(client.rpc).not.toHaveBeenCalled();
});
