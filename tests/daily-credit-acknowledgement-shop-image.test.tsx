import { render, screen } from '@testing-library/react';
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
