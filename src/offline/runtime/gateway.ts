import type { EmployeeDeliveryGateway, EmployeeDeliveryPayload, EmployeeImmediateSalePayload, EmployeeStockTransferPayload } from '../../EmployeeDeliveryWorkspace';
import type { DeliveryFinancialResult, EmployeeStockState, ImmediateSaleResult } from '../../types/app';
import { contextPolicy, stockPolicy } from './project';
import { runOnlineOnlyEmployeeWrite, type EmployeeRuntime } from './client';
import { pendingCommand, type OfflineOperation, type WorkCommand, type WorkSnapshot } from './types';
import { isTransportFailure } from './network';

export function createOfflineGateway(live: EmployeeDeliveryGateway, runtime: EmployeeRuntime): EmployeeDeliveryGateway {
  const pendingEvidence = new Map<string, File>();
  const livePosStops = new Set<string>();
  const liveStockRounds = new Set<string>();
  const pending = () => runtime.engine.getSnapshot().commands.some(pendingCommand);
  const savedRead = <T,>(snapshot: WorkSnapshot | undefined, select: (snapshot: WorkSnapshot) => T | undefined) => {
    const value = snapshot && select(snapshot);
    if (value === undefined) throw new Error(pending()
      ? 'มีรายการค้างซิงก์ ต้องตรวจสอบก่อนโหลดข้อมูลใหม่'
      : 'ข้อมูลออฟไลน์ของวันนี้ยังไม่พร้อม กรุณาเปิดเน็ตและรอจนขึ้น “พร้อมทำงาน แม้ไม่มีเน็ต”');
    return { value, snapshot };
  };
  async function read<T>(select: (snapshot: WorkSnapshot) => T | undefined, request: () => Promise<T>) {
    const snapshot = await runtime.snapshot();
    // A pending projection can already include a server commit whose response
    // was lost. Never replace it with an unrelated live read.
    if (!navigator.onLine || pending()) return savedRead(snapshot, select);
    try {
      const value = await request();
      const latest = await runtime.snapshot();
      if (pending()) return savedRead(latest, select);
      return { value, snapshot: undefined };
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      const latest = await runtime.snapshot();
      if (!latest || select(latest) === undefined) throw error;
      return savedRead(latest, select);
    }
  }
  const useLiveWrite = (readLive: boolean, id: string) => navigator.onLine && readLive && !pending()
    && !runtime.engine.getSnapshot().commands.some(command => command.id === id);
  const onlineKey = (operation: string, payload: unknown) => JSON.stringify({ kind: 'gateway', operation, payload });
  const confirmedOnline = (operation: string, payload: unknown) => runtime.engine.store.onlineResult(runtime.engine.owner, onlineKey(operation, payload));
  const online = async <T,>(operation: string, payload: unknown, action: () => Promise<T>) => {
    const result = await runOnlineOnlyEmployeeWrite(action, onlineKey(operation, payload));
    void runtime.prepare(true);
    return result;
  };
  async function queue(type: OfflineOperation, rpc: string, args: Record<string, unknown>, expected: Record<string, unknown>, label: string, recordedAt = new Date().toISOString()) {
    const id = String(args.p_idempotency_key);
    const command = await runtime.engine.submit({ id, type, rpc, args, expected, label, recordedAt, evidence: pendingEvidence.get(id) });
    pendingEvidence.delete(id);
    // Confirmation is independent of refreshing the full prepared snapshot.
    // A failed refresh must not disable the already updated local projection.
    if (command.status === 'applied') void runtime.prepare(true);
    else void runtime.tick();
    return command;
  }
  async function snapshotForWrite() {
    const snapshot = await runtime.snapshot();
    if (!snapshot && runtime.engine.getSnapshot().commands.some(pendingCommand)) throw new Error('มีรายการค้างซิงก์ ต้องตรวจสอบก่อนทำรายการใหม่');
    return snapshot;
  }
  async function stock(type: 'stock_transfer' | 'stock_return' | 'stock_damage', payload: EmployeeStockTransferPayload) {
    const confirmed = await confirmedOnline(type, payload);
    if (confirmed) return confirmed.value as EmployeeStockState;
    const snapshot = await snapshotForWrite();
    if (!snapshot || useLiveWrite(liveStockRounds.has(payload.roundId), payload.idempotencyKey)) return online(type, payload, () => (type === 'stock_transfer' ? live.recordEmployeeStockTransfer : type === 'stock_return' ? live.recordEmployeeStockReturn : live.recordEmployeeStockDamage)(payload));
    const current = snapshot.stocks[payload.roundId];
    if (!current) throw new Error('ยังไม่ได้เตรียมสต๊อกของรอบนี้');
    const command = await queue(type, `record_employee_${type}`, { p_round_id: payload.roundId, p_items: payload.items, p_idempotency_key: payload.idempotencyKey },
      stockPolicy(current), type === 'stock_transfer' ? 'เบิกน้ำแข็ง' : type === 'stock_return' ? 'คืนน้ำแข็ง' : 'น้ำแข็งละลาย/เสีย');
    if (command.status === 'applied') return command.result as unknown as EmployeeStockState;
    return { ...runtime.engine.getSnapshot().snapshot!.stocks[payload.roundId], offline_pending: true };
  }
  async function delivery(payload: EmployeeDeliveryPayload): Promise<DeliveryFinancialResult | void> {
    const confirmed = await confirmedOnline('delivery', payload);
    if (confirmed) return confirmed.value as DeliveryFinancialResult | void;
    // Approval validity/fingerprint belongs to the server. Never relax the
    // offline credit limit merely because a caller supplies an approval ID.
    if (payload.approvalId) return online('delivery', payload, () => live.recordDelivery(payload));
    const snapshot = await snapshotForWrite();
    if (!snapshot || useLiveWrite(livePosStops.has(payload.roundStopId), payload.idempotencyKey)) return online('delivery', payload, () => live.recordDelivery(payload));
    const context = snapshot.contexts[payload.roundStopId];
    if (!context) throw new Error('ยังไม่ได้เตรียมข้อมูลร้านนี้');
    const event = payload.destinationKind === 'event';
    const command = await queue('delivery', event ? 'record_event_ice_delivery' : 'record_delivery_with_vat_check', {
      p_round_stop_id: payload.roundStopId, p_items: payload.items, p_stop_status: payload.status, p_note: payload.note,
      p_client_recorded_at: payload.clientRecordedAt, p_idempotency_key: payload.idempotencyKey,
      ...(!event ? { p_payment_term: payload.paymentTerm, p_approval_id: payload.approvalId ?? null,
        p_expected_vat_rate: payload.expectedVatRate ?? 0, p_expected_total: payload.expectedTotal ?? null } : {}),
    }, { ...contextPolicy(context), expected_total: payload.expectedTotal ?? null }, `${context.shop.code} ${context.shop.name}`, payload.clientRecordedAt);
    return command.status === 'applied' ? command.result as unknown as DeliveryFinancialResult : localDelivery(command, payload, snapshot.serviceDate);
  }
  async function immediate(payload: EmployeeImmediateSalePayload): Promise<ImmediateSaleResult> {
    const confirmed = await confirmedOnline('immediate_sale', payload);
    if (confirmed) return confirmed.value as ImmediateSaleResult;
    const snapshot = await snapshotForWrite();
    if (!snapshot || useLiveWrite(livePosStops.has(payload.roundStopId), payload.idempotencyKey)) {
      if (!live.recordImmediateSale) throw new Error('ยังไม่พร้อมรับชำระ');
      let evidencePath = payload.evidencePath;
      if (evidencePath?.startsWith('offline:')) {
        const evidence = pendingEvidence.get(payload.idempotencyKey);
        if (!evidence || !live.uploadPaymentEvidence) throw new Error('กรุณาแนบหลักฐานรับเงินอีกครั้ง');
        evidencePath = await live.uploadPaymentEvidence(evidence, payload.idempotencyKey);
      }
      const onlinePayload = { ...payload, evidencePath };
      return online('immediate_sale', onlinePayload, async () => {
        const result = await live.recordImmediateSale!(onlinePayload);
        pendingEvidence.delete(payload.idempotencyKey);
        return result;
      });
    }
    const context = snapshot.contexts[payload.roundStopId];
    if (!context) throw new Error('ยังไม่ได้เตรียมข้อมูลร้านนี้');
    const command = await queue('immediate_sale', 'record_immediate_sale', {
      p_round_stop_id: payload.roundStopId, p_items: payload.items, p_note: payload.note, p_client_recorded_at: payload.clientRecordedAt,
      p_payment_method: payload.paymentMethod, p_received_amount: payload.receivedAmount, p_reference_number: payload.referenceNumber,
      p_evidence_path: payload.evidencePath?.startsWith('offline:') ? null : payload.evidencePath,
      p_expected_total: payload.expectedTotal, p_idempotency_key: payload.idempotencyKey,
    }, contextPolicy(context), `ส่งและรับเงิน ${context.shop.code}`, payload.clientRecordedAt);
    if (command.status === 'applied') return command.result as unknown as ImmediateSaleResult;
    return { offline_pending: true, delivery: localDelivery(command, { ...payload, status: 'delivered', paymentTerm: 'immediate', destinationKind: 'regular' }, snapshot.serviceDate),
      payment: { payment_id: `local:${command.id}`, shop_id: context.shop.id, payment_method: payload.paymentMethod,
        received_amount: payload.receivedAmount, allocated_amount: payload.expectedTotal, change_amount: Math.round((payload.receivedAmount - payload.expectedTotal) * 100) / 100, status: 'active' },
      receipt_number: `TMP-${command.id}`, print_document: null };
  }
  return {
    ...live,
    recordPayment: live.recordPayment ? p => online('payment', p, () => live.recordPayment!(p)) : undefined,
    recordCasualTransaction: live.recordCasualTransaction ? p => online('casual', p, () => live.recordCasualTransaction!(p)) : undefined,
    voidCasualTransaction: live.voidCasualTransaction ? p => online('void_casual', p, () => live.voidCasualTransaction!(p)) : undefined,
    requestFinancialApproval: live.requestFinancialApproval ? p => online('approval', p, () => live.requestFinancialApproval!(p)) : undefined,
    get offlineReady() { const s = runtime.engine.getSnapshot().snapshot; return Boolean(s && Date.parse(s.validUntil) > Date.now()); },
    async loadReferenceData(day) {
      if (day !== runtime.engine.day) return live.loadReferenceData(day);
      return (await read(s => ({ rounds: s.rounds, iceTypes: s.iceTypes }), () => live.loadReferenceData(day))).value;
    },
    async loadShopCards(roundId, options) {
      const result = await read(s => s.cards[roundId], () => live.loadShopCards(roundId, options));
      if (result.snapshot) options?.onBaseCards?.(result.value);
      return result.value;
    },
    async loadEmployeeStockState(roundId) {
      liveStockRounds.delete(roundId);
      const result = await read(s => s.stocks[roundId], () => live.loadEmployeeStockState(roundId));
      if (!result.snapshot) liveStockRounds.add(roundId);
      return result.value;
    },
    async loadDeliveryPosContext(id, options) {
      livePosStops.delete(id);
      const result = await read(s => s.contexts[id], async () => {
        if (!live.loadDeliveryPosContext) throw new Error('ยังไม่ได้เตรียมข้อมูลร้านนี้');
        return live.loadDeliveryPosContext(id, options);
      });
      if (!result.snapshot) { livePosStops.add(id); return result.value; }
      return { ...result.value, offline_snapshot: true, client_cache: { cached_at: result.snapshot.preparedAt, stale: false } };
    },
    async loadCollectionOutstanding(day) {
      const load = async () => live.loadCollectionOutstanding?.(day) ?? [];
      if (day !== runtime.engine.day) return load();
      return (await read(s => s.collection.queue.map(shop => ({ queueKey: shop.queue_key ?? `regular:${shop.shop_id}`, shopId: shop.shop_id,
        eventParticipationId: shop.event_participation_id, outstandingAmount: shop.outstanding_amount })), load)).value;
    },
    async loadShopCreditEligibility(shopId, serviceDate) {
      // Credit documents require current server invoices, not the cached payment profile.
      if (!navigator.onLine) return false;
      return live.loadShopCreditEligibility?.(shopId, serviceDate) ?? false;
    },
    invalidateDeliveryPosContextCache() {
      if (navigator.onLine) runtime.invalidateSnapshot(false);
      if (navigator.onLine || !runtime.engine.getSnapshot().snapshot) live.invalidateDeliveryPosContextCache?.();
    },
    recordDelivery: delivery, recordImmediateSale: immediate,
    recordEmployeeStockTransfer: p => stock('stock_transfer', p), recordEmployeeStockReturn: p => stock('stock_return', p), recordEmployeeStockDamage: p => stock('stock_damage', p),
    async uploadPaymentEvidence(file, id) {
      const snapshot = await runtime.snapshot();
      if (!snapshot || (navigator.onLine && livePosStops.size > 0 && !pending())) {
        if (!live.uploadPaymentEvidence) throw new Error('ยังไม่พร้อมรับหลักฐาน');
        try { return await live.uploadPaymentEvidence(file, id); }
        catch (error) {
          if (!snapshot || !isTransportFailure(error)) throw error;
          // Keep the evidence and ensuing sale together in the offline queue.
          livePosStops.clear();
        }
      }
      if (file.size > 5 * 1024 * 1024) throw new Error('หลักฐานต้องมีขนาดไม่เกิน 5 MB');
      pendingEvidence.set(id, file); return `offline:${id}`;
    },
    async deletePaymentEvidence(path, id) { if (path.startsWith('offline:')) pendingEvidence.delete(id); else await live.deletePaymentEvidence?.(path, id); },
  };
}
function localDelivery(command: WorkCommand, payload: EmployeeDeliveryPayload, day: string): DeliveryFinancialResult {
  return { offline_pending: true, delivery_event_id: `local:${command.id}`, round_stop_id: payload.roundStopId,
    charge_id: payload.status === 'delivered' ? `local:${command.id}` : null, service_date: day, total_amount: payload.expectedTotal ?? null, payment_term: payload.paymentTerm,
    payment_status: null, due_date: null, approval_id: payload.approvalId ?? null, print_document: null };
}
