import { useMemo, useState } from 'react';
import {
  EmployeeDeliveryWorkspace,
  type EmployeeDeliveryGateway,
  type EmployeeDeliveryPayload,
  type EmployeeStockTransferPayload,
} from './EmployeeDeliveryWorkspace';
import { EmployeeLayout } from './EmployeeLayout';
import { AdminLayout } from './AdminLayout';
import { ManagerStockControl } from './ManagerStockControl';
import type { DeliveryRound, EmployeeStockState, IceTypeOption, ShopCard, ShopCardHistoryEntry, StockControlSummary } from './types/app';

const demoRounds: DeliveryRound[] = [
  {
    id: 'demo-round-morning',
    service_date: '2026-07-18',
    name: 'รอบเช้า',
    status: 'open',
    opened_at: '2026-07-18T01:00:00.000Z',
  },
  {
    id: 'demo-round-afternoon',
    service_date: '2026-07-18',
    name: 'รอบบ่าย',
    status: 'open',
    opened_at: '2026-07-18T06:00:00.000Z',
  },
];

const demoIceTypes: IceTypeOption[] = [
  { id: 'ice-block', code: 'BLOCK', name: 'น้ำแข็งก้อน', unit: 'ถุง' },
  { id: 'ice-small', code: 'SMALL', name: 'น้ำแข็งเล็ก', unit: 'ถุง' },
  { id: 'ice-tube', code: 'TUBE', name: 'น้ำแข็งหลอด', unit: 'ถุง' },
];

function createCard(
  roundId: string,
  code: string,
  name: string,
  buildingId: string,
  buildingName: string,
  zone: string,
  sequenceNo: number,
  overrides: Partial<ShopCard> = {},
): ShopCard {
  return {
    round_stop_id: `${roundId}-${code}`,
    shop_id: `shop-${code}`,
    shop_code: code,
    shop_name: name,
    building_id: buildingId,
    building_name: buildingName,
    floor_or_zone: zone,
    sequence_no: sequenceNo,
    image_path: null,
    image_url: null,
    payment_status: 'unknown',
    stop_status: 'pending',
    stop_note: null,
    today_history: [],
    today_totals: {},
    ...overrides,
  };
}

const demoCardsByRound: Record<string, ShopCard[]> = {
  'demo-round-morning': [
    createCard('demo-round-morning', 'AA01', 'กาแฟลุงนิด', 'building-a', 'ตึก A', 'โซน 1', 1),
    createCard(
      'demo-round-morning',
      'AA02',
      'ข้าวแกงป้านา',
      'building-a',
      'ตึก A',
      'โซน 1',
      2,
      {
        stop_status: 'delivered',
        today_totals: { 'ice-block': 2 },
        today_history: [
          {
            event_id: 'history-aa02-1',
            recorded_at: '2026-07-18T02:10:00.000Z',
            round_name: 'รอบเช้า',
            recorded_by: 'เดโม่ พนักงานส่ง',
            stop_status: 'delivered',
            note: null,
            items: { 'ice-block': 2 },
          },
        ],
      },
    ),
    createCard(
      'demo-round-morning',
      'BB01',
      'ร้านผลไม้คุณเมย์',
      'building-b',
      'ตึก B',
      'โดม 2',
      3,
      {
        stop_status: 'closed_shop',
        stop_note: 'ปิดช่วงเช้า',
        today_history: [
          {
            event_id: 'history-bb01-1',
            recorded_at: '2026-07-18T02:35:00.000Z',
            round_name: 'รอบเช้า',
            recorded_by: 'เดโม่ พนักงานส่ง',
            stop_status: 'closed_shop',
            note: 'ปิดช่วงเช้า',
            items: {},
          },
        ],
      },
    ),
    createCard('demo-round-morning', 'CC01', 'ร้านข้าวมันไก่', 'building-c', 'ตึก C', 'ชั้น 1', 4),
  ],
  'demo-round-afternoon': [
    createCard('demo-round-afternoon', 'AA03', 'น้ำสมุนไพรยายนา', 'building-a', 'ตึก A', 'โซน 2', 1),
    createCard('demo-round-afternoon', 'BB02', 'ลูกชิ้นปิ้งหน้า Tops', 'building-b', 'ตึก B', 'ศูนย์อาหาร', 2),
    createCard(
      'demo-round-afternoon',
      'CC02',
      'ก๋วยเตี๋ยวเรือป้าหอม',
      'building-c',
      'ตึก C',
      'ชั้น 2',
      3,
      {
        today_totals: { 'ice-small': 1 },
        today_history: [
          {
            event_id: 'history-cc02-1',
            recorded_at: '2026-07-18T07:15:00.000Z',
            round_name: 'รอบบ่าย',
            recorded_by: 'เดโม่ พนักงานส่ง',
            stop_status: 'delivered',
            note: null,
            items: { 'ice-small': 1 },
          },
        ],
        stop_status: 'delivered',
      },
    ),
  ],
};

