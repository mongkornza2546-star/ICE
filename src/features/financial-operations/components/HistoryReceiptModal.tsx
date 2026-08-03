import type { RefObject } from 'react';
import { Coins, ListNumbers, Printer, X } from '@phosphor-icons/react';
import type { HistoryReceiptDetail } from '../types';
import { money, paymentMethodLabel, receiptDateTime } from '../utils';

export function HistoryReceiptModal({
  historyReceipt,
  busy,
  dialogRef,
  closeButtonRef,
  onClose,
  onPrint,
}: {
  historyReceipt: HistoryReceiptDetail;
  busy: boolean;
  dialogRef: RefObject<HTMLDivElement>;
  closeButtonRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
  onPrint: () => void;
}) {
  return (
    <div
      aria-label={`รายละเอียดใบเสร็จ ${historyReceipt.payment.receipt_number}`}
      aria-modal="true"
      className="financial-ops__modal"
      ref={dialogRef}
      role="dialog"
    >
      <div className="financial-ops__modal-backdrop" onClick={onClose} />
      <article className="financial-ops__payment-card financial-ops__receipt-detail-card">
        <header>
          <span className="financial-ops__receipt-detail-icon" aria-hidden="true"><Coins size={34} weight="duotone" /></span>
          <span>
            <small>ใบเสร็จรับเงิน</small>
            <h2>{historyReceipt.payment.receipt_number}</h2>
            <b>{historyReceipt.payment.shops?.code ?? '—'} · {historyReceipt.payment.shops?.name ?? 'ไม่พบร้าน'}</b>
          </span>
          <button
            aria-label="ปิดรายละเอียดใบเสร็จ"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            <X aria-hidden="true" size={22} />
          </button>
        </header>

        <section className="financial-ops__receipt-summary" aria-label="ข้อมูลการรับเงิน">
          <span><small>วันที่รับเงิน</small><strong>{receiptDateTime.format(new Date(historyReceipt.payment.recorded_at))}</strong></span>
          <span><small>วิธีรับเงิน</small><strong>{paymentMethodLabel(historyReceipt.payment.payment_method)}</strong></span>
          <span><small>ยอดชำระ</small><b>{money.format(historyReceipt.payment.allocated_amount)}</b></span>
          {historyReceipt.payment.change_amount > 0 ? (
            <span><small>รับเงิน / เงินทอน</small><strong>{money.format(historyReceipt.payment.received_amount)} / {money.format(historyReceipt.payment.change_amount)}</strong></span>
          ) : null}
        </section>

        {historyReceipt.payment.status === 'voided' ? (
          <p className="financial-ops__voided-receipt" role="status">รายการนี้ถูกยกเลิก: {historyReceipt.payment.void_reason ?? '—'}</p>
        ) : null}

        <section className="financial-ops__receipt-charges" aria-label="บิลที่ชำระ">
          <strong><ListNumbers aria-hidden="true" size={18} /> บิลที่ชำระ</strong>
          {historyReceipt.charges === null && !historyReceipt.error ? <p>กำลังโหลดรายละเอียดบิล...</p> : null}
          {historyReceipt.error ? <p className="employee-error" role="alert">โหลดรายละเอียดบิลไม่สำเร็จ: {historyReceipt.error}</p> : null}
          {historyReceipt.charges?.length === 0 ? <p>ไม่พบรายการบิลในใบเสร็จนี้</p> : null}
          {historyReceipt.charges?.map((charge) => (
            <article key={charge.chargeNumber}>
              <header><strong>{charge.chargeNumber}</strong><b>{money.format(charge.receivedAmount)}</b></header>
              {charge.items.map((item, index) => (
                <div key={`${item.name}-${index}`}>
                  <span>{item.name} × {item.quantity} {item.unit}</span>
                  <b>{money.format(item.lineTotal)}</b>
                </div>
              ))}
            </article>
          ))}
        </section>

        <div className="financial-ops__receipt-actions">
          <button disabled={busy} onClick={onPrint} type="button"><Printer aria-hidden="true" size={19} />พิมพ์ซ้ำ</button>
          <button onClick={onClose} type="button">ปิด</button>
        </div>
      </article>
    </div>
  );
}
