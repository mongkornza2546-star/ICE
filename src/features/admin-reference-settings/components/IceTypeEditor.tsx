import { type FormEvent, useMemo, useState } from 'react';
import {
  CheckCircle,
  Circle,
  FunnelSimple,
  Info,
  MagnifyingGlass,
  Plus,
} from '@phosphor-icons/react';
import { EMPTY_ICE_TYPE, type IceTypeSetting, type IceTypeDraft } from '../types';
import { saveIceType, getErrorMessage } from '../adminReferenceSettingsService';
import {
  filterLabel,
  matchesActiveFilter,
  matchesQuery,
  nextFilter,
  type ActiveFilter,
} from '../referenceEditorFilters';

interface IceTypeEditorProps {
  iceTypes: IceTypeSetting[];
  onIceTypeSaved: (savedIceType: IceTypeSetting) => void;
}

function toIceTypeDraft(iceType: IceTypeSetting): IceTypeDraft {
  return {
    id: iceType.id,
    code: iceType.code,
    name: iceType.name,
    unit: iceType.unit,
    isActive: iceType.is_active,
  };
}

export function IceTypeEditor({ iceTypes, onIceTypeSaved }: IceTypeEditorProps) {
  const [iceTypeDraft, setIceTypeDraft] = useState<IceTypeDraft>(EMPTY_ICE_TYPE);
  const [iceTypeQuery, setIceTypeQuery] = useState('');
  const [iceTypeFilter, setIceTypeFilter] = useState<ActiveFilter>('all');
  
  const [savingIceType, setSavingIceType] = useState(false);
  const [iceTypeError, setIceTypeError] = useState<string | null>(null);
  const [iceTypeSuccess, setIceTypeSuccess] = useState<string | null>(null);

  const filteredIceTypes = useMemo(
    () => iceTypes
      .filter((iceType) => matchesQuery(iceTypeQuery, [iceType.code, iceType.name, iceType.unit]))
      .filter((iceType) => matchesActiveFilter(iceType.is_active, iceTypeFilter)),
    [iceTypeFilter, iceTypeQuery, iceTypes],
  );

  function chooseIceType(iceType: IceTypeSetting) {
    setIceTypeDraft(toIceTypeDraft(iceType));
    setIceTypeError(null);
    setIceTypeSuccess(null);
  }

  function startNewIceType() {
    setIceTypeDraft(EMPTY_ICE_TYPE);
    setIceTypeError(null);
    setIceTypeSuccess(null);
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const code = iceTypeDraft.code.trim();
    const name = iceTypeDraft.name.trim();
    const unit = iceTypeDraft.unit.trim();
    if (!code || !name || !unit) {
      setIceTypeError('กรุณาระบุรหัส ชื่อ และหน่วยให้ครบ');
      return;
    }

    setSavingIceType(true);
    setIceTypeError(null);
    setIceTypeSuccess(null);
    
    try {
      const savedIceType = await saveIceType(iceTypeDraft.id, {
        code,
        name,
        unit,
        is_active: iceTypeDraft.isActive,
      });

      onIceTypeSaved(savedIceType);
      setIceTypeDraft(toIceTypeDraft(savedIceType));
      setIceTypeSuccess(iceTypeDraft.id ? 'บันทึกชนิดน้ำแข็งแล้ว' : 'เพิ่มชนิดน้ำแข็งแล้ว');
    } catch (error) {
      setIceTypeError(getErrorMessage(error));
    } finally {
      setSavingIceType(false);
    }
  }

  const iceTypeFilterLabel = filterLabel(iceTypeFilter);

  return (
    <section className="reference-editor-panel">
      <div className="reference-editor-panel__header">
        <span>2</span>
        <h2>จัดการชนิดน้ำแข็ง</h2>
      </div>

      <div className="reference-editor-panel__body">
        <div className="reference-editor-panel__column reference-editor-panel__column--list">
          <div className="reference-toolbar">
            <label className="reference-search-field">
              <MagnifyingGlass aria-hidden="true" size={20} />
              <input
                onChange={(event) => setIceTypeQuery(event.target.value)}
                placeholder="ค้นหาชนิดน้ำแข็ง"
                value={iceTypeQuery}
              />
            </label>
            <button
              aria-label={`กรองชนิดน้ำแข็ง: ${iceTypeFilterLabel}`}
              className={`reference-filter-button ${iceTypeFilter !== 'all' ? 'reference-filter-button--active' : ''}`}
              onClick={() => setIceTypeFilter(nextFilter(iceTypeFilter))}
              title={`กรองชนิดน้ำแข็ง: ${iceTypeFilterLabel}`}
              type="button"
            >
              <FunnelSimple size={20} />
            </button>
            <button
              className="primary-button reference-add-button"
              onClick={startNewIceType}
              type="button"
            >
              <Plus size={18} weight="bold" />
              เพิ่มชนิดน้ำแข็ง
            </button>
          </div>

          <div className="reference-list">
            {filteredIceTypes.map((iceType) => {
              const selected = iceTypeDraft.id === iceType.id;
              return (
                <button
                  aria-current={selected ? 'true' : undefined}
                  className={`reference-list-item ${selected ? 'reference-list-item--selected' : ''}`}
                  key={iceType.id}
                  onClick={() => chooseIceType(iceType)}
                  type="button"
                >
                  <span className="reference-list-item__radio" aria-hidden="true">
                    {selected ? <CheckCircle size={20} weight="fill" /> : <Circle size={20} />}
                  </span>
                  <span className="reference-list-item__body">
                    <strong>{iceType.code} · {iceType.name}</strong>
                    <small>{iceType.unit}</small>
                  </span>
                  <span className="reference-list-item__tags">
                    <span className={`reference-pill ${iceType.is_active ? 'reference-pill--green' : 'reference-pill--gray'}`}>
                      {iceType.is_active ? 'ใช้งาน' : 'พักใช้งาน'}
                    </span>
                  </span>
                </button>
              );
            })}
            {filteredIceTypes.length === 0 ? <p className="empty-text">ไม่พบชนิดน้ำแข็งตามคำค้นหรือเงื่อนไขที่เลือก</p> : null}
          </div>

          <p className="reference-list__meta">
            แสดง {filteredIceTypes.length === 0 ? 0 : 1}-{filteredIceTypes.length} จาก {iceTypes.length} รายการ
          </p>
        </div>

        <div className="reference-editor-panel__divider" aria-hidden="true" />

        <div className="reference-editor-panel__column reference-editor-panel__column--form">
          <div className="reference-form-heading">
            <h3>เพิ่ม/แก้ไขชนิดน้ำแข็ง</h3>
          </div>
          <form className="reference-form" onSubmit={handleSave}>
            <div className="field-grid field-grid--three">
              <label>รหัส<input placeholder="เช่น 01, ICE-BLOCK" required value={iceTypeDraft.code} onChange={(event) => setIceTypeDraft({ ...iceTypeDraft, code: event.target.value })} /></label>
              <label>ชื่อ<input placeholder="เช่น ถุงใสหลอดเล็ก" required value={iceTypeDraft.name} onChange={(event) => setIceTypeDraft({ ...iceTypeDraft, name: event.target.value })} /></label>
              <label>หน่วย<input placeholder="เช่น ถุง" required value={iceTypeDraft.unit} onChange={(event) => setIceTypeDraft({ ...iceTypeDraft, unit: event.target.value })} /></label>
            </div>
            <label className="inline-check reference-checkbox">
              <input checked={iceTypeDraft.isActive} onChange={(event) => setIceTypeDraft({ ...iceTypeDraft, isActive: event.target.checked })} type="checkbox" />
              เปิดใช้งานชนิดนี้
            </label>
            <p className="reference-inline-note"><Info size={16} weight="fill" />รายการที่ไม่ได้ใช้แล้วให้พักใช้งาน ข้อมูลเก่ายังอยู่ในระบบ</p>
            {iceTypeError ? <p className="error-text" role="alert">{iceTypeError}</p> : null}
            {iceTypeSuccess ? <p aria-live="polite" className="success-text">{iceTypeSuccess}</p> : null}
            <div className="reference-form__actions">
              <button
                className="secondary-button"
                onClick={() => {
                  if (iceTypeDraft.id) {
                    const original = iceTypes.find((iceType) => iceType.id === iceTypeDraft.id);
                    if (original) chooseIceType(original);
                    return;
                  }
                  startNewIceType();
                }}
                type="button"
              >
                ยกเลิก
              </button>
              <button className="primary-button" disabled={savingIceType} type="submit">
                {savingIceType ? 'กำลังบันทึก...' : 'บันทึกชนิดน้ำแข็ง'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}
