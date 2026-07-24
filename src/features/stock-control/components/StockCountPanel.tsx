import { useState, useEffect } from 'react';
import { Check, Snowflake } from '@phosphor-icons/react';
import type { StockLocationBalance } from '../../../types/app';

interface StockCountPanelProps {
  location: StockLocationBalance;
  onSaveCount: (counts: { ice_type_id: string; actual_quantity: number }[], note: string) => Promise<void>;
  loading: boolean;
  error: string | null;
  successMessage?: string | null;
}

export function StockCountPanel({
  location,
  onSaveCount,
  loading,
  error,
  successMessage,
}: StockCountPanelProps) {
  const [actualCounts, setActualCounts] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');

  // Sync with location balances
  useEffect(() => {
    setActualCounts(
      Object.fromEntries(
        location.balances.map((b) => [b.ice_type_id, Math.max(0, b.quantity)])
      )
    );
    setNote('');
  }, [location]);

  const handleStep = (iceTypeId: string, step: number) => {
    const val = actualCounts[iceTypeId] ?? 0;
    const nextVal = Math.max(0, val + step);
    setActualCounts((prev) => ({ ...prev, [iceTypeId]: nextVal }));
  };

  const handleInputChange = (iceTypeId: string, valStr: string) => {
    const num = parseFloat(valStr);
    if (isNaN(num)) {
      setActualCounts((prev) => ({ ...prev, [iceTypeId]: 0 }));
    } else {
      const rounded = Math.round(num * 2) / 2; // Snap to 0.5
      setActualCounts((prev) => ({ ...prev, [iceTypeId]: Math.max(0, rounded) }));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const counts = location.balances.map((b) => ({
      ice_type_id: b.ice_type_id,
      actual_quantity: actualCounts[b.ice_type_id] ?? 0,
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
          const actual = actualCounts[b.ice_type_id] ?? 0;
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
                    disabled={actual <= 0 || loading}
                  >
                    -1
                  </button>
                  <button
                    type="button"
                    onClick={() => handleStep(b.ice_type_id, -0.5)}
                    disabled={actual <= 0 || loading}
                  >
                    -0.5
                  </button>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={actual === 0 ? '' : actual}
                    placeholder="0"
                    onChange={(e) => handleInputChange(b.ice_type_id, e.target.value)}
                    disabled={loading}
                  />
                  <button
                    type="button"
                    onClick={() => handleStep(b.ice_type_id, 0.5)}
                    disabled={loading}
                  >
                    +0.5
                  </button>
                  <button
                    type="button"
                    onClick={() => handleStep(b.ice_type_id, 1)}
                    disabled={loading}
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
          disabled={loading}
        />
      </div>

      {error && (
        <div className="error-text">
          ⚠️ {error}
        </div>
      )}

      {successMessage && (
        <div className="success-text stock-v2-feedback">
          <Check size={16} /> {successMessage}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="primary-button"
      >
        {loading ? 'กำลังบันทึกยอดนับ...' : 'บันทึกผลการนับจริง'}
      </button>
    </form>
  );
}
