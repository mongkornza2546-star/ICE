import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { WarningCircle, X } from '@phosphor-icons/react';
import { supabase } from '../../lib/supabase';
import { getErrorMessage } from '../../lib/errorMessage';
import type { AppRole } from '../../types/app';

type CorrectionItem = {
  ice_type_id: string;
  code?: string;
  name: string;
  unit: string;
  quantity?: number;
  unit_price: number | null;
};

type CorrectionContext = {
  delivery_event_id: string;
  round_stop_id: string;
  charge_number: string | null;
  shop_name: string;
  service_date: string;
  round_status: 'open' | 'closed';
  day_closed: boolean;
  original_amount: number;
  effective_amount: number;
  allocated_amount: number;
  payment_term: 'immediate' | 'credit';
  note: string | null;
  can_correct: boolean;
  can_cancel: boolean;
  blocker_reason: string | null;
  ice_types: CorrectionItem[];
  items: CorrectionItem[];
};

type CorrectionPreview = {
  old_amount: number;
  new_amount: number;
  allocated_amount: number;
  refund_amount: number;
  outstanding_amount: number;
  approval_required?: boolean;
  stock_deltas: Array<{ ice_type_id: string; name: string; unit: string; quantity_delta: number }>;
};

const money = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 2,
});

function requestKey() {
  return globalThis.crypto?.randomUUID?.() ?? `correction-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function DeliveryCorrectionDialog({
  eventId,
  onClose,
  onSuccess,
  userRole = 'round_lead',
}: {
  eventId: string;
  onClose: () => void;
  onSuccess: (message: string) => void | Promise<void>;
  userRole?: AppRole;
}) {
  const [context, setContext] = useState<CorrectionContext | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<CorrectionPreview | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [approvalStatus, setApprovalStatus] = useState<'pending' | 'approved' | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const correctionKey = useRef(requestKey());
  const cancellationKey = useRef(requestKey());

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
        const { data, error: loadError } = await supabase.rpc('get_delivery_correction_context', {
          p_event_id: eventId,
        });
        if (loadError) throw loadError;
        if (!active) return;
        const next = data as CorrectionContext;
        setContext(next);
        setQuantities(Object.fromEntries((next.items ?? []).map((item) => [item.ice_type_id, Number(item.quantity)])));
        setNote(next.note ?? '');
      } catch (loadError) {
        if (active) setError(getErrorMessage(loadError));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [eventId]);

  const isClosed = Boolean(context && (context.round_status === 'closed' || context.day_closed));
  const canCreateAdjustment = isClosed && userRole === 'admin';
  const items = useMemo(() => (context?.ice_types ?? context?.items ?? [])
    .map((item) => ({ ice_type_id: item.ice_type_id, quantity: quantities[item.ice_type_id] ?? 0 }))
    .filter((item) => item.quantity > 0), [context, quantities]);

  const localClosedPreview = () => {
    if (!context) return null;
    const newAmount = items.reduce((total, item) => {
      const product = (context.ice_types ?? context.items).find((candidate) => candidate.ice_type_id === item.ice_type_id);
      if (product?.unit_price == null) throw new Error('พบชนิดน้ำแข็งที่ไม่มีราคา');
      return total + item.quantity * Number(product.unit_price);
    }, 0);
    return {
      old_amount: Number(context.effective_amount),
      new_amount: newAmount,
      allocated_amount: Number(context.allocated_amount),
      refund_amount: Math.max(Number(context.allocated_amount) - newAmount, 0),
      outstanding_amount: Math.max(newAmount - Number(context.allocated_amount), 0),
      stock_deltas: (context.ice_types ?? context.items).map((product) => ({
        ice_type_id: product.ice_type_id,
        name: product.name,
        unit: product.unit,
        quantity_delta: Number(context.items.find((item) => item.ice_type_id === product.ice_type_id)?.quantity ?? 0)
          - Number(items.find((item) => item.ice_type_id === product.ice_type_id)?.quantity ?? 0),
      })).filter((item) => item.quantity_delta !== 0),
    };
  };

  const previewChange = async () => {
    if (!context || (!isClosed && items.length === 0)) return setError('รายการส่งต้องมีน้ำแข็งอย่างน้อย 1 ชนิด');
    setSubmitting(true);
    setError(null);
    try {
      if (isClosed) {
        setPreview(localClosedPreview());
      } else {
        if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
        const { data, error: previewError } = await supabase.rpc('preview_delivery_correction', {
          p_event_id: eventId,
          p_action: 'correct',
          p_items: items,
          p_stop_status: 'delivered',
        });
        if (previewError) throw previewError;
        setPreview(data as CorrectionPreview);
        setApprovalId(null);
        setApprovalStatus(null);
      }
    } catch (previewError) {
      setError(getErrorMessage(previewError));
    } finally {
      setSubmitting(false);
    }
  };

  const requestApproval = async () => {
    if (!context || !preview?.approval_required || !reason.trim()) {
      setError('กรุณาระบุเหตุผลก่อนขออนุมัติ');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data, error: approvalError } = await supabase.rpc('request_financial_approval', {
        p_round_stop_id: context.round_stop_id,
        p_kind: 'credit_limit',
        p_items: items,
        p_payment_term: 'credit',
        p_requested_amount: preview.new_amount,
        p_reason: reason.trim(),
        p_charge_id: null,
      });
      if (approvalError) throw approvalError;
      const approval = data as { id: string; status: 'pending' | 'approved' | 'rejected' | 'consumed' };
      if (approval.status === 'approved') {
        setApprovalId(approval.id);
        setApprovalStatus('approved');
      } else {
        setApprovalId(null);
        setApprovalStatus('pending');
      }
    } catch (approvalError) {
      setError(getErrorMessage(approvalError));
    } finally {
      setSubmitting(false);
    }
  };

  const submitChange = async (event: FormEvent) => {
    event.preventDefault();
    if (!context || !preview) return void previewChange();
    if (!reason.trim()) return setError('กรุณาระบุเหตุผล');
    if (isClosed && items.length === 0
      && !window.confirm('ยืนยันสร้างเอกสารปรับปรุงให้ยอดบิลเป็นศูนย์หรือไม่')) return;
    setSubmitting(true);
    setError(null);
    try {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const rpc = isClosed ? 'create_closed_delivery_adjustment' : 'apply_open_delivery_correction';
      const args = isClosed ? {
        p_event_id: eventId,
        p_items: items,
        p_reason: reason.trim(),
        p_idempotency_key: correctionKey.current,
      } : {
        p_event_id: eventId,
        p_action: 'correct',
        p_items: items,
        p_stop_status: 'delivered',
        p_note: note.trim() || null,
        p_reason: reason.trim(),
        p_idempotency_key: correctionKey.current,
        p_approval_id: approvalId,
      };
      const { error: saveError } = await supabase.rpc(rpc, args);
      if (saveError) throw saveError;
      await onSuccess(isClosed ? 'สร้างเอกสารปรับปรุงบิลแล้ว' : 'แก้ไขบิลแล้ว');
      onClose();
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setSubmitting(false);
    }
  };

  const cancelBill = async () => {
    if (!context || !context.can_cancel || !reason.trim()) return setError('กรุณาระบุเหตุผลก่อนยกเลิกบิล');
    if (!window.confirm(`ยืนยันยกเลิกบิล ${context.charge_number ?? ''} หรือไม่`)) return;
    setSubmitting(true);
    setError(null);
    try {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { error: saveError } = await supabase.rpc('apply_open_delivery_correction', {
        p_event_id: eventId,
        p_action: 'cancel',
        p_items: [],
        p_stop_status: 'delivered',
        p_note: note.trim() || null,
        p_reason: reason.trim(),
        p_idempotency_key: cancellationKey.current,
        p_approval_id: null,
      });
      if (saveError) throw saveError;
      await onSuccess('ยกเลิกบิลแล้ว ยอดที่รับชำระจะเข้าคิวคืนเงิน');
      onClose();
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setSubmitting(false);
    }
  };

  const editable = Boolean(context && (context.can_correct || canCreateAdjustment));

  return <div className="modal-backdrop delivery-correction-layer">
    <form aria-label={`แก้ไขบิล ${context?.charge_number ?? ''}`} aria-modal="true" className="modal-card delivery-correction-dialog" onSubmit={submitChange} role="dialog">
      <div className="panel-header">
        <div><p className="eyebrow">{isClosed ? 'เอกสารปรับปรุง' : 'แก้ไขบิล'}</p><h2>{context?.charge_number ?? 'รายการส่ง'}</h2></div>
        <button aria-label="ปิด" className="ghost-button" disabled={submitting} onClick={onClose} type="button"><X size={20} /></button>
      </div>
      {loading ? <p className="muted">กำลังโหลดข้อมูลบิล...</p> : context ? <>
        <div className="delivery-correction-dialog__summary">
          <span><small>ร้าน</small><strong>{context.shop_name}</strong></span>
          <span><small>ยอดปัจจุบัน</small><strong>{money.format(Number(context.effective_amount))}</strong></span>
          <span><small>รับชำระแล้ว</small><strong>{money.format(Number(context.allocated_amount))}</strong></span>
        </div>
        {isClosed ? <p className="delivery-correction-dialog__notice"><WarningCircle size={18} />รอบหรือวันนี้ปิดแล้ว ระบบจะเก็บเป็นเอกสารปรับปรุงโดยไม่แก้รายการเดิม</p> : null}
        <div className="field-grid field-grid--three">
          {(context.ice_types ?? context.items).map((ice) => <label key={ice.ice_type_id}>{ice.name} ({ice.unit})<input disabled={!editable || submitting} min="0" onChange={(event) => { setQuantities((current) => ({ ...current, [ice.ice_type_id]: Math.max(0, Math.round((Number(event.target.value) || 0) * 2) / 2) })); setPreview(null); setApprovalId(null); setApprovalStatus(null); }} step="0.5" type="number" value={quantities[ice.ice_type_id] ?? 0} /></label>)}
        </div>
        <label>เหตุผล<input disabled={!editable || submitting} onChange={(event) => setReason(event.target.value)} required value={reason} /></label>
        {!isClosed ? <label>หมายเหตุ<textarea disabled={!editable || submitting} onChange={(event) => setNote(event.target.value)} rows={2} value={note} /></label> : null}
        {preview ? <div className="delivery-correction-dialog__preview">
          <span><small>ยอดใหม่</small><strong>{money.format(Number(preview.new_amount))}</strong></span>
          <span><small>ยอดค้างใหม่</small><strong>{money.format(Number(preview.outstanding_amount))}</strong></span>
          <span><small>ต้องคืนเงิน</small><strong>{money.format(Number(preview.refund_amount))}</strong></span>
        </div> : null}
        {preview?.approval_required ? <div className="employee-approval-request">
          <strong>{approvalStatus === 'approved' ? 'อนุมัติวงเงินแล้ว' : approvalStatus === 'pending' ? 'ส่งคำขอแล้ว รออนุมัติ' : 'ยอดใหม่เกินวงเงินเครดิต'}</strong>
          {approvalStatus !== 'approved' ? <button disabled={submitting} onClick={() => void requestApproval()} type="button">{approvalStatus === 'pending' ? 'ตรวจสถานะคำขอ' : 'ขออนุมัติวงเงิน'}</button> : null}
        </div> : null}
        {preview?.stock_deltas?.length ? <div className="delivery-correction-dialog__stock-impact"><strong>ผลต่อสต๊อก</strong>{context.day_closed ? <span>วันนี้ปิดสต๊อกแล้ว จึงไม่เปลี่ยน snapshot สิ้นวัน</span> : preview.stock_deltas.map((item) => <span key={item.ice_type_id}>{item.name}: {item.quantity_delta > 0 ? 'คืนเข้า' : 'ตัดออก'} {Math.abs(item.quantity_delta).toLocaleString('th-TH')} {item.unit}</span>)}</div> : null}
        {context.blocker_reason && !canCreateAdjustment ? <p className="credit-ar__action-error" role="alert">{context.blocker_reason}</p> : null}
      </> : null}
      {error ? <p className="credit-ar__action-error" role="alert">{error}</p> : null}
      <div className="modal-actions">
        {!isClosed && context?.can_cancel ? <button className="ghost-button danger-button" disabled={submitting} onClick={() => void cancelBill()} type="button">ยกเลิกบิลส่งของ</button> : null}
        <button className="secondary-button" disabled={!editable || submitting} onClick={() => void previewChange()} type="button">คำนวณผลกระทบ</button>
        <button className="primary-button" disabled={!editable || !preview || submitting || Boolean(preview.approval_required && !approvalId)} type="submit">{submitting ? 'กำลังบันทึก...' : isClosed ? 'สร้างเอกสารปรับปรุง' : 'ยืนยันแก้ไข'}</button>
      </div>
    </form>
  </div>;
}
