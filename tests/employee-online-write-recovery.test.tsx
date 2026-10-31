import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), owner: 'employee-1' }));
vi.mock('../src/lib/supabase', () => ({ supabase: {
  rpc: (...args: unknown[]) => mocks.rpc(...args),
  auth: { getSession: async () => ({ data: { session: { user: { id: mocks.owner } } }, error: null }) },
} }));
import { hasUnsentWork, offlineStore, runOnlineOnlyEmployeeWrite } from '../src/offline/runtime/client';
import { OnlineWriteRecovery } from '../src/offline/runtime/OnlineWriteRecovery';
import { retryPendingOnlineWrite } from '../src/offline/runtime/onlineRecovery';
import { employeeEventGateway } from '../src/features/employee-events/employeeEventGateway';

const factory = new IDBFactory();
beforeEach(() => { vi.stubGlobal('indexedDB', factory); mocks.owner = 'employee-1'; });
afterEach(async () => {
  vi.restoreAllMocks();
  await offlineStore().close();
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase('ice-employee-work-v1');
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
  vi.unstubAllGlobals();
});

it('isolates persisted online confirmations by owner and exact request', async () => {
  const first = vi.fn(async () => ({ receipt: 'first-owner' }));
  await runOnlineOnlyEmployeeWrite(first, correction);
  await offlineStore().close();
  expect(await runOnlineOnlyEmployeeWrite(first, correction)).toEqual({ receipt: 'first-owner' });
  expect(first).toHaveBeenCalledTimes(1);
  mocks.owner = 'employee-2';
  const second = vi.fn(async () => ({ receipt: 'second-owner' }));
  expect(await runOnlineOnlyEmployeeWrite(second, correction)).toEqual({ receipt: 'second-owner' });
  expect(second).toHaveBeenCalledTimes(1);
  const changed = JSON.stringify({ kind: 'rpc', rpc: 'apply_open_delivery_correction', args: { ...args, p_reason: 'changed' } });
  await runOnlineOnlyEmployeeWrite(second, changed);
  expect(second).toHaveBeenCalledTimes(2);
});

it('keeps an unresolved fence if saving the server confirmation fails', async () => {
  const action = vi.fn(async () => ({ receipt: 'confirmed' }));
  const end = vi.spyOn(offlineStore(), 'endOnlineWrite').mockRejectedValueOnce(new DOMException('Quota exceeded', 'QuotaExceededError'));
  await expect(runOnlineOnlyEmployeeWrite(action, correction)).rejects.toThrow('Quota exceeded');
  expect(end).toHaveBeenCalledTimes(1);
  expect(await offlineStore().hasOnlineWrite()).toBe(true);
  expect(await offlineStore().onlineResult('employee-1', correction)).toBeUndefined();
  await runOnlineOnlyEmployeeWrite(action, correction);
  expect(await offlineStore().hasOnlineWrite()).toBe(false);
  expect(await offlineStore().onlineResult('employee-1', correction)).toEqual({ value: { receipt: 'confirmed' } });
});

it('preserves the event gateway result shape when consuming an RPC recovered in the background', async () => {
  const input = { eventJobId: 'event', requestId: 'booth-request', boothNumber: 'A1',
    shopName: '', eventZone: '', contactName: '', contactPhone: '' };
  const result = { created: true, duplicate: false, booth: { id: 'booth' } };
  mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Load failed' }, status: 0 })
    .mockResolvedValue({ data: result, error: null, status: 200 });
  await expect(employeeEventGateway.createBooth(input)).rejects.toThrow('Load failed');
  await retryPendingOnlineWrite('employee-1', live);
  await expect(employeeEventGateway.createBooth(input)).resolves.toEqual(result);
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
});

const args = { p_event_id: 'delivery-1', p_action: 'cancel', p_reason: 'ส่งผิด', p_idempotency_key: 'original-key' };
const correction = JSON.stringify({ kind: 'rpc', rpc: 'apply_open_delivery_correction', args });
const live = {} as EmployeeDeliveryGateway;

