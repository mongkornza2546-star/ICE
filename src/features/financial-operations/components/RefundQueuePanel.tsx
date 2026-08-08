import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, CheckCircle, Coins, WarningCircle } from '@phosphor-icons/react';
import { supabase } from '../../../lib/supabase';
import { getErrorMessage } from '../../../lib/errorMessage';
import type { PaymentMethod } from '../../../types/app';
import { money, paymentMethodLabel, receiptDateTime } from '../utils';
import { publishDataChange, subscribeToDataChange } from '../../../lib/dataChange';

type RefundQueueItem = {
  id: string;
  shop_code: string;
  shop_name: string;
  receipt_number: string;
  charge_number: string;
  amount: number;
  status: 'pending' | 'settled' | 'voided';
  reason: string;
  created_at: string;
  age_days: number;
  settlement: null | {
    refund_method: PaymentMethod;
    reference_number: string | null;
    settled_by: string;
    settled_at: string;
  };
};

type RefundSummary = {
  service_date: string;
  gross_received: number;
  refunded_amount: number;
  net_received: number;
};

function requestKey() {
  return globalThis.crypto?.randomUUID?.() ?? `refund-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function RefundQueuePanel() {
  const [items, setItems] = useState<RefundQueueItem[]>([]);
  const [summary, setSummary] = useState<RefundSummary | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [settlingId, setSettlingId] = useState<string | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const settlementKeys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const [queueResult, summaryResult] = await Promise.all([
        supabase.rpc('get_refund_queue', { p_pending_only: !showAll }),
        supabase.rpc('get_financial_refund_summary', { p_service_date: null }),
      ]);
      if (queueResult.error) throw queueResult.error;
      if (summaryResult.error) throw summaryResult.error;
      setItems((queueResult.data ?? []) as RefundQueueItem[]);
      setSummary(summaryResult.data as RefundSummary);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribeToDataChange(['refund', 'payment'], () => { void load(); }), [load]);

  const pendingTotal = useMemo(() => items.filter((item) => item.status === 'pending')
    .reduce((total, item) => total + Number(item.amount), 0), [items]);

  const settle = async (item: RefundQueueItem) => {
    if (method !== 'cash' && !reference.trim()) {
      setError('กรุณาระบุเลขอ้างอิงสำหรับการคืนเงินที่ไม่ใช่เงินสด');
      return;
    }
    if (!window.confirm(`ยืนยันคืนเงิน ${money.format(Number(item.amount))} ให้ ${item.shop_name} หรือไม่`)) return;
    setSettlingId(item.id);
    setError(null);
    setSuccess(null);
    try {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { error: settleError } = await supabase.rpc('settle_refund', {
        p_obligation_id: item.id,
        p_refund_method: method,
        p_reference_number: reference.trim() || null,
        p_idempotency_key: settlementKeys.current.get(item.id) ?? (() => {
          const key = requestKey();
          settlementKeys.current.set(item.id, key);
          return key;
        })(),
      });
      if (settleError) throw settleError;
      publishDataChange(['accounting', 'refund', 'payment']);
      setSuccess(`บันทึกคืนเงิน ${item.charge_number} แล้ว`);
      setReference('');
      await load();
    } catch (settleError) {
      setError(getErrorMessage(settleError));
    } finally {
      setSettlingId(null);
    }
  };

  return <section className="financial-ops refund-queue">
    <header className="financial-ops__header">
      <div><p className="eyebrow">การเงินหลังแก้ไขบิล</p><h1>คิวคืนเงิน</h1><span>คืนเต็มจำนวนตามรายการปรับปรุง พร้อมเก็บผู้คืนและเวลา</span></div>
      <button disabled={loading} onClick={() => void load()} type="button"><ArrowClockwise size={18} />รีเฟรช</button>
    </header>
    <div className="credit-ar__summary-cards">
      <article><span>ยอดรับรวม</span><strong>{money.format(Number(summary?.gross_received ?? 0))}</strong><small>วันนี้</small></article>
      <article><span>ยอดคืนจริง</span><strong>{money.format(Number(summary?.refunded_amount ?? 0))}</strong><small>วันนี้</small></article>
      <article><span>ยอดรับสุทธิ</span><strong>{money.format(Number(summary?.net_received ?? 0))}</strong><small>วันนี้</small></article>
      <article><span>ยอดรอคืน</span><strong>{money.format(pendingTotal)}</strong><small>{items.filter((item) => item.status === 'pending').length} รายการ</small></article>
    </div>
    <label className="refund-queue__filter"><input checked={showAll} onChange={(event) => setShowAll(event.target.checked)} type="checkbox" />แสดงรายการที่คืนแล้ว</label>
    {success ? <p className="employee-success" role="status"><CheckCircle size={18} />{success}</p> : null}
    {error ? <p className="credit-ar__action-error" role="alert"><WarningCircle size={18} />{error}</p> : null}
    {loading ? <p className="financial-ops__empty">กำลังโหลดคิวคืนเงิน...</p> : items.length === 0 ? <p className="financial-ops__empty">ไม่มียอดรอคืน</p> : <div className="refund-queue__list">
      {items.map((item) => <article key={item.id}>
        <div><small>{item.shop_code}</small><h3>{item.shop_name}</h3><span>{item.charge_number} · ใบรับเงิน {item.receipt_number}</span><p>{item.reason}</p></div>
        <strong>{money.format(Number(item.amount))}</strong>
        {item.status === 'pending' ? <div className="refund-queue__actions">
          <select aria-label="วิธีคืนเงิน" onChange={(event) => setMethod(event.target.value as PaymentMethod)} value={method}><option value="cash">เงินสด</option><option value="bank_transfer">โอนเงิน</option><option value="qr">QR</option></select>
          <input aria-label="เลขอ้างอิงการคืนเงิน" onChange={(event) => setReference(event.target.value)} placeholder="เลขอ้างอิง" value={reference} />
          <button className="primary-button" disabled={Boolean(settlingId)} onClick={() => void settle(item)} type="button"><Coins size={16} />{settlingId === item.id ? 'กำลังบันทึก...' : 'บันทึกคืนเงิน'}</button>
        </div> : <small>คืนแล้วด้วย {item.settlement ? paymentMethodLabel(item.settlement.refund_method) : '—'}{item.settlement ? ` · ${receiptDateTime.format(new Date(item.settlement.settled_at))} · ${item.settlement.settled_by}` : ''}</small>}
      </article>)}
    </div>}
  </section>;
}
