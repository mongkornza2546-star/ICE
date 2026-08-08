export function QuantityStepper({
  iceTypeName,
  purpose,
  quantity,
  maxQuantity,
  unit,
  disabled,
  onChange,
}: {
  iceTypeName: string;
  purpose: string;
  quantity: number;
  maxQuantity?: number;
  unit?: string;
  disabled: boolean;
  onChange: (delta: number) => void;
}) {
  return (
    <div className="employee-quantity-stepper" role="group" aria-label={`${purpose} ${iceTypeName}`}>
      <button
        aria-label={`ลด${iceTypeName}ลงหนึ่ง`}
        disabled={disabled || quantity === 0}
        onClick={() => onChange(-1)}
        type="button"
      >−</button>
      <span className="employee-quantity-value">
        <input
          aria-label={`จำนวน${iceTypeName}`}
          disabled={disabled}
          inputMode="numeric"
          max={maxQuantity}
          min={0}
          onChange={(event) => {
            const enteredQuantity = Number(event.currentTarget.value);
            const nextQuantity = Number.isFinite(enteredQuantity)
              ? Math.max(0, Math.trunc(enteredQuantity))
              : 0;
            onChange(nextQuantity - quantity);
          }}
          placeholder="0"
          step={1}
          type="number"
          value={quantity === 0 ? '' : quantity}
        />
        {unit ? <small>{unit}</small> : null}
      </span>
      <button
        aria-label={`เพิ่ม${iceTypeName}อีกหนึ่ง`}
        disabled={disabled || (typeof maxQuantity === 'number' && quantity >= maxQuantity)}
        onClick={() => onChange(1)}
        type="button"
      >+</button>
    </div>
  );
}
