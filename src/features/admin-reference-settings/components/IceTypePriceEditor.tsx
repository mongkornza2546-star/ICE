import { type FormEvent, useEffect, useState } from 'react';
import { CurrencyDollar, Plus, Calendar } from '@phosphor-icons/react';
import type { IceTypePriceSetting, IceTypeOption } from '../../../types/app';
import { toBangkokDateString } from '../../../lib/serviceDate';
import { loadIceTypePrices, saveIceTypePrice, getErrorMessage } from '../adminReferenceSettingsService';


interface IceTypePriceEditorProps {
  iceTypes: IceTypeOption[];
}

export function IceTypePriceEditor({ iceTypes }: IceTypePriceEditorProps) {
  const [selectedIceTypeId, setSelectedIceTypeId] = useState<string>('');
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
    if (iceTypes.length > 0 && !selectedIceTypeId) {
      setSelectedIceTypeId(iceTypes[0].id);
    }
  }, [iceTypes, selectedIceTypeId]);

  useEffect(() => {
    if (!selectedIceTypeId) return;
    void refreshPrices(selectedIceTypeId);
  }, [selectedIceTypeId]);

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
    if (!selectedIceTypeId) return;

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
        ice_type_id: selectedIceTypeId,
        unit_price: numPrice,
        valid_from: validFrom,
        valid_to: validTo || null,
      });

      setSuccess('บันทึกราคากลางใหม่เรียบร้อยแล้ว');
      setUnitPrice('');
      setValidTo('');
      await refreshPrices(selectedIceTypeId);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const selectedIceType = iceTypes.find((it) => it.id === selectedIceTypeId);

  return (
    <section className="reference-editor-panel" aria-label="จัดการราคากลางรายชนิดน้ำแข็ง">
      <div className="reference-editor-panel__header">
        <span className="reference-editor-panel__header-icon"><CurrencyDollar size={24} weight="bold" /></span>
        <h2>ราคากลางรายชนิดน้ำแข็ง</h2>
      </div>

      <div className="reference-editor-panel__body">
        <div className="reference-editor-panel__column reference-editor-panel__column--list">
          <label className="field-label">
            เลือกชนิดน้ำแข็ง
            <select
              className="reference-select-field"
              onChange={(e) => setSelectedIceTypeId(e.target.value)}
              value={selectedIceTypeId}
            >
              {iceTypes.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.code} · {it.name} ({it.unit})
                </option>
              ))}
            </select>
          </label>

          <div className="price-history-section" style={{ marginTop: '1rem' }}>
            <h4 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <Calendar size={18} /> ประวัติราคากลาง
            </h4>

            {loading ? (
              <p className="empty-text">กำลังโหลดราคากลาง...</p>
            ) : prices.length === 0 ? (
              <p className="empty-text">ยังไม่มีการตั้งราคากลางสำหรับชนิดน้ำแข็งนี้</p>
            ) : (
              <table className="data-table price-history-table">
                <thead>
                  <tr>
                    <th>ราคา/หน่วย</th>
                    <th>เริ่มมีผล</th>
                    <th>สิ้นสุด</th>
                  </tr>
                </thead>
                <tbody>
                  {prices.map((p) => (
                    <tr key={p.id}>
                      <td><strong>฿{p.unit_price.toFixed(2)}</strong> /{selectedIceType?.unit}</td>
                      <td>{p.valid_from}</td>
                      <td>{p.valid_to ?? 'ปัจจุบัน'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="reference-editor-panel__divider" aria-hidden="true" />

        <div className="reference-editor-panel__column reference-editor-panel__column--form">
          <h3>เพิ่มช่วงราคากลางใหม่</h3>
          <p className="muted" style={{ marginBottom: '1rem' }}>
            ราคาใหม่จะถูกนำไปใช้อัตโนมัติเมื่อสร้างรายการส่งในวันธุรกิจที่ตรงกับช่วงเวลาที่กำหนด
          </p>

          <form className="reference-form" onSubmit={handleSave}>
            <div className="field-grid">
              <label>
                ราคากลางต่อ{selectedIceType?.unit ?? 'หน่วย'} (บาท)
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
              <label>
                วันที่เริ่มมีผล (Valid From)
                <input
                  onChange={(e) => setValidFrom(e.target.value)}
                  required
                  type="date"
                  value={validFrom}
                />
              </label>
              <label>
                วันที่สิ้นสุด (Valid To - ไม่บังคับ)
                <input
                  onChange={(e) => setValidTo(e.target.value)}
                  type="date"
                  value={validTo}
                />
              </label>
            </div>

            {error ? <p className="error-text" role="alert">{error}</p> : null}
            {success ? <p className="success-text" role="polite">{success}</p> : null}

            <div className="reference-form__actions" style={{ marginTop: '1rem' }}>
              <button className="primary-button" disabled={saving} type="submit">
                <Plus size={18} weight="bold" />
                {saving ? 'กำลังบันทึก...' : 'บันทึกราคากลางใหม่'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}
