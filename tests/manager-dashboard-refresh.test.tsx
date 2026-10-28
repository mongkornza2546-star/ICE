import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const client = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: client }));
import { ManagerDashboard } from '../src/ManagerDashboard';
import { LocalDemoApp } from '../src/LocalDemoApp';
import { publishDataChange } from '../src/lib/dataChange';

afterEach(() => vi.useRealTimers());

function setup(status = 'open', creditBreakdown: { creditSalesSubtotalValue?: number; creditSalesVatValue?: number } = { creditSalesSubtotalValue: 290, creditSalesVatValue: 10 }) {
  client.rpc.mockImplementation((name: string, args: { p_service_date: string }) => Promise.resolve({ error: null, data:
    name === 'get_daily_work_dashboard' ? {
      session: { status: status === 'closed' ? 'completed' : 'in_progress', service_date: args.p_service_date },
      deliverySummary: { regularShopCount: 0, eventParticipationCount: 0, activeDeliveryCount: 0 },
      salesSummary: {
        netSalesValue: 800,
        locationSales: [
          { id: 'building-a', kind: 'building', name: 'ตึก A', netSalesValue: 620.50, saleCount: 2 },
          { id: 'building-b', kind: 'building', name: 'ตึก B', netSalesValue: 0, saleCount: 0 },
          { id: 'event-today', kind: 'event', name: 'ตลาดวันนี้', netSalesValue: 179.50, saleCount: 1 },
        ],
        locationReceipts: [
          { id: 'building-a', kind: 'building', name: 'ตึก A', receivedValue: 120.50 },
          { id: 'building-b', kind: 'building', name: 'ตึก B', receivedValue: 100 },
          { id: 'event-today', kind: 'event', name: 'ตลาดวันนี้', receivedValue: 0 },
        ],
        locationIceTotals: [
          { id: 'building-a', kind: 'building', name: 'ตึก A', iceTotals: [{ ice_type_id: 'small-tube', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 42 }] },
          { id: 'building-b', kind: 'building', name: 'ตึก B', iceTotals: [] },
          { id: 'event-today', kind: 'event', name: 'ตลาดวันนี้', iceTotals: [{ ice_type_id: 'large-tube', ice_type_name: 'หลอดใหญ่', unit: 'ถุง', quantity: 18 }] },
        ],
        iceTypeSales: [
          { ice_type_id: 'small-tube', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 42 },
          { ice_type_id: 'large-tube', ice_type_name: 'หลอดใหญ่', unit: 'ถุง', quantity: 18 },
        ],
      }, cancellationState: { can_cancel: false }, problems: [],
      readiness: [{ status: 'uncounted', location_id: 'legacy-location' }],
    } : name === 'get_stock_control_summary' ? { locations: [] } : name === 'get_daily_payment_method_summary' ? {
      cashReceivedValue: 200, transferReceivedValue: 300, creditSalesValue: 300, ...creditBreakdown,
    } : {
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
  expect(screen.getByText('เงินสด')).not.toBeNull();
  expect(screen.getByText('โอนเงิน')).not.toBeNull();
  expect(screen.getByText('เครดิต')).not.toBeNull();
  expect(screen.getAllByText('รับชำระแล้ววันนี้ · รวมลูกค้าขายสด')).toHaveLength(2);
  expect(screen.getByText('จำนวนที่ขายได้วันนี้ · รวมลูกค้าขายสด')).not.toBeNull();
  expect(screen.getByText('ยอดขายแยกตามประเภทน้ำแข็ง')).not.toBeNull();
  expect(screen.getByText('หลอดเล็ก')).not.toBeNull();
  expect(screen.getByText('42')).not.toBeNull();
  expect(screen.getByText('หลอดใหญ่')).not.toBeNull();
  expect(screen.getByText('18')).not.toBeNull();
  const pointIceTotals = within(screen.getByLabelText('ยอดน้ำแข็งแยกตามตึกและอีเว้น'));
  expect(pointIceTotals.getByText('ตึก A')).not.toBeNull();
  expect(pointIceTotals.getByText('ตึก B')).not.toBeNull();
  expect(pointIceTotals.getByText('ตลาดวันนี้')).not.toBeNull();
  expect(pointIceTotals.getByText('หลอดเล็ก 42 ถุง')).not.toBeNull();
  expect(pointIceTotals.getByText('หลอดใหญ่ 18 ถุง')).not.toBeNull();
  expect(pointIceTotals.getByText('ยังไม่มีรายการส่งน้ำแข็ง')).not.toBeNull();
  expect(screen.getByText('สรุปเงินที่ได้รายตึก')).not.toBeNull();
  expect(screen.queryByText('การแจ้งเตือนที่ต้องดำเนินการ')).toBeNull();
  const pointSales = within(screen.getByLabelText('เงินรับชำระแยกตามตึกและอีเว้น'));
  expect(within(pointSales.getByText('ตึก A').closest('article')!).getByText('฿120.50')).not.toBeNull();
  expect(within(pointSales.getByText('ตึก B').closest('article')!).getByText('฿100.00')).not.toBeNull();
  expect(within(pointSales.getByText('ตลาดวันนี้').closest('article')!).getByText('฿0.00')).not.toBeNull();
  expect(screen.queryByLabelText('เส้นทางกระจายสต๊อก')).toBeNull();
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
  client.rpc.mockClear();
  await act(async () => { publishDataChange(['payment']); });
  expect(client.rpc).toHaveBeenCalledWith('get_daily_work_dashboard', { p_service_date: '2026-09-07' });
  rerender(<ManagerDashboard {...props} isActive={false} />);
  client.rpc.mockClear();
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(client.rpc).not.toHaveBeenCalled();
});

it('shows per-building ice quantities through the actual demo entry point', async () => {
  window.history.replaceState(null, '', '/?screen=today-layout');
  try {
    render(<LocalDemoApp />);
    const pointIceTotals = within(await screen.findByLabelText('ยอดน้ำแข็งแยกตามตึกและอีเว้น'));
    expect(pointIceTotals.getByText('ตึก A')).not.toBeNull();
    expect(pointIceTotals.getByText('ตึก B')).not.toBeNull();
    expect(pointIceTotals.getByText('ตึก C')).not.toBeNull();
    expect(pointIceTotals.getByText('หลอดเล็ก 32 ถุง · หลอดเล็กโม่ 12 ถุง')).not.toBeNull();
    expect(pointIceTotals.getByText('หลอดเล็ก 40 ถุง · หลอดเล็กโม่ 16 ถุง · เปลือย (หลอดใหญ่) 18 ถุง')).not.toBeNull();
    expect(pointIceTotals.getByText('ยังไม่มีรายการส่งน้ำแข็ง')).not.toBeNull();
    const pointSales = within(screen.getByLabelText('เงินรับชำระแยกตามตึกและอีเว้น'));
    expect(within(pointSales.getByText('ตึก A').closest('article')!).getByText('฿1,400.00')).not.toBeNull();
    expect(within(pointSales.getByText('ตึก B').closest('article')!).getByText('฿1,600.00')).not.toBeNull();
    expect(within(pointSales.getByText('ตึก C').closest('article')!).getByText('฿0.00')).not.toBeNull();
  } finally {
    window.history.replaceState(null, '', '/');
  }
});

it.each([undefined, []])('does not substitute sales when location receipts are unavailable (%j)', async (locationReceipts) => {
  setup();
  const base = client.rpc.getMockImplementation()!;
  client.rpc.mockImplementation(async (name: string, args: { p_service_date: string }) => {
    const result = await base(name, args);
    if (name === 'get_daily_work_dashboard') result.data.salesSummary.locationReceipts = locationReceipts;
    return result;
  });
  render(<ManagerDashboard isActive profileRole="admin" onNavigate={vi.fn()} />);
  const panel = within(await screen.findByLabelText('เงินรับชำระแยกตามตึกและอีเว้น'));
  expect(panel.getByText(locationReceipts == null
    ? 'ยังไม่สามารถโหลดข้อมูลเงินรับชำระรายตึกได้'
    : 'ยังไม่มีข้อมูลเงินรับชำระรายตึกสำหรับวันนี้')).toBeTruthy();
  expect(panel.queryByText('฿620.50')).toBeNull();
  expect(panel.queryByText('฿0.00')).toBeNull();
});

it('shows the credit goods price prominently with the actual VAT and gross total', async () => {
  setup();
  render(<ManagerDashboard isActive profileRole="admin" onNavigate={vi.fn()} />);
  const card = (await screen.findByText('เครดิต')).closest('article')!;
  expect(card.querySelector('strong')?.textContent).toBe('฿290.00');
  expect(within(card).getByText('ค่าน้ำแข็ง (ไม่รวม VAT)')).toBeTruthy();
  expect(within(card).getByText('฿10.00')).toBeTruthy();
  expect(within(card).getByText('฿300.00')).toBeTruthy();
});

it('does not present gross credit as goods price when the server has no VAT breakdown', async () => {
  setup('open', {});
  render(<ManagerDashboard isActive profileRole="admin" onNavigate={vi.fn()} />);
  const card = (await screen.findByText('เครดิต')).closest('article')!;
  expect(card.querySelector('strong')?.textContent).toBe('—');
  expect(within(card).getAllByText('—')).toHaveLength(2);
  expect(within(card).getByText('฿300.00')).toBeTruthy();
});
