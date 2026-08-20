import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmployeeDeliveryWorkspace,
  type EmployeeDeliveryGateway,
} from '../src/EmployeeDeliveryWorkspace';

vi.mock('../src/lib/supabase', () => ({ supabase: null }));

function createGateway(): EmployeeDeliveryGateway {
  return {
    loadReferenceData: vi.fn().mockResolvedValue({
      rounds: [{
        id: 'round-1',
        service_date: '2026-08-20',
        name: 'งานประจำวัน',
        round_type: 'daily',
        status: 'open',
        opened_at: '2026-08-20T01:00:00Z',
      }],
      iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
    }),
    loadShopCards: vi.fn().mockResolvedValue([]),
    loadEmployeeStockState: vi.fn(),
    recordEmployeeStockTransfer: vi.fn(),
    recordEmployeeStockReturn: vi.fn(),
    recordEmployeeStockDamage: vi.fn(),
    recordDelivery: vi.fn(),
  };
}

describe('casual-customer POS navigation', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the production entry hidden until the rollout capability is enabled', async () => {
    render(<EmployeeDeliveryWorkspace
      gateway={createGateway()}
      serviceDate="2026-08-20"
    />);

    await screen.findByRole('searchbox', { name: 'ค้นหาร้าน' });
    expect(screen.queryByRole('button', { name: 'บันทึกลูกค้าขาจร' })).toBeNull();
  });

  it('opens casual customers above shop search and returns to the shop picker', async () => {
    const user = userEvent.setup();
    let scrollY = 640;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    vi.spyOn(window, 'scrollTo').mockImplementation((options) => {
      scrollY = typeof options === 'object' ? options.top ?? 0 : Number(options);
    });
    render(<EmployeeDeliveryWorkspace
      casualCustomerPreviewEnabled
      gateway={createGateway()}
      serviceDate="2026-08-20"
    />);

    const casualButton = await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' });
    const search = screen.getByRole('searchbox', { name: 'ค้นหาร้าน' });
    expect(casualButton.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(casualButton);
    const heading = screen.getByRole('heading', { level: 1, name: 'ลูกค้าขาจร' });
    expect(document.activeElement).toBe(heading);
    expect(scrollY).toBe(0);
    expect(screen.getByText('ยังไม่เปิดรับรายการจริง')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'กลับไปเลือกร้าน' }));
    const restoredButton = await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' });
    await waitFor(() => expect(document.activeElement).toBe(restoredButton));
    expect(scrollY).toBe(640);
  });

  it('returns to the picker when the service date changes', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    vi.mocked(gateway.loadReferenceData).mockImplementation(async (serviceDate) => ({
      rounds: [{
        id: `round-${serviceDate}`,
        service_date: serviceDate,
        name: `งาน ${serviceDate}`,
        round_type: 'daily',
        status: 'open',
        opened_at: `${serviceDate}T01:00:00Z`,
      }],
      iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
    }));
    const view = render(<EmployeeDeliveryWorkspace
      casualCustomerPreviewEnabled
      gateway={gateway}
      serviceDate="2026-08-20"
    />);

    await user.click(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' }));
    expect(screen.getByRole('heading', { level: 1, name: 'ลูกค้าขาจร' })).toBeTruthy();

    view.rerender(<EmployeeDeliveryWorkspace
      casualCustomerPreviewEnabled
      gateway={gateway}
      serviceDate="2026-08-19"
    />);

    expect(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'ลูกค้าขาจร' })).toBeNull();
  });

  it('does not reopen the subpage after leaving and returning to POS', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    const view = render(<EmployeeDeliveryWorkspace
      casualCustomerPreviewEnabled
      gateway={gateway}
      serviceDate="2026-08-20"
      viewMode="pos"
    />);

    await user.click(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' }));
    expect(screen.getByRole('heading', { level: 1, name: 'ลูกค้าขาจร' })).toBeTruthy();

    view.rerender(<EmployeeDeliveryWorkspace
      casualCustomerPreviewEnabled
      enableAssignedStockFlow
      gateway={gateway}
      serviceDate="2026-08-20"
      viewMode="withdrawal"
    />);
    expect(screen.queryByRole('heading', { level: 1, name: 'ลูกค้าขาจร' })).toBeNull();

    view.rerender(<EmployeeDeliveryWorkspace
      casualCustomerPreviewEnabled
      gateway={gateway}
      serviceDate="2026-08-20"
      viewMode="pos"
    />);
    expect(await screen.findByRole('button', { name: 'บันทึกลูกค้าขาจร' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'ลูกค้าขาจร' })).toBeNull();
  });
});
