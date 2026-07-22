import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmployeeDeliveryWorkspace,
  type EmployeeDeliveryGateway,
  type EmployeeDeliveryPayload,
  type EmployeeStockTransferPayload,
} from '../src/EmployeeDeliveryWorkspace';
import type { DeliveryRound, EmployeeStockState, IceTypeOption, ShopCard } from '../src/types/app';

const round: DeliveryRound = {
  id: 'round-1',
  service_date: '2026-07-16',
  name: 'รอบเช้า',
  status: 'open',
  opened_at: '2026-07-16T01:00:00.000Z',
};

const iceTypes: IceTypeOption[] = [
  { id: 'ice-block', code: 'BLOCK', name: 'ก้อน', unit: 'ถุง' },
  { id: 'ice-small', code: 'SMALL', name: 'เล็ก', unit: 'ถุง' },
];

function card(code: string, name: string, building = 'ตึก A', zone = 'โซน 1'): ShopCard {
  return {
    round_stop_id: `stop-${code}`,
    shop_id: `shop-${code}`,
    shop_code: code,
    shop_name: name,
    building_id: `building-${building}`,
    building_name: building,
    floor_or_zone: zone,
    sequence_no: 1,
    image_path: null,
    image_url: null,
    payment_status: 'unknown',
    stop_status: 'pending',
    stop_note: null,
    today_history: [],
    today_totals: {},
  };
}

const shopA = card('AA01', 'ร้านเจ๊อ้อย');
const shopB = card('BB01', 'ร้านน้ำฝน', 'ตึก B', 'โซน 2');

function employeeStockState(overrides: Partial<EmployeeStockState> = {}): EmployeeStockState {
  return {
    round_id: round.id,
    service_date: round.service_date,
    truck_location: {
      id: 'truck-main',
      code: 'TRUCK-MAIN',
      name: 'รถบรรทุกหลัก',
      balances: iceTypes.map((iceType) => ({
        ice_type_id: iceType.id,
        ice_type_name: iceType.name,
        unit: iceType.unit,
        quantity: 20,
      })),
    },
    holding_location: {
      id: 'holding-user',
      code: 'TEAM-01',
      name: 'รถเข็นคัน 1',
      balances: iceTypes.map((iceType) => ({
        ice_type_id: iceType.id,
        ice_type_name: iceType.name,
        unit: iceType.unit,
        quantity: 5,
      })),
    },
    ...overrides,
  };
}

