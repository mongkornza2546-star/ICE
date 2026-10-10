import { render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmployeeDeliveryWorkspace, type EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';
import { readPosCollectionReturn } from '../src/lib/posCollectionReturn';
import { toBangkokDateString } from '../src/lib/serviceDate';
import type { CollectionCloseResult, CollectionFocusRequest, ShopCard } from '../src/types/app';

vi.mock('../src/features/financial-operations/components/DailyCreditAcknowledgementPanel', () => ({
  DailyCreditAcknowledgementPanel: ({ shopId, serviceDate, printerName, onBack }: {
    shopId: string; serviceDate: string; printerName: string; onBack: () => void;
  }) => <section aria-label="Credit print page">
    <p>{shopId} / {serviceDate} / {printerName}</p>
    <button onClick={onBack}>กลับ POS</button>
  </section>,
}));

const deliveredShop: ShopCard = {
  round_stop_id: 'stop-bb44',
  shop_id: 'shop-bb44',
  shop_code: 'BB44',
  shop_name: 'ร้านใหม่น้ำปั่น (ปุ้ย)',
  building_id: 'building-b',
  building_name: 'B',
  floor_or_zone: 'ซุ้มโดม 3',
  sequence_no: 44,
  image_path: null,
  image_url: null,
  payment_status: 'unpaid',
  stop_status: 'delivered',
  stop_note: null,
  today_history: [],
  today_totals: {},
};

function createGateway(outstandingAmount: number): EmployeeDeliveryGateway {
  return {
    loadReferenceData: vi.fn().mockResolvedValue({
      rounds: [{
        id: 'round-1', service_date: '2026-09-25', name: 'รอบเช้า', status: 'open', opened_at: '2026-09-25T01:00:00Z',
      }],
      iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'น้ำแข็ง', unit: 'ถุง' }],
    }),
    loadShopCards: vi.fn().mockResolvedValue([deliveredShop]),
    loadCollectionOutstanding: vi.fn().mockResolvedValue(outstandingAmount > 0 ? [{
      queueKey: 'regular:shop-bb44',
      shopId: 'shop-bb44',
      outstandingAmount,
    }] : []),
    loadEmployeeStockState: vi.fn(),
    recordEmployeeStockTransfer: vi.fn(),
    recordEmployeeStockReturn: vi.fn(),
    recordEmployeeStockDamage: vi.fn(),
    recordDelivery: vi.fn(),
    recordImmediateSale: vi.fn(),
  };
}

