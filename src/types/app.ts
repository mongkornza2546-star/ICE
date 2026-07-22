export type AppRole = 'courier' | 'round_lead' | 'admin';
export type DeliveryRoundStatus = 'open' | 'closed';
export type ShopRoundStatus =
  | 'pending'
  | 'delivered'
  | 'full_bin'
  | 'closed_shop'
  | 'no_access'
  | 'issue';
export type ShopPaymentStatus = 'unknown' | 'paid' | 'unpaid';
export type PaymentTerm = 'immediate' | 'end_of_day' | 'credit';
export type PaymentMethod = 'cash' | 'bank_transfer' | 'qr';
export type FinancialPaymentStatus = 'unpaid' | 'partial' | 'paid';

export interface UserProfile {
  id: string;
  code: string;
  display_name: string;
  phone: string | null;
  role: AppRole;
  is_active: boolean;
}

export interface DeliveryRound {
  id: string;
  service_date: string;
  name: string;
  status: DeliveryRoundStatus;
  opened_at: string;
  closed_at?: string | null;
  cancelled_at?: string | null;
  cancellation_reason?: string | null;
}

export interface IceTypeOption {
  id: string;
  code: string;
  name: string;
  unit: string;
}

export interface DeliveryRoundNameOption {
  id: string;
  name: string;
  sort_order: number;
}

export interface RoundMemberOption {
  id: string;
  code: string;
  display_name: string;
  role: AppRole;
  phone: string | null;
}

export interface RoundControlIceCount {
  ice_type_id: string;
  ice_type_name: string;
  unit: string;
  loaded_quantity: number;
  replenished_quantity: number;
  remaining_quantity: number;
  damaged_quantity: number;
  expected_quantity: number;
  delivered_quantity: number;
  variance_quantity: number;
}

export interface RoundControlSummary {
  stop_counts: {
    total: number;
    delivered: number;
    pending: number;
    problem: number;
  };
  ice_counts: RoundControlIceCount[];
}

export type StockLocationKind =
  | 'truck'
  | 'team'
  | 'small_vehicle'
  | 'work_site'
  | 'reserve_bin'
  | 'front_vehicle';

export type StockMovementKind =
  | 'factory_order'
  | 'transfer'
  | 'damage'
  | 'return_to_factory';

export interface StockBalanceItem {
  ice_type_id: string;
  ice_type_name: string;
  unit: string;
  quantity: number;
}

export interface StockLocationBalance {
  id: string;
  code: string;
  name: string;
  kind: StockLocationKind;
  holds_inventory?: boolean;
  requires_daily_count?: boolean;
  is_courier_source?: boolean;
  balances: StockBalanceItem[];
}

export interface EmployeeStockLocation {
  id: string;
  code: string;
  name: string;
  balances: StockBalanceItem[];
}

export interface EmployeeStockState {
  round_id: string;
  service_date: string;
  truck_location: EmployeeStockLocation;
  holding_location: EmployeeStockLocation;
}

export interface StockMovementEntry {
  id: string;
  kind: StockMovementKind;
  recorded_at: string;
  note: string | null;
  from_location_name: string | null;
  to_location_name: string | null;
  recorded_by: string;
  items: StockBalanceItem[];
  status?: 'active' | 'cancelled';
  cancelled_by_name?: string | null;
  cancelled_at?: string | null;
  cancellation_reason?: string | null;
  original_movement_id?: string | null;
  replacement_movement_id?: string | null;
}

export interface StockControlSummary {
  service_date: string;
  is_snapshot?: boolean;
  snapshot_at?: string | null;
  locations: StockLocationBalance[];
  recent_movements: StockMovementEntry[];
}

export interface FactoryOrderSummary extends StockControlSummary {
  order_count: number;
  ordered_totals: StockBalanceItem[];
}

export interface StockLocationSetting {
  id: string;
  code: string;
  name: string;
  kind: StockLocationKind;
  building_id: string | null;
  assigned_user_id: string | null;
  is_courier_source: boolean;
  is_default_for_building: boolean;
  is_active: boolean;
  holds_inventory: boolean;
  requires_daily_count: boolean;
}

export interface StockHolderAreaAssignment {
  id: string;
  stock_location_id: string;
  building_id: string | null;
  building_name?: string | null;
  zone_id: string | null;
  zone_name?: string | null;
  assigned_by: string;
  assigned_at: string;
}

export interface StockCountVarianceReview {
  id: string;
  service_date: string;
  location_id: string;
  location_name: string;
  ice_type_id: string;
  ice_type_name: string;
  unit: string;
  system_quantity: number;
  actual_quantity: number;
  variance_quantity: number;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_by?: string | null;
  reviewed_by_name?: string | null;
  reviewed_at?: string | null;
  review_note?: string | null;
  created_at: string;
}

