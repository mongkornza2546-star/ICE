import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';
import { EmployeeDeliveryWorkspace } from '../src/EmployeeDeliveryWorkspace';
import type { WorkCommand } from '../src/offline/runtime/types';
import { offlineSnapshot } from './helpers/offlineSnapshot';
import { createRealtimeSync } from '../src/lib/realtimeSync';
import { publishDataChange, subscribeToDataChange } from '../src/lib/dataChange';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), queue: vi.fn(), upload: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: {
  auth: { getSession: async () => ({ data: { session: { user: { id: '10000000-0000-4000-8000-000000000001' } } }, error: null }) },
  rpc: (...args: unknown[]) => Object.assign(Promise.resolve(mocks.rpc(...args)), { abortSignal() { return this; } }),
  channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: vi.fn(),
} }));
vi.mock('../src/lib/collectionQueue', () => ({ loadCurrentCollectionQueue: mocks.queue }));
vi.mock('../src/lib/paymentEvidence', () => ({ uploadPaymentEvidence: mocks.upload }));
let client: typeof import('../src/offline/runtime/client');
let remote: ReturnType<typeof offlineSnapshot>;
let cleanup: Array<() => void>;

beforeEach(async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-29T02:00:00Z');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  client = await import('../src/offline/runtime/client');
  remote = offlineSnapshot(); cleanup = [];
  mocks.rpc.mockReset().mockImplementation((name: string) => ({ error: null, data:
    name === 'get_employee_offline_capability' ? { version: 1, enabled: true, profile: remote.profile, validUntil: remote.validUntil, aggregate: remote.aggregate }
      : name === 'get_employee_offline_commands' ? [] : structuredClone(remote.contexts),
  }));
  mocks.queue.mockReset().mockImplementation(async () => structuredClone(remote.collection));
  mocks.upload.mockReset().mockRejectedValue(new TypeError('Failed to fetch'));
});
afterEach(async () => {
  cleanup.reverse().forEach(stop => stop());
  await client.offlineStore().close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function setRemoteStock(quantity: number) {
  remote.contexts.stop.items[0].stock_quantity = quantity;
  remote.stocks.round.holding_location.balances[0].quantity = quantity;
}
async function setup() {
  const live = {
    loadReferenceData: vi.fn(async () => ({ rounds: remote.rounds, iceTypes: remote.iceTypes })),
    loadShopCards: vi.fn(async (roundId: string) => structuredClone(remote.cards[roundId] ?? [])),
    loadEmployeeStockState: vi.fn(async () => structuredClone(remote.stocks.round)),
    loadDeliveryPosContext: vi.fn(async () => structuredClone(remote.contexts.stop)),
    invalidateDeliveryPosContextCache: vi.fn(),
  } as unknown as EmployeeDeliveryGateway;
  const runtime = client.createEmployeeRuntime(remote.ownerId, remote.serviceDate, live);
  await runtime.prepare(true);
  const { createOfflineGateway } = await import('../src/offline/runtime/gateway');
  const gateway = createOfflineGateway(live, runtime);
  return { runtime, gateway, live };
}
const options = { destinationKind: 'regular' as const, serviceDate: '2026-10-29', forceRefresh: true };

it('rechecks a cached delivery before sending and allows correcting insufficient stock without a queued conflict', async () => {
  setRemoteStock(18);
  const { gateway, runtime, live } = await setup();
  vi.mocked(live.loadDeliveryPosContext!).mockRejectedValueOnce(new TypeError('Failed to fetch'));
  expect((await gateway.loadDeliveryPosContext!('stop', options)).offline_snapshot).toBe(true);
  setRemoteStock(3.5);
  live.recordDelivery = vi.fn(async () => ({ delivery_event_id: 'confirmed' }) as never);
  const payload = { destinationKind: 'regular' as const, roundStopId: 'stop', items: [{ ice_type_id: 'ice', quantity: 5 }],
    status: 'delivered' as const, note: null, clientRecordedAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(),
    paymentTerm: 'end_of_day' as const, expectedTotal: 125, expectedVatRate: 0 };
  await expect(gateway.recordDelivery(payload)).rejects.toMatchObject({ stockRejectedBeforeCommit: true, message: expect.stringContaining('3.5') });
  expect(live.recordDelivery).not.toHaveBeenCalled();
  expect(await runtime.engine.store.commands(remote.ownerId)).toEqual([]);
  expect(await runtime.engine.store.hasPending()).toBe(false);
  await gateway.recordDelivery({ ...payload, idempotencyKey: crypto.randomUUID(), items: [{ ice_type_id: 'ice', quantity: 3 }], expectedTotal: 75 });
  expect(live.recordDelivery).toHaveBeenCalledTimes(1);
});

it('rejects an immediate sale against fresh stock before recording delivery or payment', async () => {
  setRemoteStock(18);
  const { gateway, runtime, live } = await setup();
  vi.mocked(live.loadDeliveryPosContext!).mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await gateway.loadDeliveryPosContext!('stop', options);
  setRemoteStock(3.5);
  live.recordImmediateSale = vi.fn();
  await expect(gateway.recordImmediateSale!({ roundStopId: 'stop', items: [{ ice_type_id: 'ice', quantity: 5 }],
    note: null, clientRecordedAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(),
    paymentMethod: 'cash', receivedAmount: 125, expectedTotal: 125, referenceNumber: null, evidencePath: null }))
    .rejects.toMatchObject({ stockRejectedBeforeCommit: true, message: expect.stringContaining('3.5') });
  expect(live.recordImmediateSale).not.toHaveBeenCalled();
  expect(await runtime.engine.store.commands(remote.ownerId)).toEqual([]);
  expect(await runtime.engine.store.hasPending()).toBe(false);
});

it.each(['stock_transfer', 'stock_return', 'stock_damage'] as const)('checks latest source before a cached %s without queuing insufficient stock', async operation => {
  const { gateway, runtime, live } = await setup();
  vi.mocked(live.loadEmployeeStockState).mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await gateway.loadEmployeeStockState('round');
  setRemoteStock(3.5); remote.stocks.round.truck_location.balances[0].quantity = 3.5;
  const method = operation === 'stock_transfer' ? 'recordEmployeeStockTransfer'
    : operation === 'stock_return' ? 'recordEmployeeStockReturn' : 'recordEmployeeStockDamage';
  live[method] = vi.fn();
  await expect(gateway[method]({ roundId: 'round', items: [{ ice_type_id: 'ice', quantity: 5 }], idempotencyKey: crypto.randomUUID() }))
    .rejects.toMatchObject({ stockRejectedBeforeCommit: true });
  expect(live[method]).not.toHaveBeenCalled();
  expect(await runtime.engine.store.hasPending()).toBe(false);
});

it('returns a definitive concurrent stock rejection for editing, but replays an uncertain write before checking remaining stock', async () => {
  const { gateway, runtime, live } = await setup();
  live.recordDelivery = vi.fn().mockRejectedValueOnce({ code: 'P0001', message: 'Employee holding does not have enough stock' });
  const payload = { destinationKind: 'regular' as const, roundStopId: 'stop', items: [{ ice_type_id: 'ice', quantity: 5 }],
    status: 'delivered' as const, note: null, clientRecordedAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(),
    paymentTerm: 'end_of_day' as const, expectedTotal: 125, expectedVatRate: 0 };
  await expect(gateway.recordDelivery(payload)).rejects.toMatchObject({ stockRejectedBeforeCommit: true });
  expect(await runtime.engine.store.hasPending()).toBe(false);
  vi.mocked(live.recordDelivery).mockRejectedValueOnce(new TypeError('Load failed'));
  await expect(gateway.recordDelivery(payload)).rejects.toThrow('Load failed');
  expect(await runtime.engine.store.hasOnlineWrite()).toBe(true);
  setRemoteStock(0);
  const reads = vi.mocked(live.loadDeliveryPosContext!).mock.calls.length;
  vi.mocked(live.recordDelivery).mockResolvedValueOnce({ delivery_event_id: 'already-committed' } as never);
  expect(await gateway.recordDelivery(payload)).toMatchObject({ delivery_event_id: 'already-committed' });
  expect(vi.mocked(live.loadDeliveryPosContext!).mock.calls.length).toBe(reads);
  expect(vi.mocked(live.recordDelivery).mock.calls[2][0]).toEqual(payload);
  expect(await runtime.engine.store.hasPending()).toBe(false);
});

it('reads POS while full preparation is stalled and receiving more changes', async () => {
  const { runtime, gateway } = await setup(); cleanup.push(runtime.start()); await runtime.tick();
  let release!: () => void;
  mocks.queue.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return remote.collection; });
  const background = runtime.prepare(true);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  setRemoteStock(0);
  let quantity: number | undefined;
  const read = gateway.loadDeliveryPosContext!('stop', options).then(context => { quantity = context.items[0].stock_quantity; });
  try {
    for (let i = 0; i < 4; i++) publishDataChange(['payment'], [{ table: 'payments', eventType: 'INSERT', serviceDate: '2020-01-01' }]);
    await vi.waitFor(() => expect(quantity).toBe(0));
  } finally { release(); await background; await read; }
});

