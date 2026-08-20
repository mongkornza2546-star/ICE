import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle,
  Gift,
  Money,
  Printer,
  Receipt,
  UserCircle,
  WarningCircle,
} from '@phosphor-icons/react';
import type {
  CasualTransactionContext,
  CasualTransactionHistoryItem,
  CasualTransactionKind,
  CasualTransactionResult,
  DeliveryRound,
  PaymentMethod,
} from '../../types/app';
import type { StoredSalesDocument } from '../../lib/salesDocumentPrint';
import { printSalesDocument, salesDocumentFromStored } from '../../lib/salesDocumentPrint';
import { publishDataChange } from '../../lib/dataChange';
import { MAX_PAYMENT_EVIDENCE_SIZE } from '../../lib/paymentEvidence';
import { usePendingRequests } from './usePendingRequests';

const money = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 0,
});

const dateTime = new Intl.DateTimeFormat('th-TH', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Bangkok',
});

const paymentLabels: Record<PaymentMethod, string> = {
  cash: 'เงินสด',
  bank_transfer: 'โอนเงิน',
  qr: 'QR',
};

type RecordPayload = {
  roundId: string;
  iceTypeId: string;
  quantity: number;
  transactionKind: CasualTransactionKind;
  saleAmount: number;
  paymentMethod: PaymentMethod | null;
  receivedAmount: number | null;
  referenceNumber: string | null;
  evidencePath: string | null;
  note: string | null;
  clientRecordedAt: string;
  idempotencyKey: string;
};

type VoidPayload = {
  transactionId: string;
  reason: string;
  refundMethod: PaymentMethod | null;
  referenceNumber: string | null;
  evidencePath: string | null;
  idempotencyKey: string;
};

type PendingEvidenceRequest = {
  signature: string;
  key: string;
  evidencePath: string | null;
};

function fileIdentity(file: File | null) {
  return file ? { name: file.name, size: file.size, lastModified: file.lastModified, type: file.type } : null;
}

