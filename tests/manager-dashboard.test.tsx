import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ManagerDashboard, type DailyAggregateStockSummary, type ManagerDashboardView } from '../src/ManagerDashboard';
import type { DailyWorkDashboard, StockControlSummary } from '../src/types/app';

const dashboard: DailyWorkDashboard = {
  session: {
    id: 'daily-round',
    service_date: '2026-07-27',
    status: 'in_progress',
  },
  members: [
    { id: 'employee-1', display_name: 'สมชาย', role: 'courier', role_label: 'พนักงานส่ง', last_activity: null },
    { id: 'employee-2', display_name: 'วิชัย', role: 'courier', role_label: 'พนักงานส่ง', last_activity: null },
    { id: 'employee-3', display_name: 'ประเสริฐ', role: 'courier', role_label: 'พนักงานส่ง', last_activity: null },
    { id: 'employee-4', display_name: 'นิรันดร์', role: 'courier', role_label: 'พนักงานส่ง', last_activity: null },
  ],
  deliverySummary: {
    activeDeliveryCount: 4,
    actualShopCount: 3,
    problemCount: 1,
  },
  salesSummary: {
    netSalesValue: 120.5,
    iceTypeSales: [],
  },
  recentDeliveries: [],
  problems: [{
    stop_id: 'problem-1',
    shop_code: 'SHOP-1',
    shop_name: 'ร้านมีปัญหา',
    problem_note: 'ติดต่อไม่ได้',
    updated_at: '2026-07-27T04:00:00.000Z',
    updated_by_name: 'สมชาย',
  }],
  readiness: [
    { location_id: 'truck', location_name: 'รถหลัก', status: 'current', snapshot: null },
    { location_id: 'holder', location_name: 'รถเข็นสมชาย', status: 'stale', snapshot: null },
  ],
  cancellationState: {
    can_cancel: false,
    blocker_reason: 'เริ่มทำรายการแล้ว',
  },
};

const stockSummary: StockControlSummary = {
  service_date: '2026-07-27',
  locations: [
    {
      id: 'truck',
      code: 'TRUCK',
      name: 'รถหลัก',
      kind: 'truck',
      holds_inventory: true,
      requires_daily_count: true,
      balances: [
        { ice_type_id: 'bag', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 3.5 },
        { ice_type_id: 'row', ice_type_name: 'น้ำแข็งก้อน', unit: 'แถว', quantity: 1 },
      ],
    },
    {
      id: 'work-site',
      code: 'SITE-A',
      name: 'จุดปฏิบัติงาน A',
      kind: 'work_site',
      holds_inventory: false,
      requires_daily_count: false,
      balances: [
        { ice_type_id: 'bag', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 0 },
        { ice_type_id: 'row', ice_type_name: 'น้ำแข็งก้อน', unit: 'แถว', quantity: 0 },
      ],
    },
    {
      id: 'holder',
      code: 'HOLDER-1',
      name: 'รถเข็นสมชาย',
      kind: 'team',
      holds_inventory: true,
      requires_daily_count: true,
      balances: [
        { ice_type_id: 'bag', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 8 },
        { ice_type_id: 'row', ice_type_name: 'น้ำแข็งก้อน', unit: 'แถว', quantity: 0 },
      ],
    },
  ],
  recent_movements: [],
};

const aggregateStockSummary: DailyAggregateStockSummary = {
  service_date: '2026-07-27',
  status: 'open',
  items: [
    { ice_type_id: 'bag', name: 'หลอดเล็ก', unit: 'ถุง', available_quantity: 9.5 },
    { ice_type_id: 'row', name: 'น้ำแข็งก้อน', unit: 'แถว', available_quantity: 1 },
  ],
};

function renderDashboard(onNavigate = vi.fn<(view: ManagerDashboardView) => void>()) {
  render(
    <ManagerDashboard
      demoDashboard={dashboard}
      demoStockSummary={stockSummary}
      demoAggregateStockSummary={aggregateStockSummary}
      isActive
      onNavigate={onNavigate}
      profileRole="round_lead"
    />,
  );
  return onNavigate;
}

describe('ManagerDashboard', () => {
  it('uses the daily aggregate stock rather than inventory-holder balances', async () => {
    renderDashboard();

    const stockCard = (await screen.findByText('สต๊อกคงเหลือ')).closest('article');
    expect(stockCard).not.toBeNull();
    expect(within(stockCard!).getByText('9.5 ถุง · 1 แถว')).toBeTruthy();
    expect(screen.queryByText('จุดปฏิบัติงาน A')).toBeNull();
    expect(screen.queryByText('หลายหน่วย')).toBeNull();
  });

  it('treats stale counts as pending and routes recounting to stock operations', async () => {
    const user = userEvent.setup();
    const onNavigate = renderDashboard();

    const countCard = (await screen.findByText('เหลือตรวจนับ')).closest('article');
    expect(countCard).not.toBeNull();
    expect(within(countCard!).getByText('1')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /มีจุดถือครองที่ต้องตรวจนับ/ }));
    expect(onNavigate).toHaveBeenLastCalledWith('stock_operations');
  });

  it('does not request stock counts before the daily work has started', async () => {
    render(
      <ManagerDashboard
        demoDashboard={{
          ...dashboard,
          session: { id: null, service_date: '2026-07-27', status: 'not_started' },
        }}
        demoStockSummary={stockSummary}
        demoAggregateStockSummary={aggregateStockSummary}
        isActive
        onNavigate={vi.fn()}
        profileRole="round_lead"
      />,
    );

    const countCard = (await screen.findByText('เหลือตรวจนับ')).closest('article');
    expect(countCard).not.toBeNull();
    expect(within(countCard!).getByText('0')).toBeTruthy();
    expect(within(countCard!).getByText('ยังไม่เริ่มงานวันนี้')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /มีจุดถือครองที่ต้องตรวจนับ/ })).toBeNull();
  });

  it('routes each operational action to its actionable workspace', async () => {
    const user = userEvent.setup();
    const onNavigate = renderDashboard();

    await user.click(await screen.findByRole('button', { name: /ตรวจนับสิ้นวัน/ }));
    expect(onNavigate).toHaveBeenLastCalledWith('stock_operations');

    await user.click(screen.getByRole('button', { name: /มีปัญหาหน้างานที่ต้องติดตาม/ }));
    expect(onNavigate).toHaveBeenLastCalledWith('delivery');
  });

  it('omits the nonessential staff and per-location stock panels', async () => {
    renderDashboard();

    expect(await screen.findByRole('heading', { name: 'สรุปเส้นทางการกระจายน้ำแข็งวันนี้' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'การแจ้งเตือนที่ต้องดำเนินการ' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'สถานะพนักงานประจำรอบ' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'สต๊อกคงเหลือแยกตามจุดถือครอง' })).toBeNull();
  });
});