it('reads current POS even when the collection queue is unavailable', async () => {
  const { gateway } = await setup(); setRemoteStock(0);
  mocks.queue.mockRejectedValue(new Error('Collection queue unavailable'));
  expect((await gateway.loadDeliveryPosContext!('stop', options)).items[0].stock_quantity).toBe(0);
});

it('bounds background retries under continuous relevant events and catches up on a later tick', async () => {
  const { runtime, gateway } = await setup(); cleanup.push(runtime.start()); await runtime.tick();
  setRemoteStock(0);
  let attempts = 0;
  mocks.queue.mockImplementation(async () => {
    attempts++;
    publishDataChange(['stock'], [{ table: 'stock_movements', eventType: 'INSERT', serviceDate: remote.serviceDate }]);
    return remote.collection;
  });
  await runtime.prepare(true);
  expect(attempts).toBe(2);
  expect(runtime.engine.getSnapshot().snapshot!.contexts.stop.items[0].stock_quantity).toBe(10);
  expect((await gateway.loadDeliveryPosContext!('stop', options)).items[0].stock_quantity).toBe(0);
  mocks.queue.mockResolvedValue(remote.collection);
  vi.setSystemTime(Date.now() + 15_000); await runtime.tick();
  expect(runtime.engine.getSnapshot().snapshot!.contexts.stop.items[0].stock_quantity).toBe(0);
});

