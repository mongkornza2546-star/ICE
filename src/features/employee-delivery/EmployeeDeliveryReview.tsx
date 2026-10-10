import { translateUi, useLanguage } from '../../i18n';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import {
  ArrowLeft,
  Bank,
  Backspace,
  CheckCircle,
  IceCream,
  MapPin,
  Money,
  MagnifyingGlass,
  Storefront,
  Trash,
  UploadSimple,
  WarningCircle,
} from '@phosphor-icons/react';
import { formatCreditCollectionCycle } from '../../lib/creditCollectionCycle';
import type {
  DeliveryFinancialResult,
  DeliveryPosContext,
  DeliveryRound,
  EmployeeStockState,
  IceTypeOption,
  PaymentMethod,
  PaymentTerm,
  ShopCard,
  ShopRoundStatus,
} from '../../types/app';
import { MAX_PAYMENT_EVIDENCE_SIZE } from '../../lib/paymentEvidence';
import { formatShortTime, isBoothSameAsName, renderTotals, statusTone, stockQuantity, toTotals } from './utils';
import { PROBLEM_STATUSES, STATUS_LABELS } from './constants';
import { DeliveryCorrectionDialog } from '../delivery-corrections/DeliveryCorrectionDialog';
import { AutoRefreshShopImage } from '../financial-operations/components/AutoRefreshShopImage';
import { visiblePaymentMethods } from '../../lib/paymentMethods';

const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'เงินสด',
  bank_transfer: 'โอนเงิน',
  qr: 'โอนเงิน',
};

const money = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 2,
});

