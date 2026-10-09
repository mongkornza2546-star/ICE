import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

beforeEach(() => {
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

it('filters by building and zone and shows the live INV breakdown without preparing a document', async () => {
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

  const detailButton = screen.getByRole('button', { name: 'ดูรายละเอียดยอด' });
  expect(detailButton.getAttribute('aria-expanded')).toBe('false');
  await user.click(detailButton);
  const details = await screen.findByText('INV-002');
  expect(within(details.closest('.daily-credit-signoff__details') as HTMLElement).getByText('รวม 2 INV')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'ซ่อนรายละเอียด' }).getAttribute('aria-expanded')).toBe('true');
  expect(supabaseMock.client.rpc).toHaveBeenCalledWith('get_daily_credit_acknowledgement_details', {
    p_shop_id: 'shop-1', p_service_date: '2026-08-21',
  });
  expect(supabaseMock.client.rpc).not.toHaveBeenCalledWith('prepare_daily_credit_acknowledgement', expect.anything());
});
