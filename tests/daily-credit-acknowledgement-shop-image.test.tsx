import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => {
  const getPublicUrl = vi.fn((path: string) => ({
    data: { publicUrl: `https://example.com/shop-images/${path}` },
  }));
  return {
    client: {
      rpc: vi.fn(),
      storage: { from: vi.fn(() => ({ getPublicUrl })) },
    },
    getPublicUrl,
  };
});

vi.mock('../src/lib/supabase', () => ({ supabase: supabaseMock.client }));

import { DailyCreditAcknowledgementPanel } from '../src/features/financial-operations/components/DailyCreditAcknowledgementPanel';
import { publishDataChange } from '../src/lib/dataChange';

beforeEach(() => {
  window.history.replaceState(null, '');
  supabaseMock.client.rpc.mockReset();
  supabaseMock.client.storage.from.mockClear();
  supabaseMock.getPublicUrl.mockClear();
});

it('shows the shop image on the daily credit acknowledgement card', async () => {
  supabaseMock.client.rpc.mockResolvedValue({
    data: [{
      shop_id: 'shop-1',
      shop_code: 'BB27',
      shop_name: 'ร้านดีโอเร่',
      shop_location: 'ซุ้มโถง 1',
      image_path: 'shops/shop-1/front.webp',
      invoice_count: 1,
      total_amount: 60,
      latest_delivery_at: '2026-08-21T06:32:00+07:00',
      open_round_count: 0,
      document_id: null,
      document_version: null,
      is_stale: false,
      evidence_count: 0,
      latest_evidence_path: null,
    }],
    error: null,
  });

  render(<DailyCreditAcknowledgementPanel serviceDate="2026-08-21" />);

  const image = await screen.findByRole('img', { name: 'รูปร้าน BB27 · ร้านดีโอเร่' });
  expect(image.getAttribute('src')).toBe('https://example.com/shop-images/shops/shop-1/front.webp');
  expect(supabaseMock.client.storage.from).toHaveBeenCalledWith('shop-images');
});

it('filters shops and opens a dedicated shop view with the live INV breakdown', async () => {
  const shops = [
    { shop_id: 'shop-1', shop_code: 'BB27', shop_name: 'ร้านดีโอเร่', shop_location: 'ซุ้ม 1', image_path: null,
      building_id: 'building-b', building_name: 'ตึก B', zone_id: 'zone-1', zone_name: 'ซุ้มโดม 1',
      invoice_count: 2, total_amount: 180, latest_delivery_at: '2026-08-21T06:32:00+07:00', open_round_count: 0,
      document_id: null, document_version: null, is_stale: false, evidence_count: 0, latest_evidence_path: null },
    { shop_id: 'shop-2', shop_code: 'BB37', shop_name: 'ร้านเจียงลูกชิ้นปลา', shop_location: 'ซุ้ม 2', image_path: null,
      building_id: 'building-b', building_name: 'ตึก B', zone_id: 'zone-2', zone_name: 'ซุ้มโดม 2',
      invoice_count: 1, total_amount: 420, latest_delivery_at: '2026-08-21T07:18:00+07:00', open_round_count: 0,
      document_id: null, document_version: null, is_stale: false, evidence_count: 0, latest_evidence_path: null },
    { shop_id: 'shop-3', shop_code: 'CC01', shop_name: 'ร้านตึก C', shop_location: 'ชั้น 1', image_path: null,
      building_id: 'building-c', building_name: 'ตึก C', zone_id: 'zone-3', zone_name: 'ชั้น 1',
      invoice_count: 1, total_amount: 90, latest_delivery_at: '2026-08-21T07:30:00+07:00', open_round_count: 0,
      document_id: null, document_version: null, is_stale: false, evidence_count: 0, latest_evidence_path: null },
  ];
  supabaseMock.client.rpc.mockImplementation(async (name: string) => {
    if (name === 'list_daily_credit_acknowledgements') return { data: shops, error: null };
    if (name === 'get_daily_credit_acknowledgement_details') return { data: [
      { document_number: 'INV-001', recorded_at: '2026-08-21T06:00:00+07:00', recorded_by: 'พนักงาน', total_amount: 60,
        items: [{ ice_type_name: 'น้ำแข็ง', ice_type_unit: 'ถุง', quantity: 2, unit_price: 30, line_total: 60 }] },
      { document_number: 'INV-002', recorded_at: '2026-08-21T06:32:00+07:00', recorded_by: 'พนักงาน', total_amount: 120,
        items: [{ ice_type_name: 'น้ำแข็ง', ice_type_unit: 'ถุง', quantity: 4, unit_price: 30, line_total: 120 }] },
    ], error: null };
    throw new Error(`Unexpected RPC: ${name}`);
  });

  const user = userEvent.setup();
  render(<DailyCreditAcknowledgementPanel serviceDate="2026-08-21" />);
  expect(await screen.findByText(/BB27 · ร้านดีโอเร่/)).toBeTruthy();
  await user.selectOptions(screen.getByLabelText('ตึก'), 'building-b');
  await user.selectOptions(screen.getByLabelText('โซน'), 'zone-1');
  expect(screen.queryByText(/BB37 · ร้านเจียงลูกชิ้นปลา/)).toBeNull();
  expect(screen.queryByText(/CC01 · ร้านตึก C/)).toBeNull();

  await user.click(screen.getByRole('button', { name: /BB27 · ร้านดีโอเร่/ }));
  expect(screen.queryByLabelText('ตึก')).toBeNull();
  expect(screen.getByRole('heading', { name: 'BB27 · ร้านดีโอเร่' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'พิมพ์ใบรวม' })).toBeTruthy();
  const details = await screen.findByText('INV-002');
  expect(within(details.closest('.daily-credit-signoff__details') as HTMLElement).getByText('รวม 2 INV')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'กลับรายชื่อร้าน' }));
  expect(await screen.findByLabelText('ตึก')).toHaveProperty('value', 'building-b');
  expect(screen.getByLabelText('โซน')).toHaveProperty('value', 'zone-1');
  expect(screen.queryByText('INV-002')).toBeNull();
  expect(supabaseMock.client.rpc).toHaveBeenCalledWith('get_daily_credit_acknowledgement_details', {
    p_shop_id: 'shop-1', p_service_date: '2026-08-21',
  });
  expect(supabaseMock.client.rpc).not.toHaveBeenCalledWith('prepare_daily_credit_acknowledgement', expect.anything());
});

