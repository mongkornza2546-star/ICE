import type { PaymentMethod } from '../../types/app';

export type PaymentProfile = {
  allowed_payment_methods: PaymentMethod[];
  default_payment_method: PaymentMethod;
  cash_reference_required: boolean;
  cash_evidence_required: boolean;
  bank_transfer_reference_required: boolean;
  bank_transfer_evidence_required: boolean;
  qr_reference_required: boolean;
  qr_evidence_required: boolean;
};

export type QueueCharge = {
  charge_id: string;
  charge_number: string;
  service_date: string;
  payment_term?: 'immediate' | 'end_of_day' | 'credit';
  due_date?: string | null;
  original_amount: number;
  outstanding_amount: number;
  items: Array<{
    ice_type_id: string;
    name: string;
    unit: string;
    quantity: number;
    line_total: number;
  }>;
};

export type QueueShop = {
  shop_id: string;
  shop_code: string;
  shop_name: string;
  image_path: string | null;
  image_url?: string | null;
  outstanding_amount: number;
  charge_count: number;
  has_new_charges: boolean;
  payment_profile: PaymentProfile;
  charges: QueueCharge[];
};

export type Receivable = {
  shop_id: string;
  shop_code: string;
  shop_name: string;
  building_name?: string | null;
  zone_name?: string | null;
  responsible_name?: string | null;
  credit_days?: number | null;
  credit_limit: number | null;
  available_credit_amount: number | null;
  credit_suspended?: boolean;
  credit_suspension_reason?: string | null;
  outstanding_amount: number;
  overdue_amount: number;
  due_today_amount?: number;
  due_today_charge_count?: number;
  overdue_charge_count?: number;
  aging_current_amount?: number;
  aging_1_7_amount?: number;
  aging_8_15_amount?: number;
  aging_16_30_amount?: number;
  aging_over_30_amount?: number;
  oldest_due_date: string | null;
  last_payment_at?: string | null;
  charges: ReceivableCharge[];
  payments?: ReceivablePayment[];
};

export type ReceivableDetail = {
  charges: ReceivableCharge[];
  payments: ReceivablePayment[];
};

export type ReceivablePayment = {
  id: string;
  receipt_number: string;
  received_amount: number;
  allocated_amount: number;
  payment_method: PaymentMethod;
  status: 'active' | 'voided';
  recorded_at: string;
  recorded_by: string | null;
  allocations: Array<{
    charge_id: string;
    charge_number: string;
    amount: number;
  }>;
};

export type ReceivableCharge = {
  charge_id: string;
  charge_number: string;
  service_date: string;
  due_date: string;
  original_amount: number;
  allocated_amount: number;
  outstanding_amount: number;
  days_overdue: number;
  payment_status: 'unpaid' | 'partial' | 'paid';
  due_status: 'not_due' | 'due_today' | 'overdue' | 'paid';
  assigned_collection_run_id: string | null;
};

export type DueDateRequest = {
  id: string;
  charge_id: string;
  charge_number: string;
  shop_code: string;
  shop_name: string;
  original_due_date: string;
  requested_due_date: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_at: string;
  requested_by: string;
};

export type Approval = {
  id: string;
  kind: 'credit_limit' | 'outstanding_balance';
  requested_amount: number;
  reason: string;
  status: 'pending';
  requested_at: string;
  shops: { code: string; name: string } | null;
  users: { display_name: string } | null;
};

export type Collector = {
  id: string;
  code: string;
  display_name: string;
  nickname: string | null;
  avatar_path: string | null;
};

export type PaymentHistoryItem = {
  id: string;
  receipt_number: string;
  received_amount: number;
  allocated_amount: number;
  change_amount: number;
  payment_method: PaymentMethod;
  status: 'active' | 'voided';
  recorded_at: string;
  void_reason: string | null;
  shops: { code: string; name: string } | null;
};

export type ReceiptItem = {
  name: string;
  unit: string;
  quantity: number;
  lineTotal: number;
};

export type ReceiptCharge = {
  chargeNumber: string;
  receivedAmount: number;
  items: ReceiptItem[];
};

export type PaymentReceipt = {
  paymentId: string;
  receiptNumber: string;
  shopCode: string;
  shopName: string;
  method: PaymentMethod;
  receivedAmount: number;
  allocatedAmount: number;
  changeAmount: number;
  recordedAt: string;
  charges: ReceiptCharge[];
};

export type HistoryReceiptDetail = {
  payment: PaymentHistoryItem;
  charges: ReceiptCharge[] | null;
  error: string | null;
};

export type ReceiptItemRow = {
  charge_number: string | null;
  received_amount: number | string;
  ice_type_name: string;
  ice_type_unit: string;
  quantity: number | string;
  line_total: number | string;
};
