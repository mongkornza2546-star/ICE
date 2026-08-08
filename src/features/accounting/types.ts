export type AccountingTab = 'reconciliation' | 'transactions' | 'review';

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
  ice_type_id?: string;
  shop_id?: string;
  employee_id?: string;
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
