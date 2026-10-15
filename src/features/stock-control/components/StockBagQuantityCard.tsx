import type { ReactNode } from 'react';
import { translateUi, useLanguage } from '../../../i18n';
import { bagTotal, normalizeBags, formatBags, type BagQuantity } from '../../employee-delivery/bagQuantity';
import '../../employee-delivery/employee-bag-transfer.css';

export function StockBagQuantityCard({ name, unit, image, bags, allowHalf, before, disabled, remainingLabel, movementLabel, warning, onChange }: {
  name: string;
  unit: string;
  image: ReactNode;
  bags: BagQuantity;
  allowHalf?: boolean;
  before: number;
  disabled: boolean;
  remainingLabel: string;
  movementLabel: string;
  warning?: string;
  onChange: (field: keyof BagQuantity, value: number) => void;
}) {
  useLanguage();
  const quantity = bagTotal(normalizeBags(bags, allowHalf));
  return <div className="bag-transfer-card" role="listitem">
    <div className="bag-transfer-heading">
      {image}
      <div className="bag-product-name"><strong>{name}</strong><small>{remainingLabel}</small></div>
      <div className="bag-transfer-total"><small>{movementLabel}</small><strong>{formatBags(quantity)} <small>{translateUi(unit)}</small></strong></div>
    </div>
    <div className="bag-transfer-inputs">
      {(['fullBags', ...(allowHalf === false ? [] : ['halfBags'])] as Array<keyof BagQuantity>).map((field) => {
        const label = translateUi(field === 'fullBags' ? 'เต็ม{0}' : 'ครึ่ง{0}', { 0: translateUi(unit) });
        return <label className="bag-counter" key={field}>
          <span>{label} <small>{field === 'fullBags' ? '×1' : '×½'}</small></span>
          <span className="bag-counter-controls">
            <button type="button" aria-label={translateUi('ลด{0} {1}', { 0: label, 1: name })} disabled={disabled || bags[field] === 0} onClick={() => onChange(field, bags[field] - 1)}>−</button>
            <input aria-label={`${label} ${name}`} type="text" inputMode="numeric" pattern="[0-9]*" value={bags[field]} disabled={disabled}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                if (/^[0-9]*$/.test(event.target.value)) onChange(field, Number(event.target.value));
              }} />
            <button type="button" aria-label={translateUi('เพิ่ม{0} {1}', { 0: label, 1: name })} disabled={disabled || quantity + (field === 'fullBags' ? 1 : 0.5) > before} onClick={() => onChange(field, bags[field] + 1)}>+</button>
          </span>
        </label>;
      })}
    </div>
    <div className="bag-transfer-warning" role={quantity > before ? 'status' : undefined}>
      {quantity > before ? warning ?? translateUi('จำนวนเกินสต๊อกคงเหลือ ไม่สามารถบันทึกได้') : '\u00a0'}
    </div>
  </div>;
}
