import { useMemo, useState } from 'react';
import { Coins, Package, Storefront } from '@phosphor-icons/react';
import {
  EmployeeDeliveryWorkspace,
  type EmployeeDeliveryGateway,
  type EmployeeDeliveryPayload,
  type EmployeePaymentPayload,
  type EmployeeStockTransferPayload,
} from './EmployeeDeliveryWorkspace';
import { EmployeeLayout } from './EmployeeLayout';
import { AdminLayout } from './AdminLayout';
import { AdminReferenceSettings } from './AdminReferenceSettings';
import { ManagerStockControl } from './ManagerStockControl';
import { ManagerDashboard } from './ManagerDashboard';
import { ShopSettings } from './ShopSettings';
import { FinancialOperations } from './FinancialOperations';
import type { DailyWorkDashboard, DeliveryRound, EmployeeStockState, IceTypeOption, ShopCard, ShopCardHistoryEntry, StockControlSummary } from './types/app';
import type { IceTypeSetting } from './features/admin-reference-settings/types';
import type { Approval, Collector, DueDateRequest, PaymentHistoryItem, QueueShop, Receivable } from './features/financial-operations/types';

const collectionServiceDate = '2026-07-31';
const collectionPaymentProfile = {
  allowed_payment_methods: ['cash', 'bank_transfer', 'qr'] as const,
  default_payment_method: 'cash' as const,
  cash_reference_required: false,
  cash_evidence_required: false,
  bank_transfer_reference_required: false,
  bank_transfer_evidence_required: true,
  qr_reference_required: false,
  qr_evidence_required: true,
};
const collectionShops = [
  ['AA4', 'ร้านครัวคุณเงินลุงทอง', 15250, '2026-07-29', 5],
  ['BB2', 'ร้านกาแฟ ลานเล่า', 9850, '2026-07-29', 5],
  ['CC1', 'ร้านอาหารเจริญรส', 7400, '2026-07-30', 1],
  ['AA2', 'ร้านเจ๊อ้อย (ก้อน)', 5800, '2026-07-31', 0],
  ['BB5', 'ร้านก๋วยเตี๋ยวเรือ', 4280, '2026-07-31', 0],
  ['CC3', 'ร้านผลไม้สด', 2800, '2026-07-30', 1],
  ['AA11', 'ร้านน้ำฟ้า', 280, '2026-07-30', 1],
] as const;
const collectionQueue: QueueShop[] = collectionShops.map(([code, name, amount, date, index]) => ({
  shop_id: `collection-${code}`,
  shop_code: code,
  shop_name: name,
  image_path: null,
  image_url: null,
  outstanding_amount: amount,
  charge_count: index > 1 ? 1 : index + 1,
  has_new_charges: date === collectionServiceDate,
  payment_profile: { ...collectionPaymentProfile, allowed_payment_methods: [...collectionPaymentProfile.allowed_payment_methods] },
  charges: Array.from({ length: index > 1 ? 1 : index + 1 }, (_, chargeIndex) => ({
    charge_id: `${code}-${chargeIndex}`,
    charge_number: `INV-2607${date.slice(-2)}-0000${index + chargeIndex + 1}`,
    service_date: date,
    payment_term: 'end_of_day' as const,
    due_date: date,
    original_amount: amount / (index > 1 ? 1 : index + 1),
    outstanding_amount: amount / (index > 1 ? 1 : index + 1),
    items: [{ ice_type_id: 'ice-small', name: 'น้ำแข็งหลอดเล็ก', unit: 'ถุง', quantity: 5, line_total: amount }],
  })),
}));
const collectionPayments: PaymentHistoryItem[] = [
  { id: 'pay-1', receipt_number: 'RC-260731-001', received_amount: 8500, allocated_amount: 8500, change_amount: 0, payment_method: 'cash', status: 'active', recorded_at: '2026-07-31T09:40:00.000Z', void_reason: null, shops: { code: 'DD1', name: 'ร้านอาหารบ้านสวน' } },
  { id: 'pay-2', receipt_number: 'RC-260731-002', received_amount: 3850, allocated_amount: 3850, change_amount: 0, payment_method: 'bank_transfer', status: 'active', recorded_at: '2026-07-31T10:10:00.000Z', void_reason: null, shops: { code: 'EE2', name: 'ร้านเครื่องดื่มเย็นใจ' } },
];

