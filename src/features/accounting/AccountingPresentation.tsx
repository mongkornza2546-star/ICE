import { formatReceiptDate } from '../../lib/salesDocumentPresentation';
import { useEffect, useRef, useState } from 'react';
import { X } from '@phosphor-icons/react';
import type { StoredSalesDocument } from '../../lib/salesDocumentPrint';
import type { AccountingReviewItem } from './types';

const money = new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' });
const dateTime = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
export function accountingDateTime(value?: string | null) {
  return value && Number.isFinite(Date.parse(value)) ? dateTime.format(new Date(value)) : '—';
}
export function accountingStatus(value: string) {
  return ({ active: 'ใช้งาน', voided: 'ยกเลิกแล้ว', paid: 'ชำระครบ', partial: 'ชำระบางส่วน', unpaid: 'ค้างชำระ', pending: 'รอดำเนินการ', replaced: 'ถูกแทนที่', cancelled: 'ยกเลิกแล้ว', completed: 'เสร็จสิ้น' } as Record<string, string>)[value] ?? value;
}

// Keep keyboard focus inside the active dialog and restore its opener on close.
export function useAccountingDialog(onClose: () => void) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? [])
      .filter((element) => !element.closest('[hidden]') && (!element.closest('details:not([open])') || element.tagName === 'SUMMARY'));
    (focusable()[0] ?? ref.current)?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); ref.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', handleKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return ref;
}

export function AccountingLoading() {
  return <div className="accounting-skeleton" role="status"><span>กำลังโหลดข้อมูลบัญชี…</span><div aria-hidden="true"><i /><i /><i /><i /></div><i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /></div>;
}

export function ReceiptPreview({ receipt }: { receipt: StoredSalesDocument }) {
  const methods = { cash: 'เงินสด', bank_transfer: 'โอนธนาคาร', qr: 'QR' };
  const items = receipt.items ?? (receipt.charges ?? []).flatMap((charge) => charge.items ?? []);
  const amount = receipt.total_amount ?? receipt.allocated_amount;
  return <section className="accounting-receipt"><h3>สำเนาใบเสร็จเดิม</h3>
    <dl><div><dt>เลขใบเสร็จ</dt><dd>{receipt.document_number ?? '—'}</dd></div><div><dt>{receipt.received_date_override ? 'วันที่รับเงิน' : 'วันเวลารับเงิน'}</dt><dd>{receipt.received_date_override ? formatReceiptDate(receipt.received_date_override) : accountingDateTime(receipt.issued_at ?? receipt.recorded_at)}</dd></div>{receipt.entered_at ? <div><dt>บันทึกเมื่อ</dt><dd>{accountingDateTime(receipt.entered_at)}</dd></div> : null}<div><dt>ช่องทาง</dt><dd>{receipt.payment_method ? methods[receipt.payment_method] : '—'}</dd></div><div><dt>ผู้บันทึก</dt><dd>{receipt.recorded_by_name ?? '—'}</dd></div></dl>
    {items.length ? <ul>{items.map((item, index) => <li key={index}><span>{item.ice_type_name}<small>{Number(item.quantity).toLocaleString('th-TH')} {item.ice_type_unit}{item.unit_price != null ? ` × ${money.format(Number(item.unit_price))}` : ''}</small></span><strong>{money.format(Number(item.line_total))}</strong></li>)}</ul> : null}
    {receipt.charges?.length ? <section><h4>จัดสรรเข้าบิล</h4><ul>{receipt.charges.map((charge, index) => <li key={index}><span>{charge.charge_number ?? 'ไม่ระบุเลขบิล'}</span><strong>{money.format(Number(charge.received_amount))}</strong></li>)}</ul></section> : null}
    <dl><div><dt>ยอดใบเสร็จ</dt><dd>{amount == null ? '—' : money.format(Number(amount))}</dd></div><div><dt>เงินที่รับ</dt><dd>{receipt.received_amount == null ? '—' : money.format(Number(receipt.received_amount))}</dd></div><div><dt>เงินทอน</dt><dd>{receipt.change_amount == null ? '—' : money.format(Number(receipt.change_amount))}</dd></div></dl>
    {receipt.void_info ? <p className="accounting-notice">ยกเลิกแล้ว · {receipt.void_info.reason} · {accountingDateTime(receipt.void_info.voided_at)}</p> : null}
  </section>;
}

export function ReviewResolutionDialog({ item, busy, error, onClose, onSubmit }: {
  item: AccountingReviewItem; busy: boolean; error: string | null;
  onClose: () => void; onSubmit: (note: string, reference: string | null) => void;
}) {
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const ref = useAccountingDialog(() => { if (!busy) onClose(); });
  return <div className="accounting-resolution-backdrop"><section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="ปิดประเด็นตรวจสอบ" className="accounting-resolution-dialog">
    <header><div><p className="eyebrow">สรุปการตรวจสอบ</p><h2>{item.title}</h2></div><button aria-label="ปิดหน้าต่างตรวจสอบ" disabled={busy} onClick={onClose} type="button"><X size={20} /></button></header>
    <p>{item.description}</p><form onSubmit={(event) => { event.preventDefault(); if (note.trim()) onSubmit(note.trim(), reference.trim() || null); }}>
      <label>ผลตรวจสอบและการดำเนินการ <span>(จำเป็น)</span><textarea required rows={4} value={note} onChange={(event) => setNote(event.target.value)} disabled={busy} /></label>
      <label>เลขอ้างอิงภายนอก <span>(ถ้ามี)</span><input value={reference} onChange={(event) => setReference(event.target.value)} disabled={busy} /></label>
      {error ? <p role="alert" className="credit-ar__action-error">{error}</p> : null}
      <footer><button disabled={busy} onClick={onClose} type="button">กลับ</button><button className="primary-button" disabled={busy || !note.trim()} type="submit">{busy ? 'กำลังบันทึก…' : 'บันทึกและปิดประเด็น'}</button></footer>
    </form>
  </section></div>;
}
