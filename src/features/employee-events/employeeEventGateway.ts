import { runOnlineOnlyEmployeeWrite } from '../../offline/runtime/client';
import { getErrorMessage } from '../../lib/errorMessage';
import { isMissingRpc } from '../../lib/rpc';
import { supabase } from '../../lib/supabase';
import type {
  EmployeeEventBoothResult,
  EmployeeEventDetail,
  EmployeeEventGateway,
  EmployeeEventSummary,
  EmployeeTankHandoffResult,
} from './types';

function client() {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase สำหรับหน้าอีเวนต์');
  return supabase;
}

async function rpc<T>(name: string, args?: Record<string, unknown>, guarded = false) {
  // Store the same RPC envelope as background recovery; unwrap it only here.
  const request = () => client().rpc(name, args);
  const { data, error, status } = await (guarded
    ? runOnlineOnlyEmployeeWrite(request, JSON.stringify({ kind: 'rpc', rpc: name, args }))
    : request());
  if (error) {
    if (isMissingRpc(error)) throw new Error('ฐานข้อมูลยังไม่รองรับหน้าอีเวนต์พนักงาน กรุณาติดตั้ง migration 0197');
    throw Object.assign(new Error(getErrorMessage(error)), { code: error.code, status });
  }
  return data as T;
}

export const employeeEventGateway: EmployeeEventGateway = {
  async loadEvents() {
    const result = await rpc<{ events?: EmployeeEventSummary[] }>('get_employee_event_overview');
    return result.events ?? [];
  },

  async loadEvent(eventJobId) {
    return rpc<EmployeeEventDetail>('get_employee_event_detail', { p_event_job_id: eventJobId });
  },

  async createBooth(input) {
    const args = {
      p_event_job_id: input.eventJobId,
      p_request_id: input.requestId,
      p_booth_number: input.boothNumber,
      p_shop_name: input.shopName || null,
      p_event_zone: input.eventZone || null,
      p_contact_name: input.contactName || null,
      p_contact_phone: input.contactPhone || null,
    };
    return rpc<EmployeeEventBoothResult>('create_employee_event_booth', args, true);
  },

  async handoffTanks(input) {
    const args = {
      p_participation_id: input.participationId,
      p_quantity: input.quantity,
      p_note: input.note,
      p_request_id: input.requestId,
    };
    return rpc<EmployeeTankHandoffResult>('record_employee_event_tank_handoff', args, true);
  },
};
