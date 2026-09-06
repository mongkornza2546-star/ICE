import { useState } from 'react';
import { X } from '@phosphor-icons/react';
import type { ShopSetting, BuildingOption, BuildingZoneOption, PaymentTerm, PaymentMethod, CreditDueRule } from '../../../types/app';
import { bulkSaveShopPaymentProfiles, getErrorMessage } from '../../admin-reference-settings/adminReferenceSettingsService';
import { CREDIT_COLLECTION_WEEKDAY_OPTIONS, formatCreditCollectionCycle } from '../../../lib/creditCollectionCycle';

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
  const [defaultPaymentTerm, setDefaultPaymentTerm] = useState<PaymentTerm>('immediate');
  const [allowedPaymentMethods, setAllowedPaymentMethods] = useState<PaymentMethod[]>(['cash', 'bank_transfer', 'qr']);
  const [defaultPaymentMethod, setDefaultPaymentMethod] = useState<PaymentMethod>('cash');
  const [allowOutstanding, setAllowOutstanding] = useState(false);
  const [creditDueRule, setCreditDueRule] = useState<CreditDueRule>('net_days');
  const [creditDays, setCreditDays] = useState(30);
  const [creditCollectionWeekday, setCreditCollectionWeekday] = useState(5);
  const [creditLimit, setCreditLimit] = useState<number | null>(null);

  const [changeTerms, setChangeTerms] = useState(true);
  const [changeMethods, setChangeMethods] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredShops = shops.filter((s) => {
    if (selectedBuildingId && s.building_id !== selectedBuildingId) return false;
    if (selectedZoneId && s.zone_id !== selectedZoneId) return false;
    return s.status === 'active';
  });

  function togglePaymentTerm(term: PaymentTerm) {
    if (term === 'credit') {
      setAllowedPaymentTerms(['credit']);
      setDefaultPaymentTerm('credit');
      setAllowOutstanding(true);
      return;
    }

    const nonCreditTerms = allowedPaymentTerms.filter((value) => value !== 'credit');
    const nextTerms: PaymentTerm[] = nonCreditTerms.includes(term)
      ? nonCreditTerms.filter((value) => value !== term)
      : [...nonCreditTerms, term];
    if (nextTerms.length === 0) return;

    setAllowedPaymentTerms(nextTerms);
    if (!nextTerms.includes(defaultPaymentTerm)) setDefaultPaymentTerm(nextTerms[0]);
  }

  function togglePaymentMethod(method: PaymentMethod) {
    const nextMethods = allowedPaymentMethods.includes(method)
      ? allowedPaymentMethods.filter((value) => value !== method)
      : [...allowedPaymentMethods, method];
    if (nextMethods.length === 0) return;

    setAllowedPaymentMethods(nextMethods);
    if (!nextMethods.includes(defaultPaymentMethod)) setDefaultPaymentMethod(nextMethods[0]);
  }

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
    if (saving || !reviewing || (!changeTerms && !changeMethods)) return;
    if (selectedShopIds.length === 0) {
      setError('กรุณาเลือกร้านค้าอย่างน้อย 1 ร้าน');
      return;
    }

    setSaving(true);
    setError(null);

    const patch = {
      terms: changeTerms ? {
        allowed_payment_terms: allowedPaymentTerms,
        default_payment_term: defaultPaymentTerm,
        allow_outstanding: allowedPaymentTerms.includes('credit') ? true : allowOutstanding,
        credit_due_rule: allowedPaymentTerms.includes('credit') ? creditDueRule : null,
        credit_days: allowedPaymentTerms.includes('credit') && creditDueRule === 'net_days' ? creditDays : null,
        credit_collection_weekday: allowedPaymentTerms.includes('credit') && creditDueRule === 'weekly' ? creditCollectionWeekday : null,
        credit_limit: allowedPaymentTerms.includes('credit') ? creditLimit : null,
      } : null,
      methods: changeMethods ? {
        allowed_payment_methods: allowedPaymentMethods,
        default_payment_method: defaultPaymentMethod,
      } : null,
    };

    try {
      await bulkSaveShopPaymentProfiles(selectedShopIds, patch);
      onSuccess();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label="ตั้งค่าชำระเงินหลายร้าน" className="panel" style={{ maxWidth: '640px', width: '90%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="panel-header">
          <div>
            <p className="eyebrow">จัดการหลายร้านค้า</p>
            <h2>กำหนดโปรไฟล์ชำระเงินแบบกลุ่ม (Bulk Setup)</h2>
          </div>
          <button aria-label="ปิดหน้าต่าง" disabled={saving} className="ghost-button" onClick={onClose} type="button">
            <X size={20} />
          </button>
        </div>

        <fieldset disabled={saving || reviewing} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="field-grid" style={{ marginBottom: '1rem' }}>
          <label>
            กรองตามอาคาร
            <select onChange={(e) => { setSelectedBuildingId(e.target.value); setSelectedZoneId(''); setSelectedShopIds([]); }} value={selectedBuildingId}>
              <option value="">ทุกอาคาร ({shops.length} ร้าน)</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
              ))}
            </select>
          </label>
          <label>
            กรองตามโซนย่อย
            <select disabled={!selectedBuildingId} onChange={(e) => { setSelectedZoneId(e.target.value); setSelectedShopIds([]); }} value={selectedZoneId}>
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
          <h4>เลือกข้อมูลที่ต้องการเปลี่ยน</h4>
          <label className="inline-check"><input type="checkbox" checked={changeTerms} onChange={(event) => setChangeTerms(event.target.checked)} />เปลี่ยนรูปแบบชำระเงินและเครดิต</label>
          <label className="inline-check"><input type="checkbox" checked={changeMethods} onChange={(event) => setChangeMethods(event.target.checked)} />เปลี่ยนช่องทางการเงิน</label>
          <p className="muted">คงเงื่อนไขหลักฐานและเลขอ้างอิงเดิมของแต่ละร้านไว้ ร้านที่ยังไม่เคยตั้งค่าต้องเลือกทั้งสองกลุ่ม</p>

          <div className="field-grid" style={{ marginTop: '0.5rem' }}>
            <div>
              <label>รูปแบบชำระเงิน</label>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                <label className="inline-check">
                  <input
                    disabled={!changeTerms}
                    checked={allowedPaymentTerms.includes('immediate')}
                    onChange={() => togglePaymentTerm('immediate')}
                    type="checkbox"
                  />
                  จ่ายทันที
                </label>
                <label className="inline-check">
                  <input
                    disabled={!changeTerms}
                    checked={allowedPaymentTerms.includes('end_of_day')}
                    onChange={() => togglePaymentTerm('end_of_day')}
                    type="checkbox"
                  />
                  เก็บท้ายวัน
                </label>
                <label className="inline-check">
                  <input
                    disabled={!changeTerms}
                    checked={allowedPaymentTerms.includes('credit')}
                    onChange={() => togglePaymentTerm('credit')}
                    type="checkbox"
                  />
                  เครดิต
                </label>
              </div>
            </div>

            <label>
              รูปแบบเริ่มต้น
              <select disabled={!changeTerms} onChange={(e) => setDefaultPaymentTerm(e.target.value as PaymentTerm)} value={defaultPaymentTerm}>
                {allowedPaymentTerms.map((term) => (
                  <option key={term} value={term}>
                    {term === 'immediate' ? 'จ่ายทันที' : term === 'end_of_day' ? 'เก็บท้ายวัน' : 'เครดิต'}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <label>ช่องทางการเงินที่อนุญาต</label>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                <label className="inline-check">
                  <input
                    disabled={!changeMethods}
                    checked={allowedPaymentMethods.includes('cash')}
                    onChange={() => togglePaymentMethod('cash')}
                    type="checkbox"
                  />
                  เงินสด
                </label>
                <label className="inline-check">
                  <input
                    disabled={!changeMethods}
                    checked={allowedPaymentMethods.includes('bank_transfer')}
                    onChange={() => togglePaymentMethod('bank_transfer')}
                    type="checkbox"
                  />
                  โอน
                </label>
                <label className="inline-check">
                  <input
                    disabled={!changeMethods}
                    checked={allowedPaymentMethods.includes('qr')}
                    onChange={() => togglePaymentMethod('qr')}
                    type="checkbox"
                  />
                  QR
                </label>
              </div>
            </div>

            <label>
              ช่องทางเริ่มต้น
              <select disabled={!changeMethods} onChange={(e) => setDefaultPaymentMethod(e.target.value as PaymentMethod)} value={defaultPaymentMethod}>
                {allowedPaymentMethods.map((method) => (
                  <option key={method} value={method}>
                    {method === 'cash' ? 'เงินสด' : method === 'bank_transfer' ? 'โอน' : 'QR'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {allowedPaymentTerms.includes('credit') ? (
            <div className="field-grid" style={{ marginTop: '1rem' }}>
              <label>
                รอบเก็บเงิน
                <select disabled={!changeTerms} onChange={(e) => setCreditDueRule(e.target.value as CreditDueRule)} value={creditDueRule}>
                  <option value="weekly">ทุกสัปดาห์</option>
                  <option value="semi_monthly">รอบครึ่งเดือน (วันที่ 1–15 / 16–สิ้นเดือน)</option>
                  <option value="end_of_month">ทุกสิ้นเดือน</option>
                  <option value="net_days">หลังส่งสินค้า X วัน</option>
                </select>
              </label>
              {creditDueRule === 'net_days' ? (
                <label>
                  จำนวนวันหลังส่งสินค้า
                  <input disabled={!changeTerms} min="1" onChange={(e) => setCreditDays(Number(e.target.value) || 1)} type="number" value={creditDays} />
                </label>
              ) : null}
              {creditDueRule === 'weekly' ? (
                <label>
                  วันเก็บเงินประจำสัปดาห์
                  <select disabled={!changeTerms} onChange={(e) => setCreditCollectionWeekday(Number(e.target.value))} value={creditCollectionWeekday}>
                    {CREDIT_COLLECTION_WEEKDAY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <p style={{ alignSelf: 'end', margin: 0 }}>{formatCreditCollectionCycle({
                credit_due_rule: creditDueRule,
                credit_days: creditDueRule === 'net_days' ? creditDays : null,
                credit_collection_weekday: creditDueRule === 'weekly' ? creditCollectionWeekday : null,
              })}</p>
              <label>
                วงเงินเครดิต (เว้นว่างหากไม่จำกัด)
                <input disabled={!changeTerms} min="0" onChange={(e) => setCreditLimit(e.target.value ? Number(e.target.value) : null)} type="number" value={creditLimit ?? ''} />
              </label>
            </div>
          ) : (
            <label className="inline-check" style={{ marginTop: '1rem' }}>
              <input disabled={!changeTerms} checked={allowOutstanding} onChange={(e) => setAllowOutstanding(e.target.checked)} type="checkbox" />
              อนุญาตยอดค้างชำระ
            </label>
          )}
        </div>

        </fieldset>
        {reviewing ? (
          <section aria-label="สรุปก่อนบันทึก" style={{ margin: '1rem 0' }}>
            <h3>สรุปก่อนบันทึก</h3>
            <p>ร้านที่จะเปลี่ยน: {shops.filter((shop) => selectedShopIds.includes(shop.id)).map((shop) => `${shop.code} · ${shop.name}`).join(', ')}</p>
            {changeTerms ? <p>รูปแบบชำระเงิน: {allowedPaymentTerms.map(termLabel).join(', ')} · เริ่มต้น {termLabel(defaultPaymentTerm)} · อนุญาตยอดค้าง {allowedPaymentTerms.includes('credit') || allowOutstanding ? 'ใช่' : 'ไม่'}
              {allowedPaymentTerms.includes('credit') ? ` · ${formatCreditCollectionCycle({ credit_due_rule: creditDueRule, credit_days: creditDays, credit_collection_weekday: creditCollectionWeekday })} · วงเงิน ${creditLimit == null ? 'ไม่จำกัด' : `${creditLimit} บาท`}` : ''}
            </p> : <p>รูปแบบชำระเงินและเครดิต: คงค่าเดิม</p>}
            {changeMethods ? <p>ช่องทางการเงิน: {allowedPaymentMethods.map(methodLabel).join(', ')} · เริ่มต้น {methodLabel(defaultPaymentMethod)}</p> : <p>ช่องทางการเงิน: คงค่าเดิม</p>}
          </section>
        ) : null}
        {error ? <p className="error-text" role="alert">{error}</p> : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <button disabled={saving} className="secondary-button" onClick={reviewing ? () => setReviewing(false) : onClose} type="button">{reviewing ? 'กลับไปแก้ไข' : 'ยกเลิก'}</button>
          <button className="primary-button" disabled={saving || selectedShopIds.length === 0 || (!changeTerms && !changeMethods)} onClick={() => reviewing ? void handleApply() : setReviewing(true)} type="button">
            {saving ? 'กำลังตั้งค่า...' : reviewing ? `ยืนยันตั้งค่า ${selectedShopIds.length} ร้าน` : `ตรวจสอบการเปลี่ยนแปลง ${selectedShopIds.length} ร้าน`}
          </button>
        </div>
      </section>
    </div>
  );
}

function termLabel(term: PaymentTerm) {
  return term === 'immediate' ? 'จ่ายทันที' : term === 'end_of_day' ? 'เก็บท้ายวัน' : 'เครดิต';
}

function methodLabel(method: PaymentMethod) {
  return method === 'cash' ? 'เงินสด' : method === 'bank_transfer' ? 'โอน' : 'QR';
}
