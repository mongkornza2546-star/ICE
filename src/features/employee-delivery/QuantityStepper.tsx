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
      <output aria-label={`จำนวน${iceTypeName}`}>
        <strong>{quantity}</strong>
        {unit ? <small>{unit}</small> : null}
      </output>
      <button
        aria-label={`เพิ่ม${iceTypeName}อีกหนึ่ง`}
        disabled={disabled || (typeof maxQuantity === 'number' && quantity >= maxQuantity)}
        onClick={() => onChange(1)}
        type="button"
      >+</button>
    </div>
  );
}
