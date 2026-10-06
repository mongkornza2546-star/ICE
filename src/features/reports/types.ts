export type ReportMetric = 'sales' | 'receipts' | 'refunds' | 'debt' | 'overdue';

export type ReportRow = {
  id: string;
  day: string;
  label: string;
  amount: number;
  method?: string | null;
  area?: string | null;
  dueDate?: string | null;
  shopId?: string | null;
};

export type ExecutiveReport = {
  from: string;
  to: string;
  asOf: string;
  previousFrom: string;
  previousTo: string;
  sales: number;
  receipts: number;
  refunds: number;
  netReceipts: number;
  previousSales: number;
  previousNetReceipts: number;
  outstanding: number;
  overdue: number;
  debtors: number;
  deliveryCount: number;
  trend: Array<{ date: string; sales: number; receipts: number; refunds: number }>;
  areas: Array<{ kind: string; id: string | null; name: string; sales: number }>;
  shops: Array<{ id: string; name: string; sales: number }>;
  products: Array<{ id: string; name: string; unit: string; delivered: number; damaged: number }>;
};

export type DetailQuery = {
  metric: ReportMetric;
  bucket?: string;
  areaKind?: string;
  areaId?: string | null;
  shopId?: string;
};

export type ReportInvoice = {
  number: string | null;
  shop: string;
  serviceDate: string;
  area: string;
  dueDate: string;
  total: number;
  paid: number;
  items: Array<{ name: string; unit: string; quantity: number }>;
  payments: Array<{ date: string; method: string; amount: number }>;
};
