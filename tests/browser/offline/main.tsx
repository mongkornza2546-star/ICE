import React, { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkStore } from '../../../src/offline/runtime/store';
import { OfflineEngine } from '../../../src/offline/runtime/engine';
import { createOfflineGateway } from '../../../src/offline/runtime/gateway';
import { OfflineStatus } from '../../../src/offline/runtime/OfflineStatus';
import { offlineSnapshot } from '../../helpers/offlineSnapshot';
import type { EmployeeRuntime } from '../../../src/offline/runtime/client';
import { runOnlineOnlyEmployeeWrite } from '../../../src/offline/runtime/client';
import type { EmployeeDeliveryGateway } from '../../../src/EmployeeDeliveryWorkspace';
import { toBangkokDateString } from '../../../src/lib/serviceDate';
import { pendingCommand } from '../../../src/offline/runtime/types';
import '../../../src/index.css';

const owner = '10000000-0000-4000-8000-000000000001';
const day = toBangkokDateString();
const store = new WorkStore();
const engine = new OfflineEngine(owner, day, store, {
  send: async (command, signal) => {
    const response = await fetch('/api/command', { method: 'POST', body: JSON.stringify(command), signal });
    if (!response.ok) throw new Error('Network response failed');
    return response.json();
  },
  upload: async (blob, command) => {
    const response = await fetch(`/api/evidence/${command.id}`, { method: 'POST', body: blob });
    if (!response.ok) throw new Error('Evidence upload failed');
    return (await response.json()).path;
  },
  resolutions: async () => [],
});
const runtime = { engine, snapshot: async () => { await engine.reload(); return engine.getSnapshot().snapshot; },
  prepare: async () => {}, start: () => () => {}, tick: async () => {} } satisfies EmployeeRuntime;
const gateway = createOfflineGateway({} as EmployeeDeliveryGateway, runtime);
const api = {
  async verifyOnlineCoordination() {
    const snapshot = structuredClone(engine.getSnapshot().snapshot!);
    const version = await store.preparationVersion(owner, day);
    try {
      await runOnlineOnlyEmployeeWrite(async () => { throw new TypeError('Load failed'); }, 'browser-original');
    } catch { /* Deliberately lose the online reply. */ }
    await store.close();
    const pendingAfterReopen = await store.hasPending();
    const installedWhilePending = await store.install(snapshot, version.sequence, version.revision);
    let otherWriteBlocked = false;
    try { await runOnlineOnlyEmployeeWrite(async () => {}, 'browser-different'); }
    catch { otherWriteBlocked = true; }
    await runOnlineOnlyEmployeeWrite(async () => ({ receipt_number: 'CONFIRMED' }), 'browser-original');
    const staleInstalled = await store.install(snapshot, version.sequence, version.revision);
    const fresh = await store.preparationVersion(owner, day);
    const freshInstalled = await engine.install(snapshot, fresh.sequence, fresh.revision);
    return { pendingAfterReopen, installedWhilePending, otherWriteBlocked, staleInstalled, freshInstalled };
  },
  async prepare() {
    const s = offlineSnapshot();
    s.serviceDate = day; s.preparedAt = new Date().toISOString();
    s.validUntil = new Date(new Date(`${day}T00:00:00+07:00`).getTime() + 86400000).toISOString();
    s.rounds[0].service_date = day; s.stocks.round.service_date = day; s.contexts.stop.service_date = day;
    s.contexts.stop.offline_collection_template = { queue_key: 'regular:shop', collection_scope: 'shop', destination_kind: 'regular', shop_id: 'shop', shop_code: 'S', shop_name: 'ร้านทดสอบ', image_path: null, outstanding_amount: 0, charge_count: 0, has_new_charges: false, charges: [], payment_profile: { allowed_payment_methods: ['cash', 'bank_transfer'], default_payment_method: 'cash', cash_reference_required: false, cash_evidence_required: false, bank_transfer_reference_required: false, bank_transfer_evidence_required: true, qr_reference_required: false, qr_evidence_required: true } };
    return engine.install(s);
  },
  withdraw: () => gateway.recordEmployeeStockTransfer({ roundId: 'round', items: [{ ice_type_id: 'ice', quantity: 5 }], idempotencyKey: crypto.randomUUID() }),
  deliver: (quantity = 2) => gateway.recordDelivery({ roundStopId: 'stop', items: [{ ice_type_id: 'ice', quantity }], status: 'delivered', note: null, clientRecordedAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(), paymentTerm: 'end_of_day', destinationKind: 'regular', expectedTotal: quantity * 25, expectedVatRate: 0 }),
  async collect() {
    await engine.reload(); const row = engine.getSnapshot().snapshot!.collection.queue[0];
    return engine.enqueue({ id: crypto.randomUUID(), type: 'collection_payment', rpc: 'record_shop_collection_payment', recordedAt: new Date().toISOString(), label: 'รับเงิน ร้านทดสอบ', evidence: new Blob(['proof-on-device'], { type: 'image/png' }),
      args: { p_expected_outstanding_amount: row.outstanding_amount, p_allocations: [{ charge_id: row.charges[0].charge_id, amount: 30 }], p_payment_method: 'bank_transfer', p_received_amount: 30, p_evidence_path: null },
      expected: { queueKey: row.queue_key, payment_profile: row.payment_profile, charges: row.charges.map(c => ({ charge_id: c.charge_id, outstanding_amount: c.outstanding_amount })) } });
  },
  sync: () => engine.sync(true),
  async state() { await engine.reload(); return engine.getSnapshot(); },
  async evidence() { return Promise.all((await store.commands(owner)).filter(c => c.evidenceData || c.evidence).map(async c => ({ id: c.id,
    text: c.evidenceData ? new TextDecoder().decode(c.evidenceData.bytes) : await c.evidence!.text(), path: c.evidencePath }))); },
  async otherOwner() { return { work: await store.read('other', day), commands: await store.commands('other') }; },
};
Object.assign(window, { offlineTest: api });
function App() {
  const view = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  return <main className="app-shell" style={{ maxWidth: 480, margin: 'auto', padding: 16 }}>
    <h1>ทดสอบงานออฟไลน์</h1><p>ข้อมูลจำลองสำหรับตรวจสอบการเก็บงานในเครื่อง</p>
    <OfflineStatus runtime={runtime} />
    <p data-testid="stock">สต๊อกที่ถือ: {view.snapshot?.stocks.round.holding_location.balances[0].quantity ?? '—'}</p>
    <p data-testid="outstanding">ยอดค้าง: {view.snapshot?.collection.queue[0]?.outstanding_amount ?? 0}</p>
    <p data-testid="pending">รอซิงก์: {view.commands.filter(pendingCommand).length}</p>
    <button onClick={() => void api.prepare()}>เตรียมงานทดสอบ</button>
    <button onClick={() => void api.withdraw()}>เบิก 5 ถุง</button>
    <button onClick={() => void api.deliver()}>ส่ง 2 ถุง</button>
    <button onClick={() => void api.collect()}>รับโอน 30 บาท</button>
  </main>;
}
await engine.reload();
createRoot(document.getElementById('root')!).render(<App />);