it('uses the guarded live writer after reading newly received stock without validating against the old offline balance', async () => {
  const { gateway, runtime, live } = await setup(); setRemoteStock(25);
  const result = { delivery_event_id: 'confirmed-sale' };
  live.recordDelivery = vi.fn(async () => result as never);
  mocks.queue.mockRejectedValue(new Error('Collection queue unavailable'));
  expect((await gateway.loadDeliveryPosContext!('stop', options)).items[0].stock_quantity).toBe(25);
  const payload = { destinationKind: 'regular' as const, roundStopId: 'stop', items: [{ ice_type_id: 'ice', quantity: 20 }],
    status: 'delivered' as const, note: null, clientRecordedAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(),
    paymentTerm: 'end_of_day' as const, expectedTotal: 500, expectedVatRate: 0 };
  expect(await gateway.recordDelivery(payload)).toEqual(result);
  await runtime.prepare(true);
  expect(await gateway.recordDelivery(payload)).toEqual(result);
  expect(live.recordDelivery).toHaveBeenCalledTimes(1);
  expect(await runtime.engine.store.commands(remote.ownerId)).toHaveLength(0);
});

it.each(['recordEmployeeStockTransfer', 'recordEmployeeStockReturn', 'recordEmployeeStockDamage'] as const)(
  'uses the guarded live %s writer for live holding/truck reads', async method => {
    const { gateway, runtime, live } = await setup(); setRemoteStock(25);
    live[method] = vi.fn(async () => remote.stocks.round);
    await gateway.loadEmployeeStockState('round');
    const payload = { roundId: 'round', items: [{ ice_type_id: 'ice', quantity: 20 }], idempotencyKey: crypto.randomUUID() };
    await gateway[method](payload); await runtime.prepare(true);
    await gateway[method](payload);
    expect(live[method]).toHaveBeenCalledTimes(1);
    expect(await runtime.engine.store.commands(remote.ownerId)).toHaveLength(0);
  },
);

