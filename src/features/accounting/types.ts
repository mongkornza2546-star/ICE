export type AccountingTab = 'shops' | 'reconciliation' | 'transactions' | 'review';

export type AccountingTransactionType =
  | 'FACTORY'
  | 'WITHDRAW'
  | 'TRANSFER'
  | 'SALE'
  | 'INV'
  | 'REC'
  | 'ADJ'
  | 'REF'
  | 'DAMAGE'
  | 'RETURN';

export type AccountingFilters = {
  document?: string;
  shop_search?: string;
  ice_type_id?: string;
  shop_id?: string;
  building_id?: string;
  zone_id?: string;
  employee_id?: string;
  payment_term?: 'immediate' | 'end_of_day' | 'credit';
  payment_status?: 'paid' | 'outstanding' | 'overdue';
  types?: AccountingTransactionType[];
  issues_only?: boolean;
};

export type AccountingSort = {
  key: string;
  direction: 'asc' | 'desc';
};

export type AccountingTransaction = {
  occurred_at: string;
  service_date: string;
  type: AccountingTransactionType;
  group_id: string;
  source_id: string;
  source_table: string;
  delivery_event_id: string | null;
  payment_id: string | null;
  document_number: string;
  reference_number: string | null;
  shop_id: string | null;
  shop_code: string | null;
  shop_name: string | null;
  holder_name: string | null;
  employee_id: string | null;
  employee_name: string | null;
  ice_type_id: string | null;
  ice_type_name: string | null;
  unit: string | null;
  quantity_in: number;
  quantity_out: number;
  sales_amount: number;
  cash_in: number;
  cash_out: number;
  receivable_delta: number;
  status: string;
  note: string | null;
  issue_code: string | null;
  issue_label: string | null;
  can_correct: boolean;
  details: Record<string, unknown>;
};

export type AccountingFacet = { value: string; label: string; count: number };

export type AccountingTransactionsResponse = {
  rows: AccountingTransaction[];
  total_count: number;
  facets: {
    ice_types: AccountingFacet[];
    shops: AccountingFacet[];
    employees: AccountingFacet[];
    types: AccountingFacet[];
  };
};

export type AccountingShopSummaryRow = {
  shop_id: string;
  shop_code: string;
  shop_name: string;
  building_id: string;
  building_name: string;
  current_zone_id: string | null;
  current_zone_name: string | null;
  historical_zone_name: string | null;
  payment_term: 'immediate' | 'end_of_day' | 'credit' | 'mixed' | null;
  employee_names: string | null;
  sales_amount: number;
  paid_amount: number;
  outstanding_amount: number;
  overdue_amount: number;
  invoice_count: number;
  due_date: string | null;
  cumulative_outstanding_amount: number;
  cumulative_overdue_amount: number;
  oldest_outstanding_due_date: string | null;
  payment_status: 'paid' | 'outstanding' | 'overdue';
};

export type AccountingShopSummaryResponse = {
  rows: AccountingShopSummaryRow[];
  total_count: number;
  totals: {
    sales_amount: number;
    paid_amount: number;
    outstanding_amount: number;
    overdue_amount: number;
    outstanding_shop_count: number;
    cumulative_outstanding_amount: number;
    cumulative_overdue_amount: number;
    cumulative_outstanding_shop_count: number;
    cash_received_in_period: number;
  };
  facets: {
    shops: AccountingFacet[];
    buildings: AccountingFacet[];
    zones: AccountingFacet[];
  };
};

export type AccountingShopInvoiceDetailEntry = {
  delivery_event_id: string;
  delivery_status?: 'active' | 'replaced' | 'cancelled';
  charge_id: string | null;
  charge_number: string | null;
  charge_status?: 'active' | 'voided' | null;
  service_date: string;
  recorded_at: string;
  recorded_by_name: string;
  total_amount: number | null;
  payment_term: 'immediate' | 'end_of_day' | 'credit' | null;
  allocated_amount: number;
  outstanding_amount: number;
  payment_status: 'unpaid' | 'partial' | 'paid' | 'voided' | null;
  building_id: string;
  building_name: string;
  historical_zone_name: string | null;
  current_zone_id: string | null;
  current_zone_name: string | null;
  items: Array<{
    ice_type_id: string;
    name: string;
    unit: string;
    quantity: number;
    unit_price: number | null;
    line_total: number | null;
  }>;
  payments: Array<{
    payment_id: string;
    payment_method: 'cash' | 'bank_transfer' | 'qr';
    amount: number;
    recorded_at: string;
  }>;
  adjustments: Array<{
    id: string;
    scope: string;
    amount_delta: number;
    corrected_total: number | null;
    reason: string;
    created_at: string;
    items: Array<{
      ice_type_id: string;
      name: string;
      unit: string;
      original_quantity: number;
      corrected_quantity: number;
      quantity_delta: number;
      unit_price: number;
      corrected_line_total: number;
    }>;
  }>;
};

export type ReconciliationLine = {
  ice_type_id: string;
  ice_type_name: string;
  unit: string;
  factory_in: number;
  sold: number;
  legacy_refill?: number;
  damaged: number;
  returned_to_factory: number;
  closed_returned_to_factory?: number;
  expected: number;
  actual: number | null;
  variance: number | null;
  count_status: 'complete' | 'incomplete' | 'stale';
};

export type HolderReconciliation = {
  location_id: string;
  location_name: string;
  location_kind: string;
  employee_name: string | null;
  items: ReconciliationLine[];
};

export type AccountingReconciliation = {
  service_date: string;
  aggregate: ReconciliationLine[];
  holders: HolderReconciliation[];
  financial: {
    effective_sales: number;
    allocated_to_sales: number;
    outstanding_collectible: number;
    outstanding_credit: number;
    cash_received: number;
    cash_refunded: number;
    net_cash: number;
    pending_refunds: number;
  };
};

export type AccountingReviewItem = {
  issue_id: string;
  issue_type: string;
  severity: 'warning' | 'critical';
  service_date: string;
  occurred_at: string;
  document_number: string | null;
  shop_name: string | null;
  title: string;
  description: string;
  source_id: string;
  delivery_event_id: string | null;
  payment_id: string | null;
};

export type AccountingReviewResponse = {
  rows: AccountingReviewItem[];
  total_count: number;
};