const collectionCollectors: Collector[] = [
  { id: 'collector-so', code: 'AUTH-F5466E', display_name: 'โซ', nickname: 'So', avatar_path: null },
  { id: 'collector-pid', code: 'AUTH-797F76', display_name: 'ผึด', nickname: 'Iamkeo', avatar_path: null },
  { id: 'collector-nueng', code: 'AUTH-92D09C', display_name: 'หนึ่ง', nickname: null, avatar_path: null },
];

const creditReceivables: Receivable[] = [
  {
    shop_id: 'credit-bb72', shop_code: 'BB72', shop_name: 'ร้านยอดชา', building_name: 'อาคาร B', zone_name: 'โซน 7', responsible_name: 'Iamkeo', credit_due_rule: 'weekly', credit_days: null, credit_collection_weekday: 5,
    credit_limit: null, available_credit_amount: null, outstanding_amount: 300, overdue_amount: 0, oldest_due_date: '2026-08-08', charges: [
      { charge_id: 'credit-bb72-1', charge_number: 'C260803-000001', service_date: '2026-08-01', due_date: '2026-08-08', original_amount: 300, allocated_amount: 0, outstanding_amount: 300, days_overdue: 0, payment_status: 'unpaid', due_status: 'not_due', assigned_collection_run_id: null, delivery_event_id: 'demo-event-bb72-1', round_status: 'open', stop_status: 'delivered', note: null, recorded_at: '2026-08-01T03:15:00.000Z', recorded_by: 'Iamkeo', items: [{ ice_type_id: 'ice-small', name: 'น้ำแข็งหลอดเล็ก', unit: 'ถุง', quantity: 5 }] },
    ], payments: [],
  },
  {
    shop_id: 'credit-aa4', shop_code: 'AA4', shop_name: 'ร้านครัวคุณเงินลุงทอง', building_name: 'อาคาร A', zone_name: 'โซน 4', responsible_name: 'โซ', credit_due_rule: 'end_of_month', credit_days: null, credit_collection_weekday: null, credit_limit: 20_000, available_credit_amount: 4_750,
    outstanding_amount: 15_250, overdue_amount: 8_500, oldest_due_date: '2026-07-24', charges: [
      { charge_id: 'credit-aa4-1', charge_number: 'C260724-000021', service_date: '2026-07-20', due_date: '2026-07-24', original_amount: 8_500, allocated_amount: 0, outstanding_amount: 8_500, days_overdue: 7, payment_status: 'unpaid', due_status: 'overdue', assigned_collection_run_id: null },
      { charge_id: 'credit-aa4-2', charge_number: 'C260730-000024', service_date: '2026-07-26', due_date: '2026-08-05', original_amount: 6_750, allocated_amount: 0, outstanding_amount: 6_750, days_overdue: 0, payment_status: 'unpaid', due_status: 'not_due', assigned_collection_run_id: null },
    ],
  },
  {
    shop_id: 'credit-bb2', shop_code: 'BB2', shop_name: 'ร้านกาแฟ ลานเล่า', building_name: 'อาคาร B', zone_name: 'โซน 2', responsible_name: 'Iamkeo', credit_due_rule: 'net_days', credit_days: 7, credit_collection_weekday: null, credit_limit: 15_000, available_credit_amount: 7_650,
    outstanding_amount: 7_350, overdue_amount: 2_350, oldest_due_date: '2026-07-29', charges: [
      { charge_id: 'credit-bb2-1', charge_number: 'C260729-000022', service_date: '2026-07-22', due_date: '2026-07-29', original_amount: 3_500, allocated_amount: 1_150, outstanding_amount: 2_350, days_overdue: 2, payment_status: 'partial', due_status: 'overdue', assigned_collection_run_id: null },
      { charge_id: 'credit-bb2-2', charge_number: 'C260731-000025', service_date: '2026-07-28', due_date: '2026-08-07', original_amount: 5_000, allocated_amount: 0, outstanding_amount: 5_000, days_overdue: 0, payment_status: 'unpaid', due_status: 'not_due', assigned_collection_run_id: null },
    ], payments: [{ id: 'credit-payment-bb2', receipt_number: 'RC260730-000014', received_amount: 1_150, allocated_amount: 1_150, payment_method: 'cash', status: 'active', recorded_at: '2026-07-30T03:15:00.000Z', recorded_by: 'Iamkeo', allocations: [{ charge_id: 'credit-bb2-1', charge_number: 'C260729-000022', amount: 1_150 }] }], last_payment_at: '2026-07-30T03:15:00.000Z',
  },
  {
    shop_id: 'credit-cc1', shop_code: 'CC1', shop_name: 'ร้านอาหารเจริญรส', building_name: 'อาคาร C', zone_name: 'โซน 1', responsible_name: 'หนึ่ง', credit_due_rule: 'net_days', credit_days: 10, credit_collection_weekday: null, credit_limit: null, available_credit_amount: null,
    outstanding_amount: 4_200, overdue_amount: 0, oldest_due_date: '2026-08-08', charges: [
      { charge_id: 'credit-cc1-1', charge_number: 'C260731-000026', service_date: '2026-07-29', due_date: '2026-08-08', original_amount: 4_200, allocated_amount: 0, outstanding_amount: 4_200, days_overdue: 0, payment_status: 'unpaid', due_status: 'not_due', assigned_collection_run_id: null },
    ],
  },
];

