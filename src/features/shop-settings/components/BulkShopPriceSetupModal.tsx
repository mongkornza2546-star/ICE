import { useEffect, useState } from 'react';
import { Tag, X } from '@phosphor-icons/react';
import type { BuildingOption, BuildingZoneOption, IceTypeOption, ShopSetting } from '../../../types/app';
import { toBangkokDateString } from '../../../lib/serviceDate';
import { bulkSaveShopIcePrices, getErrorMessage } from '../../admin-reference-settings/adminReferenceSettingsService';

interface BulkShopPriceSetupModalProps {
  shops: ShopSetting[];
  buildings: BuildingOption[];
  zones: BuildingZoneOption[];
  iceTypes: IceTypeOption[];
  onClose: () => void;
  onSuccess: () => void;
}

export function BulkShopPriceSetupModal({ shops, buildings, zones, iceTypes, onClose, onSuccess }: BulkShopPriceSetupModalProps) {
  const [selectedBuildingId, setSelectedBuildingId] = useState('');
  const [selectedZoneId, setSelectedZoneId] = useState('');
  const [selectedShopIds, setSelectedShopIds] = useState<string[]>([]);
  const [selectedIceTypeId, setSelectedIceTypeId] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [validFrom, setValidFrom] = useState(toBangkokDateString());
  const [validTo, setValidTo] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredShops = shops.filter((shop) => (
    shop.status === 'active'
    && (!selectedBuildingId || shop.building_id === selectedBuildingId)
    && (!selectedZoneId || shop.zone_id === selectedZoneId)
  ));

  useEffect(() => {
    if (!selectedIceTypeId && iceTypes.length > 0) setSelectedIceTypeId(iceTypes[0].id);
  }, [iceTypes, selectedIceTypeId]);

  function toggleSelectAll() {
    setSelectedShopIds((current) => (
      current.length === filteredShops.length ? [] : filteredShops.map((shop) => shop.id)
    ));
  }

  function toggleShop(shopId: string) {
    setSelectedShopIds((current) => (
      current.includes(shopId) ? current.filter((id) => id !== shopId) : [...current, shopId]
    ));
  }

  async function applyPrice() {
    const price = Number(unitPrice);
    if (selectedShopIds.length === 0) {
      setError('กรุณาเลือกร้านค้าอย่างน้อย 1 ร้าน');
      return;
    }
    if (!selectedIceTypeId || !price || price <= 0) {
      setError('กรุณาระบุราคาที่มากกว่า 0');
      return;
    }
    if (!validFrom) {
      setError('กรุณาระบุวันเริ่มมีผล');
      return;
    }
    if (validTo && validTo < validFrom) {
      setError('วันสิ้นสุดต้องไม่ก่อนวันเริ่มมีผล');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await bulkSaveShopIcePrices(selectedShopIds, {
        ice_type_id: selectedIceTypeId,
        unit_price: price,
        valid_from: validFrom,
        valid_to: validTo || null,
      });
      onSuccess();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-modal="true" className="panel" role="dialog" style={{ maxWidth: '640px', width: '90%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="panel-header">
          <div>
            <p className="eyebrow">จัดการหลายร้านค้า</p>
            <h2>กำหนดราคาน้ำแข็งหลายร้าน</h2>
          </div>
          <button aria-label="ปิดหน้าต่างตั้งราคาหลายร้าน" className="ghost-button" onClick={onClose} type="button"><X size={20} /></button>
        </div>

        <p className="muted">กำหนดราคาเดียวให้ร้านที่เลือก แล้วหากร้านใดใช้ราคาไม่เหมือนกัน สามารถเข้าไปตั้งราคาพิเศษเฉพาะร้านได้</p>

        <div className="field-grid" style={{ margin: '1rem 0' }}>
          <label>
            กรองตามอาคาร
            <select onChange={(event) => { setSelectedBuildingId(event.target.value); setSelectedZoneId(''); setSelectedShopIds([]); }} value={selectedBuildingId}>
              <option value="">ทุกอาคาร ({shops.filter((shop) => shop.status === 'active').length} ร้าน)</option>
              {buildings.map((building) => <option key={building.id} value={building.id}>{building.code} · {building.name}</option>)}
            </select>
          </label>
          <label>
            กรองตามโซนย่อย
            <select disabled={!selectedBuildingId} onChange={(event) => { setSelectedZoneId(event.target.value); setSelectedShopIds([]); }} value={selectedZoneId}>
              <option value="">ทุกโซน</option>
              {zones.filter((zone) => zone.building_id === selectedBuildingId).map((zone) => <option key={zone.id} value={zone.id}>{zone.code} · {zone.name}</option>)}
            </select>
          </label>
          <label>
            ชนิดน้ำแข็ง
            <select onChange={(event) => setSelectedIceTypeId(event.target.value)} value={selectedIceTypeId}>
              {iceTypes.map((iceType) => <option key={iceType.id} value={iceType.id}>{iceType.code} · {iceType.name} ({iceType.unit})</option>)}
            </select>
          </label>
          <label>
            ราคา (บาท/หน่วย)
            <input min="0.01" onChange={(event) => setUnitPrice(event.target.value)} placeholder="เช่น 35.00" step="0.01" type="number" value={unitPrice} />
          </label>
          <label>
            เริ่มมีผล
            <input onChange={(event) => setValidFrom(event.target.value)} required type="date" value={validFrom} />
          </label>
          <label>
            สิ้นสุด (ไม่บังคับ)
            <input onChange={(event) => setValidTo(event.target.value)} type="date" value={validTo} />
          </label>
        </div>

        <div style={{ border: '1px solid var(--border-color, #eee)', borderRadius: '8px', padding: '0.75rem' }}>
          <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <strong>เลือกร้านที่ต้องการตั้งราคา ({selectedShopIds.length}/{filteredShops.length})</strong>
            <button className="ghost-button" onClick={toggleSelectAll} type="button">{selectedShopIds.length === filteredShops.length ? 'ยกเลิกเลือกทั้งหมด' : 'เลือกทั้งหมด'}</button>
          </div>
          <div style={{ display: 'grid', gap: '0.5rem', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', maxHeight: '150px', overflowY: 'auto' }}>
            {filteredShops.map((shop) => (
              <label className="inline-check" key={shop.id} style={{ fontSize: '0.875rem' }}>
                <input checked={selectedShopIds.includes(shop.id)} onChange={() => toggleShop(shop.id)} type="checkbox" />
                {shop.code} · {shop.name}
              </label>
            ))}
          </div>
        </div>

        {error ? <p className="error-text" role="alert">{error}</p> : null}
        <button className="primary-button" disabled={saving || selectedShopIds.length === 0} onClick={() => void applyPrice()} style={{ marginTop: '1rem' }} type="button">
          <Tag size={18} weight="bold" />
          {saving ? 'กำลังบันทึก...' : `ยืนยันตั้งราคา ${selectedShopIds.length} ร้าน`}
        </button>
      </section>
    </div>
  );
}