const demoOpeningStockState: EmployeeStockState = {
  round_id: demoRounds[0].id,
  service_date: demoRounds[0].service_date,
  truck_location: {
    id: 'truck-main',
    code: 'TRUCK-MAIN',
    name: 'รถบรรทุกหลัก',
    balances: demoIceTypes.map((iceType) => ({
      ice_type_id: iceType.id,
      ice_type_name: iceType.name,
      unit: iceType.unit,
      quantity: 40,
    })),
  },
  holding_location: {
    id: 'holding-demo',
    code: 'TEAM-DEMO',
    name: 'รถเข็นเดโม่',
    balances: demoIceTypes.map((iceType) => ({
      ice_type_id: iceType.id,
      ice_type_name: iceType.name,
      unit: iceType.unit,
      quantity: 4,
    })),
  },
};

const managerStockDemoRound: DeliveryRound = {
  id: 'demo-manager-round',
  service_date: '2026-07-20',
  name: 'รอบงานวันนี้',
  status: 'open',
  opened_at: '2026-07-20T01:00:00.000Z',
};

const managerStockDemoSummary: StockControlSummary = {
  service_date: managerStockDemoRound.service_date,
  locations: [
    {
      id: 'truck-main',
      code: 'TRUCK-MAIN',
      name: 'รถบรรทุกหลัก',
      kind: 'truck',
      holds_inventory: true,
      requires_daily_count: true,
      is_courier_source: true,
      balances: [
        { ice_type_id: 'tube', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 47.5 },
        { ice_type_id: 'crushed', ice_type_name: 'โม่', unit: 'ถุง', quantity: 9 },
        { ice_type_id: 'half', ice_type_name: 'หลอดเล็กโม่', unit: 'ถุง', quantity: 22 },
        { ice_type_id: 'cube', ice_type_name: 'น้ำแข็งก้อน', unit: 'แถว', quantity: 1 },
        { ice_type_id: 'melt', ice_type_name: 'เปลือย (หลอดใหญ่)', unit: 'ถุง', quantity: 3 },
      ],
    },
    {
      id: 'holder-somchai', code: 'พื้นที่ A · Skywalk', name: 'รถเข็นสมชาย', kind: 'team',
      holds_inventory: true, requires_daily_count: true, is_courier_source: false,
      balances: [{ ice_type_id: 'tube', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 12 }],
    },
    {
      id: 'holder-vichai', code: 'พื้นที่ B', name: 'รถเข็นวิชัย', kind: 'team',
      holds_inventory: true, requires_daily_count: true, is_courier_source: false,
      balances: [{ ice_type_id: 'tube', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 8 }],
    },
    {
      id: 'holder-nid', code: 'พื้นที่ C', name: 'รถเข็นนิด', kind: 'team',
      holds_inventory: true, requires_daily_count: true, is_courier_source: false,
      balances: [{ ice_type_id: 'tube', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 0 }],
    },
  ],
  recent_movements: [],
};

function cloneCards(cards: ShopCard[]) {
  return cards.map((card) => ({
    ...card,
    today_history: card.today_history.map((entry) => ({
      ...entry,
      items: { ...entry.items },
    })),
    today_totals: { ...card.today_totals },
  }));
}

