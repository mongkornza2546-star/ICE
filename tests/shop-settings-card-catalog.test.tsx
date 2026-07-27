import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShopSettings } from '../src/ShopSettings';

const mocks = vi.hoisted(() => ({
  bulkSignedUrls: vi.fn(),
  from: vi.fn(),
  readinessReport: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
  },
}));

vi.mock('../src/features/admin-reference-settings/adminReferenceSettingsService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/features/admin-reference-settings/adminReferenceSettingsService')>();
  return {
    ...actual,
    getShopImageSignedUrls: (...args: unknown[]) => mocks.bulkSignedUrls(...args),
    loadShopPaymentProfile: vi.fn().mockResolvedValue(null),
    loadShopIcePrices: vi.fn().mockResolvedValue([]),
    loadPOSReadinessReport: (...args: unknown[]) => mocks.readinessReport(...args),
  };
});

const readyReport = {
  total_active_shops: 2,
  shops_ready_count: 1,
  shops_missing_payment_profile: 0,
  ice_types_missing_standard_price: 0,
  items: [{
    shop_id: 'shop-a',
    shop_code: 'AA01',
    shop_name: 'ร้านเจ๊อ้อย',
    has_payment_profile: true,
    missing_special_prices_count: 0,
    has_issues: false,
    issue_details: [],
  }],
};


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
    vi.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:tank-preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
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
      if (table === 'ice_types') return queryResult([
        { id: 'ice-block', code: 'BLOCK', name: 'ก้อน', unit: 'ถุง' },
      ]);
      if (table === 'shop_rented_tanks') return queryResult([]);
      throw new Error(`Unexpected table: ${table}`);

    });
    mocks.bulkSignedUrls.mockResolvedValue({
      'shops/shop-a/photo.jpg': 'https://example.test/shop-a.jpg',
    });
    mocks.readinessReport.mockResolvedValue(readyReport);
    mocks.rpc.mockResolvedValue({ data: null, error: null });
  });

  it('filters cards, reports the match count, and opens the selected shop in a dialog', async () => {
    const user = userEvent.setup();
    render(<ShopSettings />);

    expect(await screen.findByText('พบ 2 ร้าน')).toBeTruthy();
    const search = screen.getByRole('textbox', { name: 'ค้นหาร้าน' });
    await user.type(search, 'BB02');

    expect(screen.getByText('พบ 1 ร้าน')).toBeTruthy();
    expect(screen.queryByText('ร้านเจ๊อ้อย')).toBeNull();
    await user.click(screen.getByRole('button', { name: /BB02 ร้านน้ำฝน/ }));

    expect(screen.getByRole('dialog', { name: 'แก้ไข ร้านน้ำฝน' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'รหัสร้าน' }) as HTMLInputElement).value).toBe('BB02');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: /BB02 ร้านน้ำฝน/ }));
    await user.click(screen.getByRole('button', { name: 'ปิดหน้าต่างข้อมูลร้าน' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: /BB02 ร้านน้ำฝน/ }));
    fireEvent.mouseDown(document.querySelector('.shop-settings-backdrop')!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sorts shop cards by code using natural numeric order', async () => {
    const unsortedShops = [
      { ...shops[0], id: 'shop-10', code: 'AA10', name: 'ร้านสิบ', image_path: null },
      { ...shops[0], id: 'shop-2', code: 'AA2', name: 'ร้านสอง', image_path: null },
      { ...shops[0], id: 'shop-1', code: 'AA1', name: 'ร้านหนึ่ง', image_path: null },
    ];
    mocks.from.mockImplementation((table: string) => {
      if (table === 'shops') return queryResult(unsortedShops);
      if (table === 'buildings') return queryResult([{ id: 'building-a', code: 'A', name: 'ตึก A' }]);
      if (table === 'building_zones') return queryResult([{ id: 'zone-a', building_id: 'building-a', code: 'A1', name: 'โซน A1', sort_order: 1, is_active: true }]);
      if (table === 'ice_types') return queryResult([{ id: 'ice-block', code: 'BLOCK', name: 'ก้อน', unit: 'ถุง' }]);
      if (table === 'shop_rented_tanks') return queryResult([]);
      throw new Error(`Unexpected table: ${table}`);
    });

    render(<ShopSettings />);

    await screen.findByRole('button', { name: /AA1 ร้านหนึ่ง/ });
    const shopCodes = Array.from(document.querySelectorAll<HTMLButtonElement>('.shop-directory-card'))
      .map((button) => button.getAttribute('aria-label')?.match(/AA\d+/)?.[0]);

    expect(shopCodes).toEqual(['AA1', 'AA2', 'AA10']);
  });

  it('searches by phone number and routes each bulk action to the matching workflow', async () => {
    const user = userEvent.setup();
    render(<ShopSettings />);

    expect(await screen.findByText('พบ 2 ร้าน')).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'ค้นหาร้าน' }), '0811111111');
    expect(screen.getByText('พบ 1 ร้าน')).toBeTruthy();
    expect(screen.getByRole('button', { name: /AA01 ร้านเจ๊อ้อย/ })).toBeTruthy();

    await user.clear(screen.getByRole('textbox', { name: 'ค้นหาร้าน' }));
    await user.click(screen.getByRole('button', { name: 'ตั้งค่าประเภทการรับเงิน' }));
    expect(screen.getByRole('heading', { name: /กำหนดโปรไฟล์ชำระเงินแบบกลุ่ม/ })).toBeTruthy();
    fireEvent.mouseDown(document.querySelector('.modal-backdrop')!);

    await user.click(screen.getByRole('button', { name: 'ตั้งค่าหลายร้าน' }));
    expect(screen.getByRole('heading', { name: 'กำหนดราคาน้ำแข็งหลายร้าน' })).toBeTruthy();
  });

  it('renders neutral readiness and disables readiness filters when the report fails', async () => {
    const user = userEvent.setup();
    mocks.readinessReport.mockRejectedValueOnce(new Error('readiness unavailable'));
    render(<ShopSettings />);

    expect((await screen.findByRole('alert')).textContent).toContain('readiness unavailable');
    const card = screen.getByRole('button', { name: /AA01 ร้านเจ๊อ้อย/ });
    expect(card.textContent).toContain('ไม่ทราบ');
    expect(card.textContent).not.toContain('ไม่มี Payment Profile');
    expect((screen.getByRole('combobox', { name: 'กรองประเภทรายรับ' }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole('combobox', { name: 'กรองความพร้อม POS' }) as HTMLSelectElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'ลองใหม่' }));
    await waitFor(() => expect(mocks.readinessReport).toHaveBeenCalledTimes(2));
    expect((screen.getByRole('combobox', { name: 'กรองประเภทรายรับ' }) as HTMLSelectElement).disabled).toBe(false);
    expect(card.textContent).toContain('พร้อม POS');
  });

  it('keeps demo-preview management controls read-only', async () => {
    const user = userEvent.setup();
    render(<ShopSettings readOnly />);

    expect(await screen.findByText('พบ 2 ร้าน')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'ร้านใหม่' }));
    await user.click(screen.getByRole('button', { name: 'ตั้งค่าหลายร้าน' }));
    await user.click(screen.getByRole('button', { name: 'ตั้งค่าประเภทการรับเงิน' }));
    await user.click(screen.getByRole('button', { name: /AA01 ร้านเจ๊อ้อย/ }));

    expect(screen.queryByRole('dialog')).toBeNull();
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

  it('labels a shop without an uploaded photo instead of implying that one is still loading', async () => {
    render(<ShopSettings />);

    const card = await screen.findByRole('button', { name: /BB02 ร้านน้ำฝน/ });
    expect(card.textContent).toContain('ยังไม่มีรูป');
  });

  it('signs photos for only the visible catalog page', async () => {
    const manyShops = Array.from({ length: 13 }, (_, index) => ({
      ...shops[0],
      id: `shop-${index + 1}`,
      code: `AA${String(index + 1).padStart(2, '0')}`,
      image_path: `shops/shop-${index + 1}/photo.jpg`,
    }));
    mocks.from.mockImplementation((table: string) => {
      if (table === 'shops') return queryResult(manyShops);
      if (table === 'buildings') return queryResult([{ id: 'building-a', code: 'A', name: 'ตึก A' }]);
      if (table === 'building_zones') return queryResult([{ id: 'zone-a', building_id: 'building-a', code: 'A1', name: 'โซน A1', sort_order: 1, is_active: true }]);
      if (table === 'ice_types') return queryResult([{ id: 'ice-block', code: 'BLOCK', name: 'ก้อน', unit: 'ถุง' }]);
      if (table === 'shop_rented_tanks') return queryResult([]);
      throw new Error(`Unexpected table: ${table}`);
    });
    mocks.bulkSignedUrls.mockResolvedValue({});

    render(<ShopSettings />);

    await waitFor(() => expect(mocks.bulkSignedUrls).toHaveBeenCalled());
    expect(mocks.bulkSignedUrls).toHaveBeenCalledWith(
      manyShops.slice(0, 12).map((shop) => shop.image_path),
    );
  });

  it('preserves unsaved payment settings while switching editor tabs', async () => {
    const user = userEvent.setup();
    render(<ShopSettings />);

    await user.click(await screen.findByRole('button', { name: /AA01 ร้านเจ๊อ้อย/ }));
    await user.click(screen.getByRole('button', { name: 'การชำระเงิน' }));

    const endOfDay = await screen.findByRole('checkbox', { name: /เก็บท้ายวัน/ });
    await user.click(endOfDay);
    expect((endOfDay as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getByRole('button', { name: 'ราคาพิเศษน้ำแข็ง' }));
    await user.click(screen.getByRole('button', { name: 'การชำระเงิน' }));

    expect((screen.getByRole('checkbox', { name: /เก็บท้ายวัน/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('shows deactivation errors from every editor tab', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'deactivation failed' } });
    render(<ShopSettings />);

    await user.click(await screen.findByRole('button', { name: /AA01 ร้านเจ๊อ้อย/ }));
    await user.click(screen.getByRole('button', { name: 'ถังเช่าและรูปภาพ' }));
    await user.click(screen.getByRole('button', { name: 'ปิดร้าน / ย้ายออก' }));

    expect((await screen.findByRole('alert')).textContent).toContain('deactivation failed');
  });

  it('shows the shop photo before rented tanks in the assets tab', async () => {
    const user = userEvent.setup();
    render(<ShopSettings />);

    await user.click(await screen.findByRole('button', { name: /AA01 ร้านเจ๊อ้อย/ }));
    await user.click(screen.getByRole('button', { name: 'ถังเช่าและรูปภาพ' }));

    const shopImageEditor = screen.getByTestId('shop-image-editor');
    const rentedTanks = screen.getByRole('heading', { name: /ถังเช่า 0 ใบ/ });
    expect(shopImageEditor.compareDocumentPosition(rentedTanks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a preview after selecting a rented tank photo', async () => {
    const user = userEvent.setup();
    render(<ShopSettings />);

    await user.click(await screen.findByRole('button', { name: /AA01 ร้านเจ๊อ้อย/ }));
    await user.click(screen.getByRole('button', { name: 'ถังเช่าและรูปภาพ' }));
    const photo = new File(['tank photo'], 'tank.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('เลือกรูปถัง'), photo);

    const preview = screen.getByRole('img', { name: 'ตัวอย่างรูปถังที่เลือก' }) as HTMLImageElement;
    expect(preview.src).toBe('blob:tank-preview');
    expect(screen.getByText('tank.jpg')).toBeTruthy();
  });
});
