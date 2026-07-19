import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShopSettings } from '../src/ShopSettings';

const mocks = vi.hoisted(() => ({
  bulkSignedUrls: vi.fn(),
  from: vi.fn(),
  scrollIntoView: vi.fn(),
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: mocks.from,
  },
}));

vi.mock('../src/features/admin-reference-settings/adminReferenceSettingsService', () => ({
  getShopImageSignedUrls: mocks.bulkSignedUrls,
}));

vi.mock('../src/features/admin-reference-settings/components/ShopImageEditor', () => ({
  ShopImageEditor: () => <div data-testid="shop-image-editor" />,
}));

const shops = [
  {
    id: 'shop-a',
    code: 'AA01',
    name: 'ร้านเจ๊อ้อย',
    image_path: 'shops/shop-a/photo.jpg',
    building_id: 'building-a',
    zone_id: 'zone-a',
    floor_or_zone: 'ชั้น 1',
    government_shop_code: 'GOV-01',
    contact_name: 'คุณอ้อย',
    contact_phone: '0811111111',
    normal_rounds_per_day: 2,
    access_note: null,
    status: 'active',
  },
  {
    id: 'shop-b',
    code: 'BB02',
    name: 'ร้านน้ำฝน',
    image_path: null,
    building_id: 'building-b',
    zone_id: 'zone-b',
    floor_or_zone: 'ชั้น 2',
    government_shop_code: null,
    contact_name: null,
    contact_phone: null,
    normal_rounds_per_day: 1,
    access_note: 'เข้าด้านหลัง',
    status: 'inactive',
  },
] as const;

function queryResult(data: unknown[]) {
  const result = { data, error: null };
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    order: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.order.mockResolvedValue(result);
  return query;
}

describe('ShopSettings card catalog', () => {
  beforeEach(() => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'shops') return queryResult([...shops]);
      if (table === 'buildings') return queryResult([
        { id: 'building-a', code: 'A', name: 'ตึก A' },
        { id: 'building-b', code: 'B', name: 'ตึก B' },
      ]);
      if (table === 'building_zones') return queryResult([
        { id: 'zone-a', building_id: 'building-a', code: 'A1', name: 'โซน A1', sort_order: 1, is_active: true },
        { id: 'zone-b', building_id: 'building-b', code: 'B1', name: 'โซน B1', sort_order: 1, is_active: true },
      ]);
      if (table === 'shop_rented_tanks') return queryResult([]);
      throw new Error(`Unexpected table: ${table}`);
    });
    mocks.bulkSignedUrls.mockResolvedValue({
      'shops/shop-a/photo.jpg': 'https://example.test/shop-a.jpg',
    });
    mocks.scrollIntoView.mockClear();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: mocks.scrollIntoView,
    });
  });

  it('filters cards, reports the match count, and selects a shop into the editor', async () => {
    const user = userEvent.setup();
    render(<ShopSettings />);

    expect(await screen.findByText('พบ 2 ร้าน')).toBeTruthy();
    const search = screen.getByRole('textbox', { name: 'ค้นหาร้าน' });
    await user.type(search, 'BB02');

    expect(screen.getByText('พบ 1 ร้าน')).toBeTruthy();
    expect(screen.queryByText('ร้านเจ๊อ้อย')).toBeNull();
    await user.click(screen.getByRole('button', { name: /BB02 ร้านน้ำฝน/ }));

    expect((screen.getByRole('textbox', { name: 'รหัสร้าน' }) as HTMLInputElement).value).toBe('BB02');
    expect(mocks.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('bulk-signs stored photos and falls back when a signed image fails to load', async () => {
    render(<ShopSettings />);

    await waitFor(() => expect(mocks.bulkSignedUrls).toHaveBeenCalledWith(['shops/shop-a/photo.jpg']));
    const card = screen.getByRole('button', { name: /AA01 ร้านเจ๊อ้อย/ });
    const image = card.querySelector('img');
    expect(image?.src).toBe('https://example.test/shop-a.jpg');

    fireEvent.error(image!);
    expect(card.querySelector('img')).toBeNull();
  });
});
