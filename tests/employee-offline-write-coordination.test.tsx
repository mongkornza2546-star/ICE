import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { offlineSnapshot } from './helpers/offlineSnapshot';
import type { EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), queue: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => Object.assign(Promise.resolve(mocks.rpc(...args)), { abortSignal() { return this; } }) } }));
vi.mock('../src/lib/collectionQueue', () => ({ loadCurrentCollectionQueue: mocks.queue }));
let client: typeof import('../src/offline/runtime/client');
beforeEach(async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-29T02:00:00Z');
  client = await import('../src/offline/runtime/client');
  const s = offlineSnapshot();
  mocks.rpc.mockImplementation((name: string) => ({ error: null, data: name === 'get_employee_offline_capability'
    ? { version: 1, enabled: true, profile: s.profile, validUntil: s.validUntil, aggregate: s.aggregate } : s.contexts }));
  mocks.queue.mockResolvedValue(s.collection);
});
afterEach(async () => { await client.offlineStore().close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup() {
  const s = offlineSnapshot();
  const live = { loadReferenceData: vi.fn(async () => ({ rounds: s.rounds, iceTypes: s.iceTypes })),
    loadShopCards: vi.fn(async () => []), loadEmployeeStockState: vi.fn(async () => structuredClone(s.stocks.round)),
    recordDelivery: vi.fn(async (_payload: unknown) => undefined) };
  return { s, live, runtime: client.createEmployeeRuntime(s.ownerId, s.serviceDate, live as unknown as EmployeeDeliveryGateway) };
}
it.each(['missing', 'expired'] as const)('explains %s preparation without starting a POS network read in airplane mode', async state => {
  const { s, live, runtime: r } = setup();
  if (state === 'expired') {
    s.validUntil = '2026-10-28T17:00:00Z';
    await r.engine.install(s);
  }
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const loadDeliveryPosContext = vi.fn(async () => s.contexts.stop);
  const { createOfflineGateway } = await import('../src/offline/runtime/gateway');
  const gateway = createOfflineGateway({ ...live, loadDeliveryPosContext } as unknown as EmployeeDeliveryGateway, r);
  await expect(gateway.loadDeliveryPosContext!('stop', { destinationKind: 'regular', serviceDate: s.serviceDate }))
    .rejects.toThrow('ข้อมูลออฟไลน์ของวันนี้ยังไม่พร้อม');
  expect(loadDeliveryPosContext).not.toHaveBeenCalled();
});
it('loads prepared prices and saves a delivery durably in airplane mode without a live request', async () => {
  const { s, live, runtime: r } = setup();
  await r.engine.install(s);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const loadDeliveryPosContext = vi.fn();
  const { createOfflineGateway } = await import('../src/offline/runtime/gateway');
  const gateway = createOfflineGateway({ ...live, loadDeliveryPosContext } as unknown as EmployeeDeliveryGateway, r);
  const context = await gateway.loadDeliveryPosContext!('stop', { destinationKind: 'regular', serviceDate: s.serviceDate });
  expect(context.items[0]).toMatchObject({ unit_price: 25, stock_quantity: 10 });
  await expect(gateway.recordDelivery({ roundStopId: 'stop', items: [{ ice_type_id: 'ice', quantity: 1 }], status: 'delivered', note: null,
    destinationKind: 'regular', clientRecordedAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(), paymentTerm: 'end_of_day', expectedTotal: 25 }))
    .resolves.toMatchObject({ offline_pending: true });
  expect(await client.offlineStore().commands(s.ownerId)).toHaveLength(1);
  expect((await client.offlineStore().read(s.ownerId, s.serviceDate))?.snapshot.contexts.stop.items[0].stock_quantity).toBe(9);
  expect(loadDeliveryPosContext).not.toHaveBeenCalled();
  expect(live.recordDelivery).not.toHaveBeenCalled();
});
it('rejects preparation fetched before a completed guarded online write', async () => {
  const { s, runtime: r } = setup();
  await r.engine.install(s);
  let release!: () => void;
  mocks.queue.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return s.collection; });
  const preparing = r.prepare(true);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  // All stock and contexts have been fetched, but final preparation is paused.
  await client.runOnlineOnlyEmployeeWrite(async () => { s.stocks.round.holding_location.balances[0].quantity = 0; }, 'completed-write');
  release(); await preparing;
  expect(Date.parse(r.engine.getSnapshot().snapshot!.validUntil)).toBe(0);
});
it('does not install a prepared projection while a cold online delivery is unresolved', async () => {
  const { s, live, runtime: r } = setup();
  let release!: () => void;
  live.recordDelivery.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); s.stocks.round.holding_location.balances[0].quantity = 0; });
  const { createOfflineGateway } = await import('../src/offline/runtime/gateway');
  const gateway = createOfflineGateway(live as unknown as EmployeeDeliveryGateway, r);
  const saving = gateway.recordDelivery({ roundStopId: 'stop', items: [{ ice_type_id: 'ice', quantity: 10 }], status: 'delivered', note: null,
    destinationKind: 'regular', clientRecordedAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(), paymentTerm: 'end_of_day', expectedTotal: 250 });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await r.prepare();
  const preparedDuringWrite = r.engine.getSnapshot().snapshot;
  release(); await saving;
  expect(preparedDuringWrite).toBeUndefined();
  await r.prepare();
  expect(r.engine.getSnapshot().snapshot?.stocks.round.holding_location.balances[0].quantity).toBe(0);
});
it('allows an approved online credit delivery to reach server validation', async () => {
  const { s, live, runtime: r } = setup();
  s.contexts.stop.payment_profile = { allowed_payment_terms: ['credit'], default_payment_term: 'credit',
    credit_suspended: false, credit_remaining: 0, credit_exposure: 100, vat_enabled: false } as NonNullable<typeof s.contexts.stop.payment_profile>;
  await r.engine.install(s);
  const { createOfflineGateway } = await import('../src/offline/runtime/gateway');
  const gateway = createOfflineGateway(live as unknown as EmployeeDeliveryGateway, r);
  await gateway.recordDelivery({ roundStopId: 'stop', items: [{ ice_type_id: 'ice', quantity: 1 }], status: 'delivered', note: null,
    destinationKind: 'regular', clientRecordedAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(), paymentTerm: 'credit', expectedTotal: 25,
    expectedVatRate: 0, approvalId: 'approved-credit-request' });
  expect(live.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({ approvalId: 'approved-credit-request' }));
  expect(r.engine.getSnapshot().commands).toHaveLength(0);
});
it('keeps unresolved online writes fenced after the UI deadline expires', async () => {
  const { s, runtime: r } = setup(); await r.engine.install(s);
  const network = await import('../src/offline/runtime/network');
  const withDeadline = network.withDeadline;
  vi.spyOn(network, 'withDeadline').mockImplementation(start => withDeadline(start, 20));
  let release!: () => void; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let actionFinished = false;
  const saving = client.runOnlineOnlyEmployeeWrite(async () => {
    started(); await new Promise<void>(resolve => { release = resolve; }); actionFinished = true;
  }, 'same-operation');
  const rejected = expect(saving).rejects.toMatchObject({ name: 'TimeoutError' });
  await entered; await rejected;
  const installedWhileUnresolved = await r.engine.install(s);
  expect(actionFinished).toBe(false); release();
  expect(installedWhileUnresolved).toBe(false);
  await vi.waitFor(() => expect(actionFinished).toBe(true));
  vi.setSystemTime('2026-10-29T02:02:00Z');
  await client.offlineStore().close();
  expect(await client.offlineStore().hasPending()).toBe(true);
  expect(await r.engine.install(s)).toBe(false);
  await expect(client.runOnlineOnlyEmployeeWrite(async () => {}, 'different-operation')).rejects.toThrow('รายการเดิม');
  await client.runOnlineOnlyEmployeeWrite(async () => ({ confirmed: true }), 'same-operation');
  expect(await r.engine.install(s)).toBe(true);
});

