import { offlineSnapshot } from './helpers/offlineSnapshot';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkStore } from '../src/offline/runtime/store';
import { OfflineEngine } from '../src/offline/runtime/engine';
import { projectCommand, contextPolicy } from '../src/offline/runtime/project';
import type { WorkCommand, WorkSnapshot } from '../src/offline/runtime/types';

const owner = '10000000-0000-4000-8000-000000000001';
const day = '2026-10-29';
const snapshot = offlineSnapshot;

function input(id = crypto.randomUUID(), quantity = 2) {
  return { id, ownerId: owner, serviceDate: day, type: 'delivery' as const, rpc: 'record_delivery_with_vat_check',
    args: { p_round_stop_id: 'stop', p_items: [{ ice_type_id: 'ice', quantity }], p_stop_status: 'delivered', p_expected_total: quantity * 25 },
    expected: contextPolicy(snapshot().contexts.stop), recordedAt: '2026-10-29T02:00:00Z', label: 'shop' };
}
let factory: IDBFactory;
let stores: WorkStore[];
let online: ReturnType<typeof vi.spyOn>;
const makeStore = () => { const s = new WorkStore(factory, 'test'); stores.push(s); return s; };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-29T02:00:00Z'));
  factory = new IDBFactory(); stores = [];
  online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(async () => { await Promise.all(stores.map(s => s.close())); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('durable work transaction', () => {
  it('restores queued items, evidence, sequence and stock after closing the database', async () => {
    const store = makeStore(); await store.install(snapshot());
    const command = await store.enqueue({ ...input(), evidence: new NodeBlob(['receipt'], { type: 'image/png' }) as unknown as Blob }, projectCommand);
    await store.close(); const reopened = makeStore();
    expect((await reopened.commands(owner))[0]).toMatchObject({ id: command.id, sequence: 1, status: 'pending' });
    expect((await reopened.commands(owner))[0].evidenceData?.bytes.byteLength).toBe(7);
    expect((await reopened.commands(owner))[0].evidence).toBeUndefined();
    expect((await reopened.read(owner, day))?.snapshot.contexts.stop.items[0].stock_quantity).toBe(8);
  });
  it('aborts both stock projection and command when projection fails', async () => {
    const store = makeStore(); await store.install(snapshot());
    await expect(store.enqueue(input(undefined, 11), projectCommand)).rejects.toThrow('จำนวนเกิน');
    expect(await store.commands(owner)).toEqual([]);
    expect((await store.read(owner, day))?.sequence).toBe(0);
    expect((await store.read(owner, day))?.snapshot.contexts.stop.items[0].stock_quantity).toBe(10);
  });
  it('leaves the command and balances untouched when evidence cannot be read', async () => {
    const store = makeStore(); await store.install(snapshot());
    const evidence = new NodeBlob(['receipt']);
    vi.spyOn(evidence, 'arrayBuffer').mockRejectedValue(new DOMException('Missing evidence', 'NotFoundError'));
    await expect(store.enqueue({ ...input(), evidence: evidence as unknown as Blob }, projectCommand)).rejects.toThrow('Missing evidence');
    expect(await store.commands(owner)).toHaveLength(0);
    expect((await store.read(owner, day))?.sequence).toBe(0);
    expect((await store.read(owner, day))?.snapshot.stocks.round.holding_location.balances[0].quantity).toBe(10);
  });
  it('deduplicates a repeated save and rejects changed payloads using the same identity', async () => {
    const store = makeStore(); await store.install(snapshot()); const payload = input();
    await store.enqueue(payload, projectCommand); await store.enqueue(payload, projectCommand);
    expect(await store.commands(owner)).toHaveLength(1);
    expect((await store.read(owner, day))?.snapshot.contexts.stop.items[0].stock_quantity).toBe(8);
    await expect(store.enqueue({ ...input(payload.id, 3) }, projectCommand)).rejects.toThrow('รหัสรายการ');
  });
  it('serializes simultaneous saves from two connections without overdraw or duplicate sequence', async () => {
    const a = makeStore(), b = makeStore(); await a.install(snapshot());
    const result = await Promise.allSettled([a.enqueue(input(undefined, 6), projectCommand), b.enqueue(input(undefined, 6), projectCommand)]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await a.commands(owner)).toHaveLength(1);
    expect((await a.read(owner, day))?.snapshot.contexts.stop.items[0].stock_quantity).toBe(4);
  });
  it('refuses a fresh server snapshot while a possibly committed command is unacknowledged', async () => {
    const store = makeStore(); await store.install(snapshot()); await store.enqueue(input(), projectCommand);
    const replacement = snapshot(); replacement.contexts.stop.items[0].stock_quantity = 6;
    expect(await store.install(replacement)).toBe(false);
    expect((await store.read(owner, day))?.snapshot.contexts.stop.items[0].stock_quantity).toBe(8);
  });
  it('does not acknowledge or project a command when storage quota rejects the write', async () => {
    const store = makeStore(); await store.install(snapshot());
    const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => { throw new DOMException('Storage full', 'QuotaExceededError'); });
    await expect(store.enqueue(input(), projectCommand)).rejects.toThrow('Storage full');
    add.mockRestore();
    expect(await store.commands(owner)).toHaveLength(0);
    expect((await store.read(owner, day))!.snapshot.stocks.round.holding_location.balances[0].quantity).toBe(10);
  });
  it('serializes online-only writes against preparation and offline writes in another tab', async () => {
    const a = makeStore(), b = makeStore(); await a.install(snapshot());
    await a.beginOnlineWrite('online');
    expect(await b.install(snapshot())).toBe(false);
    await expect(b.enqueue(input(), projectCommand)).rejects.toThrow('ออนไลน์');
    await a.endOnlineWrite('online');
    await expect(b.enqueue(input(), projectCommand)).rejects.toThrow('หมดอายุ');
    expect(await b.install(snapshot())).toBe(true);
    await b.enqueue(input(), projectCommand);
    await expect(a.beginOnlineWrite('another')).rejects.toThrow('ค้างซิงก์');
  });
  it('invalidates projected balances after an approved discard until preparation succeeds', async () => {
    const store = makeStore(); await store.install(snapshot());
    const command = await store.enqueue(input(), projectCommand);
    await store.update({ ...command, status: 'discard_approved' });
    await expect(store.enqueue(input(), projectCommand)).rejects.toThrow('หมดอายุ');
    expect(await store.install(snapshot())).toBe(true);
    expect((await store.read(owner, day))!.snapshot.stocks.round.holding_location.balances[0].quantity).toBe(10);
  });
  it('isolates owners and refuses commands after the Bangkok-day lease expires', async () => {
    const store = makeStore(); await store.install(snapshot());
    expect(await store.read('other', day)).toBeUndefined(); expect(await store.commands('other')).toEqual([]);
    vi.setSystemTime(new Date('2026-10-29T17:00:00Z'));
    await expect(store.enqueue(input(), projectCommand)).rejects.toThrow('หมดอายุ');
    expect(await store.commands(owner)).toHaveLength(0);
  });
});

describe('foreground synchronization', () => {
  it('replays the same command after a lost response and never projects it a second time', async () => {
    const store = makeStore(); await store.install(snapshot());
    const remote = new Map<string, Record<string, unknown>>(); let writes = 0; let lose = true;
    const send = vi.fn(async (command: WorkCommand) => {
      if (!remote.has(command.id)) { remote.set(command.id, { delivery_event_id: 'server-event' }); writes++; }
      if (lose) { lose = false; throw new TypeError('Load failed'); }
      return { status: 'applied' as const, result: remote.get(command.id)! };
    });
    const engine = new OfflineEngine(owner, day, store, { send, resolutions: async () => [] });
    await engine.enqueue(input()); await engine.sync();
    expect((await store.commands(owner))[0].status).toBe('retry_wait');
    await store.close();
    const reboot = new OfflineEngine(owner, day, makeStore(), { send, resolutions: async () => [] });
    await reboot.reload(); await reboot.sync(true);
    expect(writes).toBe(1); expect(send).toHaveBeenCalledTimes(2);
    expect((await reboot.store.commands(owner))[0].status).toBe('applied');
    expect((await reboot.store.read(owner, day))?.snapshot.contexts.stop.items[0].stock_quantity).toBe(8);
  });
  it('allows only one tab to send and resumes a crashed tab after its lease expires', async () => {
    const a = makeStore(), b = makeStore(); await a.install(snapshot()); await a.enqueue(input(), projectCommand);
    expect(await a.claim(owner, day, 'crashed')).toBe(true);
    const send = vi.fn(async () => ({ status: 'applied' as const, result: { ok: true } }));
    const e = new OfflineEngine(owner, day, b, { send, resolutions: async () => [] });
    await e.sync(); expect(send).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 60_001); await e.sync(); expect(send).toHaveBeenCalledTimes(1);
  });
  it('stops following commands on a business conflict, preserving all payloads and money', async () => {
    const store = makeStore(); await store.install(snapshot());
    const first = await store.enqueue(input(), projectCommand); await store.enqueue(input(), projectCommand);
    const send = vi.fn(async () => ({ status: 'conflict' as const, error: 'Price changed' }));
    const engine = new OfflineEngine(owner, day, store, { send, resolutions: async () => [] });
    await engine.sync(); expect(send).toHaveBeenCalledTimes(1);
    const commands = await store.commands(owner);
    expect(commands[0]).toMatchObject({ status: 'conflict', args: first.args }); expect(commands[1].status).toBe('pending');
    await expect(store.enqueue(input(), projectCommand)).rejects.toThrow('รอตรวจสอบ');
  });
  it('does not send while offline and never marks an authentication failure as applied', async () => {
    const store = makeStore(); await store.install(snapshot()); await store.enqueue(input(), projectCommand);
    const send = vi.fn(async () => { throw { status: 401, message: 'JWT expired' }; });
    const engine = new OfflineEngine(owner, day, store, { send, resolutions: async () => [] });
    online.mockReturnValue(false);
    await engine.sync(); expect(send).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    await engine.sync(); expect((await store.commands(owner))[0].status).toBe('auth_required');
  });
});

