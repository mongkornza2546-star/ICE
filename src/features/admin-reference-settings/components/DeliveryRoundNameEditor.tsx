import { type FormEvent, useState } from 'react';
import { CheckCircle, Circle, Info } from '@phosphor-icons/react';
import {
  EMPTY_DELIVERY_ROUND_NAME,
  type DeliveryRoundNameDraft,
  type DeliveryRoundNameSetting,
} from '../types';
import { getErrorMessage, saveDeliveryRoundName } from '../adminReferenceSettingsService';

function toDraft(option: DeliveryRoundNameSetting): DeliveryRoundNameDraft {
  return { id: option.id, name: option.name, sortOrder: String(option.sort_order), isActive: option.is_active };
}

export function DeliveryRoundNameEditor({
  options,
  onSaved,
}: {
  options: DeliveryRoundNameSetting[];
  onSaved: (option: DeliveryRoundNameSetting) => void;
}) {
  const [draft, setDraft] = useState<DeliveryRoundNameDraft>(EMPTY_DELIVERY_ROUND_NAME);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = draft.name.trim();
    const sortOrder = Number(draft.sortOrder);
    if (!name || !Number.isInteger(sortOrder) || sortOrder < 0) {
      setError('กรุณาระบุชื่อรอบและลำดับเป็นจำนวนเต็มตั้งแต่ 0');
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const saved = await saveDeliveryRoundName(draft.id, { name, sort_order: sortOrder, is_active: draft.isActive });
      onSaved(saved);
      setDraft(toDraft(saved));
      setSuccess(draft.id ? 'บันทึกชื่อรอบแล้ว' : 'เพิ่มชื่อรอบแล้ว');
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="reference-editor-panel">
      <div className="reference-editor-panel__header"><span>3</span><h2>จัดการชื่อรอบส่ง</h2></div>
      <div className="reference-editor-panel__body">
        <div className="reference-editor-panel__column reference-editor-panel__column--list">
          <div className="reference-list">
            {options.map((option) => {
              const selected = draft.id === option.id;
              return <button aria-current={selected ? 'true' : undefined} className={`reference-list-item ${selected ? 'reference-list-item--selected' : ''}`} key={option.id} onClick={() => { setDraft(toDraft(option)); setError(null); setSuccess(null); }} type="button">
                <span className="reference-list-item__radio" aria-hidden="true">{selected ? <CheckCircle size={20} weight="fill" /> : <Circle size={20} />}</span>
                <span className="reference-list-item__body"><strong>{option.name}</strong><small>ลำดับ {option.sort_order}</small></span>
                <span className="reference-list-item__tags"><span className={`reference-pill ${option.is_active ? 'reference-pill--green' : 'reference-pill--gray'}`}>{option.is_active ? 'ใช้งาน' : 'พักใช้งาน'}</span></span>
              </button>;
            })}
          </div>
        </div>
        <div className="reference-editor-panel__divider" aria-hidden="true" />
        <div className="reference-editor-panel__column reference-editor-panel__column--form">
          <div className="reference-form-heading"><h3>เพิ่ม/แก้ไขชื่อรอบ</h3></div>
          <form className="reference-form" onSubmit={handleSave}>
            <div className="field-grid"><label>ชื่อรอบ<input placeholder="เช่น เช้ามืด" required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>ลำดับ<input min="0" required type="number" value={draft.sortOrder} onChange={(event) => setDraft({ ...draft, sortOrder: event.target.value })} /></label></div>
            <label className="inline-check reference-checkbox"><input checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} type="checkbox" />เปิดใช้งานชื่อนี้</label>
            <p className="reference-inline-note"><Info size={16} weight="fill" />ชื่อที่พักใช้งานจะไม่แสดงในรายการเลือกเปิดรอบใหม่</p>
            {error ? <p className="error-text" role="alert">{error}</p> : null}{success ? <p aria-live="polite" className="success-text">{success}</p> : null}
            <div className="reference-form__actions"><button className="secondary-button" onClick={() => setDraft(EMPTY_DELIVERY_ROUND_NAME)} type="button">เพิ่มชื่อรอบ</button><button className="primary-button" disabled={saving} type="submit">{saving ? 'กำลังบันทึก...' : 'บันทึกชื่อรอบ'}</button></div>
          </form>
        </div>
      </div>
    </section>
  );
}
