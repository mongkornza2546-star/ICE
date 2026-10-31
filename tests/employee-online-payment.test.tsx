import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { offlineSnapshot } from './helpers/offlineSnapshot';
import { OfflineEngine, type SyncResponse } from '../src/offline/runtime/engine';
import { WorkStore } from '../src/offline/runtime/store';
import type { EmployeeRuntime } from '../src/offline/runtime/client';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), queue: vi.fn(), print: vi.fn(), android: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../src/lib/collectionQueue', () => ({ loadCurrentCollectionQueue: mocks.queue }));
vi.mock('../src/lib/salesDocumentPrint', () => ({ printSalesDocumentForCurrentPlatform: mocks.print }));
vi.mock('../src/lib/thermalPrinter', () => ({ isAndroidApp: mocks.android }));
import { FinancialOperations } from '../src/FinancialOperations';

let store: WorkStore;
let runtime: EmployeeRuntime;
let send: ReturnType<typeof vi.fn>;
const confirmed = {
  payment_id: 'payment-confirmed', receipt_number: 'REC-001', recorded_at: '2026-10-29T02:00:01Z',
  received_amount: 100, allocated_amount: 75, change_amount: 25,
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-29T02:00:00Z');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  mocks.android.mockReturnValue(true);
  mocks.print.mockResolvedValue(true);
  mocks.rpc.mockResolvedValue({ error: null, data: {
    ...confirmed, shop_code: 'BB1', shop_name: 'ร้านทดสอบ', payment_method: 'cash',
    charges: [{ charge_number: 'INV-001', received_amount: 75,
      items: [{ ice_type_name: 'น้ำแข็ง', ice_type_unit: 'ถุง', quantity: 3, unit_price: 25, line_total: 75 }] }],
  } });
  const snapshot = offlineSnapshot();
  snapshot.collection.queue = [{
    shop_id: 'shop', shop_code: 'BB1', shop_name: 'ร้านทดสอบ', image_path: null,
    outstanding_amount: 75, charge_count: 1, has_new_charges: true,
    payment_profile: { allowed_payment_methods: ['cash'], default_payment_method: 'cash',
      cash_reference_required: false, cash_evidence_required: false, bank_transfer_reference_required: false,
      bank_transfer_evidence_required: false, qr_reference_required: false, qr_evidence_required: false },
    charges: [{ charge_id: 'charge', charge_number: 'INV-001', service_date: snapshot.serviceDate,
      original_amount: 75, outstanding_amount: 75, items: [] }],
  }];
  mocks.queue.mockResolvedValue(structuredClone(snapshot.collection));
  store = new WorkStore(new IDBFactory(), 'receipt-sync');
  send = vi.fn(async (): Promise<SyncResponse> => ({ status: 'applied', result: confirmed }));
  const engine = new OfflineEngine(snapshot.ownerId, snapshot.serviceDate, store, { send, resolutions: async () => [] });
  await engine.install(snapshot);
  runtime = { engine, snapshot: async () => engine.getSnapshot().snapshot, tick: vi.fn(async () => {}),
    prepare: vi.fn(async () => {}), start: () => () => {} };
});

afterEach(async () => {
  runtime.engine.dispose();
  await store.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function openPayment() {
  render(<FinancialOperations offlineRuntime={runtime} userRole="courier" serviceDate={runtime.engine.day} />);
  fireEvent.click(await screen.findByRole('button', { name: /BB1.*ร้านทดสอบ/ }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }), { target: { value: '100' } });
}

it('waits for confirmation and displays the official receipt without a temporary success screen', async () => {
  await openPayment();
  expect(screen.getByText('เลขที่บิล INV-001')).toBeTruthy();
  let release!: () => void;
  send.mockImplementation(async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return { status: 'applied', result: confirmed };
  });
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  expect(screen.queryByText('บันทึกลงเครื่องแล้ว · รอซิงก์')).toBeNull();
  expect(screen.queryByText('บันทึกรับเงินเรียบร้อย')).toBeNull();
  await act(async () => { release(); });
  await screen.findByText('บันทึกรับเงินเรียบร้อย');
  expect(screen.getByRole('button', { name: 'พิมพ์ใบเสร็จ' }).hasAttribute('disabled')).toBe(false);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ rpc: 'record_regular_collection_payment', args: expect.objectContaining({
    p_allocations: [{ charge_id: 'charge', amount: 75 }], p_received_amount: 100,
  }) }), expect.any(AbortSignal));
  expect(await store.commands(runtime.engine.owner)).toHaveLength(1);
  expect(runtime.engine.getSnapshot().commands[0].status).toBe('applied');
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it('retains a lost payment response for automatic retry and then displays the confirmed receipt', async () => {
  await openPayment();
  send.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({ status: 'applied', result: confirmed });
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));
  await screen.findByText('บันทึกลงเครื่องแล้ว · รอซิงก์');
  const original = send.mock.calls[0][0];
  vi.setSystemTime(Date.now() + 16_000);
  await act(async () => { await runtime.engine.sync(); });
  await screen.findByText('บันทึกรับเงินเรียบร้อย');
  expect(send.mock.calls[1][0]).toMatchObject({ id: original.id, args: original.args });
  expect(await store.commands(runtime.engine.owner)).toHaveLength(1);
  expect(screen.queryByText('บันทึกลงเครื่องแล้ว · รอซิงก์')).toBeNull();
});

