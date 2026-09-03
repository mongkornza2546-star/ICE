import { expect, it, vi } from 'vitest';
import type { ShopCard } from '../src/types/app';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  rpc: vi.fn(),
  getPublicUrl: vi.fn((path: string) => ({ data: { publicUrl: `https://supabase.test/${path}` } })),
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    functions: { invoke: mocks.invoke },
    rpc: mocks.rpc,
    storage: { from: () => ({ getPublicUrl: mocks.getPublicUrl }) },
  },
}));

import { createSupabaseGateway } from '../src/EmployeeDeliveryWorkspace';

const shopCard: ShopCard = {
  round_stop_id: 'stop-1',
  shop_id: 'shop-1',
  shop_code: 'BB16',
  shop_name: 'ร้านเล่าซา',
  building_id: 'building-1',
  building_name: 'อาคาร B',
  floor_or_zone: 'ศูนย์อาหาร',
  sequence_no: 1,
  image_path: 'shops/shop-1/r2/photo.webp',
  image_url: null,
  payment_status: 'unpaid',
  stop_status: 'pending',
  stop_note: null,
  today_history: [],
  today_totals: {},
};

it('returns base shop cards before catalog URL signing finishes', async () => {
  let finishSigning!: (value: unknown) => void;
  mocks.invoke.mockReturnValue(new Promise((resolve) => { finishSigning = resolve; }));
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_event_delivery_capability') {
      return { data: { schema_version: 3 }, error: null };
    }
    if (name === 'get_round_shop_cards') return { data: [shopCard], error: null };
    return { data: 1, error: null };
  });

  let receiveBaseCards!: (cards: ShopCard[]) => void;
  const baseCardsPromise = new Promise<ShopCard[]>((resolve) => { receiveBaseCards = resolve; });
  const finalCardsPromise = createSupabaseGateway().loadShopCards('round-1', {
    onBaseCards: receiveBaseCards,
  });

  const baseCards = await baseCardsPromise;
  expect(baseCards[0].shop_name).toBe('ร้านเล่าซา');
  expect(baseCards[0].image_url).toBeNull();

  finishSigning({
    data: {
      signedUrls: [{ path: shopCard.image_path, signedUrl: 'https://r2.test/fresh-photo' }],
    },
    error: null,
  });
  const finalCards = await finalCardsPromise;
  expect(finalCards[0].image_url).toBe('https://r2.test/fresh-photo');
});
