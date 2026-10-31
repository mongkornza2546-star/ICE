import { projectCommand } from './project';
import { WorkStore } from './store';
import { isTransportFailure, withDeadline } from './network';
import { newOfflineId, pendingCommand, type WorkCommand, type WorkSnapshot } from './types';

export interface SyncResponse { status: 'received' | 'applied' | 'conflict' | 'retry_requested' | 'discard_approved'; result?: Record<string, unknown>; error?: string }
export interface OfflineTransport {
  send(command: WorkCommand, signal: AbortSignal): PromiseLike<SyncResponse>;
  upload?(blob: Blob, command: WorkCommand): Promise<string>;
  resolutions(commandIds: string[]): Promise<Array<SyncResponse & { id: string }>>;
}
export interface RuntimeView { snapshot?: WorkSnapshot; commands: WorkCommand[]; preparing: boolean; syncing: boolean; notice: string | null }
export class OfflineEngine {
  private holder = newOfflineId();
  private running?: Promise<void>;
  private listeners = new Set<() => void>();
  private view: RuntimeView = { commands: [], preparing: false, syncing: false, notice: null };
  private disposed = false;
  constructor(readonly owner: string, readonly day: string, readonly store: WorkStore, private transport: OfflineTransport) {}
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setView(patch: Partial<RuntimeView>) { this.view = { ...this.view, ...patch }; this.listeners.forEach(f => f()); }
  async reload() {
    const [work, commands] = await Promise.all([this.store.read(this.owner, this.day), this.store.commands(this.owner)]);
    if (this.disposed) return;
    this.setView({ snapshot: work?.snapshot, commands });
  }
  async install(snapshot: WorkSnapshot, expectedSequence?: number, expectedRevision?: number) {
    if (snapshot.ownerId !== this.owner || snapshot.serviceDate !== this.day || snapshot.version !== 1) throw new Error('ข้อมูลออฟไลน์ไม่ตรงกับผู้ใช้หรือวันที่');
    if (!Number.isFinite(Date.parse(snapshot.validUntil)) || !snapshot.aggregate
      || Object.values(snapshot.aggregate).some(q => !Number.isFinite(q))) throw new Error('ข้อมูลออฟไลน์จากเซิร์ฟเวอร์ไม่ครบ');
    const installed = await this.store.install(snapshot, expectedSequence, expectedRevision); await this.reload(); return installed;
  }
  async enqueue(input: Omit<WorkCommand, 'ownerId' | 'serviceDate' | 'deviceId' | 'sequence' | 'status' | 'attempts' | 'nextAttemptAt'>) {
    if (this.disposed) throw new Error('หน้าการทำงานนี้ปิดแล้ว กรุณาเปิดใหม่');
    const command = await this.store.enqueue({ ...input, ownerId: this.owner, serviceDate: this.day }, projectCommand);
    await this.reload();
    return command;
  }
  async submit(input: Parameters<OfflineEngine['enqueue']>[0]) {
    // A foreground retry must retain the first projection and expected state,
    // including after the server has already applied this identity.
    const existing = (await this.store.commands(this.owner)).find(c => c.id === input.id);
    if (existing && (existing.serviceDate !== this.day || existing.type !== input.type || existing.rpc !== input.rpc
      || JSON.stringify(existing.args) !== JSON.stringify(input.args))) throw new Error('รหัสรายการนี้ถูกใช้กับข้อมูลอื่นแล้ว');
    let command = existing ?? await this.enqueue(input);
    if (existing) await this.reload();
    if (navigator.onLine && command.status !== 'applied') {
      await this.sync(true);
      command = this.getSnapshot().commands.find(c => c.id === input.id)!;
      // A drain already in progress (possibly in another tab) may have taken
      // its command list before this save. Wait for this specific identity.
      if (navigator.onLine && ['pending', 'syncing'].includes(command.status)) {
        command = await withDeadline(async signal => {
          while (!signal.aborted && navigator.onLine) {
            await this.sync(); await this.reload();
            const current = this.getSnapshot().commands.find(c => c.id === input.id)!;
            if (!['pending', 'syncing'].includes(current.status)) return current;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          return this.getSnapshot().commands.find(c => c.id === input.id)!;
        });
      }
    }
    if (['blocked', 'conflict', 'auth_required', 'discard_approved'].includes(command.status)) {
      throw new Error(command.error ?? 'รายการยังไม่ยืนยัน กรุณาตรวจสอบรายการเดิม');
    }
    return command;
  }
  sync(force = false) {
    if (this.running) return this.running;
    this.running = this.drain(force).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async drain(force: boolean) {
    if (this.disposed || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
    this.setView({ syncing: true });
    try {
      const all = await this.store.commands(this.owner);
      for (const day of [...new Set(all.filter(pendingCommand).map(c => c.serviceDate))].sort()) {
        if (!(await this.store.claim(this.owner, day, this.holder))) continue;
        try {
          let commands = await this.store.commands(this.owner, day);
          if (commands.some(c => c.status === 'conflict')) {
            const feed = await this.transport.resolutions(commands.filter(c => c.status === 'conflict').map(c => c.id));
            for (const command of commands.filter(c => c.status === 'conflict')) {
              const resolution = feed.find(r => r.id === command.id);
              if (resolution?.status === 'retry_requested') await this.store.update({ ...command, status: 'pending', error: undefined });
              else if (resolution?.status === 'discard_approved') {
                await this.store.update({ ...command, status: 'discard_approved' });

              }
            }
            commands = await this.store.commands(this.owner, day);
          }
          for (const original of commands.filter(pendingCommand)) {
            if (this.disposed || !navigator.onLine || original.status === 'conflict'
              || (!force && (original.status === 'blocked' || original.nextAttemptAt > Date.now()))) break;
            if (!(await this.store.claim(this.owner, day, this.holder))) break;
            let command: WorkCommand = { ...original, status: 'syncing', attempts: original.attempts + 1 };
            await this.store.update(command); await this.reload();
            try {
              if ((command.evidenceData || command.evidence) && !command.evidencePath) {
                if (!this.transport.upload) throw new Error('ยังไม่พร้อมอัปโหลดหลักฐาน');
                // New writes persist bytes; retain support for earlier Blob rows.
                const evidencePath = await withDeadline(async () => {
                  const saved = command.evidenceData;
                  const blob = saved ? new Blob([saved.bytes], { type: saved.type })
                    : new Blob([await command.evidence!.arrayBuffer()], { type: command.evidence!.type });
                  return this.transport.upload!(blob, command);
                }, 20_000);
                command = { ...command, evidencePath }; await this.store.update(command);
              }
              if (!command.resolved && command.type === 'collection_payment') {
                const predecessors = await this.store.commands(this.owner, day);
                const resolve = (value: unknown): unknown => {
                  if (Array.isArray(value)) return value.map(resolve);
                  if (!value || typeof value !== 'object') return value;
                  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
                    if (key === 'charge_id' && typeof entry === 'string' && entry.startsWith('local:')) {
                      const parent = predecessors.find(c => c.id === entry.slice(6));
                      const charge = parent?.result?.charge_id;
                      if (parent?.status === 'discard_approved') return [key, entry];
                      if (parent?.status !== 'applied' || typeof charge !== 'string') throw new Error('รายการส่งที่อ้างอิงยังไม่ยืนยันหรือถูกยกเลิก กรุณาให้แอดมินตรวจสอบ');
                      return [key, charge];
                    }
                    return [key, resolve(entry)];
                  }));
                };
                command = { ...command, resolved: { args: resolve(command.args) as WorkCommand['args'], expected: resolve(command.expected) as WorkCommand['expected'] } };
                await this.store.update(command);
              }
              if (this.disposed) return;
              const response = await withDeadline(signal => this.transport.send(command, signal));
              if (!['applied', 'discard_approved', 'conflict'].includes(response.status)) throw new Error('Invalid offline server response');
              if (response.status === 'applied' && (!response.result || typeof response.result !== 'object')) throw new Error('Missing offline transaction result');
              await this.store.update({ ...command, status: response.status as WorkCommand['status'], result: response.result,
                error: response.error, nextAttemptAt: 0,
                ...(response.status === 'applied' ? { evidence: undefined, evidenceData: undefined } : {}) });
              await this.reload();
              if (response.status === 'conflict') break;
            } catch (error) {
              const e = error as { code?: string; message?: string; status?: number };
              const auth = e.status === 401 || /^PGRST30/.test(e.code ?? '') || /jwt|session|เข้าสู่ระบบ|active courier|active user|disabled for this employee|owner mismatch/i.test(e.message ?? '');
              const retry = isTransportFailure(error);
              await this.store.update({ ...command, status: auth ? 'auth_required' : retry ? 'retry_wait' : 'blocked',
                error: e.message ?? 'ซิงก์ไม่สำเร็จ', nextAttemptAt: Date.now() + Math.min(60_000, (retry ? 2_000 : 30_000) * 2 ** Math.min(command.attempts, 5)) });
              await this.reload(); break;
            }
          }
        } finally { await this.store.release(this.owner, day, this.holder); }
      }
    } catch (error) { this.setView({ notice: (error as Error).message }); }
    finally { this.setView({ syncing: false }); }
  }
  resume() { this.disposed = false; }
  pause() { this.disposed = true; }
  dispose() { this.pause(); this.listeners.clear(); }
}