it('keeps uploaded evidence in the durable live-sale payload across retries', async () => {
  const { gateway, runtime, live } = await setup(); setRemoteStock(25);
  live.uploadPaymentEvidence = vi.fn(async () => 'evidence/receipt.jpg');
  live.recordImmediateSale = vi.fn().mockResolvedValue({ receipt_number: 'R-1' });
  await gateway.loadDeliveryPosContext!('stop', options);
  const id = crypto.randomUUID();
  const evidencePath = await gateway.uploadPaymentEvidence!(new File(['receipt'], 'receipt.jpg'), id);
  expect(evidencePath).toBe('evidence/receipt.jpg');
  const payload = { roundStopId: 'stop', items: [{ ice_type_id: 'ice', quantity: 20 }],
    note: null, clientRecordedAt: new Date().toISOString(), idempotencyKey: id, paymentMethod: 'cash' as const,
    expectedTotal: 500, receivedAmount: 500, referenceNumber: null, evidencePath };
  await gateway.recordImmediateSale!(payload); await runtime.prepare(true);
  await gateway.recordImmediateSale!(payload);
  expect(live.recordImmediateSale).toHaveBeenCalledExactlyOnceWith(payload);
  expect(await runtime.engine.store.commands(remote.ownerId)).toHaveLength(0);
});

it('retains evidence locally when an upload loses connectivity after a live POS read', async () => {
  remote.contexts.stop.payment_profile = {
    allowed_payment_terms: ['immediate'], default_payment_term: 'immediate',
    allowed_payment_methods: ['cash'], default_payment_method: 'cash',
    cash_reference_required: false, cash_evidence_required: true,
    bank_transfer_reference_required: false, bank_transfer_evidence_required: false,
    qr_reference_required: false, qr_evidence_required: false, allow_outstanding: false,
    credit_due_rule: null, credit_days: null, credit_collection_weekday: null,
    credit_limit: null, credit_exposure: 0, credit_remaining: null, credit_suspended: false,
  };
  const { gateway, runtime, live } = await setup();
  live.uploadPaymentEvidence = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  await gateway.loadDeliveryPosContext!('stop', options);
  const id = crypto.randomUUID();
  const evidencePath = await gateway.uploadPaymentEvidence!(new File(['receipt'], 'receipt.jpg'), id);
  expect(evidencePath).toBe(`offline:${id}`);
  // The subsequent write must stay on the offline path even though onLine is true.
  mocks.rpc.mockResolvedValue({ data: null, error: new TypeError('Failed to fetch') });
  await gateway.recordImmediateSale!({ roundStopId: 'stop', items: [{ ice_type_id: 'ice', quantity: 1 }],
    note: null, clientRecordedAt: new Date().toISOString(), idempotencyKey: id,
    paymentMethod: 'cash', receivedAmount: 25, expectedTotal: 25, referenceNumber: null, evidencePath });
  const command = (await runtime.engine.store.commands(remote.ownerId))[0];
  expect(command.id).toBe(id);
  expect(command.status).toBe('retry_wait');
  expect(command.evidenceData?.bytes.byteLength).toBe(7);
});

