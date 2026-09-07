import { supabase } from '../../lib/supabase';
import { getErrorMessage } from '../../lib/errorMessage';
import { isMissingRpc } from '../../lib/rpc';
import type {
  EventConfigurationInput,
  EventDeliveryCapability,
  EventJob,
  EventManagementDetail,
  EventManagementGateway,
  EventMetadataInput,
  EventNewShopsResult,
  EventOverview,
  EventParticipation,
  EventParticipationInput,
  EventShopOption,
} from './types';

const SHOP_PAGE_SIZE = 500;

function client() {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase สำหรับหน้างานอีเวนต์');
  return supabase;
}

async function rpc<T>(name: string, args?: Record<string, unknown>) {
  const { data, error } = await client().rpc(name, args);
  if (error) {
    if (name.startsWith('get_event_management_') && isMissingRpc(error)) {
      throw new Error('ฐานข้อมูลยังไม่พร้อมสำหรับหน้างานอีเวนต์ กรุณาติดตั้ง migration 0169');
    }
    throw new Error(getErrorMessage(error));
  }
  return data as T;
}

export const eventManagementGateway: EventManagementGateway = {
  async loadCapability() {
    return rpc<EventDeliveryCapability>('get_event_delivery_capability');
  },

  async loadOverview() {
    const result = await rpc<{ events?: EventOverview[] }>('get_event_management_overview');
    return result.events ?? [];
  },

  async loadDetail(eventJobId) {
    return rpc<EventManagementDetail>('get_event_management_detail', { p_event_job_id: eventJobId });
  },

  async loadActiveShops() {
    const shops: EventShopOption[] = [];
    for (let offset = 0; ; offset += SHOP_PAGE_SIZE) {
      const { data, error } = await client()
        .from('shops')
        .select('id, code, name, contact_name, contact_phone, status')
        .eq('status', 'active')
        .is('event_job_id', null)
        .order('code')
        .range(offset, offset + SHOP_PAGE_SIZE - 1);
      if (error) throw new Error(getErrorMessage(error));
      const page = (data ?? []) as EventShopOption[];
      shops.push(...page);
      if (page.length < SHOP_PAGE_SIZE) return shops;
    }
  },

  async saveMetadata(input: EventMetadataInput) {
    return rpc<EventJob>('save_event_job_metadata', {
      p_event_job_id: input.event_job_id,
      p_name: input.name,
      p_organizer_name: input.organizer_name,
      p_contact_name: input.contact_name,
      p_contact_phone: input.contact_phone,
      p_location: input.location,
      p_start_date: input.start_date,
      p_end_date: input.end_date,
      p_notes: input.notes || null,
    });
  },

  async saveEvent(input: EventConfigurationInput) {
    return rpc('save_event_job', {
      p_event_job_id: input.event_job_id,
      p_name: input.name,
      p_organizer_name: input.organizer_name,
      p_contact_name: input.contact_name,
      p_contact_phone: input.contact_phone,
      p_location: input.location,
      p_start_date: input.start_date,
      p_end_date: input.end_date,
      p_notes: input.notes || null,
      p_tank_rental_unit_price: input.tank_rental_unit_price,
      p_allowed_payment_methods: input.allowed_payment_methods,
      p_default_payment_method: input.default_payment_method,
      p_cash_reference_required: input.cash_reference_required,
      p_cash_evidence_required: input.cash_evidence_required,
      p_bank_transfer_reference_required: input.bank_transfer_reference_required,
      p_bank_transfer_evidence_required: input.bank_transfer_evidence_required,
      p_qr_reference_required: input.qr_reference_required,
      p_qr_evidence_required: input.qr_evidence_required,
    });
  },

  async saveParticipation(input: EventParticipationInput) {
    return rpc<EventParticipation>(input.shop_name !== undefined ? 'save_event_participation_with_shop_name' : 'save_event_participation', {
      ...(input.shop_name !== undefined ? { p_shop_name: input.shop_name } : {}),
      p_participation_id: input.participation_id,
      p_event_job_id: input.event_job_id,
      p_shop_id: input.shop_id,
      p_booth_number: input.booth_number || null,
      p_event_zone: input.event_zone || null,
      p_landmark: input.landmark || null,
      p_contact_name: input.contact_name || null,
      p_contact_phone: input.contact_phone || null,
      p_start_date: input.start_date,
      p_end_date: input.end_date,
      p_rents_tank_from_us: input.rents_tank_from_us,
    });
  },

  async createEventShops(eventJobId, requestId, rows) {
    return rpc<EventNewShopsResult>('create_event_shops', {
      p_event_job_id: eventJobId,
      p_request_id: requestId,
      p_rows: rows,
    });
  },

  async publishEvent(eventJobId) {
    return rpc<EventJob>('publish_event_job', { p_event_job_id: eventJobId });
  },

  async cancelEvent(eventJobId, reason) {
    return rpc<EventJob>('cancel_event_job', { p_event_job_id: eventJobId, p_reason: reason });
  },

  async cancelParticipation(participationId, reason) {
    return rpc<EventParticipation>('cancel_event_participation', {
      p_participation_id: participationId,
      p_reason: reason,
    });
  },
};
