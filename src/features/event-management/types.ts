import type { PaymentMethod } from '../../types/app';

export type EventJobStatus = 'draft' | 'published' | 'cancelled';
export type EventParticipationStatus = 'active' | 'cancelled';

export interface EventJob {
  id: string;
  name: string;
  organizer_name: string;
  contact_name: string;
  contact_phone: string;
  location: string;
  start_date: string;
  end_date: string;
  timezone: 'Asia/Bangkok';
  notes: string | null;
  status: EventJobStatus;
  current_config_version_id: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
}

export interface EventOverview extends EventJob {
  active_participation_count: number;
  has_configuration: boolean;
}

export interface EventConfiguration {
  id: string;
  event_job_id: string;
  version_no: number;
  tank_rental_unit_price: number;
  payment_term: 'end_of_day';
  allowed_payment_methods: PaymentMethod[];
  default_payment_method: PaymentMethod;
  cash_reference_required: boolean;
  cash_evidence_required: boolean;
  bank_transfer_reference_required: boolean;
  bank_transfer_evidence_required: boolean;
  qr_reference_required: boolean;
  qr_evidence_required: boolean;
}

export interface EventParticipation {
  id: string;
  event_job_id: string;
  shop_id: string;
  booth_number: string | null;
  event_zone: string | null;
  landmark: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  start_date: string;
  end_date: string;
  rents_tank_from_us: boolean;
  status: EventParticipationStatus;
  cancellation_reason: string | null;
  shop_code: string;
  shop_name: string;
  shop_status: 'active' | 'inactive';
  shop_contact_name: string | null;
  shop_contact_phone: string | null;
}

export interface EventReadinessCheck {
  code: 'draft_status' | 'settlement_configuration' | 'participation_count' | 'participation_details' | 'standard_price_coverage';
  ok: boolean;
  message: string;
  actual?: number;
  minimum?: number;
  maximum?: number;
  items?: Array<Record<string, unknown>>;
}

export interface EventReadiness {
  is_ready: boolean;
  checks: EventReadinessCheck[];
}

export interface EventManagementDetail {
  event: EventJob;
  configuration: EventConfiguration | null;
  participations: EventParticipation[];
  readiness: EventReadiness;
}

export interface EventDeliveryCapability {
  schema_version: number;
  lifecycle_enabled: boolean;
}

export interface EventShopOption {
  id: string;
  code: string;
  name: string;
  contact_name: string | null;
  contact_phone: string | null;
  status: 'active';
}

export interface EventMetadataInput {
  event_job_id: string | null;
  name: string;
  organizer_name: string;
  contact_name: string;
  contact_phone: string;
  location: string;
  start_date: string;
  end_date: string;
  notes: string;
}

export interface EventConfigurationInput extends EventMetadataInput {
  tank_rental_unit_price: number;
  allowed_payment_methods: PaymentMethod[];
  default_payment_method: PaymentMethod;
  cash_reference_required: boolean;
  cash_evidence_required: boolean;
  bank_transfer_reference_required: boolean;
  bank_transfer_evidence_required: boolean;
  qr_reference_required: boolean;
  qr_evidence_required: boolean;
}

export interface EventParticipationInput {
  participation_id: string | null;
  event_job_id: string;
  shop_id: string;
  booth_number: string;
  event_zone: string;
  landmark: string;
  contact_name: string;
  contact_phone: string;
  start_date: string;
  end_date: string;
  rents_tank_from_us: boolean;
}

export interface EventManagementGateway {
  loadCapability(): Promise<EventDeliveryCapability>;
  loadOverview(): Promise<EventOverview[]>;
  loadDetail(eventJobId: string): Promise<EventManagementDetail>;
  loadActiveShops(): Promise<EventShopOption[]>;
  saveMetadata(input: EventMetadataInput): Promise<EventJob>;
  saveEvent(input: EventConfigurationInput): Promise<{ event_job: EventJob; configuration: EventConfiguration }>;
  saveParticipation(input: EventParticipationInput): Promise<EventParticipation>;
  publishEvent(eventJobId: string): Promise<EventJob>;
  cancelEvent(eventJobId: string, reason: string): Promise<EventJob>;
  cancelParticipation(participationId: string, reason: string): Promise<EventParticipation>;
}