const navigationShops = [{
  shop_id: 'shop-1', shop_code: 'BB27', shop_name: 'ร้านทดสอบ', shop_location: 'ซุ้ม 1',
  image_path: null, invoice_count: 1, total_amount: 60,
  latest_delivery_at: '2026-08-21T06:32:00+07:00', open_round_count: 0,
  document_id: null, document_version: null, is_stale: false, evidence_count: 0,
  latest_evidence_path: null,
}];

it('supports browser back, forward, and the in-page back button without losing existing history state', async () => {
  window.history.replaceState({ previousPage: 'collections' }, '');
  supabaseMock.client.rpc.mockImplementation(async (name: string) => ({
    data: name === 'list_daily_credit_acknowledgements' ? navigationShops : [], error: null,
  }));
  const user = userEvent.setup();
  render(<DailyCreditAcknowledgementPanel serviceDate="2026-08-21" />);
  await user.click(await screen.findByRole('button', { name: /BB27/ }));
  act(() => window.history.back());
  expect(await screen.findByRole('button', { name: /BB27/ })).toBeTruthy();
  expect(window.history.state).toEqual({ previousPage: 'collections' });
  act(() => window.history.forward());
  expect(await screen.findByRole('heading', { name: 'BB27 · ร้านทดสอบ' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'กลับรายชื่อร้าน' }));
  expect(await screen.findByRole('button', { name: /BB27/ })).toBeTruthy();
  expect(window.history.state).toEqual({ previousPage: 'collections' });
});

it('restores the shop after a pending refresh and does not steal focus on later refreshes', async () => {
  let finishRefresh!: (value: unknown) => void;
  let listCalls = 0;
  supabaseMock.client.rpc.mockImplementation((name: string) => {
    if (name === 'list_daily_credit_acknowledgements') {
      if (++listCalls === 2) return new Promise((resolve) => { finishRefresh = resolve; });
      return Promise.resolve({ data: navigationShops, error: null });
    }
    return Promise.resolve({ data: [], error: null });
  });
  const user = userEvent.setup();
  render(<DailyCreditAcknowledgementPanel serviceDate="2026-08-21" />);
  await user.click(await screen.findByRole('button', { name: /BB27/ }));
  act(() => publishDataChange(['receivable']));
  await user.click(screen.getByRole('button', { name: 'กลับรายชื่อร้าน' }));
  expect(await screen.findByText('กำลังโหลดใบเครดิต...')).toBeTruthy();
  await act(async () => { finishRefresh({ data: navigationShops, error: null }); });
  const shop = await screen.findByRole('button', { name: /BB27/ });
  expect(document.activeElement).toBe(shop);
  const date = screen.getByLabelText('วันที่');
  date.focus();
  await act(async () => publishDataChange(['receivable']));
  await waitFor(() => expect(listCalls).toBe(3));
  expect(document.activeElement).toBe(date);
});

it('removes the active detail history entry when leaving the panel', async () => {
  const baseline = { previousPage: 'collections' };
  window.history.replaceState(baseline, '');
  supabaseMock.client.rpc.mockImplementation(async (name: string) => ({
    data: name === 'list_daily_credit_acknowledgements' ? navigationShops : [], error: null,
  }));
  const user = userEvent.setup();
  const { unmount } = render(<StrictMode><DailyCreditAcknowledgementPanel serviceDate="2026-08-21" /></StrictMode>);
  await user.click(await screen.findByRole('button', { name: /BB27/ }));
  expect(window.history.state).not.toEqual(baseline);
  unmount();
  await waitFor(() => expect(window.history.state).toEqual(baseline));
});

it('closes the detail history entry when the service date changes', async () => {
  supabaseMock.client.rpc.mockImplementation(async (name: string) => ({
    data: name === 'list_daily_credit_acknowledgements' ? navigationShops : [], error: null,
  }));
  const user = userEvent.setup();
  const { rerender } = render(<DailyCreditAcknowledgementPanel serviceDate="2026-08-21" />);
  await user.click(await screen.findByRole('button', { name: /BB27/ }));
  rerender(<DailyCreditAcknowledgementPanel serviceDate="2026-08-22" />);
  expect(await screen.findByLabelText('วันที่')).toHaveProperty('value', '2026-08-22');
  await waitFor(() => expect(window.history.state).toBeNull());
  act(() => window.history.forward());
  await waitFor(() => expect(window.history.state).not.toBeNull());
  expect(screen.queryByRole('heading', { name: 'BB27 · ร้านทดสอบ' })).toBeNull();
  act(() => window.history.back());
  await waitFor(() => expect(window.history.state).toBeNull());
});
