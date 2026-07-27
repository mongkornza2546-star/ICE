import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  Backspace,
  CheckCircle,
  IceCream,
  MapPin,
  Storefront,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
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
import { QuantityStepper } from './QuantityStepper';
import { formatShortTime, renderTotals, statusTone, stockQuantity, toTotals } from './utils';
import { PROBLEM_STATUSES, STATUS_LABELS } from './constants';

const TERM_LABELS: Record<PaymentTerm, string> = {
  immediate: 'จ่ายทันที',
  end_of_day: 'เก็บท้ายวัน',
  credit: 'เครดิต',
};

const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'เงินสด',
  bank_transfer: 'โอน',
  qr: 'QR',
};

const money = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 2,
});

export function EmployeeDeliveryReview({
  round,
  shopCard,
  assignedStockState,
  deliveryQuantities,
  posContext,
  posContextError,
  loadingPosContext,
  paymentTerm,
  paymentResult,
  paymentOpen,
  paymentMethod,
  paymentAmount,
  paymentReference,
  paymentEvidence,
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
  onDeliveryQuantityChange,
  onSetQuantity,
  onClearCart,
  onPaymentTermChange,
  onPaymentMethodChange,
  onPaymentAmountChange,
  onPaymentReferenceChange,
  onPaymentEvidenceChange,
  onPaymentSubmit,
  onPaymentLater,
  onApprovalReasonChange,
  onRequestApproval,
  onNoteChange,
  onReturnToDelivery,
}: {
  round: DeliveryRound;
  shopCard: ShopCard;
  assignedStockState: EmployeeStockState | null;
  deliveryQuantities: Record<string, number>;
  posContext: DeliveryPosContext | null;
  posContextError: string | null;
  loadingPosContext: boolean;
  paymentTerm: PaymentTerm;
  paymentResult: DeliveryFinancialResult | null;
  paymentOpen: boolean;
  paymentMethod: PaymentMethod;
  paymentAmount: string;
  paymentReference: string;
  paymentEvidence: File | null;
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
  onDeliveryQuantityChange: (iceTypeId: string, delta: number) => void;
  onSetQuantity: (iceTypeId: string, quantity: number) => void;
  onClearCart: () => void;
  onPaymentTermChange: (term: PaymentTerm) => void;
  onPaymentMethodChange: (method: PaymentMethod) => void;
  onPaymentAmountChange: (amount: string) => void;
  onPaymentReferenceChange: (reference: string) => void;
  onPaymentEvidenceChange: (file: File | null) => void;
  onPaymentSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onPaymentLater: () => void;
  onApprovalReasonChange: (reason: string) => void;
  onRequestApproval: () => void;
  onNoteChange: (value: string) => void;
  onReturnToDelivery: () => void;
}) {
  const [selectedIceTypeId, setSelectedIceTypeId] = useState(iceTypes[0]?.id ?? '');
  const [mobileStep, setMobileStep] = useState<'items' | 'review'>('items');
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
  const selectedItem = contextItems.find((item) => item.ice_type_id === selectedIceTypeId)
    ?? contextItems[0];
  const totalAmount = useMemo(() => items.reduce((total, item) => {
    const product = contextItems.find((candidate) => candidate.ice_type_id === item.ice_type_id);
    return total + item.quantity * (product?.unit_price ?? 0);
  }, 0), [contextItems, items]);
  const missingPrice = items.some((item) => (
    contextItems.find((candidate) => candidate.ice_type_id === item.ice_type_id)?.unit_price == null
  ));
  const exceedsCredit = paymentTerm === 'credit'
    && posContext?.payment_profile?.credit_remaining != null
    && totalAmount > posContext.payment_profile.credit_remaining;
  const financialContextRequired = loadingPosContext || Boolean(posContextError) || Boolean(posContext);
  const canSubmit = !submitting
    && round.status !== 'closed'
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
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        enterDigit(event.key);
      } else if (event.key === 'Backspace' && selectedItem) {
        event.preventDefault();
        const current = String(deliveryQuantities[selectedItem.ice_type_id] ?? 0);
        onSetQuantity(selectedItem.ice_type_id, Number(current.slice(0, -1) || '0'));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  if (paymentOpen && paymentResult?.charge_id) {
    const profile = posContext?.payment_profile;
    const allocatedAmount = Math.min(Number(paymentAmount) || 0, paymentResult.total_amount ?? 0);
    const remainingAmount = Math.max((paymentResult.total_amount ?? 0) - allocatedAmount, 0);
    const changeAmount = paymentMethod === 'cash'
      ? Math.max((Number(paymentAmount) || 0) - allocatedAmount, 0)
      : 0;
    const referenceRequired = paymentMethod === 'cash'
      ? profile?.cash_reference_required
      : paymentMethod === 'bank_transfer'
        ? profile?.bank_transfer_reference_required
        : profile?.qr_reference_required;
    const evidenceRequired = paymentMethod === 'cash'
      ? profile?.cash_evidence_required
      : paymentMethod === 'bank_transfer'
        ? profile?.bank_transfer_evidence_required
        : profile?.qr_evidence_required;
    const outstandingApprovalRequired = Boolean(
      profile && !profile.allow_outstanding && remainingAmount > 0,
    );
    const nonCashOverpayment = paymentMethod !== 'cash'
      && (Number(paymentAmount) || 0) > (paymentResult.total_amount ?? 0);
    const paymentReady = (!referenceRequired || Boolean(paymentReference.trim()))
      && (!evidenceRequired || Boolean(paymentEvidence))
      && (!outstandingApprovalRequired || Boolean(approvalId))
      && !nonCashOverpayment;
    return (
      <div className="employee-payment-sheet">
        <header>
          <CheckCircle aria-hidden="true" size={38} weight="fill" />
          <div>
            <p>บันทึกส่งสำเร็จแล้ว</p>
            <h1>รับชำระจาก {shopCard.shop_name}</h1>
            <span>ยอดเรียกเก็บ {money.format(paymentResult.total_amount ?? 0)}</span>
          </div>
        </header>
        <form onSubmit={onPaymentSubmit}>
          <fieldset disabled={paymentSubmitting}>
            <legend>วิธีชำระ</legend>
            <div className="employee-payment-methods">
              {(profile?.allowed_payment_methods ?? ['cash', 'bank_transfer', 'qr']).map((method) => (
                <button
                  aria-pressed={paymentMethod === method}
                  key={method}
                  onClick={() => onPaymentMethodChange(method)}
                  type="button"
                >
                  {METHOD_LABELS[method]}
                </button>
              ))}
            </div>
            <label>
              <span>ยอดรับเงินจริง</span>
              <input
                inputMode="decimal"
                min="0.01"
                max={paymentMethod === 'cash' ? undefined : paymentResult.total_amount ?? undefined}
                onChange={(event) => onPaymentAmountChange(event.target.value)}
                step="0.01"
                type="number"
                value={paymentAmount}
              />
            </label>
            <label>
              <span>เลขอ้างอิง{referenceRequired ? ' *' : ''}</span>
              <input
                onChange={(event) => onPaymentReferenceChange(event.target.value)}
                placeholder={paymentMethod === 'cash' ? 'ถ้ามี' : 'เลขรายการโอน/QR'}
                required={referenceRequired}
                value={paymentReference}
              />
            </label>
            <label>
              <span>หลักฐานการชำระ{evidenceRequired ? ' *' : ''}</span>
              <input
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(event) => onPaymentEvidenceChange(event.target.files?.[0] ?? null)}
                required={evidenceRequired}
                type="file"
              />
              {paymentEvidence ? <small>{paymentEvidence.name}</small> : null}
            </label>
          </fieldset>
          <div className="employee-payment-summary">
            <span>ตัดยอด <strong>{money.format(allocatedAmount)}</strong></span>
            {changeAmount > 0 ? <span>เงินทอน <strong>{money.format(changeAmount)}</strong></span> : null}
          </div>
          {nonCashOverpayment ? <p className="employee-error" role="alert">ยอดโอนหรือ QR ต้องไม่เกินยอดเรียกเก็บ</p> : null}
          {outstandingApprovalRequired ? (
            <div className="employee-approval-request">
              <strong>{approvalId
                ? `อนุมัติยอดค้าง ${money.format(remainingAmount)} แล้ว`
                : `ร้านนี้ต้องอนุมัติก่อนค้าง ${money.format(remainingAmount)}`}</strong>
              {!approvalId ? (
                <>
                  <textarea
                    onChange={(event) => onApprovalReasonChange(event.target.value)}
                    placeholder="เหตุผลที่รับเงินไม่ครบ"
                    rows={2}
                    value={approvalReason}
                  />
                  <button disabled={approvalSubmitting} onClick={onRequestApproval} type="button">
                    {approvalSubmitting ? 'กำลังตรวจคำขอ...' : 'ขออนุมัติ / ตรวจสถานะ'}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
          {entryError ? <p className="employee-error" role="alert">{entryError}</p> : null}
          <button className="employee-submit" disabled={paymentSubmitting || !paymentReady} type="submit">
            {paymentSubmitting ? 'กำลังบันทึกรับเงิน...' : 'ยืนยันรับเงิน'}
          </button>
          {profile?.allow_outstanding !== false ? (
            <button className="employee-text-button" disabled={paymentSubmitting} onClick={onPaymentLater} type="button">
              ยังไม่รับเงินตอนนี้
            </button>
          ) : null}
        </form>
      </div>
    );
  }

  return (
    <div className="employee-pos">
      <button autoFocus className="employee-back" disabled={submitting} onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={24} />
        <span>กลับไปเลือกร้าน</span>
      </button>

      <nav aria-label="ขั้นตอนบันทึกส่ง" className="employee-pos-mobile-steps">
        <button disabled={submitting} onClick={onBack} type="button"><span>1</span> ร้าน</button>
        <button aria-current={mobileStep === 'items' ? 'step' : undefined} onClick={() => setMobileStep('items')} type="button"><span>2</span> รายการ</button>
        <button aria-current={mobileStep === 'review' ? 'step' : undefined} disabled={items.length === 0} onClick={() => setMobileStep('review')} type="button"><span>3</span> ตรวจ</button>
      </nav>

      <header className="employee-pos-shop">
        {shopCard.image_url ? <img alt="" src={shopCard.image_url} /> : (
          <span><Storefront aria-hidden="true" size={30} /></span>
        )}
        <div>
          <p>{shopCard.shop_code}</p>
          <h1>{shopCard.shop_name}</h1>
          <small><MapPin aria-hidden="true" size={16} />{shopCard.building_name} · {shopCard.floor_or_zone}</small>
        </div>
        <span className={`employee-status employee-status--${statusTone(shopCard.stop_status)}`}>
          {STATUS_LABELS[shopCard.stop_status]}
        </span>
      </header>

      {loadingPosContext ? <p className="employee-pos-notice">กำลังโหลดราคา สต๊อก และเงื่อนไขชำระ…</p> : null}
      {posContextError ? <p className="employee-error" role="alert">{posContextError}</p> : null}

      <form className="employee-pos-layout" onSubmit={onSubmit}>
        {!problemOpen ? (
          <>
            <section aria-label="เลือกร้านอื่น" className="employee-pos-shops">
              <div className="employee-pos-heading"><div><p>ร้าน</p><h2>ร้านในรอบ</h2></div><span>{shopCards.length} ร้าน</span></div>
              <div className="employee-pos-shop-list">
                {shopCards.map((card) => (
                  <button
                    aria-current={card.round_stop_id === shopCard.round_stop_id ? 'true' : undefined}
                    key={card.round_stop_id}
                    onClick={() => onChangeShop(card)}
                    type="button"
                  >
                    <strong>{card.shop_code}</strong><span>{card.shop_name}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className={`employee-pos-products ${mobileStep === 'items' ? '' : 'employee-pos-mobile--hidden'}`} aria-labelledby="employee-delivery-items">
              <div className="employee-pos-heading">
                <div>
                  <p>สินค้า</p>
                  <h2 id="employee-delivery-items">เลือกน้ำแข็ง</h2>
                </div>
                <span>ตัดจาก {posContext?.stock_source.name ?? (enableAssignedStockFlow
                  ? assignedStockState?.holding_location.name ?? 'จุดถือครอง'
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
                      <small>{iceType.unit_price == null ? 'ยังไม่มีราคา' : `${money.format(iceType.unit_price)} / ${iceType.unit}`}</small>
                      <b>{quantity > 0 ? quantity : '—'}</b>
                      <em>คงเหลือ {iceType.stock_quantity === Number.MAX_SAFE_INTEGER ? '—' : iceType.stock_quantity} {iceType.unit}</em>
                    </button>
                  );
                })}
              </div>
              {enableAssignedStockFlow ? (
                <div className="employee-pos-steppers">
                  {contextItems.map((iceType) => (
                    <div key={iceType.ice_type_id}>
                      <span>{iceType.name}</span>
                      <QuantityStepper
                        disabled={submitting || round.status === 'closed'}
                        iceTypeName={iceType.name}
                        maxQuantity={iceType.stock_quantity}
                        onChange={(delta) => onDeliveryQuantityChange(iceType.ice_type_id, delta)}
                        quantity={deliveryQuantities[iceType.ice_type_id] ?? 0}
                        purpose="ส่งร้าน"
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </section>

            <section className={`employee-pos-keypad ${mobileStep === 'items' ? '' : 'employee-pos-mobile--hidden'}`} aria-label="แป้นใส่จำนวน">
              <div className="employee-pos-quantity">
                <span>{selectedItem?.name ?? 'เลือกสินค้า'}</span>
                <strong aria-live="polite">
                  {selectedItem ? deliveryQuantities[selectedItem.ice_type_id] ?? 0 : 0}
                </strong>
                <small>{selectedItem?.unit ?? ''}</small>
              </div>
              <div className="employee-keypad">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                  <button key={digit} onClick={() => enterDigit(digit)} type="button">{digit}</button>
                ))}
                <button
                  aria-label="ล้างจำนวน"
                  onClick={() => selectedItem && onSetQuantity(selectedItem.ice_type_id, 0)}
                  type="button"
                >
                  ล้าง
                </button>
                <button onClick={() => enterDigit('0')} type="button">0</button>
                <button
                  aria-label="ลบหนึ่งหลัก"
                  onClick={() => {
                    if (!selectedItem) return;
                    const current = String(deliveryQuantities[selectedItem.ice_type_id] ?? 0);
                    onSetQuantity(selectedItem.ice_type_id, Number(current.slice(0, -1) || '0'));
                  }}
                  type="button"
                >
                  <Backspace aria-hidden="true" size={24} />
                </button>
              </div>
              <button
                className="employee-pos-mobile-next"
                disabled={items.length === 0}
                onClick={() => setMobileStep('review')}
                type="button"
              >
                ตรวจรายการ ({items.length})
              </button>
            </section>

            <section aria-label="สรุปตะกร้า" className={`employee-pos-cart ${mobileStep === 'review' ? '' : 'employee-pos-mobile--hidden'}`}>
              <button className="employee-pos-mobile-back" onClick={() => setMobileStep('items')} type="button">
                กลับไปแก้รายการ
              </button>
              <div className="employee-pos-heading">
                <div><p>ตะกร้า</p><h2>ตรวจและบันทึก</h2></div>
                <span>{items.length} รายการ</span>
              </div>
              <div className="employee-cart-lines">
                {items.length === 0 ? <p>เลือกสินค้าแล้วใส่จำนวน</p> : items.map((item) => {
                  const product = contextItems.find((candidate) => candidate.ice_type_id === item.ice_type_id);
                  return (
                    <div key={item.ice_type_id}>
                      <span><strong>{product?.name}</strong><small>{item.quantity} {product?.unit} × {product?.unit_price == null ? '—' : money.format(product.unit_price)}</small></span>
                      <b>{product?.unit_price == null ? '—' : money.format(item.quantity * product.unit_price)}</b>
                      <button aria-label={`ลบ${product?.name ?? 'สินค้า'}`} onClick={() => onSetQuantity(item.ice_type_id, 0)} type="button">
                        <Trash aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
              {items.length > 0 ? (
                <button className="employee-text-button employee-cart-clear" disabled={submitting} onClick={onClearCart} type="button">ล้างตะกร้า</button>
              ) : null}
              {posContext?.payment_profile ? (
                <fieldset className="employee-payment-terms">
                  <legend>เงื่อนไขชำระ</legend>
                  {posContext.payment_profile.allowed_payment_terms.map((term) => (
                    <button
                      aria-pressed={paymentTerm === term}
                      key={term}
                      onClick={() => onPaymentTermChange(term)}
                      type="button"
                    >
                      {TERM_LABELS[term]}
                    </button>
                  ))}
                  {paymentTerm === 'credit' ? (
                    <small>
                      วงเงินคงเหลือ {posContext.payment_profile.credit_remaining == null
                        ? 'ไม่จำกัด'
                        : money.format(posContext.payment_profile.credit_remaining)} · {posContext.payment_profile.credit_due_rule === 'net_days'
                        ? `ครบกำหนด ${posContext.payment_profile.credit_days ?? 0} วันหลังส่ง`
                        : 'ครบกำหนดวันสิ้นเดือน'}
                    </small>
                  ) : null}
                </fieldset>
              ) : financialContextRequired && !loadingPosContext ? (
                <p className="employee-error">ร้านนี้ยังไม่มีเงื่อนไขการชำระ</p>
              ) : null}
              <div className="employee-cart-total">
                <span>ยอดรวม</span>
                <strong>{posContext ? money.format(totalAmount) : renderTotals(toTotals(items), iceTypes)}</strong>
              </div>
              {exceedsCredit ? (
                <div className="employee-approval-request">
                  <strong>{approvalId ? 'อนุมัติวงเงินแล้ว' : 'ยอดเกินวงเงินเครดิต'}</strong>
                  {!approvalId ? (
                    <>
                      <textarea
                        onChange={(event) => onApprovalReasonChange(event.target.value)}
                        placeholder="เหตุผลที่ขออนุมัติ"
                        rows={2}
                        value={approvalReason}
                      />
                      <button disabled={approvalSubmitting} onClick={onRequestApproval} type="button">
                        {approvalSubmitting ? 'กำลังตรวจคำขอ...' : 'ขออนุมัติ / ตรวจสถานะ'}
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
              {entryError ? <p className="employee-error" role="alert"><WarningCircle aria-hidden="true" />{entryError}</p> : null}
              <button className="employee-submit" disabled={!canSubmit} type="submit">
                {round.status === 'closed' ? 'รอบนี้ปิดแล้ว' : submitting ? 'กำลังบันทึก...' : 'ยืนยันส่งร้านนี้'}
              </button>
            </section>
          </>
        ) : (
          <section className="employee-problem-panel employee-pos-problem">
            <div className="employee-pos-heading">
              <div><p>งานรอง</p><h2>แจ้งเหตุส่งไม่ได้</h2></div>
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
                  {option.label}
                </button>
              ))}
            </div>
            <label>
              <span>หมายเหตุที่เกิดขึ้น</span>
              <textarea onChange={(event) => onNoteChange(event.target.value)} rows={3} value={note} />
            </label>
            {entryError ? <p className="employee-error" role="alert">{entryError}</p> : null}
            <button className="employee-submit" disabled={submitting} type="submit">บันทึกเหตุ</button>
            <button className="employee-text-button" onClick={onReturnToDelivery} type="button">กลับไปบันทึกส่งร้าน</button>
          </section>
        )}
      </form>

      {!problemOpen ? (
        <button className="employee-problem-toggle" disabled={submitting} onClick={() => onChooseProblemStatus('issue')} type="button">
          <WarningCircle aria-hidden="true" size={22} /> แจ้งเหตุส่งไม่ได้
        </button>
      ) : null}

      <section className="employee-history">
        <div className="employee-shop-section__heading">
          <h2>ประวัติวันนี้</h2><span>{shopCard.today_history.length} รายการ</span>
        </div>
        {shopCard.today_history.length === 0 ? <p className="employee-empty-history">วันนี้ยังไม่มีรายการของร้านนี้</p> : (
          <div className="employee-history-list">
            {shopCard.today_history.map((entry) => (
              <article key={entry.event_id}>
                <strong>{formatShortTime(entry.recorded_at)} · {entry.round_name}</strong>
                <span>{entry.stop_status && entry.stop_status !== 'delivered'
                  ? `${STATUS_LABELS[entry.stop_status]}${entry.note ? ` · ${entry.note}` : ''}`
                  : renderTotals(entry.items, iceTypes)}</span>
                <small>{entry.recorded_by}</small>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