it('keeps projected balances when a pending sale exists instead of mixing live stock into the queue', async () => {
  const { gateway, runtime, live } = await setup();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const payload = { destinationKind: 'regular' as const, roundStopId: 'stop', items: [{ ice_type_id: 'ice', quantity: 1 }],
    status: 'delivered' as const, note: null, clientRecordedAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(),
    paymentTerm: 'end_of_day' as const, expectedTotal: 25, expectedVatRate: 0 };
  await gateway.recordDelivery(payload);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true); setRemoteStock(0);
  const context = await gateway.loadDeliveryPosContext!('stop', options);
  expect(context.offline_snapshot).toBe(true);
  expect(context.items[0].stock_quantity).toBe(9);
  expect(live.loadDeliveryPosContext).not.toHaveBeenCalled();
  expect((await runtime.engine.store.commands(remote.ownerId))[0].id).toBe(payload.idempotencyKey);
});

it('queues a delivery on transport failure while navigator still says online', async () => {
  const { gateway, runtime, live } = await setup();
  vi.mocked(live.loadDeliveryPosContext!).mockRejectedValue(new TypeError('Failed to fetch'));
  mocks.rpc.mockResolvedValue({ data: null, error: new TypeError('Failed to fetch') });
  const context = await gateway.loadDeliveryPosContext!('stop', options);
  expect(context.offline_snapshot).toBe(true);
  const id = crypto.randomUUID();
  const payload = { destinationKind: 'regular' as const, roundStopId: 'stop', items: [{ ice_type_id: 'ice', quantity: 1 }],
    status: 'delivered' as const, note: null, clientRecordedAt: new Date().toISOString(), idempotencyKey: id,
    paymentTerm: 'end_of_day' as const, expectedTotal: 25, expectedVatRate: 0 };
  await expect(gateway.recordDelivery(payload)).resolves.toMatchObject({ offline_pending: true });
  await expect(gateway.recordDelivery(payload)).resolves.toMatchObject({ offline_pending: true });
  expect(await runtime.engine.store.commands(remote.ownerId)).toEqual([expect.objectContaining({ id, status: 'retry_wait' })]);
  expect(runtime.engine.getSnapshot().snapshot!.contexts.stop.items[0].stock_quantity).toBe(9);
  await runtime.tick();
});

it('reads current POS and holdings immediately, then installs the offline snapshot separately', async () => {
  setRemoteStock(23); const { gateway, runtime } = await setup();
  setRemoteStock(0);
  expect((await gateway.loadDeliveryPosContext!('stop', options)).items[0].stock_quantity).toBe(0);
  expect((await gateway.loadEmployeeStockState('round')).holding_location.balances[0].quantity).toBe(0);
  await runtime.prepare(true);
  expect(runtime.engine.getSnapshot().snapshot!.contexts.stop.items[0].stock_quantity).toBe(0);
});

it('updates the prepared snapshot through a real Realtime callback without refreshing itself forever', async () => {
  setRemoteStock(23); const { runtime, gateway } = await setup();
  cleanup.push(runtime.start()); await runtime.tick();
  const before = mocks.rpc.mock.calls.length;
  const handlers = new Map<string, (payload: unknown) => void>();
  const channel = { on: (_: string, filter: { table: string }, callback: (payload: unknown) => void) => {
    handlers.set(filter.table, callback); return channel;
  }, subscribe() { return this; } };
  cleanup.push(createRealtimeSync({ channel: () => channel, removeChannel: vi.fn() } as unknown as SupabaseClient,
    undefined, { debounceMs: 0, enableFocusCatchup: false }));
  let displayed = 23;
  const refreshes: Promise<unknown>[] = [];
  cleanup.push(subscribeToDataChange(['stock'], detail => {
    // Same invalidation/read path as EmployeeDeliveryWorkspace.
    const fromSnapshot = detail.source === 'offline-snapshot';
    if (!fromSnapshot) gateway.invalidateDeliveryPosContextCache?.();
    refreshes.push(gateway.loadDeliveryPosContext!('stop', { ...options, forceRefresh: !fromSnapshot })
      .then(context => { displayed = context.items[0].stock_quantity; }));
  }));
  setRemoteStock(0);
  handlers.get('stock_movements')!({ eventType: 'INSERT', new: { id: 'remote-sale', service_date: remote.serviceDate } });
  await vi.waitFor(() => expect(displayed).toBe(0));
  await Promise.all(refreshes);
  vi.setSystemTime(Date.now() + 15_000);
  await runtime.tick();
  expect(runtime.engine.getSnapshot().snapshot!.contexts.stop.items[0].stock_quantity).toBe(0);
  // One capability + one context batch; installing it must not trigger another fetch.
  expect(mocks.rpc.mock.calls.length - before).toBe(2);
});

