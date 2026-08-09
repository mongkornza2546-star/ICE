import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EmployeeShopPicker } from '../src/features/employee-delivery/EmployeeShopPicker';
import type { ShopCard } from '../src/types/app';

const shop: ShopCard = {
  round_stop_id: 'stop-1',
  shop_id: 'shop-1',
  shop_code: 'BB16',
  shop_name: 'ร้านเล่าซา',
  building_id: 'building-1',
  building_name: 'ศูนย์อาหารฝั่งธนาคารกรุงไทย',
  floor_or_zone: 'B',
  sequence_no: 1,
  image_path: 'shops/bb16.jpg',
  image_url: 'https://example.com/bb16.jpg',
  payment_status: 'unpaid',
  stop_status: 'pending',
  stop_note: null,
  today_history: [],
  today_totals: {},
};

function renderPicker(openCard = vi.fn()) {
  render(<EmployeeShopPicker
    enableAssignedStockFlow={false}
    selectedRoundId="round-1"
    query=""
    setQuery={vi.fn()}
    selectedBuildingId=""
    setSelectedBuildingId={vi.fn()}
    buildingOptions={[]}
    selectedZone=""
    setSelectedZone={vi.fn()}
    zoneOptions={[]}
    loadingCards={false}
    filteredCards={[shop]}
    openCard={openCard}
    stockState={null}
    shopButtonRefs={{ current: new Map<string, HTMLButtonElement>() }}
  />);
  return openCard;
}

describe('employee shop picker image preview', () => {
  it('opens the shop photo without selecting the shop, then closes it', async () => {
    const user = userEvent.setup();
    const openCard = renderPicker();

    await user.click(screen.getByRole('button', { name: 'ดูรูปร้าน BB16 ร้านเล่าซา' }));

    expect(screen.getByRole('dialog', { name: 'รูปร้าน BB16 · ร้านเล่าซา' })).toBeTruthy();
    expect(openCard).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('still selects the shop from the shop details button', async () => {
    const user = userEvent.setup();
    const openCard = renderPicker();

    await user.click(screen.getByRole('button', { name: 'เลือกร้าน BB16 ร้านเล่าซา' }));
    expect(openCard).toHaveBeenCalledWith(shop);
  });
});
