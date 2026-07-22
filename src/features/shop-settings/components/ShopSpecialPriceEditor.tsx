import { type FormEvent, useEffect, useState } from 'react';
import { Tag, Plus } from '@phosphor-icons/react';
import type { ShopIcePriceSetting, IceTypeOption } from '../../../types/app';
import { toBangkokDateString } from '../../../lib/serviceDate';
import { loadShopIcePrices, saveShopIcePrice, getErrorMessage } from '../../admin-reference-settings/adminReferenceSettingsService';

interface ShopSpecialPriceEditorProps {
  shopId: string;
  shopName: string;
  iceTypes: IceTypeOption[];
}

export function ShopSpecialPriceEditor({ shopId, shopName, iceTypes }: ShopSpecialPriceEditorProps) {
  const [specialPrices, setSpecialPrices] = useState<ShopIcePriceSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form draft
  const [selectedIceTypeId, setSelectedIceTypeId] = useState<string>('');
  const [unitPrice, setUnitPrice] = useState<string>('');
  const [validFrom, setValidFrom] = useState<string>(toBangkokDateString());
  const [validTo, setValidTo] = useState<string>('');

  useEffect(() => {
    if (iceTypes.length > 0 && !selectedIceTypeId) {
      setSelectedIceTypeId(iceTypes[0].id);
    }
  }, [iceTypes, selectedIceTypeId]);

  useEffect(() => {
    if (!shopId) return;
    void refreshPrices();
  }, [shopId]);

  async function refreshPrices() {
    setLoading(true);
    setError(null);
    try {
      const data = await loadShopIcePrices(shopId);
      setSpecialPrices(data);
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
      setError('กรุณาระบุราคาพิเศษที่มากกว่า 0');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      await saveShopIcePrice({
        shop_id: shopId,
        ice_type_id: selectedIceTypeId,
        unit_price: numPrice,
        valid_from: validFrom,
        valid_to: validTo || null,
      });

      setSuccess('บันทึกราคาพิเศษเรียบร้อยแล้ว');
      setUnitPrice('');
      setValidTo('');
      await refreshPrices();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="empty-text">กำลังโหลดราคาพิเศษ...</p>;

  return (
    <section className="shop-special-prices-section" style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border-color, #eee)', paddingTop: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <Tag size={22} weight="duotone" />
        <h3 style={{ margin: 0 }}>ราคาน้ำแข็งพิเศษประจำร้าน {shopName}</h3>
      </div>

      <p className="muted" style={{ marginBottom: '1rem' }}>
        หากไม่มีการตั้งราคาพิเศษ ระบบจะใช้ราคากลางรายชนิดน้ำแข็งในวันธุรกิจนั้นโดยอัตโนมัติ
      </p>

      {specialPrices.length > 0 ? (
        <table className="data-table" style={{ marginBottom: '1.5rem' }}>
          <thead>
            <tr>
              <th>ชนิดน้ำแข็ง</th>
              <th>ราคาพิเศษ/หน่วย</th>
              <th>เริ่มมีผล</th>
              <th>สิ้นสุด</th>
            </tr>
          </thead>
          <tbody>
            {specialPrices.map((sp) => (
              <tr key={sp.id}>
                <td>{sp.ice_type_code} · {sp.ice_type_name} ({sp.unit})</td>
                <td><strong>฿{sp.unit_price.toFixed(2)}</strong></td>
                <td>{sp.valid_from}</td>
                <td>{sp.valid_to ?? 'ปัจจุบัน'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty-text" style={{ marginBottom: '1.5rem' }}>ร้านนี้ยังไม่มีราคาพิเศษ ใช้ราคากลางทั้งหมด</p>
      )}

      <h4>เพิ่มราคาพิเศษรายชนิด</h4>
      <form onSubmit={handleSave} style={{ marginTop: '0.5rem' }}>
        <div className="field-grid">
          <label>
            ชนิดน้ำแข็ง
            <select
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
          <label>
            ราคาพิเศษ (บาท)
            <input
              min="0.01"
              onChange={(e) => setUnitPrice(e.target.value)}
              placeholder="เช่น 35.00"
              required
              step="0.01"
              type="number"
              value={unitPrice}
            />
          </label>
          <label>
            เริ่มมีผล
            <input
              onChange={(e) => setValidFrom(e.target.value)}
              required
              type="date"
              value={validFrom}
            />
          </label>
          <label>
            สิ้นสุด (ไม่บังคับ)
            <input
              onChange={(e) => setValidTo(e.target.value)}
              type="date"
              value={validTo}
            />
          </label>
        </div>

        {error ? <p className="error-text" role="alert">{error}</p> : null}
        {success ? <p className="success-text" role="polite">{success}</p> : null}

        <button className="primary-button" disabled={saving} style={{ marginTop: '1rem' }} type="submit">
          <Plus size={18} weight="bold" />
          {saving ? 'กำลังบันทึก...' : 'บันทึกราคาพิเศษ'}
        </button>
      </form>
    </section>
  );
}
