import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';
import { useEmployeeDeliveryData } from '../src/features/employee-delivery/useEmployeeDeliveryData';
import type { ShopCard } from '../src/types/app';

const shop: ShopCard = {
  round_stop_id: 'stop-1',
  shop_id: 'shop-1',
  shop_code: 'BB15',
  shop_name: 'ร้านทดสอบ',
  building_id: 'building-1',
  building_name: 'อาคาร B',
  floor_or_zone: '1',
  sequence_no: 15,
  image_path: null,
  image_url: null,
  payment_status: 'unpaid',
  stop_status: 'pending',
  stop_note: null,
  today_history: [],
  today_totals: {},
};

function createGateway(): EmployeeDeliveryGateway {
  return {
    loadReferenceData: vi.fn().mockResolvedValue({
      rounds: [{
        id: 'round-1',
        service_date: '2026-08-19',
        name: 'งานประจำวัน',
        status: 'open',
        opened_at: '2026-08-19T01:00:00Z',
      }],
      iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
    }),
    loadShopCards: vi.fn().mockResolvedValue([shop]),
    loadEmployeeStockState: vi.fn(),
    recordEmployeeStockTransfer: vi.fn(),
    recordEmployeeStockReturn: vi.fn(),
    recordEmployeeStockDamage: vi.fn(),
    recordDelivery: vi.fn().mockResolvedValue(undefined),
  };
}

function DeliveryHarness({ gateway }: { gateway: EmployeeDeliveryGateway }) {
  const data = useEmployeeDeliveryData({
    gateway,
    requestScope: 'employee-1',
    serviceDate: '2026-08-19',
  });

  if (data.loadingReference || data.loadingCards || data.cards.length === 0) return <div>กำลังโหลด</div>;

  if (data.selectedCard) {
    return (
      <form onSubmit={data.handleSubmit}>
        <button onClick={() => data.setDeliveryQuantity('ice-1', 1)} type="button">ใส่จำนวน</button>
        <button type="submit">ยืนยันส่งร้านนี้</button>
      </form>
    );
  }

  return (
    <button
      onClick={() => data.openCard(shop)}
      ref={(node) => {
        if (node) data.shopButtonRefs.current.set(shop.round_stop_id, node);
        else data.shopButtonRefs.current.delete(shop.round_stop_id);
      }}
      type="button"
    >
      เลือกร้าน BB15
    </button>
  );
}

describe('employee delivery browse position', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('restores the saved scroll position only after the shop list is rendered again', async () => {
    const user = userEvent.setup();
    let scrollY = 1_400;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    vi.spyOn(window, 'scrollTo').mockImplementation((options) => {
      const requestedTop = typeof options === 'object' ? options.top ?? 0 : Number(options);
      scrollY = screen.queryByRole('button', { name: 'เลือกร้าน BB15' })
        ? requestedTop
        : 0;
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    render(<DeliveryHarness gateway={createGateway()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'เลือกร้าน BB15' }));
    await user.click(await screen.findByRole('button', { name: 'ใส่จำนวน' }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));

    await screen.findByRole('button', { name: 'เลือกร้าน BB15' });
    await waitFor(() => expect(scrollY).toBe(1_400));
  });
});
