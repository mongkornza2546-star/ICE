import { type FormEvent, useEffect, useState } from 'react';
import { Plus } from '@phosphor-icons/react';
import type { IceTypePriceSetting, IceTypeOption } from '../../../types/app';
import { toBangkokDateString } from '../../../lib/serviceDate';
import { loadIceTypePrices, saveIceTypePrice, getErrorMessage } from '../adminReferenceSettingsService';

interface IceTypePriceEditorProps {
  iceType: IceTypeOption | null;
}

export function IceTypePriceEditor({ iceType }: IceTypePriceEditorProps) {
  const [prices, setPrices] = useState<IceTypePriceSetting[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form draft
  const [unitPrice, setUnitPrice] = useState<string>('');
  const [validFrom, setValidFrom] = useState<string>(toBangkokDateString());
  const [validTo, setValidTo] = useState<string>('');

  useEffect(() => {
    if (!iceType) {
      setPrices([]);
      return;
    }
    void refreshPrices(iceType.id);
  }, [iceType?.id]);

  async function refreshPrices(iceTypeId: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await loadIceTypePrices(iceTypeId);
      setPrices(data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!iceType) return;

    const numPrice = Number(unitPrice);
    if (!numPrice || numPrice <= 0) {
      setError('กรุณาระบุราคากลางที่มากกว่า 0');
      return;
    }

    if (!validFrom) {
      setError('กรุณาระบุวันที่เริ่มมีผล');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      await saveIceTypePrice({
        ice_type_id: iceType.id,
        unit_price: numPrice,
        valid_from: validFrom,
        valid_to: validTo || null,
      });

      setSuccess('บันทึกราคากลางใหม่เรียบร้อยแล้ว');
      setUnitPrice('');
      setValidTo('');
      await refreshPrices(iceType.id);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function formatDateDisplay(dateStr: string | null) {
    if (!dateStr) return 'ไม่มีกำหนด';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return dateStr;
  }

  const todayStr = toBangkokDateString();

  return (
    <div className="ref-section">
      <div className="ref-section-title">
        <h3>ราคากลาง</h3>
        <p>กำหนดช่วงราคากลางสำหรับชนิดน้ำแข็งนี้</p>
      </div>

      {!iceType ? (
        <p className="empty-text">บันทึกชนิดน้ำแข็งก่อน แล้วจึงเพิ่มราคากลางได้</p>
      ) : (
        <div className="ref-price-container">
          {/* Price History Table */}
          {loading ? (
            <p className="empty-text">กำลังโหลดราคากลาง...</p>
          ) : prices.length === 0 ? (
            <p className="empty-text">ยังไม่มีการตั้งราคากลางสำหรับชนิดน้ำแข็งนี้</p>
          ) : (
            <div className="ref-table-wrapper">
              <table className="ref-price-table">
                <thead>
                  <tr>
                    <th>ราคากลางต่อ{iceType.unit} (บาท)</th>
                    <th>วันที่เริ่มมีผล</th>
                    <th>วันที่สิ้นสุด</th>
                    <th>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {prices.map((p) => {
                    const isCurrent = p.is_active
                      && p.valid_from <= todayStr
                      && (!p.valid_to || p.valid_to >= todayStr);
                    const statusLabel = !p.is_active
                      ? 'พักใช้งาน'
                      : p.valid_from > todayStr
                        ? 'กำหนดไว้'
                        : isCurrent
                          ? 'ปัจจุบัน'
                          : 'สิ้นสุดแล้ว';
                    return (
                      <tr key={p.id}>
                        <td><strong>฿{p.unit_price.toFixed(2)}</strong></td>
                        <td>{formatDateDisplay(p.valid_from)}</td>
                        <td>{formatDateDisplay(p.valid_to)}</td>
                        <td>
                          <span className={`ref-pill ${isCurrent ? 'ref-pill--green' : 'ref-pill--gray'}`}>
                            {statusLabel}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Add New Price Period Card */}
          <div className="ref-add-price-card">
            <h4>เพิ่มช่วงราคากลางใหม่</h4>

            <form className="ref-add-price-form" onSubmit={handleSave}>
              <div className="ref-add-price-grid">
                <div className="ref-form-group">
                  <label>
                    ราคากลางต่อ{iceType.unit} (บาท)
                    <input
                      min="0.01"
                      onChange={(e) => setUnitPrice(e.target.value)}
                      placeholder="เช่น 40.00"
                      required
                      step="0.01"
                      type="number"
                      value={unitPrice}
                    />
                  </label>
                </div>

                <div className="ref-form-group">
                  <label>วันที่เริ่มมีผล</label>
                  <input
                    onChange={(e) => setValidFrom(e.target.value)}
                    required
                    type="date"
                    value={validFrom}
                  />
                </div>

                <div className="ref-form-group">
                  <label>วันที่สิ้นสุด (ไม่บังคับ)</label>
                  <input
                    onChange={(e) => setValidTo(e.target.value)}
                    placeholder="ไม่มีกำหนด"
                    type="date"
                    value={validTo}
                  />
                </div>

                <div className="ref-form-group ref-form-group--btn">
                  <button
                    className="primary-button ref-add-price-btn"
                    disabled={saving}
                    type="submit"
                    aria-label="บันทึกราคากลางใหม่"
                  >
                    <Plus size={16} weight="bold" />
                    <span>{saving ? 'กำลังบันทึก...' : 'เพิ่มช่วงราคา'}</span>
                  </button>
                </div>
              </div>

              {error ? <p className="error-text" role="alert">{error}</p> : null}
              {success ? <p className="success-text" role="polite">{success}</p> : null}
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