describe('dependent payments and refresh races', () => {
  const collectionSnapshot = () => {
    const s = snapshot();
    s.contexts.stop.offline_collection_template = { queue_key: 'regular:shop', collection_scope: 'shop', destination_kind: 'regular',
      shop_id: 'shop', shop_code: 'S', shop_name: 'Shop', image_path: null, outstanding_amount: 0, charge_count: 0, has_new_charges: false, charges: [],
      payment_profile: { allowed_payment_methods: ['cash'], default_payment_method: 'cash', cash_reference_required: false, cash_evidence_required: false,
        bank_transfer_reference_required: false, bank_transfer_evidence_required: false, qr_reference_required: false, qr_evidence_required: false } };
    return s;
  };
  it('saves delivery then partial cash collection offline and binds the real charge before sync', async () => {
    const store = makeStore(); await store.install(collectionSnapshot());
    const sends: WorkCommand[] = [];
    const engine = new OfflineEngine(owner, day, store, { resolutions: async () => [], send: async c => {
      sends.push(c); return { status: 'applied', result: c.type === 'delivery' ? { charge_id: 'actual-charge' } : { receipt_number: 'RC-1' } };
    } });
    const delivery = await engine.enqueue(input());
    const projected = engine.getSnapshot().snapshot!;
    expect(projected.collection.queue[0].outstanding_amount).toBe(50);
    const charge = projected.collection.queue[0].charges[0];
    await engine.enqueue({ id: crypto.randomUUID(), type: 'collection_payment', rpc: 'record_shop_collection_payment', recordedAt: '2026-10-29T02:01:00Z', label: 'cash',
      args: { p_expected_outstanding_amount: 50, p_allocations: [{ charge_id: charge.charge_id, amount: 30 }], p_payment_method: 'cash', p_received_amount: 40 },
      expected: { queueKey: 'regular:shop', charges: [{ charge_id: charge.charge_id, outstanding_amount: 50 }] } });
    expect(engine.getSnapshot().snapshot!.collection.queue[0].outstanding_amount).toBe(20);
    await engine.sync();
    expect(sends.map(c => c.type)).toEqual(['delivery', 'collection_payment']);
    expect(sends[1].resolved?.args.p_allocations).toEqual([{ charge_id: 'actual-charge', amount: 30 }]);
    expect(sends[1].args.p_allocations).toEqual([{ charge_id: `local:${delivery.id}`, amount: 30 }]);
    await store.close(); const recovered = await makeStore().commands(owner);
    expect(recovered[1].result?.receipt_number).toBe('RC-1');
  });
  it('rejects an in-flight prepared snapshot if another tab saved and synced a command during the fetch', async () => {
    const store = makeStore(); await store.install(snapshot()); const revision = (await store.read(owner, day))!.sequence;
    const command = await store.enqueue(input(), projectCommand); await store.update({ ...command, status: 'applied' });
    expect(await store.install(snapshot(), revision)).toBe(false);
    expect((await store.read(owner, day))!.snapshot.contexts.stop.items[0].stock_quantity).toBe(8);
  });
  it('keeps upload failures retryable, persists the evidence and never sends a payment without it', async () => {
    const store = makeStore(); await store.install(snapshot());
    const upload = vi.fn(async () => { throw new TypeError('Load failed'); }); const send = vi.fn();
    const engine = new OfflineEngine(owner, day, store, { upload, send, resolutions: async () => [] });
    await engine.enqueue({ ...input(), evidence: new NodeBlob(['slip']) as unknown as Blob }); await engine.sync();
    expect(send).not.toHaveBeenCalled(); expect((await store.commands(owner))[0].status).toBe('retry_wait');
    expect((await store.commands(owner))[0].evidenceData?.bytes.byteLength).toBe(4);
  });
  it('rejects payment without required evidence before reducing the local receivable', async () => {
    const store = makeStore(); const s = collectionSnapshot();
    s.contexts.stop.offline_collection_template!.payment_profile.cash_evidence_required = true;
    await store.install(s); const delivery = await store.enqueue(input(), projectCommand);
    const pay = { ...input(), type: 'collection_payment' as const, rpc: 'record_shop_collection_payment',
      args: { p_expected_outstanding_amount: 50, p_allocations: [{ charge_id: `local:${delivery.id}`, amount: 30 }], p_payment_method: 'cash', p_received_amount: 40 },
      expected: { queueKey: 'regular:shop' } };
    await expect(store.enqueue(pay, projectCommand)).rejects.toThrow('หลักฐาน');
    expect((await store.read(owner, day))!.snapshot.collection.queue[0].outstanding_amount).toBe(50);
    expect(await store.commands(owner)).toHaveLength(1);
  });
  it('registers subsequent commands after a discard with the server instead of stranding local conflicts', async () => {
    const store = makeStore(); await store.install(snapshot());
    const first = await store.enqueue(input(), projectCommand); const second = await store.enqueue(input(), projectCommand);
    await store.update({ ...first, status: 'conflict' });
    const send = vi.fn(async () => ({ status: 'conflict' as const, error: 'Preceding command discarded' }));
    const engine = new OfflineEngine(owner, day, store, { send, resolutions: async () => [{ id: first.id, status: 'discard_approved' }] });
    await engine.sync(); expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0].id).toBe(second.id);
    expect((await store.commands(owner))[0].status).toBe('discard_approved');
    expect((await store.commands(owner))[1].status).toBe('conflict');
  });
});