export function EmployeeCasualCustomerPage({
  deleteEvidence,
  loadContext,
  loadReceipt,
  onBack,
  onDraftStateChange,
  recordTransaction,
  round,
  serviceDateLabel,
  uploadEvidence,
  voidTransaction,
}: {
  deleteEvidence: (path: string, idempotencyKey: string) => Promise<void>;
  loadContext: (roundId: string) => Promise<CasualTransactionContext>;
  loadReceipt: (transactionId: string) => Promise<StoredSalesDocument>;
  onBack: () => void;
  onDraftStateChange?: (state: { dirty: boolean; submitting: boolean }) => void;
  recordTransaction: (payload: RecordPayload) => Promise<CasualTransactionResult>;
  round: DeliveryRound;
  serviceDateLabel: string;
  uploadEvidence: (file: File, idempotencyKey: string) => Promise<string>;
  voidTransaction: (payload: VoidPayload) => Promise<CasualTransactionResult>;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const recordRetryRef = useRef<PendingEvidenceRequest | null>(null);
  const voidRetryRef = useRef<PendingEvidenceRequest | null>(null);
  const {
    clearPendingRequest,
    getOrCreatePendingRequest,
    setPendingRequestEvidencePath,
  } = usePendingRequests();
  const [context, setContext] = useState<CasualTransactionContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [latestReceipt, setLatestReceipt] = useState<StoredSalesDocument | null>(null);
  const [iceTypeId, setIceTypeId] = useState('');
  const [quantity, setQuantity] = useState(0.5);
  const [kind, setKind] = useState<CasualTransactionKind>('paid');
  const [saleAmount, setSaleAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [receivedAmount, setReceivedAmount] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [evidence, setEvidence] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [voidTarget, setVoidTarget] = useState<CasualTransactionHistoryItem | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [refundMethod, setRefundMethod] = useState<PaymentMethod>('cash');
  const [refundReference, setRefundReference] = useState('');
  const [refundEvidence, setRefundEvidence] = useState<File | null>(null);

  useLayoutEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const dirty = Boolean(
    busy || saleAmount || receivedAmount || referenceNumber || evidence || note
    || quantity !== 0.5 || kind !== 'paid' || voidTarget || voidReason || refundReference || refundEvidence,
  );

  useEffect(() => {
    onDraftStateChange?.({ dirty, submitting: busy });
  }, [busy, dirty, onDraftStateChange]);

  useEffect(() => () => {
    onDraftStateChange?.({ dirty: false, submitting: false });
  }, [onDraftStateChange]);

  const preparePendingRequest = (
    retryRef: typeof recordRetryRef,
    signature: string,
  ) => {
    const previous = retryRef.current;
    if (previous && previous.signature !== signature) {
      clearPendingRequest(previous.signature, previous.key);
      if (previous.evidencePath) {
        void deleteEvidence(previous.evidencePath, previous.key).catch(() => undefined);
      }
      retryRef.current = null;
    }
    const request = getOrCreatePendingRequest(signature);
    const retry = retryRef.current?.signature === signature
      ? retryRef.current
      : { signature, key: request.key, evidencePath: request.evidencePath ?? null };
    retryRef.current = retry;
    return { request, retry };
  };

  const selectEvidence = (
    file: File | null,
    setFile: (file: File | null) => void,
  ) => {
    if (file && file.size > MAX_PAYMENT_EVIDENCE_SIZE) {
      setFile(null);
      setError('หลักฐานต้องมีขนาดไม่เกิน 5 MB');
      return;
    }
    setFile(file);
    setError('');
  };

  const refresh = async () => {
    const next = await loadContext(round.id);
    setContext(next);
    setIceTypeId((current) => current || next.items.find((item) => Number(item.available_quantity) >= 0.5)?.ice_type_id || '');
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadContext(round.id)
      .then((next) => {
        if (cancelled) return;
        setContext(next);
        setIceTypeId(next.items.find((item) => Number(item.available_quantity) >= 0.5)?.ice_type_id ?? '');
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'โหลดข้อมูลลูกค้าขาจรไม่สำเร็จ');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [loadContext, round.id]);

  const selectedItem = useMemo(
    () => context?.items.find((item) => item.ice_type_id === iceTypeId) ?? null,
    [context, iceTypeId],
  );
  const available = Number(selectedItem?.available_quantity ?? 0);
  const sale = Number(saleAmount);
  const received = Number(receivedAmount);
  const needsEvidence = kind === 'paid' && paymentMethod !== 'cash';
  const validPaid = kind === 'paid'
    && Number.isInteger(sale) && sale > 0
    && Number.isInteger(received) && received >= sale
    && (paymentMethod === 'cash' || received === sale)
    && (!needsEvidence || Boolean(evidence));
  const canSubmit = !busy && !loading && Boolean(selectedItem)
    && quantity >= 0.5 && quantity <= available && Number.isInteger(quantity * 2)
    && (kind === 'free' || validPaid) && !context?.stock_closed;

  const resetForm = () => {
    setQuantity(0.5);
    setSaleAmount('');
    setReceivedAmount('');
    setReferenceNumber('');
    setEvidence(null);
    setNote('');
  };

  const submit = async () => {
    if (!canSubmit) return;
    const signature = `casual-record:${JSON.stringify({
      roundId: round.id, iceTypeId, quantity, kind, sale: kind === 'paid' ? sale : 0,
      paymentMethod: kind === 'paid' ? paymentMethod : null,
      received: kind === 'paid' ? received : null,
      referenceNumber: kind === 'paid' ? referenceNumber.trim() || null : null,
      note: note.trim() || null,
      evidence: needsEvidence ? fileIdentity(evidence) : null,
    })}`;
    const { request, retry } = preparePendingRequest(recordRetryRef, signature);
    let evidencePath = retry.evidencePath;
    let transactionRecorded = false;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      if (needsEvidence && evidence && !evidencePath) {
        evidencePath = await uploadEvidence(evidence, request.key);
        setPendingRequestEvidencePath(signature, request.key, evidencePath);
        recordRetryRef.current = { ...retry, evidencePath };
      }
      const result = await recordTransaction({
        roundId: round.id,
        iceTypeId,
        quantity,
        transactionKind: kind,
        saleAmount: kind === 'paid' ? sale : 0,
        paymentMethod: kind === 'paid' ? paymentMethod : null,
        receivedAmount: kind === 'paid' ? received : null,
        referenceNumber: kind === 'paid' ? referenceNumber.trim() || null : null,
        evidencePath,
        note: note.trim() || null,
        clientRecordedAt: request.clientRecordedAt,
        idempotencyKey: request.key,
      });
      transactionRecorded = true;
      clearPendingRequest(signature, request.key);
      recordRetryRef.current = null;
      publishDataChange(['accounting', 'payment', 'stock', 'pos']);
      setLatestReceipt(result.receipt);
      setSuccess(kind === 'paid'
        ? `บันทึกสำเร็จ · ${result.transaction.receipt_number ?? 'ออกใบรับเงินแล้ว'}`
        : 'บันทึกแจกฟรีสำเร็จ');
      resetForm();
      await refresh();
    } catch (cause) {
      setError(transactionRecorded
        ? 'บันทึกสำเร็จแล้ว แต่โหลดสต๊อกล่าสุดไม่สำเร็จ กรุณาออกแล้วเข้าหน้านี้ใหม่'
        : cause instanceof Error ? cause.message : 'บันทึกรายการไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const printReceipt = async (transactionId?: string) => {
    try {
      const document = transactionId ? await loadReceipt(transactionId) : latestReceipt;
      if (!document || !printSalesDocument(salesDocumentFromStored(document))) {
        setError('เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาต pop-up แล้วลองใหม่');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'เปิดใบรับเงินไม่สำเร็จ');
    }
  };

  const submitVoid = async () => {
    if (!voidTarget || !voidReason.trim() || busy) return;
    const isPaid = voidTarget.transaction_kind === 'paid';
    if (isPaid && refundMethod !== 'cash' && !refundEvidence) return;
    const signature = `casual-void:${JSON.stringify({
      transactionId: voidTarget.id,
      reason: voidReason.trim(),
      refundMethod: isPaid ? refundMethod : null,
      referenceNumber: isPaid ? refundReference.trim() || null : null,
      evidence: isPaid && refundMethod !== 'cash' ? fileIdentity(refundEvidence) : null,
    })}`;
    const { request, retry } = preparePendingRequest(voidRetryRef, signature);
    let evidencePath = retry.evidencePath;
    let transactionVoided = false;
    setBusy(true);
    setError('');
    try {
      if (isPaid && refundMethod !== 'cash' && refundEvidence && !evidencePath) {
        evidencePath = await uploadEvidence(refundEvidence, request.key);
        setPendingRequestEvidencePath(signature, request.key, evidencePath);
        voidRetryRef.current = { ...retry, evidencePath };
      }
      await voidTransaction({
        transactionId: voidTarget.id,
        reason: voidReason.trim(),
        refundMethod: isPaid ? refundMethod : null,
        referenceNumber: isPaid ? refundReference.trim() || null : null,
        evidencePath,
        idempotencyKey: request.key,
      });
      transactionVoided = true;
      clearPendingRequest(signature, request.key);
      voidRetryRef.current = null;
      publishDataChange(['accounting', 'payment', 'refund', 'stock', 'pos']);
      setLatestReceipt(null);
      if (isPaid) {
        setLatestReceipt(await loadReceipt(voidTarget.id).catch(() => null));
      }
      setSuccess('ยกเลิกรายการและคืนสต๊อกแล้ว');
      setVoidTarget(null);
      setVoidReason('');
      setRefundReference('');
      setRefundEvidence(null);
      await refresh();
    } catch (cause) {
      setError(transactionVoided
        ? 'ยกเลิกสำเร็จแล้ว แต่โหลดสต๊อกล่าสุดไม่สำเร็จ กรุณาเข้าหน้านี้ใหม่'
        : cause instanceof Error ? cause.message : 'ยกเลิกรายการไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="employee-entry employee-casual-page">
      <button aria-label="กลับไปเลือกร้าน" className="employee-back" disabled={busy} onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={20} weight="bold" />
        <span>กลับไปเลือกร้าน</span>
      </button>

      <section className="employee-entry-card employee-casual-page__header">
        <span className="employee-casual-page__icon"><UserCircle aria-hidden="true" size={38} weight="duotone" /></span>
        <div>
          <p className="employee-eyebrow">บันทึกส่งน้ำแข็ง · POS</p>
          <h1 ref={headingRef} tabIndex={-1}>ลูกค้าขาจร</h1>
          <p>{round.name} · {serviceDateLabel}{context ? ` · ${context.stock_source.name}` : ''}</p>
        </div>
      </section>

      {error ? <p className="employee-error" role="alert"><WarningCircle size={20} weight="fill" />{error}</p> : null}
      {success ? <div aria-live="polite" className="employee-success">
        <CheckCircle size={20} weight="fill" /><span>{success}</span>
        {latestReceipt ? <button className="employee-success__print" onClick={() => { void printReceipt(); }} type="button"><Printer size={17} />พิมพ์</button> : null}
      </div> : null}

      {loading ? <section className="employee-entry-section employee-casual-page__loading">กำลังโหลดสต๊อกและประวัติ...</section> : context ? <>
        <section className="employee-entry-section employee-casual-form" aria-labelledby="casual-sale-title">
          <div className="employee-casual-form__title">
            <span>1</span><div><h2 id="casual-sale-title">เลือกสินค้า</h2><p>รองรับเต็มถุงและครึ่งถุง ตัดสต๊อกทันที</p></div>
          </div>
          <div className="employee-casual-form__choices">
            {context.items.map((item) => <button
              className={item.ice_type_id === iceTypeId ? 'is-selected' : ''}
              disabled={Number(item.available_quantity) < 0.5}
              key={item.ice_type_id}
              onClick={() => { setIceTypeId(item.ice_type_id); setQuantity(0.5); }}
              type="button"
            ><strong>{item.name}</strong><small>เหลือ {Number(item.available_quantity).toLocaleString('th-TH')} {item.unit}</small></button>)}
          </div>
          <div className="employee-casual-quantity">
            <button disabled={quantity <= 0.5} onClick={() => setQuantity((value) => value - 0.5)} type="button">−</button>
            <label><span>จำนวน</span><strong>{quantity.toLocaleString('th-TH')} {selectedItem?.unit ?? 'ถุง'}</strong></label>
            <button disabled={quantity + 0.5 > available} onClick={() => setQuantity((value) => value + 0.5)} type="button">+</button>
          </div>
          <p className="employee-casual-stock-note">หลังบันทึกจะเหลือ {Math.max(0, available - quantity).toLocaleString('th-TH')} {selectedItem?.unit ?? 'ถุง'}</p>
        </section>

        <section className="employee-entry-section employee-casual-form" aria-labelledby="casual-kind-title">
          <div className="employee-casual-form__title"><span>2</span><div><h2 id="casual-kind-title">เลือกประเภท</h2></div></div>
          <div className="employee-casual-kind">
            <button className={kind === 'paid' ? 'is-selected' : ''} onClick={() => setKind('paid')} type="button"><Money size={24} /><strong>จ่ายทันที</strong></button>
            <button className={kind === 'free' ? 'is-selected' : ''} onClick={() => setKind('free')} type="button"><Gift size={24} /><strong>แจกฟรี</strong></button>
          </div>
          {kind === 'paid' ? <div className="employee-casual-payment">
            <label><span>ยอดขาย (บาท)</span><input inputMode="numeric" min="1" onChange={(event) => { setSaleAmount(event.target.value); if (paymentMethod !== 'cash') setReceivedAmount(event.target.value); }} step="1" type="number" value={saleAmount} /></label>
            <div className="employee-casual-methods">{(['cash', 'bank_transfer', 'qr'] as PaymentMethod[]).map((method) => <button className={paymentMethod === method ? 'is-selected' : ''} key={method} onClick={() => { setPaymentMethod(method); if (method !== 'cash' && saleAmount) setReceivedAmount(saleAmount); }} type="button">{paymentLabels[method]}</button>)}</div>
            <label><span>รับเงิน (บาท)</span><input inputMode="numeric" min={sale || 0} onChange={(event) => setReceivedAmount(event.target.value)} readOnly={paymentMethod !== 'cash'} step="1" type="number" value={receivedAmount} /></label>
            {paymentMethod === 'cash' && received >= sale && sale > 0 ? <p className="employee-casual-change">เงินทอน <strong>{money.format(received - sale)}</strong></p> : null}
            <label><span>เลขอ้างอิง (ไม่บังคับ)</span><input onChange={(event) => setReferenceNumber(event.target.value)} type="text" value={referenceNumber} /></label>
            {needsEvidence ? <label><span>หลักฐานการชำระ</span><input accept="image/*,application/pdf" onChange={(event) => selectEvidence(event.target.files?.[0] ?? null, setEvidence)} type="file" /></label> : null}
          </div> : null}
          <label className="employee-casual-note"><span>หมายเหตุ (ไม่บังคับ)</span><textarea onChange={(event) => setNote(event.target.value)} value={note} /></label>
          <button className="employee-primary-action" disabled={!canSubmit} onClick={() => { void submit(); }} type="button">{busy ? 'กำลังบันทึก...' : kind === 'paid' ? 'ยืนยันขายและรับเงิน' : 'ยืนยันแจกฟรี'}</button>
        </section>

        <section className="employee-history employee-casual-history" aria-labelledby="casual-history-title">
          <div className="employee-casual-history__heading"><div><Receipt size={22} /><h2 id="casual-history-title">ประวัติวันนี้</h2></div><span>{context.history.length} รายการ</span></div>
          {context.history.length === 0 ? <p className="employee-casual-history__empty">ยังไม่มีรายการขาจรวันนี้</p> : <div className="employee-casual-history__list">{context.history.map((item) => <article className={item.status === 'voided' ? 'is-voided' : ''} key={item.id}>
            <div><strong>{item.ice_type_name} · {Number(item.quantity).toLocaleString('th-TH')} {item.ice_type_unit}</strong><small>{dateTime.format(new Date(item.recorded_at))} · {item.transaction_kind === 'paid' ? paymentLabels[item.payment_method!] : 'แจกฟรี'}{item.receipt_number ? ` · ${item.receipt_number}` : ''}</small>{item.status === 'voided' ? <em>ยกเลิกแล้ว · {item.void_reason}</em> : null}</div>
            <b>{item.transaction_kind === 'paid' ? money.format(Number(item.sale_amount)) : 'ฟรี'}</b>
            <div className="employee-casual-history__actions">{item.receipt_number ? <button onClick={() => { void printReceipt(item.id); }} type="button"><Printer size={16} />พิมพ์</button> : null}{item.status === 'active' && !context.stock_closed ? <button onClick={() => setVoidTarget(item)} type="button">ยกเลิก</button> : null}</div>
          </article>)}</div>}
        </section>
      </> : null}

      {voidTarget ? <div className="employee-casual-void" role="dialog" aria-modal="true" aria-labelledby="casual-void-title">
        <section>
          <h2 id="casual-void-title">ยกเลิกรายการขาจร</h2>
          <p>{voidTarget.ice_type_name} {Number(voidTarget.quantity).toLocaleString('th-TH')} {voidTarget.ice_type_unit}{voidTarget.transaction_kind === 'paid' ? ` · คืนเงินเต็มจำนวน ${money.format(Number(voidTarget.sale_amount))}` : ''}</p>
          <label><span>เหตุผลการยกเลิก</span><textarea autoFocus onChange={(event) => setVoidReason(event.target.value)} value={voidReason} /></label>
          {voidTarget.transaction_kind === 'paid' ? <>
            <div className="employee-casual-methods">{(['cash', 'bank_transfer', 'qr'] as PaymentMethod[]).map((method) => <button className={refundMethod === method ? 'is-selected' : ''} key={method} onClick={() => setRefundMethod(method)} type="button">คืน{paymentLabels[method]}</button>)}</div>
            <label><span>เลขอ้างอิงการคืน (ไม่บังคับ)</span><input onChange={(event) => setRefundReference(event.target.value)} value={refundReference} /></label>
            {refundMethod !== 'cash' ? <label><span>หลักฐานการคืนเงิน</span><input accept="image/*,application/pdf" onChange={(event) => selectEvidence(event.target.files?.[0] ?? null, setRefundEvidence)} type="file" /></label> : null}
          </> : null}
          <div className="employee-casual-void__actions"><button disabled={busy} onClick={() => setVoidTarget(null)} type="button">กลับ</button><button disabled={!voidReason.trim() || busy || (voidTarget.transaction_kind === 'paid' && refundMethod !== 'cash' && !refundEvidence)} onClick={() => { void submitVoid(); }} type="button">ยืนยันยกเลิก</button></div>
        </section>
      </div> : null}
    </div>
  );
}