it('resolves the temporary bill in an open payment screen after the delivery is acknowledged', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const s = runtime.engine.getSnapshot().snapshot!;
  s.collection.queue[0].charges[0].charge_id = 'local:delivery-command';
  s.collection.queue[0].charges[0].charge_number = 'TMP-delivery-command';
  await store.install(s);
  await openPayment();
  expect(screen.getByText('เลขที่บิล TMP-delivery-command')).toBeTruthy();
  await act(async () => {
    await store.update({ id: 'delivery-command', ownerId: s.ownerId, serviceDate: s.serviceDate, deviceId: 'device', sequence: 0,
      type: 'delivery', rpc: 'record_delivery_with_vat_check', args: {}, expected: {}, recordedAt: s.preparedAt,
      status: 'applied', attempts: 1, nextAttemptAt: 0, label: 'delivery',
      result: { charge_id: 'charge', charge_number: 'INV-001', delivery_event_id: 'event' } });
    await runtime.engine.reload();
    const refreshed = structuredClone(runtime.engine.getSnapshot().snapshot!);
    delete refreshed.chargeAliases;
    await runtime.engine.install(refreshed);
  });
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));
  await screen.findByText('บันทึกรับเงินเรียบร้อย');
  expect(send.mock.calls[0][0].resolved.args.p_allocations).toEqual([{ charge_id: 'charge', amount: 75 }]);
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it.each(['live', 'reopened', 'expired'] as const)('resolves the handoff bill after acknowledgement with a %s snapshot', async state => {
  const snapshot = structuredClone(runtime.engine.getSnapshot().snapshot!);
  snapshot.collection.queue[0].charges[0].charge_id = 'local:delivery-command';
  await runtime.engine.install(snapshot);
  await store.update({ id: 'delivery-command', ownerId: snapshot.ownerId, serviceDate: snapshot.serviceDate,
    deviceId: 'device', sequence: 1, type: 'delivery', rpc: 'record_delivery_with_vat_check', args: {}, expected: {},
    recordedAt: snapshot.preparedAt, status: 'applied', attempts: 1, nextAttemptAt: 0, label: 'delivery',
    result: { charge_id: 'charge', charge_number: 'INV-001', delivery_event_id: 'event' } });
  await runtime.engine.reload();
  if (state === 'reopened') {
    const refreshed = structuredClone(runtime.engine.getSnapshot().snapshot!);
    delete refreshed.chargeAliases;
    await runtime.engine.install(refreshed);
    await store.close(); await runtime.engine.reload();
  } else if (state === 'expired') {
    await store.invalidate(snapshot.ownerId, snapshot.serviceDate);
    await runtime.engine.reload();
    runtime.snapshot = async () => undefined;
  }
  const onClose = vi.fn();
  render(<FinancialOperations offlineRuntime={runtime} userRole="courier" serviceDate={runtime.engine.day}
    onFocusedCollectionClose={onClose}
    focusRequest={{ requestId: 'handoff', source: 'delivery', shopId: 'shop',
      chargeId: 'local:delivery-command', returnContextId: 'return' }} />);
  await waitFor(() => {
    expect(screen.queryByText('ไม่พบยอดรายการส่งล่าสุดในคิวรับเงิน')).toBeNull();
    expect(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' })).toBeTruthy();
  });
  expect(screen.getByText('ยอดรายการส่งล่าสุด')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'handoff', status: 'cancelled' }));
});
