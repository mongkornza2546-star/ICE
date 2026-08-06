import { useState, type RefObject } from 'react';
import {
  Bank,
  CaretDown,
  CheckCircle,
  FloppyDisk,
  ListNumbers,
  Money,
  Printer,
  QrCode,
  Storefront,
  UploadSimple,
  X,
} from '@phosphor-icons/react';
import type { PaymentMethod } from '../../../types/app';
import type { PaymentReceipt, QueueShop } from '../types';
import { formatServiceDate, money, paymentMethodLabel } from '../utils';

export function PaymentModal({
  presentation = 'modal',
  selectedShop,
  serviceDate,
  busy,
  method,
  amount,
  reference,
  evidence,
  evidenceError,
  printReceiptWanted,
  receipt,
  receiptWarning,
  allocatedAmount,
  changeAmount,
  remainingAmount,
  evidenceRequired,
  paymentReady,
  dialogRef,
  closeButtonRef,
  onClose,
  onPaymentMethodChange,
  onAmountChange,
  onEvidenceChange,
  onReferenceChange,
  onPrintReceiptWantedChange,
  onRecordPayment,
  onEditCharge,
  onPrintReceipt,
  onRequestDueDate,
}: {
  presentation?: 'modal' | 'panel';
  selectedShop: QueueShop;
  serviceDate: string;
  busy: boolean;
  method: PaymentMethod;
  amount: string;
  reference: string;
  evidence: File | null;
  evidenceError: string | null;
  printReceiptWanted: boolean;
  receipt: PaymentReceipt | null;
  receiptWarning: string | null;
  allocatedAmount: number;
  changeAmount: number;
  remainingAmount: number;
  evidenceRequired: boolean;
  paymentReady: boolean;
  dialogRef: RefObject<HTMLDivElement>;
  closeButtonRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
  onPaymentMethodChange: (method: PaymentMethod) => void;
  onAmountChange: (amount: string) => void;
  onEvidenceChange: (file: File | null) => void;
  onReferenceChange: (reference: string) => void;
  onPrintReceiptWantedChange: (wanted: boolean) => void;
  onRecordPayment: () => void;
  onEditCharge?: (charge: QueueShop['charges'][number]) => void;
  onPrintReceipt: (receipt: PaymentReceipt) => void;
  onRequestDueDate: (charge: QueueShop['charges'][number]) => void;
}) {
  const isPanel = presentation === 'panel';
  const [expandedChargeId, setExpandedChargeId] = useState<string | null>(null);
  return (
    <div
      aria-label={`รับเงิน ${selectedShop.shop_name}`}
      aria-modal={isPanel ? undefined : 'true'}
      className={isPanel ? 'financial-ops__inline-panel' : 'financial-ops__modal'}
      ref={dialogRef}
      role={isPanel ? 'region' : 'dialog'}
    >
      {!isPanel ? <div className="financial-ops__modal-backdrop" onClick={() => {
        if (!busy) onClose();
      }} /> : null}
      <article className="financial-ops__payment-card">
        <header>
          <span className="financial-ops__payment-image">
            {selectedShop.image_url ? (
              <img alt={`ร้าน ${selectedShop.shop_name}`} src={selectedShop.image_url} />
            ) : (
              <Storefront aria-hidden="true" size={40} weight="duotone" />
            )}
          </span>
          <span>
            <small>{selectedShop.shop_code}</small>
            <h2>{isPanel ? `${selectedShop.shop_code} · ${selectedShop.shop_name}` : 'บันทึกรับชำระเงิน'}</h2>
            <b>{selectedShop.shop_name}</b>
          </span>
          <button
            aria-label="ปิดหน้ารับเงิน"
            disabled={busy}
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            <X aria-hidden="true" size={22} />
          </button>
        </header>

        {receipt ? (
          <div className="financial-ops__payment-complete">
            <CheckCircle aria-hidden="true" size={24} weight="fill" />
            <span><strong>บันทึกรับเงินเรียบร้อย</strong><small>เลือกพิมพ์ใบเสร็จสำหรับร้านที่ต้องการ</small></span>
            {receiptWarning ? <small className="financial-ops__receipt-warning" role="status">{receiptWarning}</small> : null}
            {printReceiptWanted ? <button onClick={() => onPrintReceipt(receipt)} type="button"><Printer aria-hidden="true" size={19} />พิมพ์ใบเสร็จ</button> : null}
            <button onClick={onClose} type="button">เสร็จสิ้น</button>
          </div>
        ) : (
          <div className="financial-ops__payment">
            <section className="financial-ops__amount-due" aria-label="ยอดที่ต้องชำระ">
              <span>ยอดที่ต้องชำระ</span>
              <strong>{money.format(selectedShop.outstanding_amount)}</strong>
            </section>

            <section className="financial-ops__charge-list" aria-label="รายละเอียดบิลและรายการที่สั่ง">
              <strong><ListNumbers aria-hidden="true" size={18} /> รายละเอียดบิลและรายการที่สั่ง</strong>
              {selectedShop.charges.map((charge) => {
                const isPriorBalance = charge.service_date !== serviceDate;
                const isExpanded = !isPanel || expandedChargeId === charge.charge_id;
                const chargeHeader = <>
                  <span>
                    <em>{isPriorBalance ? 'ยอดค้างจากวันอื่น' : 'บิลวันนี้'}</em>
                    <b>{charge.charge_number ? `เลขที่บิล ${charge.charge_number}` : 'ขายสด'}</b>
                    <small>ส่งวันที่ {formatServiceDate(charge.service_date)}</small>
                  </span>
                  <span className="financial-ops__charge-total"><small>ยอดค้างบิลนี้</small><b>{money.format(charge.outstanding_amount)}</b></span>
                </>;
                return (
                  <article className={`${isPriorBalance ? 'is-prior-balance ' : ''}${isExpanded ? 'is-expanded' : ''}`.trim()} key={charge.charge_id}>
                    {isPanel ? <button
                      aria-controls={`financial-charge-items-${charge.charge_id}`}
                      aria-expanded={isExpanded}
                      aria-label={`ดูรายละเอียดบิลส่งของ ${charge.charge_number ?? 'ขายสด'}`}
                      className="financial-ops__charge-toggle"
                      onClick={() => setExpandedChargeId((current) => current === charge.charge_id ? null : charge.charge_id)}
                      type="button"
                    >
                      {chargeHeader}
                      <CaretDown aria-hidden="true" className="financial-ops__charge-caret" size={17} weight="bold" />
                    </button> : <header>{chargeHeader}</header>}
                    <div
                      aria-label={`รายการส่งของบิล ${charge.charge_number ?? 'ขายสด'}`}
                      className="financial-ops__charge-items"
                      hidden={!isExpanded}
                      id={`financial-charge-items-${charge.charge_id}`}
                      role="region"
                    >
                      {(charge.items ?? []).map((item) => (
                        <div key={item.ice_type_id}>
                          <span>{item.name} × {item.quantity.toLocaleString('th-TH')} {item.unit}</span>
                          <b>{money.format(item.line_total)}</b>
                        </div>
                      ))}
                      {(charge.items ?? []).length === 0 ? <small>ไม่พบรายละเอียดสินค้าของบิลนี้</small> : null}
                    </div>
                    {isExpanded && onEditCharge && charge.delivery_event_id ? <button
                      aria-label={`แก้ไขหรือยกเลิกใบส่งของ ${charge.charge_number ?? 'ขายสด'}`}
                      className="financial-ops__charge-edit"
                      disabled={busy}
                      onClick={() => onEditCharge(charge)}
                      type="button"
                    >แก้ไขหรือยกเลิกใบส่งของ</button> : null}
                    {charge.payment_term === 'credit' ? (
                      <button
                        className="financial-ops__due-date-request"
                        disabled={busy}
                        onClick={() => onRequestDueDate(charge)}
                        type="button"
                      >ขอเลื่อนกำหนด{charge.due_date ? ` · ${formatServiceDate(charge.due_date)}` : ''}</button>
                    ) : null}
                  </article>
                );
              })}
            </section>

            <section className="financial-ops__payment-methods" aria-labelledby="payment-method-label">
              <h3 id="payment-method-label">รูปแบบการชำระ</h3>
              <div style={{
                gridTemplateColumns: `repeat(${selectedShop.payment_profile.allowed_payment_methods.length}, minmax(0, 1fr))`,
              }}>
                {selectedShop.payment_profile.allowed_payment_methods.map((allowedMethod) => {
                  const Icon = allowedMethod === 'cash' ? Money : allowedMethod === 'bank_transfer' ? Bank : QrCode;
                  return (
                    <button
                      aria-pressed={method === allowedMethod}
                      className={method === allowedMethod ? 'is-selected' : ''}
                      key={allowedMethod}
                      onClick={() => onPaymentMethodChange(allowedMethod)}
                      type="button"
                    >
                      <Icon aria-hidden="true" size={22} weight="duotone" />
                      <span>{paymentMethodLabel(allowedMethod)}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="financial-ops__received-box">
              <label className="financial-ops__payment-amount">
                <span>{method === 'cash' ? 'รับเงินมา' : 'ยอดเงินที่โอน'}</span>
                <span className="financial-ops__currency" aria-hidden="true">฿</span>
                <input
                  aria-label="ยอดรับเงินจริง"
                  inputMode="decimal"
                  min="0.01"
                  onChange={(event) => onAmountChange(event.target.value)}
                  step="0.01"
                  type="number"
                  value={amount}
                />
                <small>บาท</small>
              </label>
              {method === 'cash' ? (
                <div className="financial-ops__change-amount">
                  <span>เงินทอน</span>
                  <strong>{money.format(changeAmount)}</strong>
                </div>
              ) : null}
            </section>

            {isPanel ? (
              <section className="financial-ops__inline-datetime" aria-label="วันและเวลาที่รับเงิน">
                <label><span>วันที่รับเงิน</span><input readOnly value={formatServiceDate(serviceDate)} /></label>
                <label><span>เวลา</span><input readOnly value={new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit' }).format(new Date())} /></label>
              </section>
            ) : null}

            {method === 'cash' ? (
              <div className="financial-ops__quick-amounts" aria-label="เลือกยอดรับเงินด่วน">
                {[100, 200, 500, 1000].map((value) => (
                  <button key={value} onClick={() => onAmountChange(value.toFixed(2))} type="button">
                    {value.toLocaleString('th-TH')}
                  </button>
                ))}
              </div>
            ) : null}

            <section className="financial-ops__payment-summary" aria-label="สรุปยอดรับเงิน">
              <span><small>ตัดยอด</small><strong>{money.format(allocatedAmount)}</strong></span>
              <span><small>คงเหลือหลังรายการ</small><b>{money.format(remainingAmount)}</b></span>
            </section>

            {(method !== 'cash' || evidenceRequired) ? (
              <label className="financial-ops__payment-evidence">
                <span>แนบภาพสลิป <small>({evidenceRequired ? 'บังคับ' : 'ไม่บังคับ'})</small></span>
                <input
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  aria-label="หลักฐานการชำระ"
                  onChange={(event) => onEvidenceChange(event.target.files?.[0] ?? null)}
                  required={evidenceRequired}
                  type="file"
                />
                <span className="financial-ops__dropzone">
                  <UploadSimple aria-hidden="true" size={25} weight="duotone" />
                  <b>{evidence ? evidence.name : 'อัปโหลดรูปสลิป'}</b>
                  <small>JPG, PNG, WebP หรือ PDF ไม่เกิน 5 MB</small>
                </span>
                {evidenceError ? <small className="financial-ops__evidence-error" role="alert">{evidenceError}</small> : null}
              </label>
            ) : null}

            <label className="financial-ops__payment-reference">
              <span>หมายเหตุ <small>(ไม่บังคับ)</small></span>
              <input
                aria-label="หมายเหตุ"
                onChange={(event) => onReferenceChange(event.target.value)}
                placeholder="เช่น ลูกค้าจ่ายแบงก์ใหญ่"
                value={reference}
              />
            </label>

            <label className="financial-ops__print-choice">
              <input checked={printReceiptWanted} disabled={busy} onChange={(event) => onPrintReceiptWantedChange(event.target.checked)} type="checkbox" />
              <span>พิมพ์ใบรับเงินหลังบันทึก</span>
            </label>

            <footer className="financial-ops__payment-actions">
              <button disabled={busy} onClick={onClose} type="button">ยกเลิก</button>
              <button disabled={busy || !paymentReady} onClick={onRecordPayment} type="button">
                <FloppyDisk aria-hidden="true" size={21} weight="regular" />
                {busy ? 'กำลังบันทึก...' : 'บันทึกรับเงินทันที'}
              </button>
            </footer>
          </div>
        )}
      </article>
    </div>
  );
}
