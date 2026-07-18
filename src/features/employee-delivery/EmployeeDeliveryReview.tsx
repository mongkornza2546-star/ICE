import type { FormEvent } from 'react';
import { ArrowLeft, Truck, Storefront, MapPin, WarningCircle } from '@phosphor-icons/react';
import type { DeliveryRound, ShopCard, EmployeeStockState, IceTypeOption, ShopRoundStatus } from '../../types/app';
import { QuantityStepper } from './QuantityStepper';
import { statusTone, renderTotals, formatShortTime, toTotals, stockQuantity } from './utils';
import { PROBLEM_STATUSES, STATUS_LABELS, PAYMENT_LABELS } from './constants';

export function EmployeeDeliveryReview({
  round,
  shopCard,
  assignedStockState,
  deliveryQuantities,
  enableAssignedStockFlow,
  iceTypes,
  items,
  status,
  stockSourceLabel,
  note,
  problemOpen,
  submitting,
  entryError,
  onBack,
  onSubmit,
  onChooseProblemStatus,
  onDeliveryQuantityChange,
  onNoteChange,
  onReturnToDelivery,
}: {
  round: DeliveryRound;
  shopCard: ShopCard;
  assignedStockState: EmployeeStockState | null;
  deliveryQuantities: Record<string, number>;
  enableAssignedStockFlow: boolean;
  iceTypes: IceTypeOption[];
  items: Array<{ ice_type_id: string; quantity: number }>;
  status: Exclude<ShopRoundStatus, 'pending'>;
  stockSourceLabel: string;
  note: string;
  problemOpen: boolean;
  submitting: boolean;
  entryError: string | null;
  onBack: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onChooseProblemStatus: (status: Exclude<ShopRoundStatus, 'pending' | 'delivered'>) => void;
  onDeliveryQuantityChange: (iceTypeId: string, delta: number) => void;
  onNoteChange: (value: string) => void;
  onReturnToDelivery: () => void;
}) {
  const isDelivery = status === 'delivered';
  const sourceLabel = enableAssignedStockFlow
    ? assignedStockState?.holding_location.name ?? 'จุดถือครอง'
    : stockSourceLabel;

  return (
    <div className="employee-entry">
      <button autoFocus className="employee-back" disabled={submitting} onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={24} />
        <span>กลับไปเลือกร้าน</span>
      </button>

      {!enableAssignedStockFlow ? <section className="employee-entry-section employee-review-stock">
        <div className="employee-entry-section__heading">
          <span>1</span>
          <div><h2>น้ำแข็งออกจาก{stockSourceLabel}</h2><p>ยอดที่จะตัดจากสต๊อก{stockSourceLabel}</p></div>
        </div>
        <div className={`employee-task-summary ${items.length > 0 ? 'employee-task-summary--ready' : ''}`}>
          <Truck aria-hidden="true" size={24} />
          <span>จำนวน</span>
          <strong>{items.length > 0 ? renderTotals(toTotals(items), iceTypes) : 'ยังไม่ได้ใส่จำนวน'}</strong>
        </div>
        <button className="employee-text-button" disabled={submitting} onClick={onBack} type="button">
          {items.length > 0 ? 'แก้จำนวน' : 'กลับไปใส่จำนวน'}
        </button>
      </section> : null}

      <section className="employee-entry-card">
        <div className="employee-entry-section__heading employee-review-shop-heading">
          <span>{enableAssignedStockFlow ? '1' : '2'}</span>
          <div><h2>ร้านที่จะไปส่ง</h2><p>ตรวจชื่อร้านก่อนยืนยัน</p></div>
        </div>
        <header className="employee-entry-shop">
          {shopCard.image_url ? (
            <img alt={shopCard.shop_name} src={shopCard.image_url} />
          ) : (
            <div className="employee-entry-shop__placeholder"><Storefront aria-hidden="true" size={46} /></div>
          )}
          <div>
            <h1>{shopCard.shop_code} · {shopCard.shop_name}</h1>
            <p><MapPin aria-hidden="true" size={18} />{shopCard.building_name} · {shopCard.floor_or_zone}</p>
            <div className="employee-entry-shop__badges">
              <span className={`employee-status employee-status--${statusTone(shopCard.stop_status)}`}>{STATUS_LABELS[shopCard.stop_status]}</span>
              <span className="employee-payment">{PAYMENT_LABELS[shopCard.payment_status]}</span>
            </div>
          </div>
        </header>
        {shopCard.stop_note ? <p className="employee-shop-note"><WarningCircle aria-hidden="true" size={20} />{shopCard.stop_note}</p> : null}
      </section>

      <form className="employee-entry-form" onSubmit={onSubmit}>
        {enableAssignedStockFlow && !problemOpen ? (
          <section className="employee-entry-section employee-review-stock" aria-labelledby="employee-delivery-items">
            <div className="employee-entry-section__heading">
              <span>2</span>
              <div>
                <h2 id="employee-delivery-items">ใส่จำนวนที่ส่ง</h2>
                <p>ตัดออกจาก {sourceLabel} แยกตามชนิดน้ำแข็ง</p>
              </div>
            </div>
            <div className="employee-delivery-lines">
              {iceTypes.map((iceType) => {
                const available = stockQuantity(assignedStockState?.holding_location.balances, iceType.id);
                return (
                  <div className="employee-delivery-line" key={iceType.id}>
                    <span><strong>{iceType.name}</strong><small>คงเหลือ {available} {iceType.unit}</small></span>
                    <QuantityStepper
                      disabled={submitting || round.status === 'closed'}
                      iceTypeName={iceType.name}
                      maxQuantity={available}
                      onChange={(delta) => onDeliveryQuantityChange(iceType.id, delta)}
                      quantity={deliveryQuantities[iceType.id] ?? 0}
                      purpose="ส่งร้าน"
                    />
                  </div>
                );
              })}
            </div>
            <div className={`employee-task-summary ${items.length > 0 ? 'employee-task-summary--ready' : ''}`}>
              <Truck aria-hidden="true" size={24} />
              <span>รวมที่จะส่ง</span>
              <strong>{items.length > 0 ? renderTotals(toTotals(items), iceTypes) : 'ยังไม่ได้ใส่จำนวน'}</strong>
            </div>
          </section>
        ) : null}
        <section className="employee-entry-section employee-entry-section--secondary">
          {!problemOpen ? (
            <button className="employee-problem-toggle" disabled={submitting || round.status === 'closed'} onClick={() => onChooseProblemStatus('issue')} type="button">
              <WarningCircle aria-hidden="true" size={22} />
              <span>แจ้งเหตุส่งไม่ได้</span>
            </button>
          ) : (
            <div className="employee-problem-panel">
              <div className="employee-entry-section__heading">
                <WarningCircle aria-hidden="true" size={24} />
                <div><h2>แจ้งเหตุส่งไม่ได้</h2><p>ร้านไม่ซื้อรอบนี้ไม่ต้องกดอะไร</p></div>
              </div>
              <div className="employee-problem-options">
                {PROBLEM_STATUSES.map((option) => (
                  <button
                    aria-pressed={status === option.value}
                    className={status === option.value ? 'employee-problem-option--selected' : ''}
                    disabled={submitting || round.status === 'closed'}
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
                <textarea disabled={submitting || round.status === 'closed'} onChange={(event) => onNoteChange(event.target.value)} placeholder="เช่น ร้านปิด ให้มารอบสาย" rows={3} value={note} />
              </label>
              <button className="employee-text-button" disabled={submitting || round.status === 'closed'} onClick={onReturnToDelivery} type="button">กลับไปบันทึกส่งร้าน</button>
            </div>
          )}
        </section>

        <section className="employee-submit-card">
          <div>
            <span>{isDelivery ? 'ยอดที่จะบันทึก' : 'เหตุที่จะบันทึก'}</span>
            <strong>{isDelivery ? (items.length > 0 ? renderTotals(toTotals(items), iceTypes) : 'ยังไม่ได้ใส่จำนวน') : STATUS_LABELS[status]}</strong>
          </div>
          {entryError ? <p className="employee-error" role="alert"><WarningCircle aria-hidden="true" size={22} weight="fill" />{entryError}</p> : null}
          <button className="employee-submit" disabled={submitting || round.status === 'closed'} type="submit">
            {round.status === 'closed' ? 'รอบนี้ปิดแล้ว' : submitting ? 'กำลังบันทึก...' : isDelivery ? 'ยืนยันส่งร้านนี้' : 'บันทึกเหตุ'}
          </button>
        </section>
      </form>

      <section className="employee-history">
        <div className="employee-shop-section__heading">
          <h2>ประวัติวันนี้</h2>
          <span>{shopCard.today_history.length} รายการ</span>
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
