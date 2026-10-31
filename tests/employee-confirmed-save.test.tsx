import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { offlineSnapshot } from './helpers/offlineSnapshot';
import type { EmployeeDeliveryGateway, EmployeeDeliveryPayload } from '../src/EmployeeDeliveryWorkspace';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), queue: vi.fn(), session: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: {
  auth: { getSession: mocks.session },
  rpc: (...args: unknown[]) => Object.assign(Promise.resolve().then(() => mocks.rpc(...args)), { abortSignal() { return this; } }),
} }));
vi.mock('../src/lib/collectionQueue', () => ({ loadCurrentCollectionQueue: mocks.queue }));
let client: typeof import('../src/offline/runtime/client');
let online: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-29T02:00:00Z');
  online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  client = await import('../src/offline/runtime/client');
  mocks.session.mockResolvedValue({ data: { session: { user: { id: offlineSnapshot().ownerId } } }, error: null });
});
afterEach(async () => { await client.offlineStore().close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const result = { delivery_event_id: 'event-real', round_stop_id: 'stop', charge_id: 'charge-real', charge_number: 'INV-001',
  total_amount: 25, service_date: '2026-10-29', payment_term: 'end_of_day', payment_status: 'unpaid', due_date: null, approval_id: null };
function payload(): EmployeeDeliveryPayload {
  return { roundStopId: 'stop', items: [{ ice_type_id: 'ice', quantity: 1 }], status: 'delivered', note: null,
    destinationKind: 'regular', clientRecordedAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(),
    paymentTerm: 'end_of_day', expectedTotal: 25 };
}
async function setup() {
  const s = offlineSnapshot();
  s.contexts.stop.offline_collection_template = { queue_key: 'regular:shop', collection_scope: 'shop', destination_kind: 'regular',
    shop_id: 'shop', shop_code: 'S', shop_name: 'Shop', image_path: null, outstanding_amount: 0, charge_count: 0, has_new_charges: false, charges: [],
    payment_profile: { allowed_payment_methods: ['cash'], default_payment_method: 'cash', cash_reference_required: false, cash_evidence_required: false,
      bank_transfer_reference_required: false, bank_transfer_evidence_required: false, qr_reference_required: false, qr_evidence_required: false } };
  const live = { loadReferenceData: vi.fn(async () => ({ rounds: s.rounds, iceTypes: s.iceTypes })), loadShopCards: vi.fn(async () => []),
    loadEmployeeStockState: vi.fn(async () => s.stocks.round), recordDelivery: vi.fn(async () => result) };
  const runtime = client.createEmployeeRuntime(s.ownerId, s.serviceDate, live as unknown as EmployeeDeliveryGateway);
  await runtime.engine.install(s);
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'offline_record_delivery_with_vat_check') return { data: { status: 'applied', result }, error: null };
    throw new TypeError('Refresh unavailable');
  });
  const { createOfflineGateway } = await import('../src/offline/runtime/gateway');
  return { s, live, runtime, gateway: createOfflineGateway(live as unknown as EmployeeDeliveryGateway, runtime) };
}
it('waits for official confirmation and retains correct offline stock and bill after refresh fails', async () => {
  const { gateway, runtime, live, s } = await setup();
  let release!: () => void;
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name !== 'offline_record_delivery_with_vat_check') throw new TypeError('Refresh unavailable');
    await new Promise<void>(resolve => { release = resolve; });
    return { data: { status: 'applied', result }, error: null };
  });
  let finished = false;
  const saving = gateway.recordDelivery(payload()).then(value => { finished = true; return value; });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(finished).toBe(false);
  release(); expect(await saving).toEqual(result);
  await runtime.prepare(true);
  online.mockReturnValue(false);
  const stored = await runtime.snapshot();
  expect(stored?.contexts.stop.items[0].stock_quantity).toBe(9);
  expect(stored?.collection.queue[0].charges[0]).toMatchObject({ charge_id: 'charge-real', charge_number: 'INV-001' });
  await expect(gateway.recordDelivery(payload())).resolves.toMatchObject({ offline_pending: true });
  expect((await runtime.snapshot())?.contexts.stop.items[0].stock_quantity).toBe(8);
  expect(await client.offlineStore().hasOnlineWrite()).toBe(false);
  expect(live.recordDelivery).not.toHaveBeenCalled();
  expect(await client.offlineStore().commands(s.ownerId)).toHaveLength(2);
});
it('automatically retries a lost response with the same identity and projects the delivery only once', async () => {
  const { gateway, runtime } = await setup();
  const sent: string[] = []; const committed = new Set<string>();
  mocks.rpc.mockImplementation(async (name: string, args: { p_idempotency_key: string }) => {
    if (name !== 'offline_record_delivery_with_vat_check') throw new TypeError('Refresh unavailable');
    sent.push(args.p_idempotency_key); committed.add(args.p_idempotency_key);
    if (sent.length === 1) throw new TypeError('Failed to fetch');
    return { data: { status: 'applied', result }, error: null };
  });
  const request = payload();
  await expect(gateway.recordDelivery(request)).resolves.toMatchObject({ offline_pending: true });
  vi.setSystemTime(Date.now() + 16_000);
  await runtime.tick();
  expect(runtime.engine.getSnapshot().commands[0].status).toBe('applied');
  expect(sent).toEqual([request.idempotencyKey, request.idempotencyKey]);
  expect(committed.size).toBe(1);
  expect((await runtime.snapshot())?.contexts.stop.items[0].stock_quantity).toBe(9);
  expect(await gateway.recordDelivery(request)).toEqual(result);
  expect((await runtime.snapshot())?.contexts.stop.items[0].stock_quantity).toBe(9);
});
it('does not report an online business rejection as a successful temporary bill', async () => {
  const { gateway, runtime } = await setup();
  mocks.rpc.mockResolvedValue({ error: null, data: { status: 'conflict', error: 'Price changed' } });
  await expect(gateway.recordDelivery(payload())).rejects.toThrow('Price changed');
  expect(runtime.engine.getSnapshot().commands[0].status).toBe('conflict');
});
it('automatically replays a legacy online request after its foreground deadline, without replaying active saves', async () => {
  const { runtime, live } = await setup();
  const request = payload();
  live.recordDelivery.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(result);
  await expect(client.runOnlineOnlyEmployeeWrite(() => live.recordDelivery(request),
    JSON.stringify({ kind: 'gateway', operation: 'delivery', payload: request }))).rejects.toThrow('Failed to fetch');
  await runtime.tick();
  expect(live.recordDelivery).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 31_000);
  await Promise.all([runtime.tick(), runtime.tick()]);
  expect(live.recordDelivery).toHaveBeenCalledTimes(2);
  expect(live.recordDelivery.mock.calls[1]).toEqual(live.recordDelivery.mock.calls[0]);
  expect(await client.offlineStore().hasOnlineWrite()).toBe(false);
});
it.each(['stock_transfer', 'stock_return', 'stock_damage', 'immediate_sale'] as const)('returns confirmed %s data and preserves the prepared snapshot', async type => {
  const { gateway, runtime, s, live } = await setup();
  s.contexts.stop.payment_profile = { ...s.contexts.stop.offline_collection_template!.payment_profile,
    allowed_payment_terms: ['immediate'], default_payment_term: 'immediate', vat_enabled: false,
    credit_suspended: false, credit_exposure: 0, credit_remaining: null } as NonNullable<typeof s.contexts.stop.payment_profile>;
  await runtime.engine.install(s);
  const response = type === 'immediate_sale' ? { delivery: result, receipt_number: 'REC-001',
    payment: { payment_id: 'payment-real', received_amount: 25, allocated_amount: 25, change_amount: 0 }, print_document: {} } : s.stocks.round;
  mocks.rpc.mockImplementation(async (name: string) => {
    if (!name.startsWith('offline_record_')) throw new TypeError('Refresh unavailable');
    return { error: null, data: { status: 'applied', result: response } };
  });
  const identity = { idempotencyKey: crypto.randomUUID(), items: [{ ice_type_id: 'ice', quantity: 1 }] };
  const actual = type === 'immediate_sale'
    ? await gateway.recordImmediateSale!({ ...identity, roundStopId: 'stop', clientRecordedAt: new Date().toISOString(),
      note: null, paymentMethod: 'cash', receivedAmount: 25, expectedTotal: 25, referenceNumber: null, evidencePath: null })
    : await gateway[type === 'stock_transfer' ? 'recordEmployeeStockTransfer' : type === 'stock_return' ? 'recordEmployeeStockReturn' : 'recordEmployeeStockDamage']({ ...identity, roundId: 'round' });
  expect(actual).toEqual(response);
  await runtime.prepare(true);
  online.mockReturnValue(false);
  expect(await runtime.snapshot()).toBeDefined();
  expect((await runtime.snapshot())?.contexts.stop.items[0].stock_quantity).toBe(type === 'stock_transfer' ? 11 : 9);
  expect(runtime.engine.getSnapshot().commands[0].status).toBe('applied');
  expect(live.recordDelivery).not.toHaveBeenCalled();
});

it('waits for its own delivery when a background drain already captured an earlier batch', async () => {
  const { runtime, gateway } = await setup();
  let firstRelease!: () => void; let firstEntered!: () => void;
  const entered = new Promise<void>(resolve => { firstEntered = resolve; });
  let calls = 0;
  mocks.rpc.mockImplementation(async (name: string) => {
    if (!name.startsWith('offline_record_')) throw new TypeError('Refresh unavailable');
    if (++calls === 1) { firstEntered(); await new Promise<void>(resolve => { firstRelease = resolve; }); }
    return { error: null, data: { status: 'applied', result } };
  });
  online.mockReturnValue(false);
  await gateway.recordDelivery(payload());
  online.mockReturnValue(true);
  const syncing = runtime.engine.sync(); await entered;
  const second = gateway.recordDelivery(payload());
  await vi.waitFor(() => expect(runtime.engine.getSnapshot().commands).toHaveLength(2));
  firstRelease(); await syncing;
  expect(await second).toEqual(result);
  expect(calls).toBe(2);
  expect(runtime.engine.getSnapshot().commands.map(c => c.status)).toEqual(['applied', 'applied']);
});