it('fetches again when a change arrives after stock was read but before installation', async () => {
  const { runtime, gateway } = await setup(); cleanup.push(runtime.start()); await runtime.tick();
  let release!: () => void;
  mocks.queue.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return remote.collection; });
  const background = runtime.prepare(true);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  setRemoteStock(2);
  publishDataChange(['stock'], [{ table: 'stock_movements', eventType: 'INSERT' }]);
  release();
  await background;
  expect((await gateway.loadDeliveryPosContext!('stop', options)).items[0].stock_quantity).toBe(2);
  expect(runtime.engine.getSnapshot().snapshot!.stocks.round.holding_location.balances[0].quantity).toBe(2);
});

it('explains conflicts without replacing the projection or discarding the original command', async () => {
  const { runtime, gateway } = await setup();
  const command: WorkCommand = { id: 'conflicting-sale', ownerId: remote.ownerId, serviceDate: remote.serviceDate,
    deviceId: 'device', sequence: 1, type: 'delivery', rpc: 'record_delivery_with_vat_check', args: {}, expected: {},
    status: 'conflict', label: 'BB29', recordedAt: remote.preparedAt, attempts: 1, nextAttemptAt: 0, error: 'Not enough stock' };
  await runtime.engine.store.update(command); setRemoteStock(0);
  await expect(gateway.loadDeliveryPosContext!('stop', options)).rejects.toThrow('รายการค้าง');
  expect((await runtime.engine.store.commands(remote.ownerId))[0]).toEqual(command);
  expect((await runtime.engine.store.read(remote.ownerId, remote.serviceDate))!.snapshot.contexts.stop.items[0].stock_quantity).toBe(10);
  await runtime.engine.store.update({ ...command, status: 'applied' });
  expect((await gateway.loadDeliveryPosContext!('stop', options)).items[0].stock_quantity).toBe(0);
});

it('reads confirmed holdings during a conflict without changing the queued command or projection', async () => {
  const { runtime, gateway, live } = await setup();
  const command: WorkCommand = { id: 'bb29', ownerId: remote.ownerId, serviceDate: remote.serviceDate,
    deviceId: 'device', sequence: 1, type: 'delivery', rpc: 'record_delivery_with_vat_check', args: {}, expected: {},
    status: 'conflict', label: 'BB29', recordedAt: remote.preparedAt, attempts: 1, nextAttemptAt: 0,
    error: 'Employee holding does not have enough stock' };
  await runtime.engine.store.update(command); setRemoteStock(3.5);
  expect((await gateway.loadReferenceData(remote.serviceDate)).rounds).toEqual(remote.rounds);
  const state = await gateway.loadEmployeeStockState('round');
  expect(state.holding_location.balances[0].quantity).toBe(3.5);
  expect(state.sync_pending).toBe(true);
  expect(state.offline_pending).toBe(false);
  expect((await runtime.engine.store.commands(remote.ownerId))[0]).toEqual(command);
  expect((await runtime.engine.store.read(remote.ownerId, remote.serviceDate))!.snapshot.stocks.round.holding_location.balances[0].quantity).toBe(10);
  live.recordEmployeeStockReturn = vi.fn();
  await expect(gateway.recordEmployeeStockReturn({ roundId: 'round', items: [{ ice_type_id: 'ice', quantity: 1 }],
    idempotencyKey: crypto.randomUUID() })).rejects.toThrow('ค้าง');
  expect(live.recordEmployeeStockReturn).not.toHaveBeenCalled();
});