it.each(['throw', 'response', 'http-502'] as const)('preserves %s transport failures across restart and replays the original identity once', async mode => {
  const { s } = setup(); const store = client.offlineStore();
  await store.install(s); let writes = 0; let committed = false;
  const apply = () => { if (!committed) { committed = true; writes++; } };
  const saving = client.runOnlineOnlyEmployeeWrite(async () => {
    apply();
    if (mode === 'throw') throw new TypeError('Load failed');
    if (mode === 'http-502') return { data: null, error: { message: 'Upstream unavailable' }, status: 502 };
    return { data: null, error: { code: '', message: 'TypeError: Load failed' } };
  }, 'payment-original');
  if (mode === 'throw') await expect(saving).rejects.toThrow('Load failed'); else await saving;
  await store.close();
  expect(await store.hasPending()).toBe(true);
  await expect(store.preparationVersion(s.ownerId, s.serviceDate)).rejects.toThrow('รายการเดิม');
  await client.runOnlineOnlyEmployeeWrite(async () => { apply(); return { data: { receipt_number: 'REC-1' }, error: null }; }, 'payment-original');
  expect(writes).toBe(1);
  expect(await store.hasPending()).toBe(false);
});

it('does not let an older completion unlock an in-flight replay from another connection', async () => {
  const { s } = setup(); const store = client.offlineStore(); await store.install(s);
  const { WorkStore } = await import('../src/offline/runtime/store'); const other = new WorkStore();
  await store.beginOnlineWrite('first', 'same');
  await other.beginOnlineWrite('replay', 'same');
  await store.endOnlineWrite('first', { value: 'older response' });
  expect(await store.install(s)).toBe(false);
  expect(await store.onlineResult(undefined, 'same')).toBeUndefined();
  await other.endOnlineWrite('replay', { value: 'confirmed replay' }); await other.close();
  expect(await store.onlineResult(undefined, 'same')).toEqual({ value: 'confirmed replay' });
  expect(await store.install(s)).toBe(true);
});

