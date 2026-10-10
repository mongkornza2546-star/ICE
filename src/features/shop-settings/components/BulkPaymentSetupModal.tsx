import { translateUi, useLanguage } from '../../../i18n';
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
  useLanguage();
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>('');
  const [selectedZoneId, setSelectedZoneId] = useState<string>('');
  const [selectedShopIds, setSelectedShopIds] = useState<string[]>([]);

  // Profile template
  const [isCredit, setIsCredit] = useState(false);
  const allowedPaymentTerms: PaymentTerm[] = isCredit ? ['credit'] : ['end_of_day', 'immediate'];
  const defaultPaymentTerm: PaymentTerm = isCredit ? 'credit' : 'end_of_day';
  const [allowedPaymentMethods, setAllowedPaymentMethods] = useState<PaymentMethod[]>(['cash', 'bank_transfer']);
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
      <section role="dialog" aria-modal="true" aria-label={translateUi('ตั้งค่าชำระเงินหลายร้าน')} className="panel" style={{ maxWidth: '640px', width: '90%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="panel-header">
          <div>
            <p className="eyebrow">{translateUi('จัดการหลายร้านค้า')}</p>
            <h2>{translateUi('กำหนดโปรไฟล์ชำระเงินแบบกลุ่ม (Bulk Setup)')}</h2>
          </div>
          <button aria-label={translateUi('ปิดหน้าต่าง')} disabled={saving} className="ghost-button" onClick={onClose} type="button">
            <X size={20} />
          </button>
        </div>

        <fieldset disabled={saving || reviewing} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="field-grid" style={{ marginBottom: '1rem' }}>
          <label>
            {translateUi('กรองตามอาคาร')}<select onChange={(e) => { setSelectedBuildingId(e.target.value); setSelectedZoneId(''); setSelectedShopIds([]); }} value={selectedBuildingId}>
              <option value="">{translateUi('ทุกอาคาร (')}{shops.length}{translateUi(' ร้าน)')}</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
              ))}
            </select>
          </label>
          <label>
            {translateUi('กรองตามโซนย่อย')}<select disabled={!selectedBuildingId} onChange={(e) => { setSelectedZoneId(e.target.value); setSelectedShopIds([]); }} value={selectedZoneId}>
              <option value="">{translateUi('ทุกโซน')}</option>
              {zones.filter((z) => z.building_id === selectedBuildingId).map((z) => (
                <option key={z.id} value={z.id}>{z.code} · {z.name}</option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ marginBottom: '1rem', border: '1px solid var(--border-color, #eee)', padding: '0.75rem', borderRadius: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <strong>{translateUi('เลือกร้านค้าที่ต้องการตั้งค่า (')}{selectedShopIds.length}/{filteredShops.length})</strong>
            <button className="ghost-button" onClick={toggleSelectAll} type="button">
              {selectedShopIds.length === filteredShops.length ? translateUi('ยกเลิกเลือกทั้งหมด') : translateUi('เลือกทั้งหมด')}
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
          <h4>{translateUi('เลือกข้อมูลที่ต้องการเปลี่ยน')}</h4>
          <label className="inline-check"><input type="checkbox" checked={changeTerms} onChange={(event) => setChangeTerms(event.target.checked)} />{translateUi('เปลี่ยนรูปแบบชำระเงินและเครดิต')}</label>
          <label className="inline-check"><input type="checkbox" checked={changeMethods} onChange={(event) => setChangeMethods(event.target.checked)} />{translateUi('เปลี่ยนช่องทางการเงิน')}</label>
          <p className="muted">{translateUi('คงเงื่อนไขหลักฐานและเลขอ้างอิงเดิมของแต่ละร้านไว้ ร้านที่ยังไม่เคยตั้งค่าต้องเลือกทั้งสองกลุ่ม')}</p>

          <div className="field-grid" style={{ marginTop: '0.5rem' }}>
            <label className="inline-check">
              <input disabled={!changeTerms} checked={isCredit} onChange={(event) => setIsCredit(event.target.checked)} type="checkbox" />
              {translateUi('ร้านเครดิต')}</label>

            <div>
              <label>{translateUi('ช่องทางการเงินที่อนุญาต')}</label>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                <label className="inline-check">
                  <input
                    disabled={!changeMethods}
                    checked={allowedPaymentMethods.includes('cash')}
                    onChange={() => togglePaymentMethod('cash')}
                    type="checkbox"
                  />
                  {translateUi('เงินสด')}</label>
                <label className="inline-check">
                  <input
                    disabled={!changeMethods}
                    checked={allowedPaymentMethods.includes('bank_transfer')}
                    onChange={() => togglePaymentMethod('bank_transfer')}
                    type="checkbox"
                  />
                  {translateUi('โอน')}</label>
              </div>
            </div>

            <label>
              {translateUi('ช่องทางเริ่มต้น')}<select disabled={!changeMethods} onChange={(e) => setDefaultPaymentMethod(e.target.value as PaymentMethod)} value={defaultPaymentMethod}>
                {allowedPaymentMethods.map((method) => (
                  <option key={method} value={method}>
                    {method === 'cash' ? translateUi('เงินสด') : translateUi('โอน')}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {allowedPaymentTerms.includes('credit') ? (
            <div className="field-grid" style={{ marginTop: '1rem' }}>
              <label>
                {translateUi('รอบเก็บเงิน')}<select disabled={!changeTerms} onChange={(e) => setCreditDueRule(e.target.value as CreditDueRule)} value={creditDueRule}>
                  <option value="weekly">{translateUi('ทุกสัปดาห์')}</option>
                  <option value="semi_monthly">{translateUi('รอบครึ่งเดือน (วันที่ 1–15 / 16–สิ้นเดือน)')}</option>
                  <option value="end_of_month">{translateUi('ทุกสิ้นเดือน')}</option>
                  <option value="net_days">{translateUi('หลังส่งสินค้า X วัน')}</option>
                </select>
              </label>
              {creditDueRule === 'net_days' ? (
                <label>
                  {translateUi('จำนวนวันหลังส่งสินค้า')}<input disabled={!changeTerms} min="1" onChange={(e) => setCreditDays(Number(e.target.value) || 1)} type="number" value={creditDays} />
                </label>
              ) : null}
              {creditDueRule === 'weekly' ? (
                <label>
                  {translateUi('วันเก็บเงินประจำสัปดาห์')}<select disabled={!changeTerms} onChange={(e) => setCreditCollectionWeekday(Number(e.target.value))} value={creditCollectionWeekday}>
                    {CREDIT_COLLECTION_WEEKDAY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{translateUi(option.label)}</option>
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
                {translateUi('วงเงินเครดิต (เว้นว่างหากไม่จำกัด)')}<input disabled={!changeTerms} min="0" onChange={(e) => setCreditLimit(e.target.value ? Number(e.target.value) : null)} type="number" value={creditLimit ?? ''} />
              </label>
            </div>
          ) : (
            <label className="inline-check" style={{ marginTop: '1rem' }}>
              <input disabled={!changeTerms} checked={allowOutstanding} onChange={(e) => setAllowOutstanding(e.target.checked)} type="checkbox" />
              {translateUi('อนุญาตยอดค้างชำระ')}</label>
          )}
        </div>

        </fieldset>
        {reviewing ? (
          <section aria-label={translateUi('สรุปก่อนบันทึก')} style={{ margin: '1rem 0' }}>
            <h3>{translateUi('สรุปก่อนบันทึก')}</h3>
            <p>{translateUi('ร้านที่จะเปลี่ยน: ')}{shops.filter((shop) => selectedShopIds.includes(shop.id)).map((shop) => `${shop.code} · ${shop.name}`).join(', ')}</p>
            {changeTerms ? <p>{translateUi('รูปแบบชำระเงิน: ')}{isCredit ? translateUi('เครดิต') : translateUi('เลือกวิธีส่งที่หน้าพนักงาน')}{translateUi(' · อนุญาตยอดค้าง ')}{isCredit || allowOutstanding ? translateUi('ใช่') : translateUi('ไม่')}
              {allowedPaymentTerms.includes('credit') ? translateUi(' · {0} · วงเงิน {1}', { 0: formatCreditCollectionCycle({ credit_due_rule: creditDueRule, credit_days: creditDays, credit_collection_weekday: creditCollectionWeekday }), 1: creditLimit == null ? translateUi('ไม่จำกัด') : translateUi('{0} บาท', { 0: creditLimit }) }) : ''}
            </p> : <p>{translateUi('รูปแบบชำระเงินและเครดิต: คงค่าเดิม')}</p>}
            {changeMethods ? <p>{translateUi('ช่องทางการเงิน: ')}{allowedPaymentMethods.map(methodLabel).join(', ')}{translateUi(' · เริ่มต้น ')}{translateUi(methodLabel(defaultPaymentMethod))}</p> : <p>{translateUi('ช่องทางการเงิน: คงค่าเดิม')}</p>}
          </section>
        ) : null}
        {error ? <p className="error-text" role="alert">{translateUi(error)}</p> : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <button disabled={saving} className="secondary-button" onClick={reviewing ? () => setReviewing(false) : onClose} type="button">{reviewing ? translateUi('กลับไปแก้ไข') : translateUi('ยกเลิก')}</button>
          <button className="primary-button" disabled={saving || selectedShopIds.length === 0 || (!changeTerms && !changeMethods)} onClick={() => reviewing ? void handleApply() : setReviewing(true)} type="button">
            {saving ? translateUi('กำลังตั้งค่า...') : reviewing ? translateUi('ยืนยันตั้งค่า {0} ร้าน', { 0: selectedShopIds.length }) : translateUi('ตรวจสอบการเปลี่ยนแปลง {0} ร้าน', { 0: selectedShopIds.length })}
          </button>
        </div>
      </section>
    </div>
  );
}

function methodLabel(method: PaymentMethod) {
  return method === 'cash' ? 'เงินสด' : 'โอน';
}