describe('aggregate stock availability', () => {
  it('caps a withdrawal by unchanged aggregate stock, then consumes aggregate across destinations', async () => {
    const store = makeStore(); const s = snapshot(); s.aggregate.ice = 4;
    s.contexts.stop.items[0].stock_quantity = 4;
    s.contexts.event = structuredClone(s.contexts.stop); s.contexts.event.round_stop_id = 'event';
    await store.install(s);
    await store.enqueue({ ...input(), type: 'stock_transfer', rpc: 'record_employee_stock_transfer',
      args: { p_round_id: 'round', p_items: [{ ice_type_id: 'ice', quantity: 5 }] } }, projectCommand);
    let state = (await store.read(owner, day))!.snapshot;
    expect(state.stocks.round.holding_location.balances[0].quantity).toBe(15);
    expect(state.contexts.stop.items[0].stock_quantity).toBe(4);
    expect(state.aggregate.ice).toBe(4);
    await store.enqueue(input(undefined, 3), projectCommand);
    state = (await store.read(owner, day))!.snapshot;
    expect(state.aggregate.ice).toBe(1);
    expect(state.contexts.event.items[0].stock_quantity).toBe(1);
    await expect(store.enqueue(input(undefined, 2), projectCommand)).rejects.toThrow('จำนวนเกิน');
    await store.enqueue({ ...input(), type: 'stock_return', rpc: 'record_employee_stock_return',
      args: { p_round_id: 'round', p_items: [{ ice_type_id: 'ice', quantity: 5 }] } }, projectCommand);
    expect((await store.read(owner, day))!.snapshot.aggregate.ice).toBe(1);
    await store.enqueue({ ...input(), type: 'stock_damage', rpc: 'record_employee_stock_damage',
      args: { p_round_id: 'round', p_items: [{ ice_type_id: 'ice', quantity: 1 }] } }, projectCommand);
    state = (await store.read(owner, day))!.snapshot;
    expect(state.aggregate.ice).toBe(0);
    expect(state.contexts.event.items[0].stock_quantity).toBe(0);
  });
});