export interface StockCountItem {
  ice_type_id: string;
  ice_type_name: string;
  unit: string;
  system_quantity: number;
  actual_quantity: number;
  variance_quantity: number;
}

export interface StockCountSnapshot {
  id: string;
  counted_at: string;
  note: string | null;
  location_id: string;
  location_name: string;
  counted_by: string;
  items: StockCountItem[];
}

export interface StockCountReadiness {
  location_id: string;
  location_name: string;
  status: 'current' | 'stale' | 'uncounted';
  snapshot: StockCountSnapshot | null;
}

export interface DailyStockCloseCount extends StockCountItem {
  location_id: string;
  location_name: string;
  note: string | null;
}

export interface DailyStockCloseState {
  service_date: string;
  open_round_count: number;
  is_closed: boolean;
  closed_at: string | null;
  closed_by: string | null;
  note: string | null;
  counts: DailyStockCloseCount[];
}

export interface ManagerDeliveryEventItem {
  ice_type_id: string;
  quantity: number;
}

export interface ManagerDeliveryEvent {
  id: string;
  round_stop_id: string;
  shop_code: string;
  shop_name: string;
  recorded_by: string;
  recorded_at: string;
  note: string | null;
  stop_status: ShopRoundStatus;
  items: ManagerDeliveryEventItem[];
}

export interface ManagerDeliveryEventSummary {
  ice_types: IceTypeOption[];
  events: ManagerDeliveryEvent[];
}

export interface BuildingOption {
  id: string;
  code: string;
  name: string;
  is_active?: boolean;
}

export interface BuildingZoneOption {
  id: string;
  building_id: string;
  code: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

export interface ShopSetting {
  id: string;
  code: string;
  name: string;
  image_path: string | null;
  building_id: string;
  zone_id: string;
  floor_or_zone: string;
  government_shop_code: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  normal_rounds_per_day: number;
  access_note: string | null;
  status: 'active' | 'inactive';
}

export interface ShopCardHistoryEntry {
  event_id: string;
  recorded_at: string;
  round_name: string;
  recorded_by: string;
  stop_status: Exclude<ShopRoundStatus, 'pending'>;
  note: string | null;
  items: Record<string, number>;
}

export interface ShopCard {
  round_stop_id: string;
  shop_id: string;
  shop_code: string;
  shop_name: string;
  building_id: string;
  building_name: string;
  floor_or_zone: string;
  sequence_no: number;
  image_path: string | null;
  image_url: string | null;
  payment_status: ShopPaymentStatus;
  stop_status: ShopRoundStatus;
  stop_note: string | null;
  today_history: ShopCardHistoryEntry[];
  today_totals: Record<string, number>;
}

export type CreditDueRule = 'net_days' | 'end_of_month';

export interface IceTypePriceSetting {
  id: string;
  ice_type_id: string;
  ice_type_code?: string;
  ice_type_name?: string;
  unit?: string;
  unit_price: number;
  valid_from: string;
  valid_to: string | null;
  is_active: boolean;
  created_at?: string;
  created_by?: string;
}

export interface ShopPaymentProfileSetting {
  id?: string;
  shop_id: string;
  allowed_payment_terms: PaymentTerm[];
  default_payment_term: PaymentTerm;
  allowed_payment_methods: PaymentMethod[];
  default_payment_method: PaymentMethod;
  cash_reference_required: boolean;
  cash_evidence_required: boolean;
  bank_transfer_reference_required: boolean;
  bank_transfer_evidence_required: boolean;
  qr_reference_required: boolean;
  qr_evidence_required: boolean;
  allow_outstanding: boolean;
  credit_due_rule: CreditDueRule | null;
  credit_days: number | null;
  credit_limit: number | null;
}

export interface ShopIcePriceSetting {
  id: string;
  shop_id: string;
  ice_type_id: string;
  ice_type_code?: string;
  ice_type_name?: string;
  unit?: string;
  unit_price: number;
  valid_from: string;
  valid_to: string | null;
  is_active: boolean;
}

export interface ShopReadinessItem {
  shop_id: string;
  shop_code: string;
  shop_name: string;
  building_name?: string;
  zone_name?: string;
  has_payment_profile: boolean;
  missing_special_prices_count: number;
  has_issues: boolean;
  issue_details: string[];
}

export interface POSReadinessReport {
  total_active_shops: number;
  shops_ready_count: number;
  shops_missing_payment_profile: number;
  ice_types_missing_standard_price: number;
  items: ShopReadinessItem[];
}
