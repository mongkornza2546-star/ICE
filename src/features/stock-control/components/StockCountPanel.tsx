import { useState, useEffect } from 'react';
import { Check, Snowflake } from '@phosphor-icons/react';
import type { StockLocationBalance } from '../../../types/app';

interface StockCountPanelProps {
  location: StockLocationBalance;
  onSaveCount: (counts: { ice_type_id: string; actual_quantity: number }[], note: string) => Promise<void>;
  loading: boolean;
  disabled?: boolean;
  disabledMessage?: string | null;
  error: string | null;
  successMessage?: string | null;
}

export function StockCountPanel({
  location,
  onSaveCount,
  loading,
  disabled = false,
  disabledMessage,
  error,
  successMessage,
}: StockCountPanelProps) {
  const [actualCounts, setActualCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');

  // Sync with location balances
  useEffect(() => {
    setActualCounts(
      Object.fromEntries(
        location.balances.map((b) => [b.ice_type_id, formatCount(Math.max(0, b.quantity))])
      )
    );
    setNote('');
  }, [location]);

  const handleStep = (iceTypeId: string, step: number) => {
    const val = normalizeCount(actualCounts[iceTypeId]);
    const nextVal = Math.max(0, val + step);
    setActualCounts((prev) => ({ ...prev, [iceTypeId]: formatCount(nextVal) }));
  };

  const handleInputChange = (iceTypeId: string, valStr: string) => {
    if (!/^\d*(?:[.,]\d*)?$/.test(valStr)) return;
    setActualCounts((prev) => ({ ...prev, [iceTypeId]: valStr }));
  };

  const normalizeInput = (iceTypeId: string) => {
    setActualCounts((prev) => ({
      ...prev,
      [iceTypeId]: formatCount(normalizeCount(prev[iceTypeId])),
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled || loading) return;
    const counts = location.balances.map((b) => ({
      ice_type_id: b.ice_type_id,
      actual_quantity: normalizeCount(actualCounts[b.ice_type_id]),
    }));
    void onSaveCount(counts, note);
  };

  return (
    <form onSubmit={handleSubmit} className="stock-v2-panel stock-count-panel">
      <div className="stock-v2-panel__header">
        <div>
          <h3>ตรวจนับสต๊อกจริง</h3>
          <p className="muted">จุดตรวจนับ: <strong>{location.name}</strong></p>
        </div>
      </div>

      <div className="stock-count-list">
        {location.balances.map((b) => {
          const actualDraft = actualCounts[b.ice_type_id] ?? '';
          const actual = normalizeCount(actualDraft);
          const system = b.quantity;
          const variance = actual - system;

          return (
            <div
              key={b.ice_type_id}
              className="stock-count-row"
            >
              <div className="stock-count-row__identity">
                <div className="stock-count-row__icon">
                  <Snowflake size={16} weight="fill" />
                </div>
                <div>
                  <strong>{b.ice_type_name}</strong>
                  <p className="muted">
                    ระบบ: <strong>{system} {b.unit}</strong>
                  </p>
                </div>
              </div>

              <div className="stock-count-row__controls">
                <div>
                  <span
                    className={`stock-variance-badge ${
                      variance === 0
                        ? 'stock-variance-badge--match'
                        : variance > 0
                        ? 'stock-variance-badge--positive'
                        : 'stock-variance-badge--negative'
                    }`}
                  >
                    ส่วนต่าง: {variance > 0 ? `+${variance}` : variance} {b.unit}
                  </span>
                </div>

                <div className="stock-count-stepper">
                  <button
                    type="button"
                    onClick={() => handleStep(b.ice_type_id, -1)}
                    disabled={actual <= 0 || disabled || loading}
                  >
                    -1
                  </button>
                  <button
                    type="button"
                    onClick={() => handleStep(b.ice_type_id, -0.5)}
                    disabled={actual <= 0 || disabled || loading}
                  >
                    -0.5
                  </button>
                  <input
                    aria-label={`ยอดนับจริง ${b.ice_type_name}`}
                    type="text"
                    inputMode="decimal"
                    value={actualDraft}
                    placeholder="0"
                    onChange={(e) => handleInputChange(b.ice_type_id, e.target.value)}
                    onBlur={() => normalizeInput(b.ice_type_id)}
                    disabled={disabled || loading}
                  />
                  <button
                    type="button"
                    onClick={() => handleStep(b.ice_type_id, 0.5)}
                    disabled={disabled || loading}
                  >
                    +0.5
                  </button>
                  <button
                    type="button"
                    onClick={() => handleStep(b.ice_type_id, 1)}
                    disabled={disabled || loading}
                  >
                    +1
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="stock-count-note">
        <label htmlFor="count-note">
          บันทึกหมายเหตุเพิ่มเติม:
        </label>
        <input
          id="count-note"
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="ใส่หมายเหตุสำหรับประวัติการนับ..."
          disabled={disabled || loading}
        />
      </div>

      {error && (
        <div className="error-text">
          ⚠️ {error}
        </div>
      )}

      {disabledMessage && (
        <div className="error-text" role="status">
          {disabledMessage}
        </div>
      )}

      {successMessage && (
        <div className="success-text stock-v2-feedback">
          <Check size={16} /> {successMessage}
        </div>
      )}

      <button
        type="submit"
        disabled={disabled || loading}
        className="primary-button"
      >
        {loading ? 'กำลังบันทึกยอดนับ...' : 'บันทึกผลการนับจริง'}
      </button>
    </form>
  );
}

function normalizeCount(value: string | undefined) {
  const parsed = Number((value ?? '').replace(',', '.'));
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed * 2) / 2);
}

function formatCount(value: number) {
  return value === 0 ? '' : String(value);
}