function createGateway(overrides: Partial<EmployeeDeliveryGateway> = {}) {
  const gateway: EmployeeDeliveryGateway = {
    loadReferenceData: vi.fn().mockResolvedValue({ rounds: [round], iceTypes }),
    loadShopCards: vi.fn().mockResolvedValue([shopA, shopB]),
    loadEmployeeStockState: vi.fn().mockResolvedValue(employeeStockState()),
    recordEmployeeStockTransfer: vi.fn().mockResolvedValue(employeeStockState()),
    recordDelivery: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return gateway;
}

async function openShop(user: ReturnType<typeof userEvent.setup>, shop = shopA) {
  await user.click(await screen.findByRole('button', {
    name: new RegExp(`${shop.shop_code} ${shop.shop_name}`),
  }));
  await screen.findByRole('heading', { name: new RegExp(shop.shop_name) });
}

describe('EmployeeDeliveryWorkspace', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    let nextId = 0;
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: vi.fn(() => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`),
    });
  });

  it('shows the truck-stock step before the shop-selection step', async () => {
    render(<EmployeeDeliveryWorkspace gateway={createGateway()} />);

    const stockHeading = await screen.findByRole('heading', { name: 'น้ำแข็งออกจากรถ' });
    const shopHeading = screen.getByRole('heading', { name: 'เลือกร้านที่จะไปส่ง' });

    expect(
      stockHeading.compareDocumentPosition(shopHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('transfers stock to the assigned holding point separately from the shop delivery', async () => {
    const user = userEvent.setup();
    const initialStock = employeeStockState();
    const transferredStock = employeeStockState({
      truck_location: {
        ...initialStock.truck_location,
        balances: initialStock.truck_location.balances.map((item) => ({
          ...item,
          quantity: item.ice_type_id === 'ice-block' ? 18 : item.quantity,
        })),
      },
      holding_location: {
        ...initialStock.holding_location,
        balances: initialStock.holding_location.balances.map((item) => ({
          ...item,
          quantity: item.ice_type_id === 'ice-block' ? 7 : item.quantity,
        })),
      },
    });
    const gateway = createGateway({
      loadEmployeeStockState: vi.fn().mockResolvedValue(initialStock),
      recordEmployeeStockTransfer: vi.fn().mockResolvedValue(transferredStock),
    });
    render(<EmployeeDeliveryWorkspace enableAssignedStockFlow gateway={gateway} />);

    expect(await screen.findByRole('heading', { name: 'รับน้ำแข็งเข้าจุดถือครอง' })).toBeTruthy();
    expect(await screen.findByText('รถเข็นคัน 1')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'เพิ่มก้อนอีกหนึ่ง' }));
    await user.click(screen.getByRole('button', { name: 'เพิ่มก้อนอีกหนึ่ง' }));

    const blockRow = screen.getByText('ก้อน').closest('.employee-stock-row');
    expect(blockRow?.textContent).toContain('20−2+1857');
    await user.click(screen.getByRole('button', { name: 'ยืนยันรับน้ำแข็ง' }));

    await waitFor(() => expect(gateway.recordEmployeeStockTransfer).toHaveBeenCalledWith({
      roundId: round.id,
      items: [{ ice_type_id: 'ice-block', quantity: 2 }],
      idempotencyKey: expect.any(String),
    }));
    await screen.findByText('รับน้ำแข็งเข้า รถเข็นคัน 1 แล้ว');

    await openShop(user);
    expect(screen.getByLabelText('จำนวนก้อน').textContent).toBe('0');
    await user.click(screen.getByRole('button', { name: 'เพิ่มก้อนอีกหนึ่ง' }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));

    await waitFor(() => expect(gateway.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
      roundStopId: shopA.round_stop_id,
      items: [{ ice_type_id: 'ice-block', quantity: 1 }],
    })));
  });

  it('reuses the stock-transfer idempotency key after a network failure', async () => {
    const user = userEvent.setup();
    const recordEmployeeStockTransfer = vi.fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(employeeStockState());
    const gateway = createGateway({ recordEmployeeStockTransfer });
    render(<EmployeeDeliveryWorkspace enableAssignedStockFlow gateway={gateway} />);

    await screen.findByText('รถเข็นคัน 1');
    await user.click(screen.getByRole('button', { name: 'เพิ่มก้อนอีกหนึ่ง' }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันรับน้ำแข็ง' }));
    expect((await screen.findByRole('alert')).textContent).toContain('เชื่อมต่อไม่สำเร็จ');

    await user.click(screen.getByRole('button', { name: 'ยืนยันรับน้ำแข็ง' }));
    await waitFor(() => expect(recordEmployeeStockTransfer).toHaveBeenCalledTimes(2));
    const first = recordEmployeeStockTransfer.mock.calls[0][0] as EmployeeStockTransferPayload;
    const second = recordEmployeeStockTransfer.mock.calls[1][0] as EmployeeStockTransferPayload;
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it.each([
    ['Employee holding location: none is configured', 'ยังไม่มีจุดถือครองที่ผูกกับบัญชีนี้'],
    ['Employee holding locations: multiple are configured', 'พบจุดถือครองของบัญชีนี้หลายจุด'],
    ['The truck does not have enough stock', 'น้ำแข็งบนรถมีไม่พอ'],
  ])('shows an actionable assigned-stock error for %s', async (message, expected) => {
    const gateway = createGateway({
      loadEmployeeStockState: vi.fn().mockRejectedValue(new Error(message)),
    });
    render(<EmployeeDeliveryWorkspace enableAssignedStockFlow gateway={gateway} />);

    expect((await screen.findByRole('alert')).textContent).toContain(expected);
    expect(screen.getByRole('button', { name: 'ลองใหม่' })).toBeTruthy();
  });

  it('keeps delivery locked until both cards and assigned stock refresh', async () => {
    const user = userEvent.setup();
    let resolveStockRefresh!: (state: EmployeeStockState) => void;
    const stockRefresh = new Promise<EmployeeStockState>((resolve) => { resolveStockRefresh = resolve; });
    const loadEmployeeStockState = vi.fn()
      .mockResolvedValueOnce(employeeStockState())
      .mockImplementationOnce(() => stockRefresh);
    const gateway = createGateway({ loadEmployeeStockState });
    render(<EmployeeDeliveryWorkspace enableAssignedStockFlow gateway={gateway} />);

    await openShop(user);
    await user.click(screen.getByRole('button', { name: 'เพิ่มก้อนอีกหนึ่ง' }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));

    await waitFor(() => expect(gateway.recordDelivery).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole('button', { name: 'กำลังบันทึก...' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'กลับไปเลือกร้าน' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => resolveStockRefresh(employeeStockState()));
    await screen.findByText('บันทึกยอดออกจากรถเข็นคัน 1และร้านปลายทางแล้ว');
    expect(loadEmployeeStockState).toHaveBeenCalledTimes(2);
  });

  it('records quantities for multiple ice types and returns to the filtered shop list', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    render(<EmployeeDeliveryWorkspace gateway={gateway} />);

    const search = await screen.findByRole('searchbox', { name: 'ค้นหาร้าน' });
    await user.type(search, 'AA01');
    expect(screen.queryByRole('button', { name: /BB01 ร้านน้ำฝน/ })).toBeNull();

    await user.click(await screen.findByRole('button', { name: 'ตั้งจำนวนเป็น 2' }));
    await user.click(screen.getByRole('button', { name: /เล็ก 0 ถุง/ }));
    await user.click(screen.getByRole('button', { name: 'ตั้งจำนวนเป็น 3' }));
    await openShop(user);
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));

    await waitFor(() => expect(gateway.recordDelivery).toHaveBeenCalledTimes(1));
    expect(gateway.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
      roundStopId: 'stop-AA01',
      status: 'delivered',
      note: null,
      items: [
        { ice_type_id: 'ice-block', quantity: 2 },
        { ice_type_id: 'ice-small', quantity: 3 },
      ],
      clientRecordedAt: expect.any(String),
      idempotencyKey: expect.any(String),
    }));

    await screen.findByText('บันทึกยอดออกจากรถและร้านปลายทางแล้ว');
    expect((screen.getByRole('searchbox', { name: 'ค้นหาร้าน' }) as HTMLInputElement).value).toBe('AA01');
    const returnedShop = screen.getByRole('button', { name: /AA01 ร้านเจ๊อ้อย/ });
    expect(returnedShop).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(returnedShop));
    expect(screen.queryByRole('button', { name: /BB01 ร้านน้ำฝน/ })).toBeNull();
  });

  it('does not submit a delivery without a positive quantity', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    render(<EmployeeDeliveryWorkspace gateway={gateway} />);

    await openShop(user);
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));

    expect((await screen.findByRole('alert')).textContent).toContain('ใส่จำนวนน้ำแข็งที่หยิบออกจากรถอย่างน้อย 1 รายการ');
    expect(gateway.recordDelivery).not.toHaveBeenCalled();
  });

  it('blocks delivery entry when no active ice type is configured', async () => {
    const gateway = createGateway({
      loadReferenceData: vi.fn().mockResolvedValue({ rounds: [round], iceTypes: [] }),
    });
    render(<EmployeeDeliveryWorkspace gateway={gateway} />);

    expect(await screen.findByRole('heading', { name: 'ยังไม่มีชนิดน้ำแข็งที่ใช้งาน' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /AA01 ร้านเจ๊อ้อย/ })).toBeNull();
  });

  it('requires a note for a problem and submits the problem without ice items', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    render(<EmployeeDeliveryWorkspace gateway={gateway} />);

    await openShop(user);
    await user.click(screen.getByRole('button', { name: 'แจ้งเหตุส่งไม่ได้' }));
    await user.click(screen.getByRole('button', { name: 'ปิดร้าน' }));
    await user.click(screen.getByRole('button', { name: 'บันทึกเหตุ' }));
    expect((await screen.findByRole('alert')).textContent).toContain('ใส่หมายเหตุว่าเกิดอะไรขึ้นกับร้าน');

    await user.type(screen.getByRole('textbox', { name: 'หมายเหตุที่เกิดขึ้น' }), 'ร้านหยุดวันนี้');
    await user.click(screen.getByRole('button', { name: 'บันทึกเหตุ' }));

    await waitFor(() => expect(gateway.recordDelivery).toHaveBeenCalledTimes(1));
    expect(gateway.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
      roundStopId: 'stop-AA01',
      status: 'closed_shop',
      note: 'ร้านหยุดวันนี้',
      items: [],
    }));
  });

  it('reuses the idempotency key and timestamp when the same failed payload is retried', async () => {
    const user = userEvent.setup();
    const recordDelivery = vi.fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(undefined);
    const gateway = createGateway({ recordDelivery });
    render(<EmployeeDeliveryWorkspace gateway={gateway} />);

    await user.click(await screen.findByRole('button', { name: 'ตั้งจำนวนเป็น 2' }));
    await openShop(user);
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));
    expect((await screen.findByRole('alert')).textContent).toContain('เชื่อมต่อไม่สำเร็จ');

    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));
    await waitFor(() => expect(recordDelivery).toHaveBeenCalledTimes(2));

    const first = recordDelivery.mock.calls[0][0] as EmployeeDeliveryPayload;
    const second = recordDelivery.mock.calls[1][0] as EmployeeDeliveryPayload;
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.clientRecordedAt).toBe(first.clientRecordedAt);
  });

  it('reuses an unresolved request after leaving and reopening the shop', async () => {
    const user = userEvent.setup();
    const recordDelivery = vi.fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(undefined);
    const gateway = createGateway({ recordDelivery });
    const firstView = render(<EmployeeDeliveryWorkspace gateway={gateway} />);

    await user.click(await screen.findByRole('button', { name: 'ตั้งจำนวนเป็น 2' }));
    await openShop(user);
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));
    expect((await screen.findByRole('alert')).textContent).toContain('เชื่อมต่อไม่สำเร็จ');
    const first = recordDelivery.mock.calls[0][0] as EmployeeDeliveryPayload;

    firstView.unmount();
    render(<EmployeeDeliveryWorkspace gateway={gateway} />);
    await user.click(await screen.findByRole('button', { name: 'ตั้งจำนวนเป็น 2' }));
    await openShop(user);
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));
    await waitFor(() => expect(recordDelivery).toHaveBeenCalledTimes(2));

    const second = recordDelivery.mock.calls[1][0] as EmployeeDeliveryPayload;
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.clientRecordedAt).toBe(first.clientRecordedAt);
  });

  it('shows the status and note for a failed-delivery history entry', async () => {
    const gateway = createGateway({
      loadShopCards: vi.fn().mockResolvedValue([{
        ...shopA,
        today_history: [{
          event_id: 'event-1',
          recorded_at: '2026-07-16T02:00:00.000Z',
          round_name: 'รอบเช้า',
          recorded_by: 'พนักงานหนึ่ง',
          stop_status: 'closed_shop',
          note: 'ร้านหยุดวันนี้',
          items: {},
        }],
      }]),
    });
    const user = userEvent.setup();
    render(<EmployeeDeliveryWorkspace gateway={gateway} />);

    await openShop(user);

    expect(screen.getByText('ปิดร้าน · ร้านหยุดวันนี้')).toBeTruthy();
  });

  it('keeps navigation and repeat submission locked until the shop list refreshes', async () => {
    const user = userEvent.setup();
    let resolveRefresh!: (cards: ShopCard[]) => void;
    const refresh = new Promise<ShopCard[]>((resolve) => { resolveRefresh = resolve; });
    const loadShopCards = vi.fn()
      .mockResolvedValueOnce([shopA, shopB])
      .mockImplementationOnce(() => refresh);
    const gateway = createGateway({ loadShopCards });
    const onDraftStateChange = vi.fn();
    render(<EmployeeDeliveryWorkspace gateway={gateway} onDraftStateChange={onDraftStateChange} />);

    await user.click(await screen.findByRole('button', { name: 'ตั้งจำนวนเป็น 2' }));
    await openShop(user);
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));

    await waitFor(() => expect(gateway.recordDelivery).toHaveBeenCalledTimes(1));
    const submitting = await screen.findByRole('button', { name: 'กำลังบันทึก...' });
    const back = screen.getByRole('button', { name: 'กลับไปเลือกร้าน' });
    expect((submitting as HTMLButtonElement).disabled).toBe(true);
    expect((back as HTMLButtonElement).disabled).toBe(true);
    expect(onDraftStateChange).toHaveBeenCalledWith({ dirty: true, submitting: true });
    await user.click(submitting);
    expect(gateway.recordDelivery).toHaveBeenCalledTimes(1);

    await act(async () => resolveRefresh([shopA, shopB]));
    await screen.findByText('บันทึกยอดออกจากรถและร้านปลายทางแล้ว');
    expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: false, submitting: false });
  });

  it('keeps a retry action visible when the post-save shop refresh fails', async () => {
    const user = userEvent.setup();
    const loadShopCards = vi.fn()
      .mockResolvedValueOnce([shopA, shopB])
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce([shopA, shopB]);
    const gateway = createGateway({ loadShopCards });
    render(<EmployeeDeliveryWorkspace gateway={gateway} />);

    await user.click(await screen.findByRole('button', { name: 'ตั้งจำนวนเป็น 2' }));
    await openShop(user);
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));

    expect((await screen.findByRole('alert')).textContent).toContain('บันทึกสำเร็จแล้ว แต่โหลดรายการร้านล่าสุดไม่สำเร็จ');
    const retry = screen.getByRole('button', { name: 'ลองใหม่' });
    await user.click(retry);
    await waitFor(() => expect(loadShopCards).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('ignores a stale shop response after the employee changes rounds', async () => {
    const user = userEvent.setup();
    const secondRound: DeliveryRound = { ...round, id: 'round-2', name: 'รอบสาย' };
    let resolveFirst!: (cards: ShopCard[]) => void;
    let resolveSecond!: (cards: ShopCard[]) => void;
    const firstCards = new Promise<ShopCard[]>((resolve) => { resolveFirst = resolve; });
    const secondCards = new Promise<ShopCard[]>((resolve) => { resolveSecond = resolve; });
    const loadShopCards = vi.fn((roundId: string) => roundId === round.id ? firstCards : secondCards);
    const gateway = createGateway({
      loadReferenceData: vi.fn().mockResolvedValue({ rounds: [round, secondRound], iceTypes }),
      loadShopCards,
    });
    render(<EmployeeDeliveryWorkspace gateway={gateway} />);

    const roundSelect = await screen.findByRole('combobox', { name: 'เลือกงาน' });
    await user.selectOptions(roundSelect, round.id);
    await waitFor(() => expect(loadShopCards).toHaveBeenCalledWith(round.id));
    await user.selectOptions(roundSelect, secondRound.id);
    await waitFor(() => expect(loadShopCards).toHaveBeenCalledWith(secondRound.id));

    await act(async () => resolveSecond([shopB]));
    expect(await screen.findByRole('button', { name: /BB01 ร้านน้ำฝน/ })).toBeTruthy();
    await act(async () => resolveFirst([shopA]));

    expect(screen.queryByRole('button', { name: /AA01 ร้านเจ๊อ้อย/ })).toBeNull();
    expect(screen.getByRole('button', { name: /BB01 ร้านน้ำฝน/ })).toBeTruthy();
  });
});