it('shows confirmed holdings for an unacknowledged sale but prevents new stock writes against them', async () => {
  const { runtime, gateway, live } = await setup();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  await gateway.recordDelivery({ destinationKind: 'regular', roundStopId: 'stop', items: [{ ice_type_id: 'ice', quantity: 1 }],
    status: 'delivered', note: null, clientRecordedAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(),
    paymentTerm: 'end_of_day', expectedTotal: 25, expectedVatRate: 0 });
  await runtime.tick();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  setRemoteStock(3.5);
  expect((await gateway.loadEmployeeStockState('round')).holding_location.balances[0].quantity).toBe(3.5);
  const before = await runtime.engine.store.commands(remote.ownerId);
  live.recordEmployeeStockReturn = vi.fn();
  // Starting another refresh must not remove the fence on the visible live balance.
  let finishRead!: () => void;
  vi.mocked(live.loadEmployeeStockState).mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { finishRead = resolve; });
    return remote.stocks.round;
  });
  const refreshing = gateway.loadEmployeeStockState('round');
  try {
    await expect(gateway.recordEmployeeStockReturn({ roundId: 'round', items: [{ ice_type_id: 'ice', quantity: 1 }],
      idempotencyKey: crypto.randomUUID() })).rejects.toThrow('ค้าง');
    expect(await runtime.engine.store.commands(remote.ownerId)).toEqual(before);
    expect(live.recordEmployeeStockReturn).not.toHaveBeenCalled();
    expect(runtime.engine.getSnapshot().snapshot!.stocks.round.holding_location.balances[0].quantity).toBe(9);
  } finally { finishRead(); await refreshing; }
});

it('marks fallback holdings as local and never hides a live authorization error with cached stock', async () => {
  const { gateway, live } = await setup();
  vi.mocked(live.loadEmployeeStockState).mockRejectedValueOnce(new TypeError('Failed to fetch'));
  expect(await gateway.loadEmployeeStockState('round')).toMatchObject({ offline_pending: true });
  vi.mocked(live.loadEmployeeStockState).mockRejectedValueOnce({ code: '42501', message: 'Permission denied' });
  await expect(gateway.loadEmployeeStockState('round')).rejects.toMatchObject({ code: '42501' });
});

it('refreshes visible holdings during a conflict and unlocks only after the server approves discard', async () => {
  remote.iceTypes = [{ id: 'ice', code: 'I', name: 'น้ำแข็ง', unit: 'ถุง' }];
  setRemoteStock(18);
  const { gateway, runtime } = await setup();
  const form = render(<EmployeeDeliveryWorkspace gateway={gateway} enableAssignedStockFlow viewMode="withdrawal"
    requestScope="conflicting-stock-refresh" serviceDate={remote.serviceDate} />);
  cleanup.push(() => form.unmount());
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'คืนขึ้นรถ' }));
  await screen.findByText('เหลือที่ถือ 18 ถุง');
  const command: WorkCommand = { id: 'bb29', ownerId: remote.ownerId, serviceDate: remote.serviceDate,
    deviceId: 'device', sequence: 1, type: 'delivery', rpc: 'record_delivery_with_vat_check', args: {}, expected: {},
    status: 'conflict', label: 'BB29', recordedAt: remote.preparedAt, attempts: 1, nextAttemptAt: 0 };
  await act(async () => {
    await runtime.engine.store.update(command); setRemoteStock(3.5);
    publishDataChange(['stock']);
  });
  await screen.findByText('เหลือที่ถือ 3.5 ถุง');
  expect((screen.getByRole('button', { name: /บันทึกคืนขึ้นรถ/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/ยอดล่าสุดจากระบบ ยังไม่รวมรายการที่รอซิงก์/)).toBeTruthy();
  mocks.rpc.mockImplementation((name: string) => ({ error: null, data: name === 'get_employee_offline_commands'
    ? [{ id: command.id, status: 'discard_approved' }]
    : name === 'get_employee_offline_capability'
      ? { version: 1, enabled: true, profile: remote.profile, validUntil: remote.validUntil, aggregate: remote.aggregate }
      : remote.contexts }));
  await act(async () => { await runtime.engine.sync(true); await runtime.prepare(true); });
  await vi.waitFor(() => expect((screen.getByRole('button', { name: /บันทึกคืนขึ้นรถ/ }) as HTMLButtonElement).disabled).toBe(false));
  expect((await runtime.engine.store.commands(remote.ownerId))[0].status).toBe('discard_approved');
});

