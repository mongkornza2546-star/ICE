import { useEffect, useState } from 'react';

export function QuantityStepper({
  iceTypeName,
  purpose,
  quantity,
  maxQuantity,
  step = 1,
  unit,
  disabled,
  onChange,
}: {
  iceTypeName: string;
  purpose: string;
  quantity: number;
  maxQuantity?: number;
  step?: 0.5 | 1;
  unit?: string;
  disabled: boolean;
  onChange: (delta: number) => void;
}) {
  const [draft, setDraft] = useState(quantity === 0 ? '' : String(quantity));
  const stepLabel = step === 0.5 ? 'ครึ่ง' : 'หนึ่ง';

  useEffect(() => {
    setDraft(quantity === 0 ? '' : String(quantity));
  }, [purpose, quantity]);

  return (
    <div className="employee-quantity-stepper" role="group" aria-label={`${purpose} ${iceTypeName}`}>
      <button
        aria-label={`ลด${iceTypeName}ลง${stepLabel}`}
        disabled={disabled || quantity === 0}
        onClick={() => onChange(-step)}
        type="button"
      >{step === 0.5 ? '−½' : '−'}</button>
      <span className="employee-quantity-value">
        <input
          aria-label={`จำนวน${iceTypeName}`}
          disabled={disabled}
          inputMode={step === 0.5 ? 'decimal' : 'numeric'}
          onChange={(event) => {
            const normalized = event.currentTarget.value
              .replace(',', '.')
              .replace(/[^\d.]/g, '')
              .replace(/(\..*)\./g, '$1');
            setDraft(normalized);
            if (normalized.endsWith('.')) return;
            const enteredQuantity = Number(normalized || '0');
            const nextQuantity = Math.round(enteredQuantity / step) * step;
            onChange(nextQuantity - quantity);
          }}
          pattern={step === 0.5 ? '[0-9]*[.,]?[0-9]*' : '[0-9]*'}
          placeholder="0"
          type="text"
          value={draft}
        />
        {unit ? <small>{unit}</small> : null}
      </span>
      <button
        aria-label={`เพิ่ม${iceTypeName}อีก${stepLabel}`}
        disabled={disabled || (typeof maxQuantity === 'number' && quantity >= maxQuantity)}
        onClick={() => onChange(step)}
        type="button"
      >{step === 0.5 ? '+½' : '+'}</button>
    </div>
  );
}
