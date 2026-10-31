import { newOfflineId, pendingCommand, workKey, type WorkCommand, type WorkSnapshot, type WorkState } from './types';
import { toBangkokDateString } from '../../lib/serviceDate';

const DB_NAME = 'ice-employee-work-v1';
const TABLES = ['work', 'commands', 'control'] as const;
export interface OnlineWrite { holder: string; retryKey?: string; ownerId?: string; startedAt: number; }
export interface OnlineWriteResult { value: unknown; }
const onlineResultKey = (ownerId: string | undefined, retryKey: string) => ['online-result', ownerId ?? '', retryKey];
const ONLINE_WRITE_PENDING = 'มีรายการออนไลน์ยังไม่ทราบผล กรุณาลองรายการเดิมอีกครั้งก่อนทำรายการใหม่';
function advanceRevision(tx: IDBTransaction) {
  const control = tx.objectStore('control'); const revision = control.get('revision');
  revision.onsuccess = () => control.put((revision.result ?? 0) + 1, 'revision');
}
export class WorkStore {
  private connection?: Promise<IDBDatabase>;
  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB, private readonly name = DB_NAME) {}
  private open() {
    if (!this.connection) this.connection = new Promise<IDBDatabase>((resolve, reject) => {
      if (!this.factory) { reject(new Error('เบราว์เซอร์นี้ไม่รองรับการเก็บงานออฟไลน์')); return; }
      const request = this.factory.open(this.name, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('control')) request.result.createObjectStore('control');
        if (request.result.objectStoreNames.contains('work')) return;
        request.result.createObjectStore('work', { keyPath: 'key' });
        const commands = request.result.createObjectStore('commands', { keyPath: 'id' });
        commands.createIndex('scope', ['ownerId', 'serviceDate']);
        commands.createIndex('owner', 'ownerId');
      };
      request.onerror = () => { this.connection = undefined; reject(request.error); };
      request.onblocked = () => { this.connection = undefined; reject(new Error('ปิดแท็บเก่าก่อนเตรียมข้อมูลออฟไลน์')); };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.connection = undefined; };
        resolve(db);
      };
    });
    return this.connection;
  }
  private async run<T>(mode: IDBTransactionMode, action: (tx: IDBTransaction, done: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction([...TABLES], mode, { durability: 'strict' }); }
      catch { tx = db.transaction([...TABLES], mode); }
      let result: T;
      let failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('บันทึกลงเครื่องไม่สำเร็จ กรุณาตรวจพื้นที่ว่าง'));
      tx.onerror = () => { /* onabort is the authoritative failure, never request.onsuccess. */ };
      try { action(tx, value => { result = value; }, error => { failure = error; tx.abort(); }); }
      catch (error) { failure = error; tx.abort(); }
    });
  }
  async read(owner: string, day: string) {
    return this.run<WorkState | undefined>('readonly', (tx, done) => {
      const r = tx.objectStore('work').get(workKey(owner, day));
      r.onsuccess = () => done(r.result);
    });
  }
  async commands(owner: string, day?: string) {
    return this.run<WorkCommand[]>('readonly', (tx, done) => {
      const store = tx.objectStore('commands');
      const r = day ? store.index('scope').getAll([owner, day]) : store.index('owner').getAll(owner);
      r.onsuccess = () => done((r.result as WorkCommand[]).sort((a, b) => a.serviceDate.localeCompare(b.serviceDate) || a.sequence - b.sequence));
    });
  }
  async preparationVersion(owner: string, day: string) {
    return this.run<{ sequence: number; revision: number }>('readonly', (tx, done, fail) => {
      const state = tx.objectStore('work').get(workKey(owner, day));
      const online = tx.objectStore('control').get('online-write');
      const revision = tx.objectStore('control').get('revision');
      revision.onsuccess = () => {
        if (online.result) { fail(new Error(ONLINE_WRITE_PENDING)); return; }
        done({ sequence: state.result?.sequence ?? 0, revision: revision.result ?? 0 });
      };
    });
  }
  async install(snapshot: WorkSnapshot, expectedSequence?: number, expectedRevision?: number) {
    return this.run<boolean>('readwrite', (tx, done) => {
      const key = workKey(snapshot.ownerId, snapshot.serviceDate);
      const work = tx.objectStore('work');
      const old = work.get(key);
      const online = tx.objectStore('control').get('online-write');
      const revision = tx.objectStore('control').get('revision');
      const commands = tx.objectStore('commands').index('scope').getAll([snapshot.ownerId, snapshot.serviceDate]);
      commands.onsuccess = () => {
        // A server snapshot may already include an unacknowledged write. Never
        // combine it with optimistic deltas until every command is reconciled.
        if (online.result || commands.result.some(pendingCommand)
          || (expectedSequence != null && (old.result?.sequence ?? 0) !== expectedSequence)
          || (expectedRevision != null && (revision.result ?? 0) !== expectedRevision)
          || old.result?.lease?.until > Date.now()) { done(false); return; }
        // Open payment sheets and queued commands can still refer to the old
        // local ID after a full refresh has installed official bill IDs.
        const state: WorkState = { key, snapshot: old.result?.snapshot.chargeAliases
          ? { ...snapshot, chargeAliases: { ...old.result.snapshot.chargeAliases, ...snapshot.chargeAliases } } : snapshot,
          deviceId: old.result?.deviceId ?? newOfflineId(), sequence: old.result?.sequence ?? 0 };
        work.put(state);
        done(true);
      };
    });
  }
  async enqueue(input: Omit<WorkCommand, 'sequence' | 'deviceId' | 'status' | 'attempts' | 'nextAttemptAt'>,
    project: (snapshot: WorkSnapshot, command: WorkCommand) => WorkSnapshot) {
    // Store bytes, not a browser-managed Blob file reference. WebKit can lose
    // that backing file across reloads even though the IndexedDB row survives.
    if (input.evidence) {
      const file = input.evidence;
      if (file.size > 5 * 1024 * 1024) throw new Error('หลักฐานต้องมีขนาดไม่เกิน 5 MB');
      const bytes = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error ?? new Error('ไม่สามารถอ่านหลักฐานการชำระได้'));
        reader.readAsArrayBuffer(file);
      });
      input = { ...input, evidence: undefined, evidenceData: { bytes, type: file.type } };
    }
    return this.run<WorkCommand>('readwrite', (tx, done, fail) => {
      const commands = tx.objectStore('commands');
      const online = tx.objectStore('control').get('online-write');
      const previous = commands.get(input.id);
      previous.onsuccess = () => {
        if (online.result) { fail(new Error(ONLINE_WRITE_PENDING)); return; }
        const existing = previous.result as WorkCommand | undefined;
        if (existing) {
          if (existing.ownerId !== input.ownerId || existing.serviceDate !== input.serviceDate || existing.rpc !== input.rpc
            || JSON.stringify(existing.args) !== JSON.stringify(input.args) || JSON.stringify(existing.expected) !== JSON.stringify(input.expected)) {
            fail(new Error('รหัสรายการนี้ถูกใช้กับข้อมูลอื่นแล้ว')); return;
          }
          done(existing); return;
        }
        const work = tx.objectStore('work');
        const request = work.get(workKey(input.ownerId, input.serviceDate));
        request.onsuccess = () => {
          const state = request.result as WorkState | undefined;
          const pending = commands.index('owner').getAll(input.ownerId);
          pending.onsuccess = () => {
            try {
              if (!state || !Number.isFinite(Date.parse(state.snapshot.validUntil)) || Date.parse(state.snapshot.validUntil) <= Date.now()
                || state.snapshot.profile.id !== input.ownerId || !state.snapshot.profile.is_active
                || state.snapshot.profile.role !== 'courier') throw new Error('ข้อมูลออฟไลน์หมดอายุ กรุณาเตรียมข้อมูลวันนี้');
              if (!Number.isFinite(Date.parse(input.recordedAt)) || toBangkokDateString(new Date(input.recordedAt)) !== input.serviceDate)
                throw new Error('วันที่รายการไม่ตรงกับวันงาน กรุณาเปิดรายการใหม่');
              if (pending.result.some((c: WorkCommand) => c.status === 'blocked')) throw new Error('ระบบรับรายการไม่ได้ กรุณาให้ผู้ดูแลแก้ไข แล้วลองส่งรายการค้างอีกครั้ง');
              if (pending.result.some((c: WorkCommand) => c.status === 'auth_required')) throw new Error('กรุณาเข้าสู่ระบบและซิงก์รายการเดิมก่อนทำรายการเพิ่ม');
              if (pending.result.some((c: WorkCommand) => c.status === 'conflict' || (c.serviceDate !== input.serviceDate && pendingCommand(c)))) throw new Error('มีรายการรอตรวจสอบ กรุณาติดต่อหัวหน้าก่อนทำรายการเพิ่ม');
              const command: WorkCommand = { ...input, sequence: state.sequence + 1, deviceId: state.deviceId,
                status: 'pending', attempts: 0, nextAttemptAt: 0 };
              const snapshot = project(structuredClone(state.snapshot), command);
              work.put({ ...state, sequence: command.sequence, snapshot });
              commands.add(command);
              done(command);
            } catch (error) {
              fail(error);
            }
          };
        };
      };
    });
  }
  async beginOnlineWrite(holder: string, retryKey?: string, ownerId?: string) {
    return this.run<void>('readwrite', (tx, done, fail) => {
      const control = tx.objectStore('control'); const lease = control.get('online-write');
      const commands = tx.objectStore('commands').getAll();
      const work = tx.objectStore('work'); const states = work.getAll();
      states.onsuccess = () => {
        if (commands.result.some(pendingCommand)) {
          fail(new Error('มีรายการค้างซิงก์หรือกำลังบันทึก กรุณารอให้เสร็จก่อนใช้รายการออนไลน์')); return;
        }
        if (lease.result && (!retryKey || lease.result.retryKey !== retryKey || lease.result.ownerId !== ownerId)) {
          fail(new Error(ONLINE_WRITE_PENDING)); return;
        }
        // No time-based expiry: a suspended tab or lost response is not proof
        // that the server stopped writing. Only the identical operation may replay.
        control.put({ holder, retryKey, ownerId, startedAt: Date.now() } satisfies OnlineWrite, 'online-write');
        advanceRevision(tx);
        for (const state of states.result) work.put({ ...state, snapshot: { ...state.snapshot, validUntil: new Date(0).toISOString() } });
        done(undefined);
      };
    });
  }
  async onlineResult(ownerId: string | undefined, retryKey: string) {
    return this.run<OnlineWriteResult | undefined>('readonly', (tx, done) => {
      const request = tx.objectStore('control').get(onlineResultKey(ownerId, retryKey));
      request.onsuccess = () => done(request.result);
    });
  }
  async endOnlineWrite(holder: string, confirmed?: OnlineWriteResult) {
    return this.run<void>('readwrite', (tx, done) => {
      const control = tx.objectStore('control'); const lease = control.get('online-write');
      lease.onsuccess = () => {
        if (lease.result?.holder === holder) {
          // Keep the acknowledgement across refresh/restart before releasing
          // the write fence. An open draft must consume it without projecting again.
          if (confirmed && lease.result.retryKey) control.put(confirmed, onlineResultKey(lease.result.ownerId, lease.result.retryKey));
          control.delete('online-write'); advanceRevision(tx);
        }
        done(undefined);
      };
    });
  }
  async invalidate(owner: string, day: string) {
    return this.run<void>('readwrite', (tx, done) => {
      advanceRevision(tx);
      const work = tx.objectStore('work'); const r = work.get(workKey(owner, day));
      r.onsuccess = () => {
        if (r.result) work.put({ ...r.result, snapshot: { ...r.result.snapshot, validUntil: new Date(0).toISOString() } });
        done(undefined);
      };
    });
  }
  async update(command: WorkCommand) {
    return this.run<void>('readwrite', (tx, done) => {
      tx.objectStore('commands').put(command);
      if (command.status === 'applied' && command.type === 'delivery' && typeof command.result?.charge_id === 'string') {
        advanceRevision(tx);
        const work = tx.objectStore('work'); const r = work.get(workKey(command.ownerId, command.serviceDate));
        r.onsuccess = () => {
          const state = r.result as WorkState | undefined;
          if (!state) return;
          const localId = `local:${command.id}`;
          const result = command.result!;
          state.snapshot.chargeAliases = { ...state.snapshot.chargeAliases, [localId]: result.charge_id as string };
          for (const shop of state.snapshot.collection.queue) for (const charge of shop.charges) {
            if (charge.charge_id !== localId) continue;
            charge.charge_id = result.charge_id as string;
            if (typeof result.charge_number === 'string' || result.charge_number === null) charge.charge_number = result.charge_number;
            if (typeof result.delivery_event_id === 'string') charge.delivery_event_id = result.delivery_event_id;
          }
          work.put(state);
        };
      }
      if (command.status === 'discard_approved') {
        advanceRevision(tx);
        const work = tx.objectStore('work'); const r = work.get(workKey(command.ownerId, command.serviceDate));
        r.onsuccess = () => {
          if (r.result) work.put({ ...r.result, snapshot: { ...r.result.snapshot, validUntil: new Date(0).toISOString() } });
        };
      }
      done(undefined);
    });
  }
  async claim(owner: string, day: string, holder: string, now = Date.now()) {
    return this.run<boolean>('readwrite', (tx, done) => {
      const store = tx.objectStore('work');
      const r = store.get(workKey(owner, day));
      r.onsuccess = () => {
        const state = r.result as WorkState | undefined;
        if (!state || (state.lease && state.lease.holder !== holder && state.lease.until > now)) { done(false); return; }
        store.put({ ...state, lease: { holder, until: now + 60_000 } }); done(true);
      };
    });
  }
  async release(owner: string, day: string, holder: string) {
    return this.run<void>('readwrite', (tx, done) => {
      const store = tx.objectStore('work'); const r = store.get(workKey(owner, day));
      r.onsuccess = () => {
        if (r.result?.lease?.holder === holder) store.put({ ...r.result, lease: undefined });
        done(undefined);
      };
    });
  }
  async hasPending() {
    return this.run<boolean>('readonly', (tx, done) => {
      const online = tx.objectStore('control').get('online-write');
      const r = tx.objectStore('commands').getAll();
      r.onsuccess = () => done(Boolean(online.result) || r.result.some(pendingCommand));
    });
  }
  async hasOnlineWrite() {
    return this.run<boolean>('readonly', (tx, done) => {
      const r = tx.objectStore('control').get('online-write'); r.onsuccess = () => done(Boolean(r.result));
    });
  }
  async onlineWrite() {
    return this.run<OnlineWrite | undefined>('readonly', (tx, done) => {
      const r = tx.objectStore('control').get('online-write'); r.onsuccess = () => done(r.result);
    });
  }
  async close() { (await this.connection)?.close(); this.connection = undefined; }
}