it('does not use cached POS to bypass a live authorization error, and recovers on retry', async () => {
  const { gateway, live } = await setup();
  vi.mocked(live.loadDeliveryPosContext!).mockRejectedValueOnce({ code: '42501', message: 'Permission denied' });
  await expect(gateway.loadDeliveryPosContext!('stop', options)).rejects.toMatchObject({ code: '42501' });
  setRemoteStock(3);
  expect((await gateway.loadDeliveryPosContext!('stop', options)).items[0].stock_quantity).toBe(3);
});

it('keeps prepared offline reads usable without sending a network request', async () => {
  const { gateway } = await setup(); const before = mocks.rpc.mock.calls.length;
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false); setRemoteStock(0);
  expect((await gateway.loadDeliveryPosContext!('stop', options)).items[0].stock_quantity).toBe(10);
  expect(mocks.rpc.mock.calls).toHaveLength(before);
});

it('falls back to live reads when the server revokes offline capability and there is no queued work', async () => {
  const { gateway, runtime, live } = await setup(); setRemoteStock(0);
  mocks.rpc.mockResolvedValue({ error: null, data: { version: 1, enabled: false } });
  await runtime.prepare(true);
  expect((await gateway.loadDeliveryPosContext!('stop', options)).items[0].stock_quantity).toBe(0);
  expect(live.loadDeliveryPosContext).toHaveBeenCalled();
  expect(Date.parse(runtime.engine.getSnapshot().snapshot!.validUntil)).toBe(0);
  await runtime.prepare();
});

it('refreshes the visible POS through the offline gateway without restarting preparation', async () => {
  remote.iceTypes = [{ id: 'ice', code: 'I', name: 'น้ำแข็ง', unit: 'ถุง' }];
  remote.contexts.stop.items[0].unit = 'ถุง';
  remote.cards.round = [{ round_stop_id: 'stop', shop_id: 'shop', shop_code: 'BB29', shop_name: 'ร้านทดสอบ',
    building_id: 'building', building_name: 'B', floor_or_zone: '1', sequence_no: 1,
    image_path: null, image_url: null, payment_status: 'unpaid', stop_status: 'pending', stop_note: null,
    today_history: [], today_totals: {} }];
  setRemoteStock(23);
  const { gateway, runtime } = await setup(); cleanup.push(runtime.start()); await runtime.tick();
  const form = render(<EmployeeDeliveryWorkspace gateway={gateway} requestScope="offline-visible-stock" serviceDate={remote.serviceDate} />);
  cleanup.push(() => form.unmount());
  await userEvent.setup().click(await screen.findByRole('button', { name: /^เลือกร้าน / }));
  await screen.findByText('คงเหลือ 23 ถุง');
  const before = mocks.rpc.mock.calls.length;
  setRemoteStock(0);
  await act(async () => {
    publishDataChange(['stock'], [{ table: 'stock_movements', eventType: 'INSERT' }]);
    await runtime.prepare(true);
  });
  await screen.findByText('คงเหลือ 0 ถุง');
  expect(mocks.rpc.mock.calls.length - before).toBe(2);
});