it('replays the original saved cancellation after reopen, retains its pending identity, and reloads through the recovery button', async () => {
  let committed = false; let writes = 0;
  mocks.rpc.mockImplementation(async () => {
    if (!committed) { committed = true; writes++; return { data: null, error: { message: 'Load failed' }, status: 0 }; }
    return { data: { cancelled: true }, error: null, status: 200 };
  });
  await runOnlineOnlyEmployeeWrite(() => mocks.rpc('apply_open_delivery_correction', args), correction);
  localStorage.setItem('ice-delivery.pending-requests.v1', JSON.stringify({ oldForm: { key: 'original-key', clientRecordedAt: new Date().toISOString() } }));
  await offlineStore().close();
  const onResolved = vi.fn();
  render(<OnlineWriteRecovery owner="employee-1" live={live} onResolved={onResolved} />);
  fireEvent.click(await screen.findByRole('button', { name: 'ตรวจสอบรายการเดิมและโหลดข้อมูลใหม่' }));
  await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'apply_open_delivery_correction', args);
  expect(writes).toBe(1);
  expect(await offlineStore().hasPending()).toBe(false);
  expect(JSON.parse(localStorage.getItem('ice-delivery.pending-requests.v1')!).oldForm.key).toBe('original-key');
  await offlineStore().close();
  const repeated = await runOnlineOnlyEmployeeWrite(() => mocks.rpc('apply_open_delivery_correction', args), correction);
  expect(repeated.data).toEqual({ cancelled: true });
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
});

it('replays a saved gateway delivery with its original approval and identity', async () => {
  const payload = { idempotencyKey: 'delivery-key', approvalId: 'approval-1', roundStopId: 'stop-1' };
  const recordDelivery = vi.fn().mockRejectedValueOnce(new TypeError('Load failed')).mockResolvedValue({ delivery_event_id: 'confirmed' });
  const key = JSON.stringify({ kind: 'gateway', operation: 'delivery', payload });
  await expect(runOnlineOnlyEmployeeWrite(() => recordDelivery(payload), key)).rejects.toThrow('Load failed');
  await offlineStore().close();
  await expect(retryPendingOnlineWrite('employee-1', { recordDelivery } as unknown as EmployeeDeliveryGateway)).resolves.toEqual({ delivery_event_id: 'confirmed' });
  expect(recordDelivery).toHaveBeenNthCalledWith(2, payload);
  expect(await offlineStore().hasPending()).toBe(false);
});

it('keeps the guard on a second transport failure and lets the same recovery button retry', async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: 'Upstream unavailable' }, status: 502 });
  await runOnlineOnlyEmployeeWrite(() => mocks.rpc('apply_open_delivery_correction', args), correction);
  const onResolved = vi.fn();
  render(<OnlineWriteRecovery owner="employee-1" live={live} onResolved={onResolved} />);
  fireEvent.click(await screen.findByRole('button', { name: 'ตรวจสอบรายการเดิมและโหลดข้อมูลใหม่' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(onResolved).not.toHaveBeenCalled();
  expect(await offlineStore().hasPending()).toBe(true);
  mocks.rpc.mockResolvedValue({ data: { cancelled: true }, error: null });
  await waitFor(() => expect(screen.getByRole('button', { name: 'ตรวจสอบรายการเดิมและโหลดข้อมูลใหม่' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'ตรวจสอบรายการเดิมและโหลดข้อมูลใหม่' }));
  await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
});

it('refuses recovery for another account, including a session change after rendering', async () => {
  await offlineStore().beginOnlineWrite('pending', correction, 'employee-1');
  expect(await hasUnsentWork('employee-1')).toBe(true);
  expect(await hasUnsentWork('employee-2')).toBe(false); // Can sign out to return to the owner.
  await expect(retryPendingOnlineWrite('employee-2', live)).rejects.toThrow('เจ้าของรายการ');
  mocks.owner = 'employee-2';
  await expect(retryPendingOnlineWrite('employee-1', live)).rejects.toThrow('รายการเดิม');
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(await offlineStore().hasPending()).toBe(true);
});

it('rejects a stored request outside the explicit recovery allowlist', async () => {
  await offlineStore().beginOnlineWrite('pending', JSON.stringify({ kind: 'rpc', rpc: 'unrelated_admin_write', args: {} }), 'employee-1');
  await expect(retryPendingOnlineWrite('employee-1', live)).rejects.toThrow('ไม่พบรายการเดิม');
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(await offlineStore().hasPending()).toBe(true);
});
