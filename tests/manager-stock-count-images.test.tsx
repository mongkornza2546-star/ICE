import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerStockControl } from '../src/ManagerStockControl';
import type { DeliveryRound, StockControlSummary } from '../src/types/app';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  createSignedUrls: vi.fn(),
  storageFrom: vi.fn(),
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    storage: { from: mocks.storageFrom },
  },
}));

const round: DeliveryRound = {
  id: 'round-1',
  service_date: '2026-07-20',
  name: '04:00',
  status: 'open',
  opened_at: '2026-07-20T04:00:00+07:00',
};

const stockSummary: StockControlSummary = {
  service_date: round.service_date,
  locations: [{
    id: 'truck-1',
    code: 'TRUCK',
    name: 'รถบรรทุก',
    kind: 'truck',
    holds_inventory: true,
    requires_daily_count: true,
    is_courier_source: true,
    balances: [{
      ice_type_id: 'ice-1',
      ice_type_name: 'หลอดเล็ก',
      unit: 'ถุง',
      quantity: 25,
      image_path: 'products/ice-1.webp',
    }],
  }],
  recent_movements: [],
};

const aggregateSummary = {
  service_date: round.service_date,
  status: 'open',
  items: [{
    ice_type_id: 'ice-1',
    code: 'SMALL',
    name: 'หลอดเล็ก',
    unit: 'ถุง',
    available_quantity: 25,
  }],
};

describe('ManagerStockControl actual-count product images', () => {
  beforeEach(() => {
    mocks.storageFrom.mockReturnValue({ createSignedUrls: mocks.createSignedUrls });
    mocks.createSignedUrls.mockImplementation(async (paths: string[]) => ({
      data: paths.map((path) => ({ path, signedUrl: `https://images.test/${path}` })),
      error: null,
    }));
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_stock_control_summary') return { data: stockSummary, error: null };
      if (name === 'get_daily_stock_close_state') {
        return { data: { service_date: round.service_date, is_closed: false }, error: null };
      }
      if (name === 'get_daily_aggregate_stock_summary') {
        return { data: aggregateSummary, error: null };
      }
      if (name === 'get_daily_stock_refill_history') return { data: [], error: null };
      return { data: null, error: null };
    });
  });

  it('renders the signed product image and opens its preview', async () => {
    const user = userEvent.setup();
    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);

    await user.click(await screen.findByRole('button', { name: 'ตรวจนับจริง' }));
    const imageButton = await screen.findByRole('button', { name: 'ดูรูป หลอดเล็ก ขนาดใหญ่' });
    const image = within(imageButton).getByRole('img', { name: 'หลอดเล็ก' }) as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('https://images.test/products/ice-1.webp');

    await user.click(imageButton);
    expect(screen.getByRole('dialog', { name: 'รูป หลอดเล็ก' })).toBeTruthy();
  });

  it('shows a visible failure state when the configured image cannot be signed', async () => {
    mocks.createSignedUrls.mockResolvedValue({ data: [], error: { message: 'signing failed' } });
    const user = userEvent.setup();
    render(<ManagerStockControl operationRound={round} round={round} serviceDate={round.service_date} />);

    await user.click(await screen.findByRole('button', { name: 'ตรวจนับจริง' }));
    expect(await screen.findByText('โหลดไม่ได้')).toBeTruthy();
  });
});
