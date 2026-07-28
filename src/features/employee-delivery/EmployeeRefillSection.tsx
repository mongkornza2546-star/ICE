import { useEffect, useMemo, useRef, useState } from 'react';
import { Drop, WarningCircle } from '@phosphor-icons/react';
import type {
  EmployeeDeliveryDraftState,
  EmployeeDeliveryGateway,
} from '../../EmployeeDeliveryWorkspace';
import type { IceTypeOption } from '../../types/app';
import { QuantityStepper } from './QuantityStepper';
import { employeeErrorMessage } from './utils';

export function EmployeeRefillSection({
  gateway,
  iceTypes,
  onDraftStateChange,
  serviceDate,
}: {
  gateway: EmployeeDeliveryGateway;
  iceTypes: IceTypeOption[];
  onDraftStateChange: (state: EmployeeDeliveryDraftState) => void;
  serviceDate: string;
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const pendingRequest = useRef<{ signature: string; key: string } | null>(null);
  const items = useMemo(() => iceTypes
    .map((iceType) => ({
      ice_type_id: iceType.id,
      quantity: quantities[iceType.id] ?? 0,
    }))
    .filter((item) => item.quantity > 0), [iceTypes, quantities]);
  const dirty = items.length > 0 || note.trim().length > 0;

  useEffect(() => {
    onDraftStateChange({ dirty, submitting });
    return () => onDraftStateChange({ dirty: false, submitting: false });
  }, [dirty, onDraftStateChange, submitting]);

  const submit = async () => {
    if (!gateway.recordDailyStockRefill || items.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    const signature = JSON.stringify({ serviceDate, items, note: note.trim() || null });
    if (pendingRequest.current?.signature !== signature) {
      pendingRequest.current = { signature, key: crypto.randomUUID() };
    }
    try {
      await gateway.recordDailyStockRefill({
        serviceDate,
        items,
        note: note.trim() || null,
        idempotencyKey: pendingRequest.current.key,
      });
      pendingRequest.current = null;
      setQuantities({});
      setNote('');
      setSuccess('บันทึกเติมน้ำแข็งแล้ว โดยไม่สร้างยอดขาย');
    } catch (submitError) {
      setError(employeeErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="employee-entry-section employee-task-section" aria-labelledby="employee-refill">
      <div className="employee-entry-section__heading">
        <span><Drop aria-hidden="true" size={20} /></span>
        <div>
          <h2 id="employee-refill">เติมน้ำแข็ง</h2>
          <p>ตัดจากสต๊อกรวมประจำวัน แต่ไม่คิดเงินและไม่ผูกกับร้าน</p>
        </div>
      </div>
      {error ? <p className="employee-error" role="alert"><WarningCircle size={20} />{error}</p> : null}
      {success ? <p className="employee-success" role="status">{success}</p> : null}
      <div className="employee-stock-table" role="table" aria-label="จำนวนเติมน้ำแข็ง">
        {iceTypes.map((iceType) => (
          <div className="employee-stock-row" key={iceType.id} role="row">
            <strong role="cell">{iceType.name}<small>{iceType.unit}</small></strong>
            <div role="cell">
              <QuantityStepper
                disabled={submitting}
                iceTypeName={iceType.name}
                maxQuantity={9999}
                onChange={(delta) => setQuantities((current) => ({
                  ...current,
                  [iceType.id]: Math.max(0, (current[iceType.id] ?? 0) + delta),
                }))}
                purpose="เติมน้ำแข็ง"
                quantity={quantities[iceType.id] ?? 0}
              />
            </div>
          </div>
        ))}
      </div>
      <label className="employee-field">
        <span>หมายเหตุ (ถ้ามี)</span>
        <textarea
          disabled={submitting}
          onChange={(event) => setNote(event.target.value)}
          value={note}
        />
      </label>
      <button
        className="employee-submit employee-stock-submit"
        disabled={!gateway.recordDailyStockRefill || items.length === 0 || submitting}
        onClick={() => void submit()}
        type="button"
      >
        {submitting ? 'กำลังบันทึก...' : 'ยืนยันเติมน้ำแข็ง'}
      </button>
    </section>
  );
}
