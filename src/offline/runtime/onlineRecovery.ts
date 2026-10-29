import type { EmployeeDeliveryGateway } from '../../EmployeeDeliveryWorkspace';
import { clearPendingRequestByKey } from '../../features/employee-delivery/usePendingRequests';
import { supabase } from '../../lib/supabase';
import { offlineStore, runOnlineOnlyEmployeeWrite } from './client';

const gatewayMethods = {
  stock_transfer: 'recordEmployeeStockTransfer', stock_return: 'recordEmployeeStockReturn', stock_damage: 'recordEmployeeStockDamage',
  delivery: 'recordDelivery', immediate_sale: 'recordImmediateSale', payment: 'recordPayment', casual: 'recordCasualTransaction',
  void_casual: 'voidCasualTransaction', approval: 'requestFinancialApproval',
} as const satisfies Record<string, keyof EmployeeDeliveryGateway>;
const replayableRpcs = new Set([
  'record_shop_collection_payment', 'record_regular_collection_payment', 'record_billing_statement_payment',
  'record_event_payment', 'record_event_collection_payment', 'record_backdated_collection_payment', 'void_payment',
  'apply_open_delivery_correction', 'apply_open_event_delivery_correction', 'create_employee_event_booth', 'record_employee_event_tank_handoff',
]);

// Only requests saved by the guarded entry points can be replayed. The same
// account, payload and server idempotency key are retained across reloads.
export async function retryPendingOnlineWrite(owner: string, live: EmployeeDeliveryGateway) {
  const pending = await offlineStore().onlineWrite();
  if (!pending?.retryKey || pending.ownerId !== owner) throw new Error('กรุณาเข้าสู่ระบบด้วยบัญชีเจ้าของรายการ');
  const request = JSON.parse(pending.retryKey);
  let payload: Record<string, unknown>;
  let result: unknown;
  if (request.kind === 'gateway' && Object.prototype.hasOwnProperty.call(gatewayMethods, request.operation)) {
    const method = live[gatewayMethods[request.operation as keyof typeof gatewayMethods]];
    if (typeof method !== 'function' || !request.payload || typeof request.payload !== 'object') throw new Error('ไม่พบรายการเดิมสำหรับตรวจสอบ');
    payload = request.payload;
    result = await runOnlineOnlyEmployeeWrite(() => Reflect.apply(method, live, [payload]), pending.retryKey);
  } else if (request.kind === 'rpc' && replayableRpcs.has(request.rpc) && request.args && typeof request.args === 'object') {
    if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
    payload = request.args;
    const response = await runOnlineOnlyEmployeeWrite(() => supabase!.rpc(request.rpc, payload), pending.retryKey);
    if (response.error) throw response.error;
    result = response.data;
  } else throw new Error('ไม่พบรายการเดิมสำหรับตรวจสอบ');
  const nested = payload.p_payment_args as Record<string, unknown> | undefined;
  const key = payload.idempotencyKey ?? payload.p_idempotency_key ?? nested?.p_idempotency_key;
  if (typeof key === 'string') clearPendingRequestByKey(key);
  return result;
}
