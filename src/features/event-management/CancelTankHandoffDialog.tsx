import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { translateUi } from '../../i18n';
import { publishDataChange } from '../../lib/dataChange';

export function CancelTankHandoffDialog({ label, quantity, onCancel, onClose, onSaved }: {
  label: string;
  quantity: number;
  onCancel: (reason: string) => Promise<unknown>;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const inFlight = useRef(false);
  const dialogRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector('textarea')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !inFlight.current) onClose();
      if (event.key !== 'Tab') return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>('textarea:not(:disabled), button:not(:disabled)');
      if (!controls?.length) return;
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown);
      previousFocus?.focus();
    };
  }, [onClose]);
  const submit = async () => {
    if (inFlight.current || (!cancelled && !reason.trim())) return;
    inFlight.current = true; setBusy(true); setError('');
    if (!cancelled) {
      try {
        await onCancel(reason.trim());
        setCancelled(true);
        publishDataChange(['pos', 'receivable', 'accounting']);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'ยกเลิกไม่สำเร็จ');
        inFlight.current = false; setBusy(false);
        return;
      }
    }
    try {
      await onSaved();
      onClose();
    } catch {
      setError('โหลดข้อมูลล่าสุดไม่สำเร็จ กรุณาลองโหลดข้อมูลใหม่');
    } finally { inFlight.current = false; setBusy(false); }
  };
  return createPortal(<div className="event-modal-layer delivery-correction-layer" role="dialog" aria-modal="true" aria-labelledby="cancel-tank-title">
    <button className="event-modal-backdrop" type="button" aria-label={translateUi('ปิดหน้าต่าง')} disabled={busy} onClick={onClose} />
    <form ref={dialogRef} className="event-modal event-modal--cancel" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <header><h2 id="cancel-tank-title">{translateUi('ยกเลิกรายการถัง')}</h2></header>
      <div className="event-modal__body">
        <p><strong>{label} · {quantity} {translateUi('ถัง')}</strong></p>
        {cancelled ? <p role="status">{translateUi('ยกเลิกรายการถังและบิลค่าเช่าแล้ว')}</p> : <p>{translateUi('ยกเลิกยอดถังค้างและบิลค่าเช่าของรายการนี้ พร้อมเก็บประวัติไว้ หากรับเงินแล้วต้องจัดการรายการรับเงินก่อน')}</p>}
        <label><span>{translateUi('เหตุผลในการยกเลิก *')}</span><textarea required disabled={busy || cancelled} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        {error ? <p className="event-form-error" role="alert">{translateUi(error)}</p> : null}
      </div>
      <footer>
        <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>{translateUi(cancelled ? 'ปิด' : 'กลับ')}</button>
        <button className={cancelled ? 'primary-button' : 'primary-button destructive-button'} type="submit" disabled={busy || (!cancelled && !reason.trim())}>
          {translateUi(cancelled ? (busy ? 'กำลังโหลดข้อมูล...' : 'ลองโหลดข้อมูลใหม่') : (busy ? 'กำลังยกเลิก...' : 'ยืนยันยกเลิกรายการถัง'))}
        </button>
      </footer>
    </form>
  </div>, document.body);
}
