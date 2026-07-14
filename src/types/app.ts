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
}

export interface IceTypeOption {
  id: string;
  code: string;
  name: string;
  unit: string;
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
  balances: StockBalanceItem[];
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
}

export interface StockControlSummary {
  service_date: string;
  locations: StockLocationBalance[];
  recent_movements: StockMovementEntry[];
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
  building_id: string;
  zone_id: string;
  floor_or_zone: string;
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