const creditApprovals: Approval[] = [
  { id: 'approval-aa4', kind: 'credit_limit', requested_amount: 3_500, reason: 'ยอดสั่งซื้อเพิ่มในช่วงจัดงาน', status: 'pending', requested_at: '2026-07-31T03:00:00.000Z', shops: { code: 'AA4', name: 'ร้านครัวคุณเงินลุงทอง' }, users: { display_name: 'สมชาย ใจดี' } },
];

const creditDueDateRequests: DueDateRequest[] = [
  { id: 'due-bb2', charge_id: 'credit-bb2-1', charge_number: 'C260729-000022', shop_code: 'BB2', shop_name: 'ร้านกาแฟ ลานเล่า', original_due_date: '2026-07-29', requested_due_date: '2026-08-05', reason: 'ร้านขอรวบยอดชำระต้นสัปดาห์', status: 'pending', requested_at: '2026-07-31T04:00:00.000Z', requested_by: 'วิชัย มั่นคง' },
];

const demoRounds: DeliveryRound[] = [
  {
    id: 'demo-round-morning',
    service_date: '2026-08-07',
    name: 'งานประจำวัน',
    status: 'open',
    opened_at: '2026-08-07T01:00:00.000Z',
  },
  {
    id: 'demo-round-afternoon',
    service_date: '2026-08-07',
    name: 'รอบบ่าย',
    status: 'closed',
    opened_at: '2026-08-07T06:00:00.000Z',
    closed_at: '2026-08-07T10:00:00.000Z',
  },
];

const demoIceTypes: IceTypeOption[] = [
  { id: 'ice-block', code: 'BLOCK', name: 'หลอดเล็ก', unit: 'ถุง' },
  { id: 'ice-small', code: 'SMALL', name: 'หลอดเล็กโม่', unit: 'ถุง' },
  { id: 'ice-tube', code: 'TUBE', name: 'เปลือย (หลอดใหญ่)', unit: 'ถุง' },
];