function cloneStockState(state: EmployeeStockState, roundId = state.round_id): EmployeeStockState {
  return {
    ...state,
    round_id: roundId,
    truck_location: { ...state.truck_location, balances: state.truck_location.balances.map((item) => ({ ...item })) },
    holding_location: { ...state.holding_location, balances: state.holding_location.balances.map((item) => ({ ...item })) },
  };
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function buildDemoGateway(): EmployeeDeliveryGateway & { reset(): void } {
  let cardsByRound = Object.fromEntries(
    Object.entries(demoCardsByRound).map(([roundId, cards]) => [roundId, cloneCards(cards)]),
  ) as Record<string, ShopCard[]>;
  let stockState = cloneStockState(demoOpeningStockState);
  let transferKeys = new Set<string>();

  const upsertHistory = (
    roundName: string,
    payload: EmployeeDeliveryPayload,
  ): ShopCardHistoryEntry => ({
    event_id: crypto.randomUUID(),
    recorded_at: payload.clientRecordedAt,
    round_name: roundName,
    recorded_by: 'เดโม่ พนักงานส่ง',
    stop_status: payload.status,
    note: payload.note,
    items: Object.fromEntries(payload.items.map((item) => [item.ice_type_id, item.quantity])),
  });

  return {
    async loadReferenceData() {
      await delay(120);
      return {
        rounds: demoRounds.map((round) => ({ ...round })),
        iceTypes: demoIceTypes.map((iceType) => ({ ...iceType })),
      };
    },
    async loadShopCards(roundId) {
      await delay(160);
      return cloneCards(cardsByRound[roundId] ?? []);
    },
    async loadEmployeeStockState(roundId) {
      await delay(120);
      return cloneStockState(stockState, roundId);
    },
    async recordEmployeeStockTransfer(payload: EmployeeStockTransferPayload) {
      await delay(180);
      if (!transferKeys.has(payload.idempotencyKey)) {
        transferKeys.add(payload.idempotencyKey);
        for (const item of payload.items) {
          const truck = stockState.truck_location.balances.find((balance) => balance.ice_type_id === item.ice_type_id);
          const holding = stockState.holding_location.balances.find((balance) => balance.ice_type_id === item.ice_type_id);
          if (truck) truck.quantity -= item.quantity;
          if (holding) holding.quantity += item.quantity;
        }
      }
      return cloneStockState(stockState, payload.roundId);
    },
    async recordDelivery(payload) {
      await delay(240);
      const round = demoRounds.find((entry) =>
        (cardsByRound[entry.id] ?? []).some((card) => card.round_stop_id === payload.roundStopId),
      );
      const roundName = round?.name ?? 'รอบเดโม่';

      if (payload.status === 'delivered') {
        for (const item of payload.items) {
          const holding = stockState.holding_location.balances.find((balance) => balance.ice_type_id === item.ice_type_id);
          if (holding) holding.quantity -= item.quantity;
        }
      }

      cardsByRound = Object.fromEntries(
        Object.entries(cardsByRound).map(([roundId, cards]) => [
          roundId,
          cards.map((card) => {
            if (card.round_stop_id !== payload.roundStopId) return card;

            const nextTotals = { ...card.today_totals };
            for (const item of payload.items) {
              nextTotals[item.ice_type_id] = (nextTotals[item.ice_type_id] ?? 0) + item.quantity;
            }

            return {
              ...card,
              stop_status: payload.status,
              stop_note: payload.note,
              today_totals: nextTotals,
              today_history: [upsertHistory(roundName, payload), ...card.today_history],
            };
          }),
        ]),
      ) as Record<string, ShopCard[]>;
    },
    reset() {
      cardsByRound = Object.fromEntries(
        Object.entries(demoCardsByRound).map(([roundId, cards]) => [roundId, cloneCards(cards)]),
      ) as Record<string, ShopCard[]>;
      stockState = cloneStockState(demoOpeningStockState);
      transferKeys = new Set<string>();
    },
  };
}

export function LocalDemoApp() {
  const [gatewayVersion, setGatewayVersion] = useState(0);
  const [draftState, setDraftState] = useState({ dirty: false, submitting: false });
  const gateway = useMemo(() => buildDemoGateway(), [gatewayVersion]);

  if (new URLSearchParams(window.location.search).get('screen') === 'stock-layout') {
    return (
      <AdminLayout
        activeView="stock_operations"
        allowedViews={['stock_operations']}
        onNavigate={() => undefined}
        profileLabel="หัวหน้างาน · Demo"
      >
        <ManagerStockControl
          demoSummary={managerStockDemoSummary}
          round={managerStockDemoRound}
          serviceDate={managerStockDemoRound.service_date}
        />
      </AdminLayout>
    );
  }

  return (
    <EmployeeLayout profileLabel="Local Demo">
      <div className="stack">
        <section className="panel">
          <p className="eyebrow">Local Demo Mode</p>
          <h1>ลองงานพนักงานตั้งแต่รับน้ำแข็งถึงส่งร้าน</h1>
          <p className="muted">
            โหมดนี้ใช้ข้อมูลจำลองในเบราว์เซอร์ ไม่แตะ Supabase จริง: รับน้ำแข็งจากรถเข้ารถเข็น
            เลือกร้าน แล้วใส่จำนวนที่ส่งแต่ละชนิด
          </p>
          <div className="toolbar">
            <button
              className="ghost-button"
              disabled={draftState.submitting}
              onClick={() => {
                gateway.reset();
                setGatewayVersion((current) => current + 1);
              }}
              type="button"
            >
              รีเซ็ตข้อมูลเดโม่
            </button>
          </div>
        </section>
        <EmployeeDeliveryWorkspace
          enableAssignedStockFlow
          gateway={gateway}
          onDraftStateChange={setDraftState}
          requestScope={`local-demo-${gatewayVersion}`}
        />
      </div>
    </EmployeeLayout>
  );
}
