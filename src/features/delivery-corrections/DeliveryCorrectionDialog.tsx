import { useEffect, useRef, useState } from 'react';
import { Printer, WarningCircle, X } from '@phosphor-icons/react';
import { supabase } from '../../lib/supabase';
import { getErrorMessage } from '../../lib/errorMessage';
import type { AppRole } from '../../types/app';
import { printSalesDocumentForCurrentPlatform, salesDocumentFromStored, type StoredSalesDocument } from '../../lib/salesDocumentPrint';
import { publishDataChange } from '../../lib/dataChange';
import { isAndroidApp } from '../../lib/thermalPrinter';

type CorrectionItem = {
  ice_type_id: string;
  code?: string;
  name: string;
  unit: string;
  quantity?: number;
  unit_price: number | null;
};

type CorrectionContext = {
  destination_kind?: 'regular' | 'event';
  delivery_event_id: string;
  round_stop_id: string;
  charge_id: string;
  charge_number: string | null;
  shop_name: string;
  service_date: string;
  round_status: 'open' | 'closed';
  day_closed: boolean;
  original_amount: number;
  effective_amount: number;
  allocated_amount: number;
  payment_term: 'immediate' | 'end_of_day' | 'credit';
  note: string | null;
  can_correct: boolean;
  can_cancel: boolean;
  blocker_reason: string | null;
  ice_types: CorrectionItem[];
  items: CorrectionItem[];
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
}: {
  eventId: string;
  onClose: () => void;
  onSuccess: (message: string) => void | Promise<void>;
  userRole?: AppRole;
}) {
  const [context, setContext] = useState<CorrectionContext | null>(null);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancellationKey = useRef(requestKey());

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
        const routeResponse = await supabase.rpc('get_delivery_correction_route', {
          p_event_id: eventId,
        });
        if (routeResponse.error) throw routeResponse.error;
        const destinationKind = (routeResponse.data as { destination_kind?: 'regular' | 'event' } | null)
          ?.destination_kind ?? 'regular';
        const contextRpc = destinationKind === 'event'
          ? 'get_event_delivery_correction_context'
          : 'get_delivery_correction_context';
        const { data, error: loadError } = await supabase.rpc(contextRpc, { p_event_id: eventId });
        if (loadError) throw loadError;
        if (!active) return;
        const next = data as CorrectionContext;
        setContext(next);
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
  const printDeliveryDocument = async () => {
    if (!context?.charge_id) return;
    const nativeAndroid = isAndroidApp();
    const printWindow = nativeAndroid ? null : window.open('', '_blank', 'popup,width=360,height=680');
    if (!nativeAndroid && !printWindow) {
      setError('เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาตป๊อปอัปแล้วลองใหม่');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data, error: printError } = await supabase.rpc('get_charge_print_document', {
        p_charge_id: context.charge_id,
      });
      if (printError) throw printError;
      await printSalesDocumentForCurrentPlatform(salesDocumentFromStored(data as StoredSalesDocument), printWindow);
    } catch (printError) {
      printWindow?.close();
      setError(getErrorMessage(printError));
    } finally {
      setSubmitting(false);
    }
  };

  const cancelBill = async () => {
    if (!context || !canCancel || submitting || !reason.trim()) return setError('กรุณาระบุเหตุผลก่อนยกเลิกบิล');
    const cancellationEffect = Number(context.allocated_amount) > 0
      ? `หลังยืนยันใบส่งจะถูกยกเลิก และสร้างยอดรอคืนเงิน ${money.format(Number(context.allocated_amount))} ใบเสร็จเดิมยังคงอยู่`
      : 'หลังยืนยันใบส่งจะถูกยกเลิกและคืนสต๊อก จากนั้นสามารถบันทึกส่งใหม่ได้';
    if (!window.confirm(`ยืนยันยกเลิกบิล ${context.charge_number ?? ''} หรือไม่\n${cancellationEffect}`)) return;
    setSubmitting(true);
    setError(null);
    try {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const correctionRpc = context.destination_kind === 'event'
        ? 'apply_open_event_delivery_correction'
        : 'apply_open_delivery_correction';
      const { error: saveError } = await supabase.rpc(correctionRpc, {
        p_event_id: eventId,
        p_action: 'cancel',
        p_items: [],
        p_stop_status: 'delivered',
        p_note: context.note,
        p_reason: reason.trim(),
        p_idempotency_key: cancellationKey.current,
        p_approval_id: null,
      });
      if (saveError) throw saveError;
      publishDataChange(['accounting', 'payment', 'receivable', 'refund', 'stock', 'pos']);
      await Promise.allSettled([Promise.resolve(onSuccess('ยกเลิกใบส่งน้ำแข็งแล้ว สามารถบันทึกส่งใหม่ได้'))]);
      onClose();
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setSubmitting(false);
    }
  };

  const immediateSale = context?.payment_term === 'immediate';
  const canCancel = Boolean(context?.can_cancel && (!isClosed || immediateSale)
    && (!immediateSale || Number(context?.allocated_amount) === 0));

  return <div className="modal-backdrop delivery-correction-layer">
    <form aria-label={`ยกเลิกใบส่งน้ำแข็ง ${context?.charge_number ?? ''}`} aria-modal="true" className="modal-card delivery-correction-dialog" onSubmit={(event) => { event.preventDefault(); void cancelBill(); }} role="dialog">
      <div className="panel-header">
        <div><p className="eyebrow">ยกเลิกใบส่งน้ำแข็ง</p><h2>{context?.charge_number ?? 'รายการขายสด'}</h2></div>
        <button aria-label="ปิด" className="ghost-button" disabled={submitting} onClick={onClose} type="button"><X size={20} /></button>
      </div>
      {loading ? <p className="muted">กำลังโหลดข้อมูลบิล...</p> : context ? <>
        <div className="delivery-correction-dialog__summary">
          <span><small>ร้าน</small><strong>{context.shop_name}</strong></span>
          <span><small>ยอดปัจจุบัน</small><strong>{money.format(Number(context.effective_amount))}</strong></span>
          <span><small>รับชำระแล้ว</small><strong>{money.format(Number(context.allocated_amount))}</strong></span>
        </div>
        {isClosed && !canCancel ? <p className="delivery-correction-dialog__notice"><WarningCircle size={18} />รอบหรือวันนี้ปิดแล้ว ไม่สามารถยกเลิกใบส่งนี้ได้</p> : null}
        {immediateSale ? <p className="delivery-correction-dialog__notice"><WarningCircle size={18} />{Number(context.allocated_amount) > 0
          ? 'ให้หัวหน้าหรือแอดมินยกเลิกใบเสร็จรับเงินก่อน แล้วจึงยกเลิกรายการส่งและบันทึกขายใหม่'
          : 'รายการนี้ไม่มียอดรับชำระที่ยังใช้งานอยู่ ให้ยกเลิกรายการส่งก่อนบันทึกขายใหม่'}</p> : null}
        <p className="muted">หากบันทึกผิด ให้ยกเลิกใบส่งนี้ แล้วบันทึกส่งใหม่</p>
        <div className="delivery-correction-dialog__stock-impact">
          <strong>รายการที่จะยกเลิก</strong>
          {context.items.map((ice) => <span key={ice.ice_type_id}>{ice.name} {Number(ice.quantity ?? 0).toLocaleString('th-TH')} {ice.unit}</span>)}
        </div>
        <label>เหตุผล<input disabled={!canCancel || submitting} onChange={(event) => setReason(event.target.value)} required value={reason} /></label>
        {context.blocker_reason ? <p className="credit-ar__action-error" role="alert">{context.blocker_reason}</p> : null}
      </> : null}
      {error ? <p className="credit-ar__action-error" role="alert">{error}</p> : null}
      <div className="modal-actions">
        {context?.charge_number ? <button className="ghost-button" disabled={submitting} onClick={() => void printDeliveryDocument()} type="button"><Printer size={18} />พิมพ์เอกสาร</button> : null}
        {canCancel ? <button className="ghost-button danger-button" disabled={submitting} type="submit">{submitting ? 'กำลังยกเลิก...' : 'ยืนยันยกเลิกใบส่งน้ำแข็ง'}</button> : null}
      </div>
    </form>
  </div>;
}
