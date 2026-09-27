import { ArrowLeft, Coins, Package, WarningCircle } from '@phosphor-icons/react';
import type { ShopCard } from '../../types/app';
import { STATUS_LABELS } from './constants';

const money = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function EmployeeShopTaskChoice({
  card,
  outstandingAmount,
  outstandingLoading,
  outstandingError,
  canCollect,
  onBack,
  onRetry,
  onSend,
  onCollect,
}: {
  card: ShopCard;
  outstandingAmount: number | undefined;
  outstandingLoading: boolean;
  outstandingError: string | null;
  canCollect: boolean;
  onBack: () => void;
  onRetry: () => void;
  onSend: () => void;
  onCollect: () => void;
}) {
  const balanceReady = outstandingAmount !== undefined && !outstandingError;
  const collectDisabled = !canCollect || !balanceReady || outstandingAmount <= 0;
  const balanceText = outstandingError
    ? 'โหลดยอดไม่สำเร็จ'
    : outstandingAmount === undefined
      ? 'กำลังโหลดยอด…'
      : outstandingAmount > 0
        ? money.format(outstandingAmount)
        : 'ไม่มียอดถึงกำหนด';
  const disabledReason = !canCollect
    ? 'บัญชีนี้ไม่มีสิทธิ์รับชำระเงิน'
    : outstandingError
      ? 'กดลองใหม่เพื่อเช็กยอดล่าสุดก่อนรับเงิน'
      : outstandingLoading && outstandingAmount === undefined
        ? 'กำลังตรวจยอดล่าสุด'
        : outstandingAmount === 0
          ? 'ร้านนี้ไม่มียอดถึงกำหนด'
          : null;

  return (
    <section className="employee-task-choice" aria-labelledby="employee-task-choice-title">
      <button className="employee-task-choice__back" onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={19} /> กลับรายชื่อร้าน
      </button>
      <header>
        <span className="employee-task-choice__code">{card.shop_code}</span>
        <h1 id="employee-task-choice-title">{card.shop_name}</h1>
        <p>{card.building_name} · {card.floor_or_zone}</p>
      </header>
      <dl>
        <div><dt>สถานะวันนี้</dt><dd>{STATUS_LABELS[card.stop_status]}</dd></div>
        <div><dt>ยอดรอรับชำระ</dt><dd aria-live="polite">{balanceText}</dd></div>
      </dl>
      {outstandingError ? (
        <div className="employee-task-choice__load-error" role="alert">
          <WarningCircle aria-hidden="true" size={20} weight="fill" />
          <span>{outstandingError}</span>
          <button disabled={outstandingLoading} onClick={onRetry} type="button">ลองใหม่</button>
        </div>
      ) : null}
      <div className="employee-task-choice__actions">
        <button className="employee-primary-action" onClick={onSend} type="button">
          <Package aria-hidden="true" size={21} weight="duotone" /> ส่งเพิ่ม
        </button>
        <button className="employee-secondary-action" disabled={collectDisabled} onClick={onCollect} type="button">
          <Coins aria-hidden="true" size={21} weight="duotone" /> รับชำระ
        </button>
      </div>
      {disabledReason ? <p className="employee-task-choice__hint">{disabledReason}</p> : null}
    </section>
  );
}