const referencePreviewIceTypes: IceTypeSetting[] = [
  { id: 'preview-01', code: '01', name: 'หลอดเล็ก', unit: 'ถุง', image_path: null, is_active: true },
  { id: 'preview-02', code: '02', name: 'โม่', unit: 'ถุง', image_path: null, is_active: true },
  { id: 'preview-03', code: '03', name: 'หลอดเล็กโม่', unit: 'ถุง', image_path: null, is_active: true },
  { id: 'preview-04', code: '04', name: 'เปลือย (หลอด)', unit: 'ถุง', image_path: null, is_active: true },
  { id: 'preview-05', code: '05', name: 'น้ำแข็งก้อน', unit: 'แถว', image_path: null, is_active: true },
  { id: 'preview-06', code: '06', name: 'หลอดเล็กถุงใส', unit: 'ถุง', image_path: null, is_active: true },
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
      quantity: iceType.id === 'ice-block' ? 100 : iceType.id === 'ice-small' ? 50 : 0,
    })),
  },
  holding_location: {
    id: 'holding-demo',
    code: 'TEAM-DEMO',
    name: 'test01@gmail.com · จุดรับสต๊อก',
    balances: demoIceTypes.map((iceType) => ({
      ice_type_id: iceType.id,
      ice_type_name: iceType.name,
      unit: iceType.unit,
      quantity: 0,
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

const managerDashboardDemo: DailyWorkDashboard = {
  session: { id: 'demo-session', service_date: managerStockDemoRound.service_date, status: 'in_progress', opened_at: '2026-07-20T01:00:00.000Z', opened_by_name: 'หัวหน้างานเดโม่' },
  members: [
    { id: 'employee-01', display_name: 'สมชาย ใจดี', role: 'courier', role_label: 'พนักงานส่ง', last_activity: { type: 'delivery', timestamp: '2026-07-20T04:20:00.000Z', description: 'กำลังส่งน้ำแข็ง' } },
    { id: 'employee-02', display_name: 'วิชัย มั่นคง', role: 'courier', role_label: 'พนักงานส่ง', last_activity: { type: 'stock_movement', timestamp: '2026-07-20T04:05:00.000Z', description: 'รับสต๊อกเข้ารถเข็น' } },
    { id: 'employee-03', display_name: 'ประเสริฐ ดีมาก', role: 'courier', role_label: 'พนักงานส่ง', last_activity: null },
  ],
  deliverySummary: { activeDeliveryCount: 48, actualShopCount: 31, problemCount: 2 },
  salesSummary: { netSalesValue: 3860, iceTypeSales: [{ ice_type_id: 'tube', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 118 }] },
  recentDeliveries: [],
  problems: [{ stop_id: 'demo-problem', shop_code: 'A01', shop_name: 'Skywalk, ฝั่งสระลม', problem_note: 'ลูกค้ายังไม่พร้อมรับสินค้า', updated_at: '2026-07-20T04:10:00.000Z', updated_by_name: 'สมชาย ใจดี' }],
  readiness: [
    { location_id: 'truck-main', location_name: 'รถบรรทุกหลัก', status: 'current', snapshot: null },
    { location_id: 'holder-somchai', location_name: 'รถเข็นสมชาย', status: 'current', snapshot: null },
    { location_id: 'holder-vichai', location_name: 'รถเข็นวิชัย', status: 'uncounted', snapshot: null },
    { location_id: 'holder-nid', location_name: 'รถเข็นนิด', status: 'uncounted', snapshot: null },
  ],
  cancellationState: { can_cancel: true, blocker_reason: null },
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
    async loadDeliveryPosContext(roundStopId) {
      await delay(100);
      const round = demoRounds.find((entry) => (cardsByRound[entry.id] ?? [])
        .some((card) => card.round_stop_id === roundStopId));
      const shop = (cardsByRound[round?.id ?? ''] ?? []).find((card) => card.round_stop_id === roundStopId);
      if (!round || !shop) throw new Error('ไม่พบร้านในรอบเดโม่');
      return {
        round_id: round.id,
        round_stop_id: roundStopId,
        service_date: round.service_date,
        shop: {
          id: shop.shop_id,
          code: shop.shop_code,
          name: shop.shop_name,
          building_name: shop.building_name,
          floor_or_zone: shop.floor_or_zone,
          image_path: null,
        },
        stock_source: {
          id: stockState.holding_location.id,
          code: stockState.holding_location.code,
          name: stockState.holding_location.name,
          kind: 'team',
        },
        items: demoIceTypes.map((iceType, index) => ({
          ice_type_id: iceType.id,
          code: iceType.code,
          name: iceType.name,
          unit: iceType.unit,
          image_path: null,
          stock_quantity: stockState.holding_location.balances
            .find((balance) => balance.ice_type_id === iceType.id)?.quantity ?? 0,
          unit_price: [30, 25, 35][index] ?? 30,
          price_source: 'standard' as const,
          price_source_id: `demo-price-${iceType.id}`,
        })),
        payment_profile: {
          allowed_payment_terms: ['immediate', 'end_of_day', 'credit'] as const,
          default_payment_term: 'immediate' as const,
          allowed_payment_methods: ['cash', 'bank_transfer', 'qr'] as const,
          default_payment_method: 'cash' as const,
          cash_reference_required: false,
          cash_evidence_required: false,
          bank_transfer_reference_required: false,
          bank_transfer_evidence_required: true,
          qr_reference_required: true,
          qr_evidence_required: false,
          allow_outstanding: true,
          credit_due_rule: 'net_days' as const,
          credit_days: 7,
          credit_collection_weekday: null,
          credit_limit: 1000,
          credit_exposure: 0,
          credit_remaining: 1000,
        },
      };
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
      if (payload.status !== 'delivered') return undefined;
      const totalAmount = payload.items.reduce((total, item) => {
        const index = demoIceTypes.findIndex((iceType) => iceType.id === item.ice_type_id);
        return total + item.quantity * ([30, 25, 35][index] ?? 30);
      }, 0);
      return {
        delivery_event_id: `demo-delivery-${payload.idempotencyKey}`,
        round_stop_id: payload.roundStopId,
        charge_id: `demo-charge-${payload.idempotencyKey}`,
        service_date: round?.service_date ?? null,
        total_amount: totalAmount,
        payment_term: payload.paymentTerm ?? 'immediate',
        payment_status: 'unpaid' as const,
        due_date: payload.paymentTerm === 'credit' ? '2026-07-25' : null,
        approval_id: payload.approvalId ?? null,
        items: payload.items.map((item) => {
          const index = demoIceTypes.findIndex((iceType) => iceType.id === item.ice_type_id);
          const unitPrice = [30, 25, 35][index] ?? 30;
          return {
            ice_type_id: item.ice_type_id,
            quantity: item.quantity,
            unit_price: unitPrice,
            line_total: item.quantity * unitPrice,
            price_source: 'standard' as const,
            price_source_id: `demo-price-${item.ice_type_id}`,
          };
        }),
      };
    },
    async recordPayment(payload: EmployeePaymentPayload) {
      await delay(160);
      return {
        payment_id: `demo-payment-${payload.idempotencyKey}`,
        shop_id: payload.shopId,
        payment_method: payload.paymentMethod,
        received_amount: payload.receivedAmount,
        allocated_amount: payload.allocatedAmount,
        change_amount: payload.paymentMethod === 'cash'
          ? Math.max(payload.receivedAmount - payload.allocatedAmount, 0)
          : 0,
        status: 'active' as const,
      };
    },
    async recordImmediateSale(payload) {
      const delivery = await this.recordDelivery({
        roundStopId: payload.roundStopId,
        items: payload.items,
        status: 'delivered',
        note: payload.note,
        clientRecordedAt: payload.clientRecordedAt,
        idempotencyKey: payload.idempotencyKey,
        paymentTerm: 'immediate',
        approvalId: null,
      });
      if (!delivery) throw new Error('เดโม่ไม่สามารถสร้างรายการขายสดได้');
      const card = Object.values(cardsByRound).flat()
        .find((candidate) => candidate.round_stop_id === payload.roundStopId);
      const receiptNumber = 'REC2607-00001';
      const receivedAt = new Date().toISOString();
      return {
        delivery: { ...delivery, charge_number: null, payment_status: 'paid' as const },
        payment: {
          payment_id: `demo-payment-${payload.idempotencyKey}`,
          receipt_number: receiptNumber,
          shop_id: card?.shop_id ?? '',
          payment_method: payload.paymentMethod,
          received_amount: payload.receivedAmount,
          allocated_amount: delivery.total_amount ?? 0,
          change_amount: payload.paymentMethod === 'cash'
            ? Math.max(payload.receivedAmount - (delivery.total_amount ?? 0), 0)
            : 0,
          status: 'active' as const,
          recorded_at: receivedAt,
        },
        receipt_number: receiptNumber,
        print_document: {
          document_type: 'REC' as const,
          document_number: receiptNumber,
          document_title: 'ใบส่งของ / ใบเสร็จรับเงิน',
          status: 'active' as const,
          recorded_at: receivedAt,
          service_date: delivery.service_date,
          shop_code: card?.shop_code ?? '',
          shop_name: card?.shop_name ?? '',
          shop_location: card ? `${card.building_name} · ${card.floor_or_zone}` : null,
          payment_term: 'immediate' as const,
          payment_method: payload.paymentMethod,
          received_amount: payload.receivedAmount,
          allocated_amount: delivery.total_amount,
          change_amount: payload.paymentMethod === 'cash'
            ? Math.max(payload.receivedAmount - (delivery.total_amount ?? 0), 0)
            : 0,
          charges: [{
            charge_number: null,
            payment_term: 'immediate' as const,
            received_amount: delivery.total_amount ?? 0,
            items: (delivery.items ?? []).map((item) => ({
              ice_type_name: item.name ?? demoIceTypes.find((ice) => ice.id === item.ice_type_id)?.name ?? 'สินค้า',
              ice_type_unit: item.unit ?? demoIceTypes.find((ice) => ice.id === item.ice_type_id)?.unit ?? '',
              quantity: item.quantity,
              unit_price: item.unit_price,
              line_total: item.line_total ?? 0,
            })),
          }],
        },
      };
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
  const [financialPage, setFinancialPage] = useState<'collection' | 'credit' | 'refund'>(() =>
    new URLSearchParams(window.location.search).get('page') === 'credit' ? 'credit' : 'collection');
  const gateway = useMemo(() => buildDemoGateway(), [gatewayVersion]);

  if (new URLSearchParams(window.location.search).get('screen') === 'collection-layout') {
    const collectionRunClosed = new URLSearchParams(window.location.search).get('run') === 'closed';
    return (
      <AdminLayout
        activeView="financial_operations"
        allowedViews={['manager_overview', 'factory_order', 'delivery', 'financial_operations', 'stock_operations', 'location_management', 'shops', 'stock_audit', 'reference_settings']}
        financialPage={financialPage}
        onNavigate={() => undefined}
        onFinancialPageChange={setFinancialPage}
        profileLabel="bhusit.tanchavanic..."
      >
        <FinancialOperations demoData={{
          serviceDate: collectionServiceDate,
          queue: collectionQueue,
          paymentHistory: collectionPayments,
          receivables: creditReceivables,
          approvals: creditApprovals,
          dueDateRequests: creditDueDateRequests,
          collectors: collectionCollectors,
          memberIds: collectionRunClosed ? [] : ['collector-so'],
          runId: collectionRunClosed ? null : 'demo-collection-run',
          runOpenedAt: collectionRunClosed ? null : `${collectionServiceDate}T01:00:00.000Z`,
        }} managerPage={financialPage} onManagerPageChange={setFinancialPage} userRole="admin" />
      </AdminLayout>
    );
  }

  if (new URLSearchParams(window.location.search).get('screen') === 'employee-collection-layout') {
    return (
      <EmployeeLayout profileLabel="พนักงานเดโม่">
        <FinancialOperations
          demoData={{ serviceDate: collectionServiceDate, queue: collectionQueue, paymentHistory: collectionPayments }}
          userRole="courier"
        />
      </EmployeeLayout>
    );
  }

  if (new URLSearchParams(window.location.search).get('screen') === 'employee-withdrawal-layout') {
    return (
      <EmployeeLayout onSignOut={() => undefined} profileLabel="test01@gmail.com">
        <nav aria-label="งานพนักงาน" className="employee-task-tabs">
          <button aria-current="page" type="button">
            <Package aria-hidden="true" size={22} weight="duotone" />
            <span>เบิก</span>
          </button>
          <button type="button">
            <Storefront aria-hidden="true" size={22} weight="duotone" />
            <span>POS</span>
          </button>
          <button type="button">
            <Coins aria-hidden="true" size={22} weight="duotone" />
            <span>เก็บเงิน</span>
          </button>
        </nav>
        <EmployeeDeliveryWorkspace
          enableAssignedStockFlow
          gateway={gateway}
          requestScope={`withdrawal-layout-${gatewayVersion}`}
          serviceDate="2026-08-07"
          viewMode="withdrawal"
        />
      </EmployeeLayout>
    );
  }

  if (new URLSearchParams(window.location.search).get('screen') === 'today-layout') {
    return (
      <AdminLayout
        activeView="manager_overview"
        allowedViews={['manager_overview', 'factory_order', 'delivery', 'stock_operations', 'stock_audit']}
        onNavigate={() => undefined}
        profileLabel="หัวหน้างาน · Demo"
      >
        <ManagerDashboard
          demoDashboard={managerDashboardDemo}
          demoStockSummary={managerStockDemoSummary}
          isActive
          onNavigate={() => undefined}
          profileRole="admin"
        />
      </AdminLayout>
    );
  }

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
          operationRound={managerStockDemoRound}
          round={managerStockDemoRound}
          serviceDate={managerStockDemoRound.service_date}
        />
      </AdminLayout>
    );
  }

  if (new URLSearchParams(window.location.search).get('screen') === 'ice-types-layout') {
    return (
      <AdminLayout
        activeView="reference_settings"
        allowedViews={['manager_overview', 'factory_order', 'delivery', 'stock_operations', 'stock_audit', 'location_management', 'shops', 'reference_settings']}
        onNavigate={() => undefined}
        profileLabel="bhusit.tanchavanic..."
      >
        <AdminReferenceSettings
          initialTab="ice_types"
          previewData={{
            iceTypes: referencePreviewIceTypes,
            prices: [{
              id: 'preview-price', ice_type_id: 'preview-01', unit_price: 60, valid_from: '2026-07-24', valid_to: null, is_active: true,
            }],
          }}
        />
      </AdminLayout>
    );
  }

  if (new URLSearchParams(window.location.search).get('screen') === 'shops-layout') {
    return (
      <AdminLayout
        activeView="shops"
        allowedViews={['manager_overview', 'factory_order', 'delivery', 'stock_operations', 'stock_audit', 'location_management', 'shops', 'reference_settings']}
        onNavigate={() => undefined}
        profileLabel="bhusit.tanchavanich"
      >
        <ShopSettings allowReadOnlyPreview readOnly />
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
