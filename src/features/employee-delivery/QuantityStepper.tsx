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
          onChange={(event) => {
            const digitsOnly = event.currentTarget.value.replace(/\D/g, '');
            const nextQuantity = Number(digitsOnly || '0');
            onChange(nextQuantity - quantity);
          }}
          pattern="[0-9]*"
          placeholder="0"
          type="text"
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
