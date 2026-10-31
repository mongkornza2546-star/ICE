import { publishDataChange } from '../../lib/dataChange';
import { supabase } from '../../lib/supabase';
import { loadCurrentCollectionQueue } from '../../lib/collectionQueue';
import { uploadPaymentEvidence } from '../../lib/paymentEvidence';
import { toBangkokDateString } from '../../lib/serviceDate';
import type { EmployeeDeliveryGateway } from '../../EmployeeDeliveryWorkspace';
import type { DeliveryPosContext } from '../../types/app';
import { OfflineEngine, type SyncResponse } from './engine';
import { WorkStore } from './store';
import { isTransportFailure, withDeadline } from './network';
import { newOfflineId, pendingCommand, type WorkSnapshot } from './types';

let store: WorkStore | undefined;
export const offlineStore = () => store ??= new WorkStore();
export async function preparedProfile(owner: string) {
  try {
    const state = await offlineStore().read(owner, toBangkokDateString());
    const snapshot = state?.snapshot;
    return snapshot?.version === 1 && Date.parse(snapshot.validUntil) > Date.now() && snapshot.profile.is_active
      && snapshot.profile.role === 'courier' && snapshot.profile.id === owner ? snapshot.profile : null;
  } catch { return null; }
}
export async function hasUnsentWork(owner: string) {
  if (typeof indexedDB === 'undefined') return false;
  return (await offlineStore().onlineWrite())?.ownerId === owner || (await offlineStore().commands(owner)).some(pendingCommand);
}
// Online-only operations cannot share a prepared projection with queued work.
// Invalidate before sending and block preparation/enqueue across tabs until done.
export async function runOnlineOnlyEmployeeWrite<T>(action: () => PromiseLike<T>, retryKey: string): Promise<T> {
  if (!navigator.onLine) throw new Error('รายการนี้ต้องเชื่อมต่ออินเทอร์เน็ต');
  if (typeof indexedDB === 'undefined') return action();
  const holder = newOfflineId(); const store = offlineStore();
  // Capture the actual account so another login cannot replay a saved request.
  const session = supabase?.auth ? await withDeadline(() => supabase!.auth.getSession()) : undefined;
  if (session?.error) throw session.error;
  if (supabase?.auth && !session?.data.session?.user.id) throw new Error('กรุณาเข้าสู่ระบบด้วยบัญชีเจ้าของรายการ');
  const ownerId = session?.data.session?.user.id;
  const confirmed = await store.onlineResult(ownerId, retryKey);
  if (confirmed) return confirmed.value as T;
  await store.beginOnlineWrite(holder, retryKey, ownerId);
  // A timeout/lost response is still unresolved even if the abandoned request
  // later completes. Replay the identical operation to obtain its authoritative
  // result before admitting fresh work (including after a browser restart).
  let result: T;
  try {
    result = await withDeadline(() => Promise.resolve().then(action));
  } catch (error) {
    if (!isTransportFailure(error)) await store.endOnlineWrite(holder);
    throw error;
  }
  const error = result && typeof result === 'object' && 'error' in result ? result.error : null;
  const status = result && typeof result === 'object' && 'status' in result ? result.status : undefined;
  const uncertain = error && (isTransportFailure(error) || (typeof status === 'number' && isTransportFailure({ status })));
  // A failed local acknowledgement must leave the fence available for replay.
  if (!uncertain) await store.endOnlineWrite(holder, error ? undefined : { value: result });
  return result;
}
export function createEmployeeRuntime(owner: string, day: string, live: EmployeeDeliveryGateway) {
  const engine = new OfflineEngine(owner, day, offlineStore(), {
    async send(command, signal) {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data: auth, error: authError } = await supabase.auth.getSession();
      if (authError || auth.session?.user.id !== owner) throw authError ?? new Error('กรุณาเข้าสู่ระบบด้วยบัญชีเจ้าของคิว');
      const { data, error } = await supabase.rpc(`offline_${command.rpc}`, {
        ...(command.resolved?.args ?? command.args),
        ...('p_evidence_path' in command.args ? { p_evidence_path: command.evidencePath ?? command.args.p_evidence_path } : {}),
        p_offline: { envelope: { schemaVersion: 1, payloadVersion: 1, commandId: command.id, idempotencyKey: command.id,
          deviceId: command.deviceId, ownerId: owner, serviceDate: command.serviceDate, sequence: command.sequence, clientRecordedAt: command.recordedAt },
        expected: command.resolved?.expected ?? command.expected },
      }).abortSignal(signal);
      if (error) throw error;
      return data as SyncResponse;
    },
    async upload(blob, command) {
      return uploadPaymentEvidence(new File([blob], blob.type === 'application/pdf' ? 'evidence.pdf' : 'evidence.jpg', { type: blob.type }), command.id);
    },
    async resolutions(commandIds) {
      if (!supabase) return [];
      const { data, error } = await withDeadline(signal => supabase!.rpc('get_employee_offline_commands', { p_service_date: null, p_command_ids: commandIds }).abortSignal(signal));
      if (error) throw error;
      return data ?? [];
    },
  });
  let preparing: Promise<void> | undefined;
  let loaded = false;
  let lastPreparedAt = 0;
  let stopped = false;
  let ticking: Promise<void> | undefined;
  async function prepare(force = false) {
    if (stopped) return;
    if (preparing) return preparing;
    preparing = (async () => {
      if (!loaded) { await engine.reload(); loaded = true; }
      const current = engine.getSnapshot().snapshot;
      if (!navigator.onLine || (!force && current && Date.parse(current.validUntil) > Date.now() && Date.now() - lastPreparedAt < 5 * 60_000)) return;
      if (engine.getSnapshot().commands.some(pendingCommand)) { await engine.sync(); return; }
      const version = await engine.store.preparationVersion(owner, day);
      lastPreparedAt = Date.now();
      engine.setView({ preparing: true, notice: null });
      try {
        if (!supabase) return;
        const { data: capability, error } = await withDeadline(signal => supabase!.rpc('get_employee_offline_capability', { p_service_date: day }).abortSignal(signal));
        if (error) throw error;
        if (capability?.version !== 1 || !capability.enabled || capability.profile?.id !== owner) {
          await engine.store.invalidate(owner, day); await engine.reload();
          throw new Error('เซิร์ฟเวอร์ยังไม่เปิดใช้งานออฟไลน์สำหรับบัญชีนี้');
        }
        const reference = await withDeadline(() => live.loadReferenceData(day));
        const snapshot: WorkSnapshot = { version: 1, ownerId: owner, serviceDate: day, profile: capability.profile,
          preparedAt: new Date().toISOString(), validUntil: capability.validUntil, rounds: reference.rounds, iceTypes: reference.iceTypes,
          aggregate: capability.aggregate, cards: {}, stocks: {}, contexts: {}, collection: { runId: null, isClosed: false, queue: [] } };
        for (const round of reference.rounds.filter(r => r.status === 'open' && !r.cancelled_at)) {
          // Destination synchronization in loadShopCards must finish before the
          // context batch, otherwise newly assigned shops can be absent.
          snapshot.cards[round.id] = await withDeadline(() => live.loadShopCards(round.id));
          const [stock, response] = await Promise.all([
            withDeadline(() => live.loadEmployeeStockState(round.id)),
            withDeadline(signal => supabase!.rpc('get_employee_offline_pos_contexts', { p_round_id: round.id }).abortSignal(signal)),
          ]);
          if (response.error) throw response.error;
          snapshot.stocks[round.id] = stock;
          const contexts = response.data as Record<string, DeliveryPosContext>;
          for (const card of snapshot.cards[round.id]) {
            if (card.destination_kind === 'event' && (!card.event_delivery_enabled || !card.is_operational)) continue;
            if (!contexts[card.round_stop_id]) throw new Error('ข้อมูลร้านสำหรับออฟไลน์ยังไม่ครบ');
          }
          Object.assign(snapshot.contexts, contexts);
        }
        snapshot.collection = await withDeadline(() => loadCurrentCollectionQueue(day));
        if (stopped) return;
        if (await engine.install(snapshot, version.sequence, version.revision)) {
          lastPreparedAt = Date.now();
          publishDataChange(['stock', 'pos', 'payment', 'receivable']);
        }
        void navigator.storage?.persist?.().catch(() => false);
      } catch (error) {
        engine.setView({ notice: `เตรียมข้อมูลออฟไลน์ไม่สำเร็จ: ${(error as { message?: string }).message ?? 'กรุณาลองใหม่'}` });
      } finally { engine.setView({ preparing: false }); }
    })().catch(error => { engine.setView({ notice: (error as Error).message, preparing: false }); }).finally(() => { preparing = undefined; });
    return preparing;
  }
  async function snapshot() {
    await engine.reload(); loaded = true;
    const current = engine.getSnapshot().snapshot;
    if (current && Date.parse(current.validUntil) > Date.now()) return current;
    void prepare();
    return undefined;
  }
  function tick(): Promise<void> {
    if (ticking) return ticking;
    ticking = drain().finally(() => { ticking = undefined; });
    return ticking;
  }
  async function drain() {
    if (stopped || document.visibilityState === 'hidden') return;
    try {
    // Recover older/cold online-only requests too. Leave a foreground save
    // alone until its 15-second deadline has elapsed, and retain its identity.
    const onlineWrite = navigator.onLine ? await engine.store.onlineWrite() : undefined;
    if (onlineWrite?.ownerId === owner && Date.now() - onlineWrite.startedAt >= 30_000) {
      const { retryPendingOnlineWrite } = await import('./onlineRecovery');
      await retryPendingOnlineWrite(owner, live);
      publishDataChange(['stock', 'pos', 'payment', 'receivable']);
    }
    await engine.reload();
    const hadPending = engine.getSnapshot().commands.some(pendingCommand);
    await engine.sync();
    await prepare(hadPending && !engine.getSnapshot().commands.some(pendingCommand));
    } catch (error) { engine.setView({ notice: (error as Error).message }); }
  }
  const start = () => {
    stopped = false;
    engine.resume();
    void tick();
    const timer = setInterval(() => { void tick(); }, 15_000);
    const resume = () => { void tick(); };
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      stopped = true; engine.pause(); clearInterval(timer); window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  };
  return { engine, snapshot, prepare, start, tick };
}
export type EmployeeRuntime = ReturnType<typeof createEmployeeRuntime>;
