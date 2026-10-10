import { translateUi, useLanguage } from '../../../i18n';
import type { RefObject } from 'react';
import { Coins, ListNumbers, Printer, X } from '@phosphor-icons/react';
import type { HistoryReceiptDetail, PaymentCorrectionTarget } from '../types';
import { formatCollectionShopIdentity, money, paymentMethodLabel, formatPaymentReceivedAt, receiptDateTime } from '../utils';

export function HistoryReceiptModal({
  historyReceipt,
  busy,
  dialogRef,
  closeButtonRef,
  onClose,
  onPrint,
  onVoid,
  onCorrect,
}: {
  historyReceipt: HistoryReceiptDetail;
  busy: boolean;
  dialogRef: RefObject<HTMLDivElement>;
  closeButtonRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
  onPrint: () => void;
  onVoid?: () => void;
  onCorrect?: (target: PaymentCorrectionTarget) => void;
}) {
  useLanguage();
  const shopIdentity = formatCollectionShopIdentity({
    destination_kind: historyReceipt.payment.destination_kind,
    shop_code: historyReceipt.payment.shops?.code,
    shop_name: historyReceipt.payment.shops?.name,
    event_booth: historyReceipt.payment.event_booth,
  });

  return (
    <div
      aria-label={translateUi('รายละเอียดใบเสร็จ {0}', { 0: historyReceipt.payment.receipt_number })}
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
            <small>{translateUi('ใบเสร็จรับเงิน')}</small>
            <h2>{historyReceipt.payment.receipt_number}</h2>
            <b>{shopIdentity.title}</b>
          </span>
          <button
            aria-label={translateUi('ปิดรายละเอียดใบเสร็จ')}
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            <X aria-hidden="true" size={22} />
          </button>
        </header>

        <section className="financial-ops__receipt-summary" aria-label={translateUi('ข้อมูลการรับเงิน')}>
          <span><small>{translateUi('วันที่รับเงิน')}</small><strong>{formatPaymentReceivedAt(historyReceipt.payment)}</strong></span>
          {historyReceipt.payment.entered_at ? <span><small>{translateUi('บันทึกเมื่อ')}</small><strong>{receiptDateTime.format(new Date(historyReceipt.payment.entered_at))}</strong></span> : null}
          <span><small>{translateUi('วิธีรับเงิน')}</small><strong>{translateUi(paymentMethodLabel(historyReceipt.payment.payment_method))}</strong></span>
          <span><small>{translateUi('ยอดชำระ')}</small><b>{money.format(historyReceipt.payment.allocated_amount)}</b></span>
          {historyReceipt.payment.change_amount > 0 ? (
            <span><small>{translateUi('รับเงิน / เงินทอน')}</small><strong>{money.format(historyReceipt.payment.received_amount)} / {money.format(historyReceipt.payment.change_amount)}</strong></span>
          ) : null}
        </section>

        {historyReceipt.payment.status === 'voided' ? (
          <p className="financial-ops__voided-receipt" role="status">{translateUi('รายการนี้ถูกยกเลิก: ')}{historyReceipt.payment.void_reason ?? '—'}</p>
        ) : null}

        <section className="financial-ops__receipt-charges" aria-label={translateUi('บิลที่ชำระ')}>
          <strong><ListNumbers aria-hidden="true" size={18} />{translateUi(' บิลที่ชำระ')}</strong>
          {historyReceipt.charges === null && !historyReceipt.error ? <p>{translateUi('กำลังโหลดรายละเอียดบิล...')}</p> : null}
          {historyReceipt.error ? <p className="employee-error" role="alert">{translateUi('โหลดรายละเอียดบิลไม่สำเร็จ: ')}{translateUi(historyReceipt.error)}</p> : null}
          {historyReceipt.charges?.length === 0 ? <p>{translateUi('ไม่พบรายการบิลในใบเสร็จนี้')}</p> : null}
          {historyReceipt.charges?.map((charge, chargeIndex) => (
            <article key={charge.chargeNumber ?? `immediate-${chargeIndex}`}>
              <header><strong>{charge.chargeNumber ?? translateUi('ขายสด')}</strong><b>{money.format(charge.receivedAmount)}</b></header>
              {charge.items.map((item, index) => (
                <div key={`${item.name}-${index}`}>
                  <span>{item.name} × {item.quantity} {item.unit}</span>
                  <b>{money.format(item.lineTotal)}</b>
                </div>
              ))}
            </article>
          ))}
        </section>

        {onCorrect ? (
          <section className="financial-ops__receipt-charges" aria-label={translateUi('บิลปัจจุบันที่แก้ไขได้')}>
            <strong><ListNumbers aria-hidden="true" size={18} />{translateUi(' บิลที่ชำระครบและแก้ไขได้')}</strong>
            {historyReceipt.correctionTargets === null && !historyReceipt.correctionError ? <p>{translateUi('กำลังตรวจสอบบิล...')}</p> : null}
            {historyReceipt.correctionError ? <p className="employee-error" role="alert">{translateUi('ตรวจสอบสิทธิ์ยกเลิกใบส่งไม่สำเร็จ: ')}{translateUi(historyReceipt.correctionError)}</p> : null}
            {historyReceipt.correctionTargets?.map((target) => (
              <article key={target.charge_id}>
                <header><strong>{target.charge_number ?? translateUi('ขายสด')}</strong><b>{money.format(target.effective_amount)}</b></header>
                <button disabled={busy} onClick={() => onCorrect(target)} type="button">{translateUi('ยกเลิกใบส่งน้ำแข็ง ')}{target.charge_number ?? translateUi('ขายสด')}</button>
              </article>
            ))}
          </section>
        ) : null}

        <div className="financial-ops__receipt-actions">
          <button disabled={busy} onClick={onPrint} type="button"><Printer aria-hidden="true" size={19} />{translateUi('พิมพ์ซ้ำ')}</button>
          {onVoid ? <button disabled={busy} onClick={onVoid} type="button">{translateUi('ยกเลิกรายการ')}</button> : null}
          <button onClick={onClose} type="button">{translateUi('ปิด')}</button>
        </div>
      </article>
    </div>
  );
}