it('invalidates cold preparation without advancing the device command sequence', async () => {
  const { s, runtime: r } = setup();
  const version = await r.engine.store.preparationVersion(s.ownerId, s.serviceDate);
  await client.runOnlineOnlyEmployeeWrite(async () => {}, 'cold-write');
  expect(await r.engine.install(s, version.sequence, version.revision)).toBe(false);
  const fresh = await r.engine.store.preparationVersion(s.ownerId, s.serviceDate);
  expect(fresh.sequence).toBe(0);
  expect(await r.engine.install(s, fresh.sequence, fresh.revision)).toBe(true);
});

it.each(['recordEmployeeStockTransfer', 'recordEmployeeStockReturn', 'recordEmployeeStockDamage', 'recordImmediateSale'] as const)('guards the cold %s path', async method => {
  const { s, live, runtime: r } = setup();
  vi.spyOn(r, 'snapshot').mockResolvedValue(undefined);
  const write = vi.fn(async () => {
    expect(await client.offlineStore().hasOnlineWrite()).toBe(true);
    expect(await r.engine.install(s)).toBe(false);
    return s.stocks.round;
  });
  const { createOfflineGateway } = await import('../src/offline/runtime/gateway');
  const gateway = createOfflineGateway({ ...live, [method]: write } as unknown as EmployeeDeliveryGateway, r);
  const identity = { idempotencyKey: crypto.randomUUID(), items: [{ ice_type_id: 'ice', quantity: 1 }] };
  if (method === 'recordImmediateSale') await gateway.recordImmediateSale!({ ...identity, roundStopId: 'stop', clientRecordedAt: new Date().toISOString(),
    note: null, paymentMethod: 'cash', receivedAmount: 25, expectedTotal: 25, referenceNumber: null, evidencePath: null });
  else await gateway[method]({ ...identity, roundId: 'round' });
  expect(write).toHaveBeenCalledTimes(1);
  expect(await client.offlineStore().hasOnlineWrite()).toBe(false);
});

it('keeps approval validation online and refuses to bypass pending local work', async () => {
  const { s, live, runtime: r } = setup(); await r.engine.install(s);
  const { createOfflineGateway } = await import('../src/offline/runtime/gateway');
  const gateway = createOfflineGateway(live as unknown as EmployeeDeliveryGateway, r);
  const payload = { destinationKind: 'regular' as const, roundStopId: 'stop', items: [{ ice_type_id: 'ice', quantity: 1 }],
    status: 'delivered' as const, note: null, clientRecordedAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(),
    paymentTerm: 'credit' as const, expectedTotal: 25, approvalId: 'approval' };
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  await expect(gateway.recordDelivery(payload)).rejects.toThrow('อินเทอร์เน็ต');
  await r.engine.enqueue({ id: crypto.randomUUID(), type: 'stock_transfer', rpc: 'record_employee_stock_transfer',
    args: { p_round_id: 'round', p_items: [{ ice_type_id: 'ice', quantity: 1 }] }, expected: {}, label: 'withdraw', recordedAt: new Date().toISOString() });
  online.mockReturnValue(true);
  await expect(gateway.recordDelivery(payload)).rejects.toThrow('ค้างซิงก์');
  expect(live.recordDelivery).not.toHaveBeenCalled();
});
