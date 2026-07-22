import { useState } from 'react';
import { X } from '@phosphor-icons/react';
import type { ShopSetting, BuildingOption, BuildingZoneOption, PaymentTerm, PaymentMethod, ShopPaymentProfileSetting } from '../../../types/app';
import { bulkSaveShopPaymentProfiles, getErrorMessage } from '../../admin-reference-settings/adminReferenceSettingsService';

interface BulkPaymentSetupModalProps {
  shops: ShopSetting[];
  buildings: BuildingOption[];
  zones: BuildingZoneOption[];
  onClose: () => void;
  onSuccess: () => void;
}

export function BulkPaymentSetupModal({ shops, buildings, zones, onClose, onSuccess }: BulkPaymentSetupModalProps) {
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>('');
  const [selectedZoneId, setSelectedZoneId] = useState<string>('');
  const [selectedShopIds, setSelectedShopIds] = useState<string[]>([]);

  // Profile template
  const [allowedPaymentTerms, setAllowedPaymentTerms] = useState<PaymentTerm[]>(['immediate']);
  const [defaultPaymentTerm] = useState<PaymentTerm>('immediate');
  const [allowedPaymentMethods, setAllowedPaymentMethods] = useState<PaymentMethod[]>(['cash', 'bank_transfer', 'qr']);
  const [defaultPaymentMethod] = useState<PaymentMethod>('cash');
  const [allowOutstanding] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredShops = shops.filter((s) => {
    if (selectedBuildingId && s.building_id !== selectedBuildingId) return false;
    if (selectedZoneId && s.zone_id !== selectedZoneId) return false;
    return s.status === 'active';
  });

  function toggleSelectAll() {
    if (selectedShopIds.length === filteredShops.length) {
      setSelectedShopIds([]);
    } else {
      setSelectedShopIds(filteredShops.map((s) => s.id));
    }
  }

  function toggleShop(id: string) {
    if (selectedShopIds.includes(id)) {
      setSelectedShopIds(selectedShopIds.filter((s) => s !== id));
    } else {
      setSelectedShopIds([...selectedShopIds, id]);
    }
  }

  async function handleApply() {
    if (selectedShopIds.length === 0) {
      setError('กรุณาเลือกเลือกร้านค้าอย่างน้อย 1 ร้าน');
      return;
    }

    setSaving(true);
    setError(null);

    const template: Omit<ShopPaymentProfileSetting, 'shop_id' | 'id'> = {
      allowed_payment_terms: allowedPaymentTerms,
      default_payment_term: defaultPaymentTerm,
      allowed_payment_methods: allowedPaymentMethods,
      default_payment_method: defaultPaymentMethod,
      cash_reference_required: false,
      cash_evidence_required: false,
      bank_transfer_reference_required: true,
      bank_transfer_evidence_required: false,
      qr_reference_required: true,
      qr_evidence_required: false,
      allow_outstanding: allowedPaymentTerms.includes('credit') ? true : allowOutstanding,
      credit_due_rule: allowedPaymentTerms.includes('credit') ? 'net_days' : null,
      credit_days: allowedPaymentTerms.includes('credit') ? 30 : null,
      credit_limit: null,
    };

    try {
      await bulkSaveShopPaymentProfiles(selectedShopIds, template);
      onSuccess();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="panel" style={{ maxWidth: '640px', width: '90%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="panel-header">
          <div>
            <p className="eyebrow">จัดการหลายร้านค้า</p>
            <h2>กำหนดโปรไฟล์ชำระเงินแบบกลุ่ม (Bulk Setup)</h2>
          </div>
          <button className="ghost-button" onClick={onClose} type="button">
            <X size={20} />
          </button>
        </div>

        <div className="field-grid" style={{ marginBottom: '1rem' }}>
          <label>
            กรองตามอาคาร
            <select onChange={(e) => { setSelectedBuildingId(e.target.value); setSelectedZoneId(''); }} value={selectedBuildingId}>
              <option value="">ทุกอาคาร ({shops.length} ร้าน)</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
              ))}
            </select>
          </label>
          <label>
            กรองตามโซนย่อย
            <select disabled={!selectedBuildingId} onChange={(e) => setSelectedZoneId(e.target.value)} value={selectedZoneId}>
              <option value="">ทุกโซน</option>
              {zones.filter((z) => z.building_id === selectedBuildingId).map((z) => (
                <option key={z.id} value={z.id}>{z.code} · {z.name}</option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ marginBottom: '1rem', border: '1px solid var(--border-color, #eee)', padding: '0.75rem', borderRadius: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <strong>เลือกร้านค้าที่ต้องการตั้งค่า ({selectedShopIds.length}/{filteredShops.length})</strong>
            <button className="ghost-button" onClick={toggleSelectAll} type="button">
              {selectedShopIds.length === filteredShops.length ? 'ยกเลิกเลือกทั้งหมด' : 'เลือกทั้งหมด'}
            </button>
          </div>

          <div style={{ maxHeight: '150px', overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '0.5rem' }}>
            {filteredShops.map((s) => (
              <label key={s.id} className="inline-check" style={{ fontSize: '0.875rem' }}>
                <input
                  checked={selectedShopIds.includes(s.id)}
                  onChange={() => toggleShop(s.id)}
                  type="checkbox"
                />
                {s.code} · {s.name}
              </label>
            ))}
          </div>
        </div>

        <div style={{ background: 'var(--panel-bg, #f9f9f9)', padding: '1rem', borderRadius: '8px', marginBottom: '1rem' }}>
          <h4>โปรไฟล์การชำระเงินที่ต้องการใช้ร่วมกัน</h4>

          <div className="field-grid" style={{ marginTop: '0.5rem' }}>
            <div>
              <label>รูปแบบชำระเงิน</label>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                <label className="inline-check">
                  <input
                    checked={allowedPaymentTerms.includes('immediate')}
                    onChange={(e) => {
                      if (e.target.checked) setAllowedPaymentTerms(['immediate']);
                    }}
                    type="checkbox"
                  />
                  จ่ายทันที
                </label>
                <label className="inline-check">
                  <input
                    checked={allowedPaymentTerms.includes('end_of_day')}
                    onChange={(e) => {
                      if (e.target.checked) setAllowedPaymentTerms(['end_of_day']);
                    }}
                    type="checkbox"
                  />
                  เก็บท้ายวัน
                </label>
              </div>
            </div>

            <div>
              <label>ช่องทางการเงินที่อนุญาต</label>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                <label className="inline-check">
                  <input
                    checked={allowedPaymentMethods.includes('cash')}
                    onChange={(e) => {
                      if (e.target.checked) setAllowedPaymentMethods([...allowedPaymentMethods, 'cash']);
                      else setAllowedPaymentMethods(allowedPaymentMethods.filter((m) => m !== 'cash'));
                    }}
                    type="checkbox"
                  />
                  เงินสด
                </label>
                <label className="inline-check">
                  <input
                    checked={allowedPaymentMethods.includes('bank_transfer')}
                    onChange={(e) => {
                      if (e.target.checked) setAllowedPaymentMethods([...allowedPaymentMethods, 'bank_transfer']);
                      else setAllowedPaymentMethods(allowedPaymentMethods.filter((m) => m !== 'bank_transfer'));
                    }}
                    type="checkbox"
                  />
                  โอน
                </label>
                <label className="inline-check">
                  <input
                    checked={allowedPaymentMethods.includes('qr')}
                    onChange={(e) => {
                      if (e.target.checked) setAllowedPaymentMethods([...allowedPaymentMethods, 'qr']);
                      else setAllowedPaymentMethods(allowedPaymentMethods.filter((m) => m !== 'qr'));
                    }}
                    type="checkbox"
                  />
                  QR
                </label>
              </div>
            </div>
          </div>
        </div>

        {error ? <p className="error-text" role="alert">{error}</p> : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <button className="secondary-button" onClick={onClose} type="button">ยกเลิก</button>
          <button className="primary-button" disabled={saving || selectedShopIds.length === 0} onClick={() => void handleApply()} type="button">
            {saving ? 'กำลังตั้งค่า...' : `ยืนยันตั้งค่า ${selectedShopIds.length} ร้าน`}
          </button>
        </div>
      </section>
    </div>
  );
}