export function EmployeeDeliveryReview({
  round,
  shopCard,
  atomicImmediateSale,
  canCollectImmediatePayment,
  assignedStockState,
  deliveryQuantities,
  posContext,
  posContextError,
  loadingPosContext,
  paymentResult,
  paymentOpen,
  paymentMethod,
  paymentAmount,
  paymentReference,
  paymentEvidence,
  paymentEvidenceUploaded,
  paymentSubmitting,
  approvalId,
  approvalReason,
  approvalSubmitting,
  enableAssignedStockFlow,
  iceTypes,
  items,
  status,
  stockSourceLabel,
  shopCards,
  note,
  problemOpen,
  submitting,
  entryError,
  onBack,
  onChangeShop,
  onSubmit,
  onChooseProblemStatus,
  onSetQuantity,
  onClearCart,
  onConfirmDelivery,
  hasPendingDelivery = false,
  onRetryDelivery,
  onPaymentMethodChange,
  onPaymentAmountChange,
  onPaymentReferenceChange,
  onPaymentEvidenceChange,
  onPaymentCancel,
  onPaymentSubmit,
  onApprovalReasonChange,
  onRequestApproval,
  onNoteChange,
  onReturnToDelivery,
  onCorrectionSuccess,
}: {
  round: DeliveryRound;
  shopCard: ShopCard;
  atomicImmediateSale: boolean;
  canCollectImmediatePayment: boolean;
  assignedStockState: EmployeeStockState | null;
  deliveryQuantities: Record<string, number>;
  posContext: DeliveryPosContext | null;
  posContextError: string | null;
  loadingPosContext: boolean;
  paymentResult: DeliveryFinancialResult | null;
  paymentOpen: boolean;
  paymentMethod: PaymentMethod;
  paymentAmount: string;
  paymentReference: string;
  paymentEvidence: File | null;
  paymentEvidenceUploaded: boolean;
  paymentSubmitting: boolean;
  approvalId: string | null;
  approvalReason: string;
  approvalSubmitting: boolean;
  enableAssignedStockFlow: boolean;
  iceTypes: IceTypeOption[];
  items: Array<{ ice_type_id: string; quantity: number }>;
  status: Exclude<ShopRoundStatus, 'pending'>;
  stockSourceLabel: string;
  shopCards: ShopCard[];
  note: string;
  problemOpen: boolean;
  submitting: boolean;
  entryError: string | null;
  onBack: () => void;
  onChangeShop: (card: ShopCard) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onChooseProblemStatus: (status: Exclude<ShopRoundStatus, 'pending' | 'delivered'>) => void;
  onSetQuantity: (iceTypeId: string, quantity: number) => void;
  onClearCart: () => void;
  onConfirmDelivery: (term: PaymentTerm) => void;
  hasPendingDelivery?: boolean;
  onRetryDelivery?: () => void;
  onPaymentMethodChange: (method: PaymentMethod) => void;
  onPaymentAmountChange: (amount: string) => void;
  onPaymentReferenceChange: (reference: string) => void;
  onPaymentEvidenceChange: (file: File | null) => void;
  onPaymentCancel: () => void;
  onPaymentSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onApprovalReasonChange: (reason: string) => void;
  onRequestApproval: () => void;
  onNoteChange: (value: string) => void;
  onReturnToDelivery: () => void;
  onCorrectionSuccess: (message: string) => void | Promise<void>;
}) {
  useLanguage();
  const [selectedIceTypeId, setSelectedIceTypeId] = useState('');
  const [shopSearch, setShopSearch] = useState('');
  const [quantityInput, setQuantityInput] = useState('');
  const quantityInputRef = useRef<HTMLInputElement>(null);
  const layoutRef = useRef<HTMLFormElement>(null);
  const [mobileStep, setMobileStep] = useState<'items' | 'review'>('items');
  const [paymentEvidenceError, setPaymentEvidenceError] = useState<string | null>(null);
  const [correctionEventId, setCorrectionEventId] = useState<string | null>(null);
  const isDelivery = status === 'delivered';
  const contextItems = posContext?.items ?? iceTypes.map((iceType) => ({
    ...iceType,
    ice_type_id: iceType.id,
    image_path: null,
    stock_quantity: enableAssignedStockFlow
      ? stockQuantity(assignedStockState?.holding_location.balances, iceType.id)
      : Number.MAX_SAFE_INTEGER,
    unit_price: null,
    price_source: null,
    price_source_id: null,
  }));
  const selectedItem = contextItems.find((item) => item.ice_type_id === selectedIceTypeId);
  const selectedQuantity = selectedItem ? deliveryQuantities[selectedItem.ice_type_id] ?? 0 : 0;
  const canEditQuantity = !submitting && round.status !== 'closed';
  const shopQuery = shopSearch.trim().toLocaleLowerCase('th-TH');
  const inputQuantity = Number(quantityInput);
  const hasUncommittedQuantity = Boolean(selectedItem)
    && (quantityInput.trim() === '' || !Number.isFinite(inputQuantity) || inputQuantity !== selectedQuantity);
  const visibleShopCards = shopCards.filter((card) => [
    card.shop_code, card.shop_name, card.booth_number, card.building_name, card.floor_or_zone,
  ].some((value) => value?.toLocaleLowerCase('th-TH').includes(shopQuery)));
  const totalAmount = useMemo(() => items.reduce((total, item) => {
    const product = contextItems.find((candidate) => candidate.ice_type_id === item.ice_type_id);
    return total + item.quantity * (product?.unit_price ?? 0);
  }, 0), [contextItems, items]);
  const missingPrice = items.some((item) => (
    contextItems.find((candidate) => candidate.ice_type_id === item.ice_type_id)?.unit_price == null
  ));
  const isCreditShop = Boolean(posContext?.payment_profile?.allowed_payment_terms.includes('credit'));
  const exceedsCredit = isCreditShop
    && posContext?.payment_profile?.credit_remaining != null
    && totalAmount > posContext.payment_profile.credit_remaining;
  const financialContextRequired = loadingPosContext || Boolean(posContextError) || Boolean(posContext);
  const canSubmit = !submitting
    && round.status !== 'closed'
    && !hasUncommittedQuantity
    && (!isDelivery || (
      !financialContextRequired
      || (
        items.length > 0
        && !loadingPosContext
        && !posContextError
        && posContext?.payment_profile
        && !missingPrice
        && (!exceedsCredit || Boolean(approvalId))
      )
    ));

  const enterDigit = (digit: string) => {
    if (!selectedItem) return;
    const current = String(deliveryQuantities[selectedItem.ice_type_id] ?? 0);
    const next = Number(current === '0' ? digit : `${current}${digit}`);
    onSetQuantity(selectedItem.ice_type_id, next);
  };

  useEffect(() => {
    setSelectedIceTypeId('');
    setMobileStep('items');
    setPaymentEvidenceError(null);
  }, [shopCard.round_stop_id]);

  useEffect(() => {
    setQuantityInput(String(selectedQuantity));
  }, [selectedIceTypeId, selectedQuantity]);

  useEffect(() => {
    const input = quantityInputRef.current;
    if (input && input.getClientRects().length > 0) {
      input.focus({ preventScroll: true });
      input.select();
    }
  }, [selectedIceTypeId]);

  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout || paymentOpen || problemOpen) return;
    const updateHeight = () => {
      // Keep the work area inside the viewport, including any notices above it.
      const top = layout.getBoundingClientRect().top + window.scrollY;
      layout.style.setProperty('--employee-pos-height', `${Math.max(0, window.innerHeight - top - 16)}px`);
    };
    updateHeight();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateHeight);
    observer?.observe(layout.parentElement!);
    window.addEventListener('resize', updateHeight);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateHeight);
    };
  }, [paymentOpen, problemOpen, loadingPosContext, posContextError]);

  const finishQuantity = (advanceToNext = false) => {
    if (!selectedItem || !canEditQuantity) return;
    if (quantityInputRef.current && !quantityInputRef.current.checkValidity()) {
      quantityInputRef.current.reportValidity();
      return;
    }
    const nextQuantity = quantityInput.trim() === '' ? 0 : inputQuantity;
    if (!Number.isFinite(nextQuantity) || nextQuantity < 0 || (nextQuantity === 0 && !advanceToNext)) return;
    onSetQuantity(selectedItem.ice_type_id, nextQuantity);
    if (advanceToNext) {
      const currentIndex = contextItems.findIndex((item) => item.ice_type_id === selectedItem.ice_type_id);
      const nextItem = [...contextItems.slice(currentIndex + 1), ...contextItems.slice(0, currentIndex)]
        .find((item) => item.stock_quantity > 0 && (item.unit_price != null || !posContext));
      if (nextItem && nextItem.ice_type_id !== selectedItem.ice_type_id) {
        setSelectedIceTypeId(nextItem.ice_type_id);
        return;
      }
    }
    layoutRef.current?.querySelector<HTMLButtonElement>('.employee-pos-product-grid button[aria-pressed="true"]')?.focus({ preventScroll: true });
    setSelectedIceTypeId('');
  };

  const handleQuantityInput = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value;
    setQuantityInput(value);
  };

  const handleQuantityKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (event.key === 'Enter' && target.matches('input')) {
      // An input's Enter must never implicitly submit the delivery form.
      event.preventDefault();
      if (target === quantityInputRef.current) finishQuantity(true);
      return;
    }
    if (!canEditQuantity || !selectedItem || !target.closest('.employee-pos-entry')
      || target.matches('input, textarea, select, [contenteditable="true"]')) return;
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      enterDigit(event.key);
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      onSetQuantity(selectedItem.ice_type_id, Number(String(selectedQuantity).slice(0, -1) || '0'));
    } else if (event.key === 'Enter' && target.closest('.employee-pos-product-grid')) {
      event.preventDefault();
      finishQuantity();
    }
  };

  const handlePaymentEvidenceChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    if (file && file.size > MAX_PAYMENT_EVIDENCE_SIZE) {
      event.currentTarget.value = '';
      onPaymentEvidenceChange(null);
      setPaymentEvidenceError('หลักฐานต้องมีขนาดไม่เกิน 5 MB');
      return;
    }
    onPaymentEvidenceChange(file);
    setPaymentEvidenceError(null);
  };

  if (paymentOpen && paymentResult) {
    const profile = posContext?.payment_profile;
    const availablePaymentMethods = visiblePaymentMethods(profile?.allowed_payment_methods ?? ['cash', 'bank_transfer']);
    const totalDue = paymentResult.total_amount ?? 0;
    const receivedAmount = Number(paymentAmount) || 0;
    const allocatedAmount = receivedAmount >= totalDue ? totalDue : receivedAmount;
    const remainingAmount = Math.max(totalDue - receivedAmount, 0);
    const changeAmount = paymentMethod === 'cash'
      ? Math.max(receivedAmount - allocatedAmount, 0)
      : 0;
    const evidenceRequired = paymentMethod === 'cash'
      ? profile?.cash_evidence_required
      : paymentMethod === 'bank_transfer'
        ? true
        : profile?.qr_evidence_required;
    const cashUnderpayment = atomicImmediateSale && paymentMethod === 'cash' && receivedAmount < totalDue;
    const nonCashMismatch = atomicImmediateSale && paymentMethod !== 'cash' && receivedAmount !== totalDue;
    const nonCashOverpayment = !atomicImmediateSale && paymentMethod !== 'cash' && receivedAmount > totalDue;
    const outstandingApprovalRequired = !atomicImmediateSale && Boolean(
      profile && !profile.allow_outstanding && remainingAmount > 0,
    );
    const paymentReady = (!evidenceRequired || Boolean(paymentEvidence) || paymentEvidenceUploaded)
      && receivedAmount > 0
      && !cashUnderpayment
      && !nonCashMismatch
      && !nonCashOverpayment
      && (!outstandingApprovalRequired || Boolean(approvalId));
    const resultItems = paymentResult.items ?? [];
    const billedItems = resultItems.length > 0
      ? resultItems
      : items.map((item) => {
          const product = contextItems.find((candidate) => candidate.ice_type_id === item.ice_type_id);
          return {
            ...item,
            name: product?.name,
            unit: product?.unit,
            line_total: item.quantity * (product?.unit_price ?? 0),
          };
        });
    return (
      <div className="employee-payment-sheet financial-ops__payment-card">
        <header>
          <span className="financial-ops__payment-image">
            <AutoRefreshShopImage
              alt={translateUi('ร้าน {0}', { 0: shopCard.shop_name })}
              fallback={<Storefront aria-hidden="true" size={40} weight="duotone" />}
              imagePath={shopCard.image_path}
              imageUrl={shopCard.image_url}
            />
          </span>
          <span>
            <small>{shopCard.destination_kind === 'event'
              ? (shopCard.booth_number ? translateUi('บูธ {0}', { 0: shopCard.booth_number }) : '')
              : shopCard.shop_code}</small>
            <h2>{translateUi('บันทึกรับชำระเงิน')}</h2>
            <b>{shopCard.shop_name}</b>
          </span>
          <span aria-hidden="true" />
        </header>
        <form onSubmit={onPaymentSubmit}>
          <fieldset disabled={paymentSubmitting}>
            <section className="financial-ops__amount-due" aria-label={translateUi('ยอดที่ต้องชำระ')}>
              <span>{translateUi('ยอดที่ต้องชำระ')}</span>
              <strong>{money.format(totalDue)}</strong>
            </section>

            <section className="financial-ops__current-order" aria-label={translateUi('รายการที่สั่งในบิลนี้')}>
              <strong>{translateUi('รายการที่สั่งในบิลนี้')}</strong>
              {billedItems.map((item) => {
                const iceType = contextItems.find((candidate) => candidate.ice_type_id === item.ice_type_id);
                return (
                  <div key={item.ice_type_id}>
                    <span>{item.name ?? iceType?.name ?? translateUi('ไม่พบชื่อสินค้า')} × {item.quantity.toLocaleString('th-TH')} {item.unit ?? iceType?.unit ?? ''}</span>
                    <b>{money.format(item.line_total ?? 0)}</b>
                  </div>
                );
              })}
            </section>

            <section className="financial-ops__payment-methods" aria-labelledby="employee-payment-method-label">
              <h3 id="employee-payment-method-label">{translateUi('รูปแบบการชำระ')}</h3>
              <div style={{
                gridTemplateColumns: `repeat(${availablePaymentMethods.length}, minmax(0, 1fr))`,
              }}>
                {availablePaymentMethods.map((method) => {
                  const Icon = method === 'cash' ? Money : Bank;
                  return (
                    <button
                      aria-pressed={paymentMethod === method}
                      className={paymentMethod === method ? 'is-selected' : ''}
                      key={method}
                      onClick={() => onPaymentMethodChange(method)}
                      type="button"
                    >
                      <Icon aria-hidden="true" size={25} weight="duotone" />
                      <span>{translateUi(METHOD_LABELS[method])}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="financial-ops__received-box">
              <label className="financial-ops__payment-amount">
                <span>{paymentMethod === 'cash' ? translateUi('รับเงินมา') : translateUi('ยอดเงินที่โอน')}</span>
                <span className="financial-ops__currency" aria-hidden="true">฿</span>
                <input
                  aria-label={translateUi('ยอดรับเงินจริง')}
                  inputMode="decimal"
                  min="0.01"
                  max={paymentMethod === 'cash' ? undefined : totalDue}
                  onChange={(event) => onPaymentAmountChange(event.target.value)}
                  step="0.01"
                  type="number"
                  value={paymentAmount}
                />
                <small>{translateUi('บาท')}</small>
              </label>
              {paymentMethod === 'cash' ? (
                <div className="financial-ops__change-amount">
                  <span>{translateUi('เงินทอน')}</span>
                  <strong>{money.format(changeAmount)}</strong>
                </div>
              ) : null}
            </section>

            {paymentMethod === 'cash' ? (
              <div className="financial-ops__quick-amounts" aria-label={translateUi('เลือกยอดรับเงินด่วน')}>
                {[100, 200, 500, 1000].map((value) => (
                  <button key={value} onClick={() => onPaymentAmountChange(value.toFixed(2))} type="button">
                    {value.toLocaleString('th-TH')}
                  </button>
                ))}
              </div>
            ) : null}
          </fieldset>

          <section className="financial-ops__payment-summary" aria-label={translateUi('สรุปยอดรับเงิน')}>
            <span><small>{translateUi('ตัดยอด')}</small><strong>{money.format(allocatedAmount)}</strong></span>
            <span><small>{translateUi('คงเหลือหลังรายการ')}</small><b>{money.format(remainingAmount)}</b></span>
          </section>

          <label className="financial-ops__payment-reference">
            <span>{translateUi('หมายเหตุ ')}<small>{translateUi('(ไม่บังคับ)')}</small></span>
            <input
              aria-label={translateUi('หมายเหตุ')}
              disabled={paymentSubmitting}
              onChange={(event) => onPaymentReferenceChange(event.target.value)}
              placeholder={translateUi('เช่น ลูกค้าจ่ายแบงก์ใหญ่')}
              value={paymentReference}
            />
          </label>

          <label className="financial-ops__payment-evidence">
            <span>{translateUi('หลักฐานการชำระ ')}<small>({evidenceRequired ? translateUi('บังคับ') : translateUi('ไม่บังคับ')})</small></span>
            <input
              accept="image/jpeg,image/png,image/webp,application/pdf"
              aria-label={translateUi('หลักฐานการชำระ')}
              disabled={paymentSubmitting}
              onChange={handlePaymentEvidenceChange}
              required={evidenceRequired}
              type="file"
            />
            <span className="financial-ops__dropzone">
              <UploadSimple aria-hidden="true" size={25} weight="duotone" />
              <b>{paymentEvidence
                ? paymentEvidence.name
                : paymentEvidenceUploaded
                  ? translateUi('ใช้หลักฐานที่อัปโหลดแล้ว')
                  : translateUi('อัปโหลดรูปสลิป')}</b>
              <small>{translateUi('JPG, PNG, WebP หรือ PDF ไม่เกิน 5 MB')}</small>
            </span>
            {paymentEvidenceError ? <small className="financial-ops__evidence-error" role="alert">{translateUi(paymentEvidenceError)}</small> : null}
          </label>

          {cashUnderpayment ? <p className="employee-error" role="alert">{translateUi('ขายสดต้องรับเงินสดครบยอดก่อนบันทึก')}</p> : null}
          {nonCashMismatch ? <p className="employee-error" role="alert">{translateUi('ยอดโอนหรือ QR ต้องเท่ากับยอดเรียกเก็บ')}</p> : null}
          {nonCashOverpayment ? <p className="employee-error" role="alert">{translateUi('ยอดโอนหรือ QR ต้องไม่เกินยอดเรียกเก็บ')}</p> : null}
          {outstandingApprovalRequired ? (
            <div className="employee-approval-request">
              <strong>{approvalId
                ? translateUi('อนุมัติยอดค้าง {0} แล้ว', { 0: money.format(remainingAmount) })
                : translateUi('ร้านนี้ต้องอนุมัติก่อนค้าง {0}', { 0: money.format(remainingAmount) })}</strong>
              {!approvalId ? (
                <>
                  <textarea
                    onChange={(event) => onApprovalReasonChange(event.target.value)}
                    placeholder={translateUi('เหตุผลที่รับเงินไม่ครบ')}
                    rows={2}
                    value={approvalReason}
                  />
                  <button disabled={approvalSubmitting} onClick={onRequestApproval} type="button">
                    {approvalSubmitting ? translateUi('กำลังตรวจคำขอ...') : translateUi('ขออนุมัติ / ตรวจสถานะ')}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
          {entryError ? <p className="employee-error" role="alert">{translateUi(entryError)}</p> : null}
          <div className="financial-ops__payment-actions">
            {atomicImmediateSale ? <button disabled={paymentSubmitting} onClick={onPaymentCancel} type="button">{translateUi('กลับไปแก้รายการ')}</button> : null}
            <button disabled={paymentSubmitting || !paymentReady} type="submit">
              {paymentSubmitting ? translateUi('กำลังบันทึกรับเงิน...') : translateUi('ยืนยันรับเงิน')}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className={`employee-pos ${problemOpen ? '' : 'employee-pos--desktop-layout'}`}>
      <div className="employee-pos-toolbar">
      <button autoFocus className="employee-back" disabled={submitting} onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={24} />
        <span>{translateUi('กลับไปเลือกร้าน')}</span>
      </button>

      <nav aria-label={translateUi('ขั้นตอนบันทึกส่ง')} className="employee-pos-mobile-steps">
        <button disabled={submitting} onClick={onBack} type="button"><span>1</span>{translateUi(' ร้าน')}</button>
        <button aria-current={mobileStep === 'items' ? 'step' : undefined} onClick={() => setMobileStep('items')} type="button"><span>2</span>{translateUi(' รายการ')}</button>
        <button aria-current={mobileStep === 'review' ? 'step' : undefined} disabled={submitting || items.length === 0 || hasUncommittedQuantity} onClick={() => setMobileStep('review')} type="button"><span>3</span>{translateUi(' ตรวจ')}</button>
      </nav>

      <header className="employee-pos-shop">
        <AutoRefreshShopImage
          alt=""
          fallback={<span><Storefront aria-hidden="true" size={30} /></span>}
          imagePath={shopCard.image_path}
          imageUrl={shopCard.image_url}
        />
        <div>
          {shopCard.destination_kind === 'event' ? (
            <>
              {shopCard.booth_number && !isBoothSameAsName(shopCard.shop_name, shopCard.booth_number) ? (
                <p>{translateUi('บูธ ')}{shopCard.booth_number}</p>
              ) : null}
              <h1>{shopCard.booth_number ? (isBoothSameAsName(shopCard.shop_name, shopCard.booth_number) ? translateUi('บูธ {0}', { 0: shopCard.booth_number }) : shopCard.shop_name) : shopCard.shop_name}</h1>
            </>
          ) : (
            <>
              <p>{shopCard.shop_code}</p>
              <h1>{shopCard.shop_name}</h1>
            </>
          )}
          <small><MapPin aria-hidden="true" size={16} />{shopCard.destination_kind === 'event' ? `${shopCard.event_name ?? shopCard.building_name} · ${shopCard.floor_or_zone}` : `${shopCard.building_name} · ${shopCard.floor_or_zone}`}</small>
        </div>
        <span className={`employee-status employee-status--${statusTone(shopCard.stop_status)}`}>
          {translateUi(STATUS_LABELS[shopCard.stop_status])}
        </span>
      </header>
      </div>

      {loadingPosContext ? <p className="employee-pos-notice">{translateUi('กำลังโหลดราคา สต๊อก และเงื่อนไขชำระ…')}</p> : null}
      {posContext?.client_cache?.stale ? (
        <p className="employee-pos-notice" role="status">
          {translateUi('ใช้ราคา สต๊อก และเงื่อนไขที่บันทึกไว้ล่าสุด เนื่องจากเครือข่ายยังไม่พร้อม')}</p>
      ) : null}
      {posContextError ? <p className="employee-error" role="alert">{translateUi(posContextError)}</p> : null}

      <form className="employee-pos-layout" onKeyDown={handleQuantityKeyDown} onSubmit={onSubmit} ref={layoutRef}>
        {!problemOpen ? (
          <>
            <section aria-label={translateUi('เลือกร้านอื่น')} className="employee-pos-shops">
              <div className="employee-pos-heading"><div><p>{translateUi('ร้าน')}</p><h2>{translateUi('ร้านในรอบ')}</h2></div><span>{shopCards.length}{translateUi(' ร้าน')}</span></div>
              <label className="employee-search employee-pos-shop-search">
                <MagnifyingGlass aria-hidden="true" size={18} />
                <input aria-label={translateUi('ค้นหาร้านในรอบ')} disabled={submitting} onChange={(event) => setShopSearch(event.target.value)} placeholder={translateUi('รหัส / ชื่อร้าน')} type="search" value={shopSearch} />
              </label>
              <div className="employee-pos-shop-list">
                {visibleShopCards.length === 0 ? <p className="employee-pos-no-shops">{translateUi('ไม่พบร้านที่ค้นหา')}</p> : null}
                {visibleShopCards.map((card) => {
                  const isEvent = card.destination_kind === 'event';
                  const boothText = card.booth_number ? translateUi('บูธ {0}', { 0: card.booth_number }) : '';
                  const sameBooth = isEvent && isBoothSameAsName(card.shop_name, card.booth_number);
                  return (
                    <button
                      aria-current={card.round_stop_id === shopCard.round_stop_id ? 'true' : undefined}
                      disabled={submitting}
                      key={card.round_stop_id}
                      onClick={() => onChangeShop(card)}
                      type="button"
                    >
                      <strong>{isEvent ? (boothText || card.shop_name) : card.shop_code}</strong>
                      <span>{isEvent ? (sameBooth ? '' : card.shop_name) : card.shop_name}</span>
                    </button>
                  );
                })}
              </div>
            </section>
            <div className="employee-pos-entry">
            <section className={`employee-pos-products ${mobileStep === 'items' ? '' : 'employee-pos-mobile--hidden'}`} aria-labelledby="employee-delivery-items">
              <div className="employee-pos-heading">
                <div>
                  <p>{translateUi('สินค้า')}</p>
                  <h2 id="employee-delivery-items">{translateUi('เลือกน้ำแข็ง')}</h2>
                </div>
                <span>{translateUi('ตัดจาก ')}{posContext?.stock_source.name ?? (enableAssignedStockFlow
                  ? assignedStockState?.holding_location.name ?? translateUi('จุดถือครอง')
                  : stockSourceLabel)}</span>
              </div>
              <div className="employee-pos-product-grid">
                {contextItems.map((iceType) => {
                  const selected = selectedItem?.ice_type_id === iceType.ice_type_id;
                  const quantity = deliveryQuantities[iceType.ice_type_id] ?? 0;
                  return (
                    <button
                      aria-pressed={selected}
                      className={selected ? 'employee-pos-product--selected' : ''}
                      disabled={submitting || round.status === 'closed' || iceType.unit_price == null && Boolean(posContext)}
                      key={iceType.ice_type_id}
                      onClick={() => setSelectedIceTypeId(iceType.ice_type_id)}
                      type="button"
                    >
                      {iceType.image_url ? (
                        <img alt="" className="employee-pos-product-image" src={iceType.image_url} />
                      ) : (
                        <span className="employee-pos-product-image"><IceCream aria-hidden="true" /></span>
                      )}
                      <span className="employee-pos-product-selected">{selected ? <CheckCircle aria-hidden="true" weight="fill" /> : null}</span>
                      <strong>{iceType.name}</strong>
                      <small>{iceType.unit_price == null ? translateUi('ยังไม่มีราคา') : `${money.format(iceType.unit_price)} / ${iceType.unit}`}</small>
                      <b>{quantity > 0 ? quantity : '—'}</b>
                      <em>{translateUi('คงเหลือ ')}{iceType.stock_quantity === Number.MAX_SAFE_INTEGER ? '—' : iceType.stock_quantity} {iceType.unit}</em>
                    </button>
                  );
                })}
              </div>
            </section>

            <section
              aria-label={selectedItem ? translateUi('แป้นใส่จำนวน') : translateUi('เลือกชนิดน้ำแข็ง')}
              className={`employee-pos-keypad ${selectedItem ? '' : 'employee-pos-keypad--empty'} ${mobileStep === 'items' ? '' : 'employee-pos-mobile--hidden'}`}
            >
              {selectedItem ? (
                <>
                  <button
                    aria-label={translateUi('ปิดแป้นใส่จำนวน')}
                    className="employee-pos-keypad-backdrop"
                    onClick={() => setSelectedIceTypeId('')}
                    type="button"
                  />
                  <div className="employee-pos-quantity">
                    <span>{selectedItem.name}</span>
                    <strong aria-live="polite" className="employee-pos-quantity-display">
                      {deliveryQuantities[selectedItem.ice_type_id] ?? 0}
                    </strong>
                    <small>
                      {translateUi('คงเหลือ ')}{selectedItem.stock_quantity === Number.MAX_SAFE_INTEGER ? '—' : selectedItem.stock_quantity} {selectedItem.unit}
                    </small>
                  </div>
                  <label className="employee-pos-quantity-input">
                    <span>{translateUi('จำนวน (')}{selectedItem.unit})</span>
                    <input
                      aria-label={translateUi('จำนวน{0}', { 0: selectedItem.name })}
                      disabled={!canEditQuantity}
                      inputMode="decimal"
                      min="0"
                      max={selectedItem.stock_quantity === Number.MAX_SAFE_INTEGER ? undefined : selectedItem.stock_quantity}
                      onChange={handleQuantityInput}
                      ref={quantityInputRef}
                      step="0.5"
                      type="number"
                      value={quantityInput}
                    />
                    <small>{translateUi('กด Enter เพื่อบันทึกและไปสินค้าถัดไป')}</small>
                  </label>
                  <div className="employee-pos-quick-quantities" role="group" aria-label={translateUi('เลือกจำนวนด่วน')}>
                    {[0.5, 1, 2, 3].map((quantity) => (
                      <button disabled={!canEditQuantity} key={quantity} onClick={() => onSetQuantity(selectedItem.ice_type_id, quantity)} type="button">
                        {quantity === 0.5 ? '½' : quantity}
                      </button>
                    ))}
                  </div>
                  <div className="employee-keypad">
                    {['7', '8', '9', '4', '5', '6', '1', '2', '3'].map((digit) => (
                      <button key={digit} onClick={() => enterDigit(digit)} type="button">{digit}</button>
                    ))}
                    <button
                      aria-label={translateUi('ล้างจำนวน')}
                      onClick={() => onSetQuantity(selectedItem.ice_type_id, 0)}
                      type="button"
                    >
                      {translateUi('ล้าง')}</button>
                    <button
                      aria-label={translateUi('เพิ่มครึ่งกระสอบ')}
                      onClick={() => onSetQuantity(
                        selectedItem.ice_type_id,
                        (deliveryQuantities[selectedItem.ice_type_id] ?? 0) + 0.5,
                      )}
                      type="button"
                    >
                      <span>½ <span className="employee-keypad-half-unit">{translateUi('กระสอบ')}</span></span>
                    </button>
                    <button onClick={() => enterDigit('0')} type="button">0</button>
                    <button
                      aria-label={translateUi('ลบหนึ่งหลัก')}
                      onClick={() => {
                        const current = String(deliveryQuantities[selectedItem.ice_type_id] ?? 0);
                        onSetQuantity(selectedItem.ice_type_id, Number(current.slice(0, -1) || '0'));
                      }}
                      type="button"
                    >
                      <Backspace aria-hidden="true" size={24} />
                    </button>
                  </div>
                  <button
                    className="employee-pos-add-item"
                    disabled={!canEditQuantity || !Number.isFinite(inputQuantity) || inputQuantity <= 0}
                    onClick={() => finishQuantity()}
                    type="button"
                  >
                    {translateUi('เพิ่มรายการ')}</button>
                  {hasUncommittedQuantity ? (
                    <button className="employee-text-button" disabled={!canEditQuantity} onClick={() => {
                      setQuantityInput(String(selectedQuantity));
                      setSelectedIceTypeId('');
                    }} type="button">
                      {translateUi('ยกเลิกการแก้จำนวน')}</button>
                  ) : null}
                </>
              ) : (
                <div className="employee-pos-keypad-empty">
                  <IceCream aria-hidden="true" size={34} />
                  <strong>{translateUi('เลือกชนิดน้ำแข็งเพื่อกรอกจำนวน')}</strong>
                  <span>{translateUi('แตะสินค้าด้านซ้าย แล้วแป้นตัวเลขจะแสดงที่นี่')}</span>
                </div>
              )}
            </section>
            </div>

            <section aria-label={translateUi('สรุปตะกร้า')} className={`employee-pos-cart ${mobileStep === 'review' ? '' : 'employee-pos-mobile--hidden'}`}>
              <button className="employee-pos-mobile-back" onClick={() => setMobileStep('items')} type="button">
                {translateUi('กลับไปแก้รายการ')}</button>
              <div className="employee-pos-heading">
                <div><p>{translateUi('ตะกร้า')}</p><h2>{translateUi('ตรวจและบันทึก')}</h2></div>
                <span>{items.length}{translateUi(' รายการ')}</span>
              </div>
              <div className="employee-cart-lines">
                {items.length === 0 ? <p>{translateUi('เลือกสินค้าแล้วใส่จำนวน')}</p> : items.map((item) => {
                  const product = contextItems.find((candidate) => candidate.ice_type_id === item.ice_type_id);
                  return (
                    <div key={item.ice_type_id}>
                      <span><strong>{product?.name}</strong><small>{item.quantity} {product?.unit} × {product?.unit_price == null ? '—' : money.format(product.unit_price)}</small></span>
                      <b>{product?.unit_price == null ? '—' : money.format(item.quantity * product.unit_price)}</b>
                      <button aria-label={translateUi('ลบ{0}', { 0: product?.name ?? translateUi('สินค้า') })} onClick={() => onSetQuantity(item.ice_type_id, 0)} type="button">
                        <Trash aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
              {items.length > 0 ? (
                <button className="employee-text-button employee-cart-clear" disabled={submitting} onClick={onClearCart} type="button">{translateUi('ล้างตะกร้า')}</button>
              ) : null}
              {isCreditShop && posContext?.payment_profile ? (
                <p className="employee-credit-note">{translateUi('ร้านเครดิต · วงเงินคงเหลือ ')}{posContext.payment_profile.credit_remaining == null
                  ? translateUi('ไม่จำกัด')
                  : money.format(posContext.payment_profile.credit_remaining)} · {formatCreditCollectionCycle(posContext.payment_profile)}</p>
              ) : !posContext?.payment_profile && financialContextRequired && !loadingPosContext ? (
                <p className="employee-error">{translateUi('ร้านนี้ยังไม่มีเงื่อนไขการชำระ')}</p>
              ) : null}
              <div className="employee-cart-total">
                <span>{translateUi('ยอดรวม')}</span>
                <strong>{posContext ? money.format(totalAmount) : renderTotals(toTotals(items), iceTypes)}</strong>
              </div>
              {exceedsCredit ? (
                <div className="employee-approval-request">
                  <strong>{approvalId ? translateUi('อนุมัติวงเงินแล้ว') : translateUi('ยอดเกินวงเงินเครดิต')}</strong>
                  {!approvalId ? (
                    <>
                      <textarea
                        onChange={(event) => onApprovalReasonChange(event.target.value)}
                        placeholder={translateUi('เหตุผลที่ขออนุมัติ')}
                        rows={2}
                        value={approvalReason}
                      />
                      <button disabled={approvalSubmitting} onClick={onRequestApproval} type="button">
                        {approvalSubmitting ? translateUi('กำลังตรวจคำขอ...') : translateUi('ขออนุมัติ / ตรวจสถานะ')}
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
              {entryError ? <p className="employee-error" role="alert"><WarningCircle aria-hidden="true" />{translateUi(entryError)}</p> : null}
              <div className="employee-delivery-actions">
                <button className="employee-submit" disabled={!canSubmit || hasPendingDelivery} onClick={() => onConfirmDelivery(isCreditShop ? 'credit' : 'end_of_day')} type="button">
                  {submitting ? translateUi('กำลังบันทึก...') : translateUi('ส่งอย่างเดียว')}
                </button>
                <button className="employee-submit" disabled={!canSubmit || hasPendingDelivery || !canCollectImmediatePayment || isCreditShop} onClick={() => onConfirmDelivery('immediate')} type="button">
                  {submitting ? translateUi('กำลังบันทึก...') : translateUi('ส่งและรับชำระ')}
                </button>
              </div>
              {hasPendingDelivery && !submitting ? (
                <div>
                  <small className="employee-delivery-action-note">{translateUi('คำขอก่อนหน้ายังไม่ทราบผล ตรวจผลรายการเดิมก่อนส่งใหม่')}</small>
                  <button className="employee-submit" disabled={submitting} onClick={onRetryDelivery} type="button">
                    {translateUi('ตรวจผล / ลองคำขอเดิมอีกครั้ง')}</button>
                </div>
              ) : null}
              {hasUncommittedQuantity ? <small className="employee-delivery-action-note">{translateUi('กดเพิ่มรายการหรือยกเลิกการแก้จำนวนก่อนส่ง')}</small> : null}
              {!canCollectImmediatePayment && !isCreditShop ? <small className="employee-delivery-action-note">{translateUi('บัญชีนี้ยังไม่ได้รับสิทธิ์รับชำระเงิน')}</small> : null}
            </section>
          </>
        ) : (
          <section className="employee-problem-panel employee-pos-problem">
            <div className="employee-pos-heading">
              <div><p>{translateUi('งานรอง')}</p><h2>{translateUi('แจ้งเหตุส่งไม่ได้')}</h2></div>
            </div>
            <div className="employee-problem-options">
              {PROBLEM_STATUSES.map((option) => (
                <button
                  aria-pressed={status === option.value}
                  className={status === option.value ? 'employee-problem-option--selected' : ''}
                  key={option.value}
                  onClick={() => onChooseProblemStatus(option.value)}
                  type="button"
                >
                  {translateUi(option.label)}
                </button>
              ))}
            </div>
            <label>
              <span>{translateUi('หมายเหตุที่เกิดขึ้น')}</span>
              <textarea onChange={(event) => onNoteChange(event.target.value)} rows={3} value={note} />
            </label>
            {entryError ? <p className="employee-error" role="alert">{translateUi(entryError)}</p> : null}
            <button className="employee-submit" disabled={submitting} type="submit">{translateUi('บันทึกเหตุ')}</button>
            <button className="employee-text-button" onClick={onReturnToDelivery} type="button">{translateUi('กลับไปบันทึกส่งร้าน')}</button>
          </section>
        )}
      </form>

      {!problemOpen && mobileStep === 'items' ? (
        <button
          className="employee-pos-review-toggle"
          disabled={submitting || items.length === 0 || hasUncommittedQuantity}
          onClick={() => setMobileStep('review')}
          type="button"
        >
          {translateUi('ตรวจรายการ (')}{items.length})
        </button>
      ) : null}

      <section className="employee-history">
        <div className="employee-shop-section__heading">
          <h2>{translateUi('ประวัติวันนี้')}</h2><span>{shopCard.today_history.length}{translateUi(' รายการ')}</span>
        </div>
        {shopCard.today_history.length === 0 ? <p className="employee-empty-history">{translateUi('วันนี้ยังไม่มีรายการของร้านนี้')}</p> : (
          <div className="employee-history-list">
            {shopCard.today_history.map((entry) => (
              <article key={entry.event_id}>
                <div><strong>{formatShortTime(entry.recorded_at)} · {entry.round_name}</strong>
                {(entry.can_cancel || entry.can_correct) ? <button className="employee-text-button" onClick={() => setCorrectionEventId(entry.event_id)} type="button">{translateUi('ยกเลิกใบส่งน้ำแข็ง')}</button> : null}</div>
                <span>{entry.stop_status && entry.stop_status !== 'delivered'
                  ? `${translateUi(STATUS_LABELS[entry.stop_status])}${entry.note ? ` · ${entry.note}` : ''}`
                  : renderTotals(entry.items, iceTypes)}</span>
                <small>{entry.recorded_by}</small>
                {entry.correction_blocker && !(entry.can_cancel || entry.can_correct) ? <small title={entry.correction_blocker}>{entry.correction_blocker}</small> : null}
              </article>
            ))}
          </div>
        )}
      </section>
      {correctionEventId ? <DeliveryCorrectionDialog
        eventId={correctionEventId}
        onClose={() => setCorrectionEventId(null)}
        onSuccess={onCorrectionSuccess}
        userRole="courier"
      /> : null}
    </div>
  );
}