describe('POS payment shortcut', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it('opens employee events from POS without requiring a delivery round action', async () => {
    const user = userEvent.setup();
    const onOpenEvents = vi.fn();
    render(<EmployeeDeliveryWorkspace
      gateway={createGateway(0)}
      onOpenEvents={onOpenEvents}
      requestScope="employee-1"
      serviceDate="2026-09-25"
      viewMode="pos"
    />);

    await user.click(await screen.findByRole('button', { name: 'เปิดอีเวนต์' }));
    expect(onOpenEvents).toHaveBeenCalledOnce();
  });

  it('opens the existing collection flow without recording another delivery', async () => {
    const user = userEvent.setup();
    const gateway = createGateway(240);
    let storedAtHandoff: ReturnType<typeof readPosCollectionReturn> = null;
    const onOpenCollection = vi.fn(() => {
      storedAtHandoff = readPosCollectionReturn('employee-1');
    });
    render(<EmployeeDeliveryWorkspace
      canCollectShopPayments
      gateway={gateway}
      onOpenCollection={onOpenCollection}
      requestScope="employee-1"
      serviceDate="2026-09-25"
      viewMode="pos"
    />);

    expect(await screen.findByText(/ยอดรอรับชำระ.*240/)).toBeTruthy();
    expect(gateway.loadCollectionOutstanding).toHaveBeenCalledWith(toBangkokDateString());
    expect(gateway.loadReferenceData).toHaveBeenCalledWith('2026-09-25');
    await user.click(screen.getByRole('button', { name: 'เลือกร้าน BB44 ร้านใหม่น้ำปั่น (ปุ้ย)' }));
    expect(screen.getByText('สถานะวันนี้').parentElement?.textContent).toContain('ส่งแล้ว');
    expect(screen.getByText('ยอดรอรับชำระ').parentElement?.textContent).toContain('240');

    await user.click(screen.getByRole('button', { name: 'รับชำระ' }));

    await waitFor(() => expect(onOpenCollection).toHaveBeenCalledWith(expect.objectContaining({
      source: 'pos-shortcut',
      shopId: 'shop-bb44',
      queueKey: 'regular:shop-bb44',
    })));
    expect(storedAtHandoff).toEqual(expect.objectContaining({
      returnTo: 'pos',
      posServiceDate: '2026-09-25',
      collectionServiceDate: toBangkokDateString(),
      shopId: 'shop-bb44',
      request: expect.objectContaining({
        source: 'pos-shortcut',
        queueKey: 'regular:shop-bb44',
      }),
    }));
    expect(gateway.recordDelivery).not.toHaveBeenCalled();
    expect(gateway.recordImmediateSale).not.toHaveBeenCalled();
  });

  it('keeps send available and disables collection when no amount is due', async () => {
    const user = userEvent.setup();
    const gateway = createGateway(0);
    render(<EmployeeDeliveryWorkspace
      canCollectShopPayments
      gateway={gateway}
      onOpenCollection={vi.fn()}
      requestScope="employee-1"
      serviceDate="2026-09-25"
      viewMode="pos"
    />);

    await user.click(await screen.findByRole('button', { name: 'เลือกร้าน BB44 ร้านใหม่น้ำปั่น (ปุ้ย)' }));
    expect(screen.getByText('ไม่มียอดถึงกำหนด')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'รับชำระ' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'ส่งเพิ่ม' }).hasAttribute('disabled')).toBe(false);
  });

  it.each([true, false])('shows the credit print shortcut only for credit shops (credit: %s)', async (credit) => {
    const user = userEvent.setup();
    const gateway = createGateway(0);
    gateway.loadShopCreditEligibility = vi.fn().mockResolvedValue(credit);
    gateway.loadDeliveryPosContext = vi.fn().mockRejectedValue(new Error('No assigned holding location'));
    render(<EmployeeDeliveryWorkspace gateway={gateway} printerName="พนักงานทดสอบ"
      serviceDate="2026-09-25" viewMode="pos" />);
    await user.click(await screen.findByRole('button', { name: 'เลือกร้าน BB44 ร้านใหม่น้ำปั่น (ปุ้ย)' }));
    await waitFor(() => expect(gateway.loadShopCreditEligibility).toHaveBeenCalledWith('shop-bb44'));
    expect(gateway.loadDeliveryPosContext).not.toHaveBeenCalled();
    if (!credit) {
      expect(screen.queryByRole('button', { name: 'ใบเซ็นเครดิต' })).toBeNull();
      return;
    }
    await user.click(await screen.findByRole('button', { name: 'ใบเซ็นเครดิต' }));
    expect(screen.getByRole('region', { name: 'Credit print page' }).textContent)
      .toContain('shop-bb44 / 2026-09-25 / พนักงานทดสอบ');
    await user.click(screen.getByRole('button', { name: 'กลับ POS' }));
    expect(screen.getByRole('heading', { name: deliveredShop.shop_name })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'รับชำระ' }).hasAttribute('disabled')).toBe(true);
    expect(gateway.recordDelivery).not.toHaveBeenCalled();
    expect(gateway.recordImmediateSale).not.toHaveBeenCalled();
  });

  it('reports credit lookup failures and retries without leaving the shop', async () => {
    const user = userEvent.setup();
    const gateway = createGateway(0);
    gateway.loadShopCreditEligibility = vi.fn()
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce(true);
    render(<EmployeeDeliveryWorkspace gateway={gateway} serviceDate="2026-09-25" viewMode="pos" />);
    await user.click(await screen.findByRole('button', { name: 'เลือกร้าน BB44 ร้านใหม่น้ำปั่น (ปุ้ย)' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Network unavailable');
    await user.click(screen.getByRole('button', { name: 'ลองใหม่' }));
    expect(await screen.findByRole('button', { name: 'ใบเซ็นเครดิต' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(gateway.loadShopCreditEligibility).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['cancelled', true], ['completed', true], ['cancelled', false], ['completed', false],
  ] as const)('restores POS after %s collection (storage: %s)', async (status, storageAvailable) => {
    const user = userEvent.setup();
    const gateway = createGateway(240);
    function Harness() {
      const [request, setRequest] = useState<CollectionFocusRequest | null>(null);
      const [result, setResult] = useState<CollectionCloseResult | null>(null);
      return <>
        <div style={{ display: request ? 'none' : undefined }}>
          <EmployeeDeliveryWorkspace gateway={gateway} canCollectShopPayments
            isActive={!request} onOpenCollection={setRequest} collectionCloseResult={result}
            requestScope="employee-1" serviceDate="2026-09-25" viewMode="pos" />
        </div>
        {request ? <button onClick={() => {
          setResult({ status, requestId: request.requestId, shopId: request.shopId,
            paymentId: status === 'completed' ? 'payment-1' : undefined });
          setRequest(null);
        }}>Return to POS</button> : null}
      </>;
    }
    const storage = storageAvailable ? null : vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'SecurityError');
    });
    try {
      render(<Harness />);
      await screen.findByText(/ยอดรอรับชำระ.*240/);
      await user.type(screen.getByRole('searchbox'), 'BB44');
      await user.click(screen.getByRole('button', { name: 'B', exact: true }));
      await user.click(screen.getByRole('button', { name: 'ซุ้มโดม 3', exact: true }));
      await user.click(screen.getByRole('button', { name: 'เลือกร้าน BB44 ร้านใหม่น้ำปั่น (ปุ้ย)' }));
      await user.click(screen.getByRole('button', { name: 'รับชำระ' }));
      if (storageAvailable) expect(readPosCollectionReturn('employee-1')).not.toBeNull();
      if (status === 'completed') vi.mocked(gateway.loadCollectionOutstanding!).mockResolvedValue([]);
      await user.click(screen.getByRole('button', { name: 'Return to POS' }));
      const card = await screen.findByRole('button', { name: 'เลือกร้าน BB44 ร้านใหม่น้ำปั่น (ปุ้ย)' });
      await waitFor(() => expect(document.activeElement).toBe(card));
      expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('BB44');
      expect(screen.getByRole('button', { name: 'B', exact: true }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByRole('button', { name: 'ซุ้มโดม 3', exact: true }).getAttribute('aria-pressed')).toBe('true');
      expect(await screen.findByText(status === 'completed' ? /ยอดรอรับชำระ.*0/ : /ยอดรอรับชำระ.*240/)).toBeTruthy();
      if (storageAvailable) expect(readPosCollectionReturn('employee-1')).toBeNull();
      expect(gateway.recordDelivery).not.toHaveBeenCalled();
      expect(gateway.recordImmediateSale).not.toHaveBeenCalled();
    } finally {
      storage?.mockRestore();
    }
  });
});
