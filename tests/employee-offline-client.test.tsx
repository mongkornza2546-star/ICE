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
function runtime() {
  const s = offlineSnapshot();
  const live = { loadReferenceData: vi.fn(async () => ({ rounds: s.rounds, iceTypes: s.iceTypes })),
    loadShopCards: vi.fn(async () => []), loadEmployeeStockState: vi.fn(async () => s.stocks.round) };
  return { live, runtime: client.createEmployeeRuntime(s.ownerId, s.serviceDate, live as unknown as EmployeeDeliveryGateway) };
}
it('prepares once, reads local data on repeat visits and sees updates from another connection', async () => {
  const { runtime: r, live } = runtime();
  await Promise.all([r.prepare(), r.prepare()]);
  expect(live.loadReferenceData).toHaveBeenCalledTimes(1);
  expect((await r.snapshot())?.aggregate.ice).toBe(30);
  await r.prepare(); await r.snapshot();
  expect(live.loadReferenceData).toHaveBeenCalledTimes(1);
  await client.offlineStore().invalidate(r.engine.owner, r.engine.day);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  expect(await r.snapshot()).toBeUndefined();
});
it('revokes preparation when the server explicitly disables capability, preserving queued history', async () => {
  const { runtime: r } = runtime(); await r.prepare();
  mocks.rpc.mockResolvedValue({ error: null, data: { version: 1, enabled: false, profile: offlineSnapshot().profile } });
  await r.prepare(true);
  expect(Date.parse(r.engine.getSnapshot().snapshot!.validUntil)).toBe(0);
  expect(r.engine.getSnapshot().notice).toContain('ไม่เปิดใช้งาน');
});
it('does not install an old preparation after its runtime stops', async () => {
  const { runtime: r, live } = runtime(); let release!: () => void;
  live.loadReferenceData.mockImplementation(async () => { await new Promise<void>(r => { release = r; }); const s = offlineSnapshot(); return { rounds: s.rounds, iceTypes: s.iceTypes }; });
  const stop = r.start();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  stop(); release();
  await r.prepare();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(await client.offlineStore().read(r.engine.owner, r.engine.day)).toBeUndefined();
});
