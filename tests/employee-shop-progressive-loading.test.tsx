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

it('refreshes data while older photo signing is pending and does not let old photos overwrite the cache', async () => {
  const pendingPhotos: Array<(value: unknown) => void> = [];
  mocks.invoke.mockImplementation(() => new Promise((resolve) => { pendingPhotos.push(resolve); }));
  const firstCard = { ...shopCard, image_path: 'shops/race/r2/before.webp' };
  const savedCard: ShopCard = {
    ...firstCard, stop_status: 'delivered', image_path: 'shops/race/r2/after.webp',
  };
  let liveCard = firstCard;
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_event_delivery_capability') return { data: { schema_version: 3 }, error: null };
    if (name === 'get_round_shop_cards') return { data: [liveCard], error: null };
    return { data: 1, error: null };
  });
  const gateway = createSupabaseGateway();
  let receiveFirst!: (cards: ShopCard[]) => void;
  const firstBase = new Promise<ShopCard[]>((resolve) => { receiveFirst = resolve; });
  const firstLoad = gateway.loadShopCards('round-1', { onBaseCards: receiveFirst });
  await firstBase;

  liveCard = savedCard;
  let receiveNext!: (cards: ShopCard[]) => void;
  const nextBase = new Promise<ShopCard[]>((resolve) => { receiveNext = resolve; });
  const nextLoad = gateway.loadShopCards('round-1', { forceRefresh: true, onBaseCards: receiveNext });
  expect((await nextBase)[0].stop_status).toBe('delivered');
  pendingPhotos[1]({ data: { signedUrls: [{ path: savedCard.image_path, signedUrl: 'https://r2.test/after' }] }, error: null });
  await nextLoad;
  pendingPhotos[0]({ data: { signedUrls: [{ path: firstCard.image_path, signedUrl: 'https://r2.test/before' }] }, error: null });
  await firstLoad;

  const cached = await gateway.loadShopCards('round-1');
  expect(cached[0]).toMatchObject({ stop_status: 'delivered', image_url: 'https://r2.test/after' });
});

it('shares pending photo signing across concurrent readers and a fresh data snapshot', async () => {
  mocks.invoke.mockClear();
  const finishes: Array<(value: unknown) => void> = [];
  mocks.invoke.mockImplementation(() => new Promise((resolve) => { finishes.push(resolve); }));
  const imagePath = 'shops/shared-readers/r2/photo.webp';
  let liveCard: ShopCard = { ...shopCard, image_path: imagePath };
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_event_delivery_capability') return { data: { schema_version: 3 }, error: null };
    if (name === 'get_round_shop_cards') return { data: [liveCard], error: null };
    return { data: 1, error: null };
  });
  const gateway = createSupabaseGateway();
  const firstBase = vi.fn();
  const secondBase = vi.fn();
  const first = gateway.loadShopCards('shared-round', { onBaseCards: firstBase });
  const second = gateway.loadShopCards('shared-round', { onBaseCards: secondBase });
  await vi.waitFor(() => expect(secondBase).toHaveBeenCalledOnce());
  expect(firstBase).toHaveBeenCalledOnce();

  liveCard = { ...liveCard, stop_status: 'delivered' };
  const refreshedBase = vi.fn();
  const refreshed = gateway.loadShopCards('shared-round', { forceRefresh: true, onBaseCards: refreshedBase });
  await vi.waitFor(() => expect(refreshedBase).toHaveBeenCalledOnce());
  expect(refreshedBase.mock.calls[0][0][0].stop_status).toBe('delivered');
  const signingCalls = mocks.invoke.mock.calls.length;
  for (const finish of finishes) {
    finish({ data: { signedUrls: [{ path: imagePath, signedUrl: 'https://r2.test/shared-photo' }] }, error: null });
  }
  const [oldCards, otherCards, newCards] = await Promise.all([first, second, refreshed]);
  expect(oldCards[0].stop_status).toBe('pending');
  expect(otherCards[0].image_url).toBe('https://r2.test/shared-photo');
  expect(newCards[0]).toMatchObject({ stop_status: 'delivered', image_url: 'https://r2.test/shared-photo' });
  expect(signingCalls).toBe(1);
});

it('preserves fresh capability after a sale but revalidates it at its normal expiry', async () => {
  const now = vi.spyOn(Date, 'now');
  const startedAt = Date.now();
  now.mockReturnValue(startedAt);
  mocks.rpc.mockClear();
  let stopStatus = 'pending';
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_event_delivery_capability') return { data: { schema_version: 3 }, error: null };
    if (name === 'get_round_shop_cards') return { data: [{ ...shopCard, image_path: null, stop_status: stopStatus }], error: null };
    return { data: 1, error: null };
  });
  try {
    const gateway = createSupabaseGateway();
    await gateway.loadShopCards('after-sale');
    stopStatus = 'delivered';
    const refreshed = await gateway.loadShopCards('after-sale', { forceRefresh: true, refreshCapability: false });
    expect(refreshed[0].stop_status).toBe('delivered');
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'get_round_shop_cards')).toHaveLength(2);
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'get_event_delivery_capability')).toHaveLength(1);
    now.mockReturnValue(startedAt + 60_001);
    await gateway.loadShopCards('after-sale', { forceRefresh: true, refreshCapability: false });
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'get_event_delivery_capability')).toHaveLength(2);
  } finally {
    now.mockRestore();
  }
});
