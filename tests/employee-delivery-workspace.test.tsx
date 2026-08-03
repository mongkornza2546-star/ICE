import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmployeeDeliveryWorkspace,
  type EmployeeDeliveryGateway,
  type EmployeeDeliveryPayload,
  type EmployeeStockTransferPayload,
} from '../src/EmployeeDeliveryWorkspace';
import type { DeliveryRound, EmployeeStockState, IceTypeOption, ShopCard } from '../src/types/app';
import { readRecovery, writeRecovery } from '../src/lib/recoveryStorage';

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

async function selectProductAndGetKeypad(
  user: ReturnType<typeof userEvent.setup>,
  productName = 'ก้อน',
) {
  await user.click(screen.getByRole('button', { name: new RegExp(productName) }));
  return screen.getByRole('region', { name: 'แป้นใส่จำนวน' });
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

  it('loads the selected historical service date for admin billing', async () => {
    const gateway = createGateway();
    render(<EmployeeDeliveryWorkspace gateway={gateway} serviceDate="2026-07-15" />);

    await screen.findByRole('heading', { name: 'เลือกร้านที่จะไปส่ง' });
    expect(gateway.loadReferenceData).toHaveBeenCalledWith('2026-07-15');
  });

  it('restores an open POS draft after the workspace is mounted again', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    const firstMount = render(
      <EmployeeDeliveryWorkspace
        gateway={gateway}
        requestScope="recovery-courier"
        serviceDate={round.service_date}
      />,
    );

    await openShop(user);
    const keypad = await selectProductAndGetKeypad(user);
    await user.click(within(keypad).getByRole('button', { name: '1' }));
    await waitFor(() => expect(
      readRecovery<{ selectedCardId: string | null }>('recovery-courier', round.service_date, 'pos')?.payload.selectedCardId,
    ).toBe(shopA.round_stop_id));
    firstMount.unmount();

    render(
      <EmployeeDeliveryWorkspace
        gateway={gateway}
        requestScope="recovery-courier"
        serviceDate={round.service_date}
      />,
    );

    await screen.findByRole('heading', { name: new RegExp(shopA.shop_name) });
  });

  it('waits for reference data from the selected service date before restoring its draft', async () => {
    const historicalRound: DeliveryRound = {
      ...round,
      id: 'round-history',
      service_date: '2026-07-15',
    };
    let resolveHistoricalReference!: (value: { rounds: DeliveryRound[]; iceTypes: IceTypeOption[] }) => void;
    const historicalReference = new Promise<{ rounds: DeliveryRound[]; iceTypes: IceTypeOption[] }>((resolve) => {
      resolveHistoricalReference = resolve;
    });
    const gateway = createGateway({
      loadReferenceData: vi.fn((serviceDate: string) => (
        serviceDate === historicalRound.service_date
          ? historicalReference
          : Promise.resolve({ rounds: [round], iceTypes })
      )),
      loadShopCards: vi.fn((roundId: string) => Promise.resolve(roundId === historicalRound.id ? [shopB] : [shopA])),
    });
    writeRecovery('recovery-admin', historicalRound.service_date, 'pos', {
      selectedRoundId: historicalRound.id,
      selectedBuildingId: '',
      selectedZone: '',
      query: '',
      selectedCardId: shopB.round_stop_id,
      selectedIceTypeId: iceTypes[0].id,
      deliveryQuantities: { [iceTypes[0].id]: 2, [iceTypes[1].id]: 0 },
      transferQuantities: { [iceTypes[0].id]: 0, [iceTypes[1].id]: 0 },
      paymentTerm: 'immediate',
      paymentResult: null,
      paymentOpen: false,
      paymentMethod: 'cash',
      paymentAmount: '',
      paymentReference: '',
      approvalId: null,
      approvalReason: '',
      status: 'delivered',
      problemOpen: false,
      note: '',
    });

    const view = render(
      <EmployeeDeliveryWorkspace
        gateway={gateway}
        requestScope="recovery-admin"
        serviceDate={round.service_date}
      />,
    );
    await screen.findByRole('button', { name: new RegExp(shopA.shop_name) });

    view.rerender(
      <EmployeeDeliveryWorkspace
        gateway={gateway}
        requestScope="recovery-admin"
        serviceDate={historicalRound.service_date}
      />,
    );
    await act(async () => {
      resolveHistoricalReference({ rounds: [historicalRound], iceTypes });
    });

    await screen.findByRole('heading', { name: new RegExp(shopB.shop_name) });
  });

  it('clears a completed delivery draft before refreshing server state', async () => {
    const user = userEvent.setup();
    let resolveDelivery!: () => void;
    let resolveCardsRefresh!: (cards: ShopCard[]) => void;
    const cardsRefresh = new Promise<ShopCard[]>((resolve) => {
      resolveCardsRefresh = resolve;
    });
    const loadShopCards = vi.fn()
      .mockResolvedValueOnce([shopA, shopB])
      .mockImplementationOnce(() => cardsRefresh);
    const recordDelivery = vi.fn(() => new Promise<void>((resolve) => {
      resolveDelivery = resolve;
    }));
    const gateway = createGateway({ loadShopCards, recordDelivery });
    const view = render(
      <EmployeeDeliveryWorkspace
        gateway={gateway}
        requestScope="completed-delivery"
        serviceDate={round.service_date}
      />,
    );

    await openShop(user);
    await user.click(within(await selectProductAndGetKeypad(user)).getByRole('button', { name: '1' }));
    await waitFor(() => expect(
      readRecovery('completed-delivery', round.service_date, 'pos'),
    ).not.toBeNull());
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));
    await act(async () => resolveDelivery());
    await waitFor(() => expect(loadShopCards).toHaveBeenCalledTimes(2));

    expect(readRecovery('completed-delivery', round.service_date, 'pos')).toBeNull();
    view.unmount();
    resolveCardsRefresh([shopA, shopB]);
  });

  it('persists a completed stock transfer before clearing its request identity', async () => {
    const user = userEvent.setup();
    let resolveTransfer!: (state: EmployeeStockState) => void;
    const recordEmployeeStockTransfer = vi.fn(() => new Promise<EmployeeStockState>((resolve) => {
      resolveTransfer = resolve;
    }));
    const gateway = createGateway({ recordEmployeeStockTransfer });
    render(
      <EmployeeDeliveryWorkspace
        enableAssignedStockFlow
        gateway={gateway}
        requestScope="completed-transfer"
        serviceDate={round.service_date}
      />,
    );

    await screen.findByText('รถเข็นคัน 1');
    await user.click(screen.getByRole('button', { name: 'เพิ่มก้อนอีกหนึ่ง' }));
    await waitFor(() => expect(
      readRecovery<{ transferQuantities: Record<string, number> }>(
        'completed-transfer',
        round.service_date,
        'withdrawal',
      )?.payload.transferQuantities['ice-block'],
    ).toBe(1));
    const storageEvents: string[] = [];
    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      storageEvents.push(key);
      originalSetItem.call(this, key, value);
    });
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (key) {
      storageEvents.push(key);
      originalRemoveItem.call(this, key);
    });
    await user.click(screen.getByRole('button', { name: 'ยืนยันรับน้ำแข็ง' }));
    await waitFor(() => expect(recordEmployeeStockTransfer).toHaveBeenCalledTimes(1));
    storageEvents.length = 0;
    await act(async () => resolveTransfer(employeeStockState()));

    const recoveryTransition = storageEvents.findIndex((key) => key.startsWith('ice-delivery.recovery.v1:'));
    const pendingRequestClear = storageEvents.indexOf('ice-delivery.pending-requests.v1');
    setItem.mockRestore();
    removeItem.mockRestore();
    expect(recoveryTransition).toBeGreaterThanOrEqual(0);
    expect(pendingRequestClear).toBeGreaterThan(recoveryTransition);
  });

  it('does not expose the retired free-refill workflow from the withdrawal tab', async () => {
    render(
      <EmployeeDeliveryWorkspace
        enableAssignedStockFlow
        gateway={createGateway()}
        serviceDate={round.service_date}
        viewMode="withdrawal"
      />,
    );

    expect(await screen.findByRole('heading', { name: 'เบิกน้ำแข็ง' })).toBeTruthy();
    expect(screen.queryByText(/เติมน้ำแข็ง|เบิกเพิ่มระหว่างวัน/)).toBeNull();
  });

  it('shows shop selection before entering any delivery quantity', async () => {
    render(<EmployeeDeliveryWorkspace gateway={createGateway()} />);

    expect(await screen.findByRole('heading', { name: 'เลือกร้านที่จะไปส่ง' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'น้ำแข็งออกจากรถ' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'แป้นใส่จำนวน' })).toBeNull();
  });

  it('sorts shops by their codes using natural numeric order', async () => {
    const gateway = createGateway({
      loadShopCards: vi.fn().mockResolvedValue([
        card('AA10', 'ร้านสิบ'),
        card('AA2', 'ร้านสอง'),
        card('AA1', 'ร้านหนึ่ง'),
      ]),
    });
    render(<EmployeeDeliveryWorkspace gateway={gateway} />);

    await screen.findByRole('button', { name: /AA1 ร้านหนึ่ง/ });
    const shopCodes = Array.from(document.querySelectorAll<HTMLButtonElement>('.employee-shop-tile'))
      .map((button) => button.textContent?.match(/AA\d+/)?.[0]);

    expect(shopCodes).toEqual(['AA1', 'AA2', 'AA10']);
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
    const keypad = await selectProductAndGetKeypad(user);
    expect(within(keypad).getByText('0', { selector: 'strong' })).toBeTruthy();
    await user.click(within(keypad).getByRole('button', { name: '1' }));
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
    await user.click(within(await selectProductAndGetKeypad(user)).getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));

    await waitFor(() => expect(gateway.recordDelivery).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole('button', { name: 'กำลังบันทึก...' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'กลับไปเลือกร้าน' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => resolveStockRefresh(employeeStockState()));
    await screen.findByText('บันทึกยอดออกจากรถเข็นคัน 1 และร้านปลายทางแล้ว');
    expect(loadEmployeeStockState).toHaveBeenCalledTimes(2);
  });

  it('records quantities for multiple ice types and returns to the filtered shop list', async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    render(<EmployeeDeliveryWorkspace gateway={gateway} />);

    const search = await screen.findByRole('searchbox', { name: 'ค้นหาร้าน' });
    await user.type(search, 'AA01');
    expect(screen.queryByRole('button', { name: /BB01 ร้านน้ำฝน/ })).toBeNull();

    await openShop(user);
    const keypad = await selectProductAndGetKeypad(user);
    await user.click(within(keypad).getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: /เล็ก/ }));
    await user.click(within(keypad).getByRole('button', { name: '3' }));
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

    await screen.findByText('บันทึกยอดออกจากสต๊อกรวมประจำวัน และร้านปลายทางแล้ว');
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

    expect((await screen.findByRole('alert')).textContent).toContain('ใส่จำนวนน้ำแข็งที่หยิบออกจากสต๊อกรวมประจำวันอย่างน้อย 1 รายการ');
    expect(gateway.recordDelivery).not.toHaveBeenCalled();
  });

  it('confirms a shop change when a delivery draft exists', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<EmployeeDeliveryWorkspace gateway={createGateway()} />);

    await openShop(user, shopA);
    await user.click(within(await selectProductAndGetKeypad(user)).getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: /BB01 ร้านน้ำฝน/ }));

    expect(confirm).toHaveBeenCalledWith('เปลี่ยนร้านแล้ว รายการในตะกร้าจะถูกล้าง ต้องการเปลี่ยนร้านหรือไม่?');
    expect(screen.getByRole('heading', { name: shopA.shop_name })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /BB01 ร้านน้ำฝน/ }));
    expect(await screen.findByRole('heading', { name: shopB.shop_name })).toBeTruthy();
    expect(screen.getByText('เลือกชนิดน้ำแข็งเพื่อกรอกจำนวน')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'แป้นใส่จำนวน' })).toBeNull();
  });

  it('blocks delivery entry when no active ice type is configured', async () => {
    const gateway = createGateway({
      loadReferenceData: vi.fn().mockResolvedValue({ rounds: [round], iceTypes: [] }),
    });
    render(<EmployeeDeliveryWorkspace gateway={gateway} />);

    expect(await screen.findByRole('heading', { name: 'ยังไม่มีชนิดน้ำแข็งที่ใช้งาน' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /AA01 ร้านเจ๊อ้อย/ })).toBeNull();
  });

  it('explains how to recover when there is no open delivery round', async () => {
    const gateway = createGateway({
      loadReferenceData: vi.fn().mockResolvedValue({ rounds: [], iceTypes }),
    });
    render(<EmployeeDeliveryWorkspace gateway={gateway} />);

    expect(await screen.findByRole('heading', { name: 'ยังไม่มีรอบส่งที่เปิดอยู่' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'โหลดรอบอีกครั้ง' })).toBeTruthy();
    expect(screen.queryByRole('searchbox', { name: 'ค้นหาร้าน' })).toBeNull();
  });

  it('places cart review in the delivery-problem action position', async () => {
    const user = userEvent.setup();
    render(<EmployeeDeliveryWorkspace gateway={createGateway()} />);

    await openShop(user);
    expect(screen.queryByRole('button', { name: 'แจ้งเหตุส่งไม่ได้' })).toBeNull();
    expect((screen.getByRole('button', { name: 'ตรวจรายการ (0)' }) as HTMLButtonElement).disabled).toBe(true);

    const keypad = await selectProductAndGetKeypad(user);
    await user.click(within(keypad).getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: 'ตรวจรายการ (1)' }));

    expect(screen.getByRole('button', { name: /3 ตรวจ/ }).getAttribute('aria-current')).toBe('step');
    expect(within(screen.getByRole('region', { name: 'สรุปตะกร้า' })).getAllByText(/2 ถุง/)).toHaveLength(2);
  });

  it('reuses the idempotency key and timestamp when the same failed payload is retried', async () => {
    const user = userEvent.setup();
    const recordDelivery = vi.fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(undefined);
    const gateway = createGateway({ recordDelivery });
    render(<EmployeeDeliveryWorkspace gateway={gateway} />);

    await openShop(user);
    await user.click(within(await selectProductAndGetKeypad(user)).getByRole('button', { name: '2' }));
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

    await openShop(user);
    await user.click(within(await selectProductAndGetKeypad(user)).getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันส่งร้านนี้' }));
    expect((await screen.findByRole('alert')).textContent).toContain('เชื่อมต่อไม่สำเร็จ');
    const first = recordDelivery.mock.calls[0][0] as EmployeeDeliveryPayload;

    firstView.unmount();
    render(<EmployeeDeliveryWorkspace gateway={gateway} />);
    await openShop(user);
    await user.click(within(await selectProductAndGetKeypad(user)).getByRole('button', { name: '2' }));
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

    await openShop(user);
    await user.click(within(await selectProductAndGetKeypad(user)).getByRole('button', { name: '2' }));
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
    await screen.findByText('บันทึกยอดออกจากสต๊อกรวมประจำวัน และร้านปลายทางแล้ว');
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

    await openShop(user);
    await user.click(within(await selectProductAndGetKeypad(user)).getByRole('button', { name: '2' }));
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
