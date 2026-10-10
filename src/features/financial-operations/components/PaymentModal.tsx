import { uiDateTimeFormat, translateUi, useLanguage } from '../../../i18n';
import { useEffect, useState, type RefObject } from 'react';
import {
  Bank,
  CaretDown,
  CheckCircle,
  FloppyDisk,
  Info,
  ListNumbers,
  Money,
  Printer,
  Storefront,
  UploadSimple,
  X,
} from '@phosphor-icons/react';
import type { PaymentMethod } from '../../../types/app';
import type { PaymentReceipt, QueueShop } from '../types';
import { formatCollectionShopIdentity, formatServiceDate, money, paymentMethodLabel } from '../utils';
import { AutoRefreshShopImage } from './AutoRefreshShopImage';
import { toBangkokDateString } from '../../../lib/serviceDate';
import { visiblePaymentMethods } from '../../../lib/paymentMethods';

export function PaymentModal({
  presentation = 'modal',
  selectedShop,
  focusedChargeId,
  serviceDate,
  busy,
  canRecordPayment = true,
  canBackdatePayment = false,
  receivedDate = toBangkokDateString(),
  today = toBangkokDateString(),
  onReceivedDateChange,
  method,
  amount,
  reference,
  evidence,
  evidenceError,
  receipt,
  allocatedAmount,
  changeAmount,
  remainingAmount,
  selectedChargeIds,
  selectedOutstandingAmount,
  selectionReviewRequired,
  evidenceRequired,
  paymentReady,
  dialogRef,
  closeButtonRef,
  onClose,
  onPaymentMethodChange,
  onAmountChange,
  onEvidenceChange,
  onReferenceChange,
  onRecordPayment,
  onToggleCharge,
  onSelectAllCharges,
  onSelectTodayCharges,
  onClearChargeSelection,
  onConfirmSelectionReview,
  onEditCharge,
  onPrintReceipt,
  onRequestDueDate,
}: {
  presentation?: 'modal' | 'panel';
  selectedShop: QueueShop;
  focusedChargeId?: string | null;
  serviceDate: string;
  busy: boolean;
  canRecordPayment?: boolean;
  canBackdatePayment?: boolean;
  receivedDate?: string;
  today?: string;
  onReceivedDateChange?: (date: string) => void;
  method: PaymentMethod;
  amount: string;
  reference: string;
  evidence: File | null;
  evidenceError: string | null;
  receipt: PaymentReceipt | null;
  allocatedAmount: number;
  changeAmount: number;
  remainingAmount: number;
  selectedChargeIds: string[];
  selectedOutstandingAmount: number;
  selectionReviewRequired: boolean;
  evidenceRequired: boolean;
  paymentReady: boolean;
  dialogRef: RefObject<HTMLDivElement>;
  closeButtonRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
  onPaymentMethodChange: (method: PaymentMethod) => void;
  onAmountChange: (amount: string) => void;
  onEvidenceChange: (file: File | null) => void;
  onReferenceChange: (reference: string) => void;
  onRecordPayment: () => void;
  onToggleCharge: (chargeId: string) => void;
  onSelectAllCharges: () => void;
  onSelectTodayCharges: () => void;
  onClearChargeSelection: () => void;
  onConfirmSelectionReview: () => void;
  onEditCharge?: (charge: QueueShop['charges'][number]) => void;
  onPrintReceipt: (receipt: PaymentReceipt) => void;
  onRequestDueDate: (charge: QueueShop['charges'][number]) => void;
}) {
  useLanguage();
  const isPanel = presentation === 'panel';
  const [expandedChargeId, setExpandedChargeId] = useState<string | null>(null);
  const [evidencePreviewUrl, setEvidencePreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!evidence || evidenceError || !evidence.type.startsWith('image/')) {
      setEvidencePreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(evidence);
    setEvidencePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [evidence, evidenceError]);

  const focusedCharge = focusedChargeId
    ? selectedShop.charges.find((charge) => charge.charge_id === focusedChargeId) ?? null
    : null;
  const priorOutstandingAmount = focusedCharge
    ? Math.max(Number(selectedShop.outstanding_amount) - Number(focusedCharge.outstanding_amount), 0)
    : 0;
  const identity = formatCollectionShopIdentity(selectedShop);
  const availablePaymentMethods = visiblePaymentMethods(selectedShop.payment_profile.allowed_payment_methods);
  const selectedChargeIdSet = new Set(selectedChargeIds);
  return (
    <div
      aria-label={translateUi('รับเงิน {0}', { 0: identity.title })}
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
            <AutoRefreshShopImage
              alt={translateUi('ร้าน {0}', { 0: identity.title })}
              fallback={<Storefront aria-hidden="true" size={40} weight="duotone" />}
              imagePath={selectedShop.image_path}
              imageUrl={selectedShop.image_url}
            />
          </span>
          <span>
            <small>{identity.isEventOnly ? identity.boothText : selectedShop.shop_code}</small>
            <h2>{isPanel ? identity.title : translateUi('บันทึกรับชำระเงิน')}</h2>
            {isPanel ? (
              identity.shopName ? <b>{identity.shopName}</b> : null
            ) : (
              <b>{identity.isEventOnly ? (identity.shopName || identity.boothText) : selectedShop.shop_name}</b>
            )}
            {!identity.isEventOnly && selectedShop.destination_kind === 'event' ? <small>{[
              selectedShop.event_name,
              selectedShop.event_location,
              selectedShop.event_zone,
            ].filter(Boolean).join(' · ')}</small> : null}
            {selectedShop.billing_statement_number ? <small>{translateUi('ใบวางบิล ')}{selectedShop.billing_statement_number}</small> : null}
          </span>
          <button
            aria-label={translateUi('ปิดหน้ารับเงิน')}
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
            <span><strong>{translateUi('บันทึกรับเงินเรียบร้อย')}</strong><small>{translateUi('กดพิมพ์เมื่อร้านต้องการใบเสร็จ')}</small></span>
            <button onClick={() => onPrintReceipt(receipt)} type="button"><Printer aria-hidden="true" size={19} />{translateUi('พิมพ์ใบเสร็จ')}</button>
            <button onClick={onClose} type="button">{translateUi('เสร็จสิ้น')}</button>
          </div>
        ) : (
          <div className="financial-ops__payment">
            <section className="financial-ops__amount-due" aria-label={translateUi('ยอดที่ต้องชำระ')}>
              <span>{translateUi('ยอดบิลที่เลือก')}</span>
              <strong>{money.format(selectedOutstandingAmount)}</strong>
            </section>

            {focusedCharge ? (
              <section className="financial-ops__payment-breakdown" aria-label={translateUi('สรุปยอดหลังส่งรอบล่าสุด')}>
                <span><small>{translateUi('ยอดค้างก่อนหน้า')}</small><b>{money.format(priorOutstandingAmount)}</b></span>
                <span><small>{translateUi('ยอดส่งรอบล่าสุด')}</small><b>{money.format(focusedCharge.outstanding_amount)}</b></span>
                <span><small>{translateUi('ยอดบิลที่เลือก')}</small><strong>{money.format(selectedOutstandingAmount)}</strong></span>
              </section>
            ) : null}

            {!canRecordPayment ? (
              <p className="employee-error" role="status">{translateUi('ดูข้อมูลได้ แต่ยังไม่ได้รับสิทธิ์บันทึกรับเงิน')}</p>
            ) : null}

            <section className="financial-ops__charge-list" aria-label={translateUi('รายละเอียดบิลและรายการที่สั่ง')}>
              <div className="financial-ops__charge-list-title">
                <strong><ListNumbers aria-hidden="true" size={18} />{translateUi(' เลือกบิลที่ต้องการรับชำระ')}</strong>
                <small>{translateUi('เลือกแล้ว ')}{selectedChargeIds.length}{translateUi(' จาก ')}{selectedShop.charges.length}{translateUi(' บิล')}</small>
              </div>
              <div className="financial-ops__charge-selection-actions" aria-label={translateUi('คำสั่งเลือกบิล')}>
                <button disabled={busy || !canRecordPayment} onClick={onSelectAllCharges} type="button">{translateUi('เลือกทั้งหมด')}</button>
                <button disabled={busy || !canRecordPayment} onClick={onSelectTodayCharges} type="button">{translateUi('เฉพาะบิลวันนี้')}</button>
                <button disabled={busy || !canRecordPayment} onClick={onClearChargeSelection} type="button">{translateUi('ล้างการเลือก')}</button>
              </div>
              {selectionReviewRequired ? (
                <div className="financial-ops__selection-warning" role="alert">
                  <span>{translateUi('ยอดหรือรายการบิลเปลี่ยนจากข้อมูลที่เปิดไว้ กรุณาตรวจสอบยอดก่อนบันทึก')}</span>
                  <button disabled={busy || !canRecordPayment} onClick={onConfirmSelectionReview} type="button">{translateUi('ตรวจสอบแล้ว')}</button>
                </div>
              ) : null}
              {selectedChargeIds.length === 0 ? (
                <p className="financial-ops__selection-empty" role="status">{translateUi('กรุณาเลือกอย่างน้อย 1 บิลเพื่อรับชำระ')}</p>
              ) : null}
              {selectedShop.charges.map((charge) => {
                const isPriorBalance = charge.service_date !== serviceDate;
                const isExpanded = !isPanel || expandedChargeId === charge.charge_id;
                const isSelected = selectedChargeIdSet.has(charge.charge_id);
                const chargeHeader = <>
                  <span>
                    <em>{isPriorBalance ? translateUi('ยอดค้างจากวันอื่น') : translateUi('บิลวันนี้')}</em>
                    <b>{charge.charge_number ? translateUi('เลขที่บิล {0}', { 0: charge.charge_number }) : translateUi('ขายสด')}</b>
                    <small>{translateUi('ส่งวันที่ ')}{formatServiceDate(charge.service_date)}</small>
                  </span>
                  <span className="financial-ops__charge-total"><small>{translateUi('ยอดค้างบิลนี้')}</small><b>{money.format(charge.outstanding_amount)}</b></span>
                </>;
                return (
                  <article className={`${isPriorBalance ? 'is-prior-balance ' : ''}${isExpanded ? 'is-expanded ' : ''}${isSelected ? 'is-selected' : ''}`.trim()} key={charge.charge_id}>
                    <div className="financial-ops__charge-heading">
                      <label className="financial-ops__charge-selector">
                        <input
                          aria-label={translateUi('เลือกบิล {0}', { 0: charge.charge_number ?? translateUi('ขายสด') })}
                          checked={isSelected}
                          disabled={busy || !canRecordPayment}
                          onChange={() => onToggleCharge(charge.charge_id)}
                          type="checkbox"
                        />
                        {chargeHeader}
                      </label>
                      {isPanel ? <button
                        aria-controls={`financial-charge-items-${charge.charge_id}`}
                        aria-expanded={isExpanded}
                        aria-label={translateUi('ดูรายละเอียดบิลส่งของ {0}', { 0: charge.charge_number ?? translateUi('ขายสด') })}
                        className="financial-ops__charge-toggle"
                        onClick={() => setExpandedChargeId((current) => current === charge.charge_id ? null : charge.charge_id)}
                        type="button"
                      >
                        <CaretDown aria-hidden="true" className="financial-ops__charge-caret" size={17} weight="bold" />
                      </button> : null}
                    </div>
                    <div
                      aria-label={translateUi('รายการส่งของบิล {0}', { 0: charge.charge_number ?? translateUi('ขายสด') })}
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
                      {(charge.items ?? []).length === 0 ? <small>{translateUi('ไม่พบรายละเอียดสินค้าของบิลนี้')}</small> : null}
                    </div>
                    {isExpanded && onEditCharge && charge.delivery_event_id ? <button
                      aria-label={translateUi('ยกเลิกใบส่งน้ำแข็ง {0}', { 0: charge.charge_number ?? translateUi('ขายสด') })}
                      className="financial-ops__charge-edit"
                      disabled={busy}
                      onClick={() => onEditCharge(charge)}
                      type="button"
                    >{translateUi('ยกเลิกใบส่งน้ำแข็ง')}</button> : null}
                    {charge.payment_term === 'credit' ? (
                      <button
                        className="financial-ops__due-date-request"
                        disabled={busy || !canRecordPayment}
                        onClick={() => onRequestDueDate(charge)}
                        type="button"
                      >{translateUi('ขอเลื่อนกำหนด')}{charge.due_date ? ` · ${formatServiceDate(charge.due_date)}` : ''}</button>
                    ) : null}
                  </article>
                );
              })}
            </section>

            <section className="financial-ops__payment-methods" aria-labelledby="payment-method-label">
              <h3 id="payment-method-label">{translateUi('รูปแบบการชำระ')}</h3>
              <div style={{
                gridTemplateColumns: `repeat(${availablePaymentMethods.length}, minmax(0, 1fr))`,
              }}>
                {availablePaymentMethods.map((allowedMethod) => {
                  const Icon = allowedMethod === 'cash' ? Money : Bank;
                  return (
                    <button
                      aria-pressed={method === allowedMethod}
                      className={method === allowedMethod ? 'is-selected' : ''}
                      disabled={busy || !canRecordPayment}
                      key={allowedMethod}
                      onClick={() => onPaymentMethodChange(allowedMethod)}
                      type="button"
                    >
                      <Icon aria-hidden="true" size={22} weight="duotone" />
                      <span>{translateUi(paymentMethodLabel(allowedMethod))}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="financial-ops__received-box">
              <label className="financial-ops__payment-amount">
                <span>{method === 'cash' ? translateUi('รับเงินมา') : translateUi('ยอดเงินที่โอน')}</span>
                <span className="financial-ops__currency" aria-hidden="true">฿</span>
                <input
                  aria-label={translateUi('ยอดรับเงินจริง')}
                  disabled={busy || !canRecordPayment}
                  inputMode="decimal"
                  min="0.01"
                  onChange={(event) => onAmountChange(event.target.value)}
                  step="0.01"
                  type="number"
                  value={amount}
                />
                <small>{translateUi('บาท')}</small>
              </label>
              {method === 'cash' ? (
                <div className="financial-ops__change-amount">
                  <span>{translateUi('เงินทอน')}</span>
                  <strong>{money.format(changeAmount)}</strong>
                </div>
              ) : null}
            </section>

            {canBackdatePayment ? (
              <section className="financial-ops__backdate-payment" aria-label={translateUi('วันและเวลาที่รับเงิน')}>
                <label>
                  <span>{translateUi('วันที่รับเงิน')}</span>
                  <input
                    disabled={busy || !canRecordPayment}
                    max={today}
                    onChange={(event) => onReceivedDateChange?.(event.target.value)}
                    required
                    type="date"
                    value={receivedDate}
                  />
                </label>
                <small className="financial-ops__backdate-hint">
                  <Info aria-hidden="true" size={14} weight="bold" />
                  <span>{translateUi('เลือกวันที่เงินเข้าจริง ระบบเก็บเวลาที่บันทึกแยกไว้ให้อัตโนมัติ')}</span>
                </small>
              </section>
            ) : isPanel ? (
              <section className="financial-ops__inline-datetime" aria-label={translateUi('วันและเวลาที่รับเงิน')}>
                <label><span>{translateUi('วันที่รับเงิน')}</span><input readOnly value={formatServiceDate(today)} /></label>
                <label><span>{translateUi('เวลา')}</span><input readOnly value={uiDateTimeFormat({ hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }).format(new Date())} /></label>
              </section>
            ) : null}

            {method === 'cash' ? (
              <div className="financial-ops__quick-amounts" aria-label={translateUi('เลือกยอดรับเงินด่วน')}>
                {[100, 200, 500, 1000].map((value) => (
                  <button disabled={busy || !canRecordPayment} key={value} onClick={() => onAmountChange(value.toFixed(2))} type="button">
                    {value.toLocaleString('th-TH')}
                  </button>
                ))}
              </div>
            ) : null}

            <section className="financial-ops__payment-summary" aria-label={translateUi('สรุปยอดรับเงิน')}>
              <span><small>{translateUi('ยอดบิลที่เลือก')}</small><strong>{money.format(selectedOutstandingAmount)}</strong></span>
              <span><small>{translateUi('ยอดรับชำระ')}</small><strong>{money.format(allocatedAmount)}</strong></span>
              <span><small>{translateUi('ยอดค้างทั้งหมดหลังรับเงิน')}</small><b>{money.format(remainingAmount)}</b></span>
            </section>

            {(method !== 'cash' || evidenceRequired) ? (
              <label className="financial-ops__payment-evidence">
                <span>{translateUi('แนบภาพสลิป ')}<small>({evidenceRequired ? translateUi('บังคับ') : translateUi('ไม่บังคับ')})</small></span>
                <input
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  aria-label={translateUi('หลักฐานการชำระ')}
                  disabled={busy || !canRecordPayment}
                  onChange={(event) => onEvidenceChange(event.target.files?.[0] ?? null)}
                  required={evidenceRequired}
                  type="file"
                />
                <span className="financial-ops__dropzone">
                  {evidencePreviewUrl ? (
                    <img className="financial-ops__evidence-preview" src={evidencePreviewUrl} alt={translateUi('ภาพตัวอย่างสลิปที่แนบ')} />
                  ) : (
                    <UploadSimple aria-hidden="true" size={25} weight="duotone" />
                  )}
                  {evidence && !evidenceError ? (
                    <span className="financial-ops__evidence-attached" role="status">
                      <CheckCircle aria-hidden="true" size={18} weight="fill" />
                      {evidence.type === 'application/pdf' ? translateUi('แนบไฟล์ PDF แล้ว') : translateUi('แนบสลิปแล้ว')}
                    </span>
                  ) : null}
                  <b>{evidence ? evidence.name : translateUi('อัปโหลดรูปสลิป')}</b>
                  {evidence && !evidenceError ? <small>{translateUi('แตะเพื่อเปลี่ยนไฟล์ · กดบันทึกรับเงินเพื่อยืนยัน')}</small> : null}
                  <small>{translateUi('JPG, PNG, WebP หรือ PDF ไม่เกิน 5 MB')}</small>
                </span>
                {evidenceError ? <small className="financial-ops__evidence-error" role="alert">{translateUi(evidenceError)}</small> : null}
              </label>
            ) : null}

            <label className="financial-ops__payment-reference">
              <span>{translateUi('หมายเหตุ ')}<small>{translateUi('(ไม่บังคับ)')}</small></span>
              <input
                aria-label={translateUi('หมายเหตุ')}
                disabled={busy || !canRecordPayment}
                onChange={(event) => onReferenceChange(event.target.value)}
                placeholder={translateUi('เช่น ลูกค้าจ่ายแบงก์ใหญ่')}
                value={reference}
              />
            </label>

            <footer className="financial-ops__payment-actions">
              <button disabled={busy} onClick={onClose} type="button">{translateUi('ยกเลิก')}</button>
              <button disabled={busy || !canRecordPayment || !paymentReady} onClick={onRecordPayment} type="button">
                <FloppyDisk aria-hidden="true" size={21} weight="regular" />
                {busy ? translateUi('กำลังบันทึก...') : translateUi('บันทึกรับเงินทันที')}
              </button>
            </footer>
          </div>
        )}
      </article>
    </div>
  );
}
