import { type FormEvent, useEffect, useMemo, useState } from 'react';
import {
  CaretRight,
  CheckCircle,
  Circle,
  Cube,
  FunnelSimple,
  MagnifyingGlass,
  PauseCircle,
} from '@phosphor-icons/react';
import { EMPTY_ICE_TYPE, type IceTypeSetting, type IceTypeDraft } from '../types';
import { saveIceType, getErrorMessage, uploadIceTypeImage, updateIceTypeImagePath, getIceTypeImageSignedUrl } from '../adminReferenceSettingsService';
import {
  filterLabel,
  matchesActiveFilter,
  matchesQuery,
  nextFilter,
  type ActiveFilter,
} from '../referenceEditorFilters';
import { IceTypeImageEditor } from './IceTypeImageEditor';
import { IceTypePriceEditor } from './IceTypePriceEditor';

interface IceTypeEditorProps {
  iceTypes: IceTypeSetting[];
  onIceTypeSaved: (savedIceType: IceTypeSetting) => void;
  createRequested?: boolean;
  onCreateHandled?: () => void;
}

function toIceTypeDraft(iceType: IceTypeSetting): IceTypeDraft {
  return {
    id: iceType.id,
    code: iceType.code,
    name: iceType.name,
    unit: iceType.unit,
    image_path: iceType.image_path,
    isActive: iceType.is_active,
  };
}

function IceTypeThumbnail({ path }: { path?: string | null }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setUrl(null);
      return undefined;
    }
    let cancelled = false;
    getIceTypeImageSignedUrl(path).then((nextUrl) => {
      if (!cancelled) setUrl(nextUrl);
    }).catch(() => {
      if (!cancelled) setUrl(null);
    });
    return () => { cancelled = true; };
  }, [path]);

  if (url) {
    return <img alt="" src={url} className="ref-ice-thumb-img" />;
  }

  return (
    <div className="ref-ice-thumb-placeholder">
      <Cube size={20} />
    </div>
  );
}

export function IceTypeEditor({
  iceTypes,
  onIceTypeSaved,
  createRequested = false,
  onCreateHandled,
}: IceTypeEditorProps) {
  const [iceTypeDraft, setIceTypeDraft] = useState<IceTypeDraft>(() => (
    iceTypes.length > 0 ? toIceTypeDraft(iceTypes[0]) : EMPTY_ICE_TYPE
  ));
  const [iceTypeQuery, setIceTypeQuery] = useState('');
  const [iceTypeFilter, setIceTypeFilter] = useState<ActiveFilter>('all');
  
  const [savingIceType, setSavingIceType] = useState(false);
  const [iceTypeError, setIceTypeError] = useState<string | null>(null);
  const [iceTypeSuccess, setIceTypeSuccess] = useState<string | null>(null);
  const [pendingImageFile, setPendingImageFile] = useState<File | null>(null);

  useEffect(() => {
    if (!createRequested) return;
    setIceTypeDraft(EMPTY_ICE_TYPE);
    setIceTypeError(null);
    setIceTypeSuccess(null);
    setPendingImageFile(null);
    onCreateHandled?.();
  }, [createRequested, onCreateHandled]);

  const filteredIceTypes = useMemo(
    () => iceTypes
      .filter((iceType) => matchesQuery(iceTypeQuery, [iceType.code, iceType.name, iceType.unit]))
      .filter((iceType) => matchesActiveFilter(iceType.is_active, iceTypeFilter)),
    [iceTypeFilter, iceTypeQuery, iceTypes],
  );

  const activeCount = useMemo(() => iceTypes.filter((t) => t.is_active).length, [iceTypes]);

  function chooseIceType(iceType: IceTypeSetting) {
    setIceTypeDraft(toIceTypeDraft(iceType));
    setIceTypeError(null);
    setIceTypeSuccess(null);
  }

  function startNewIceType() {
    setIceTypeDraft(EMPTY_ICE_TYPE);
    setIceTypeError(null);
    setIceTypeSuccess(null);
    setPendingImageFile(null);
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

      const fileToUpload = !iceTypeDraft.id ? pendingImageFile : null;
      let finalIceType = savedIceType;

      if (fileToUpload) {
        try {
          const imagePath = await uploadIceTypeImage(savedIceType.id, fileToUpload);
          finalIceType = await updateIceTypeImagePath(savedIceType.id, imagePath);
          setPendingImageFile(null);
        } catch {
          setIceTypeError('บันทึกชนิดน้ำแข็งสำเร็จ แต่อัปโหลดรูปไม่สำเร็จ กรุณาเพิ่มรูปใหม่ในหัวข้อรูปสินค้า');
        }
      }

      onIceTypeSaved(finalIceType);
      setIceTypeDraft(toIceTypeDraft(finalIceType));
      setIceTypeSuccess(
        iceTypeDraft.id
          ? 'บันทึกชนิดน้ำแข็งแล้ว'
          : fileToUpload
            ? 'เพิ่มชนิดน้ำแข็งและอัปโหลดรูปสินค้าแล้ว'
            : 'เพิ่มชนิดน้ำแข็งแล้ว',
      );
    } catch (error) {
      setIceTypeError(getErrorMessage(error));
    } finally {
      setSavingIceType(false);
    }
  }

  const iceTypeFilterLabel = filterLabel(iceTypeFilter);

  return (
    <div className="ref-ice-types-container">
      {/* Top Stats Cards Grid */}
      <section className="ref-stats-grid" aria-label="สรุปชนิดน้ำแข็ง">
        <article className="ref-stat-card">
          <div className="ref-stat-card__icon ref-stat-card__icon--blue">
            <Cube size={26} weight="fill" />
          </div>
          <div className="ref-stat-card__content">
            <p>ชนิดน้ำแข็งทั้งหมด</p>
            <div className="ref-stat-card__val">
              <strong>{iceTypes.length}</strong>
              <span>รายการ</span>
            </div>
          </div>
        </article>

        <article className="ref-stat-card">
          <div className="ref-stat-card__icon ref-stat-card__icon--green">
            <CheckCircle size={26} weight="fill" />
          </div>
          <div className="ref-stat-card__content">
            <p>กำลังใช้งาน</p>
            <div className="ref-stat-card__val">
              <strong>{activeCount}</strong>
              <span>รายการ</span>
            </div>
          </div>
        </article>

        <article className="ref-stat-card">
          <div className="ref-stat-card__icon ref-stat-card__icon--purple">
            <PauseCircle size={26} weight="fill" />
          </div>
          <div className="ref-stat-card__content">
            <p>พักใช้งาน</p>
            <div className="ref-stat-card__val">
              <strong>{iceTypes.length - activeCount}</strong>
              <span>รายการ</span>
            </div>
          </div>
        </article>
      </section>

      {/* Split Layout */}
      <div className="ref-split-layout">
        {/* Left Column: Ice Type List */}
        <div className="ref-left-panel">
          <div className="ref-toolbar">
            <div className="ref-search-input">
              <MagnifyingGlass aria-hidden="true" size={18} />
              <input
                onChange={(event) => setIceTypeQuery(event.target.value)}
                placeholder="ค้นหาชื่อหรือรหัสชนิดน้ำแข็ง"
                value={iceTypeQuery}
              />
            </div>
            <button
              aria-label={`กรองชนิดน้ำแข็ง: ${iceTypeFilterLabel}`}
              className={`ref-filter-btn ${iceTypeFilter !== 'all' ? 'ref-filter-btn--active' : ''}`}
              onClick={() => setIceTypeFilter(nextFilter(iceTypeFilter))}
              title={`กรองชนิดน้ำแข็ง: ${iceTypeFilterLabel}`}
              type="button"
            >
              <FunnelSimple size={18} />
              <span>ตัวกรอง</span>
            </button>
          </div>

          <div className="ref-item-list">
            {filteredIceTypes.map((iceType) => {
              const selected = iceTypeDraft.id === iceType.id;
              return (
                <button
                  aria-current={selected ? 'true' : undefined}
                  className={`ref-ice-card ${selected ? 'ref-ice-card--selected' : ''}`}
                  key={iceType.id}
                  onClick={() => chooseIceType(iceType)}
                  type="button"
                >
                  <div className="ref-ice-card__radio">
                    {selected ? (
                      <CheckCircle size={20} weight="fill" className="ref-radio--selected" />
                    ) : (
                      <Circle size={20} className="ref-radio--unselected" />
                    )}
                  </div>

                  <div className="ref-ice-card__thumb">
                    <IceTypeThumbnail path={iceType.image_path} />
                  </div>

                  <div className="ref-ice-card__code">
                    <span>{iceType.code}</span>
                  </div>

                  <div className="ref-ice-card__body">
                    <strong>{iceType.name}</strong>
                    <small>หน่วย: {iceType.unit}</small>
                  </div>

                  <div className="ref-ice-card__badge-wrap">
                    <span className={`ref-pill ${iceType.is_active ? 'ref-pill--green' : 'ref-pill--amber'}`}>
                      {iceType.is_active ? 'ใช้งาน' : 'ไม่ใช้งาน'}
                    </span>
                  </div>

                  <div className="ref-ice-card__chevron">
                    <CaretRight size={18} />
                  </div>
                </button>
              );
            })}
            {filteredIceTypes.length === 0 ? <p className="empty-text">ไม่พบชนิดน้ำแข็งตามคำค้นหรือเงื่อนไขที่เลือก</p> : null}
          </div>

          <div className="ref-pagination-footer">
            <span className="ref-pagination-info">
              แสดง {filteredIceTypes.length === 0 ? 0 : 1}-{filteredIceTypes.length} จาก {iceTypes.length} รายการ
            </span>
            <div className="ref-pagination-controls">
              <button className="ref-page-btn" disabled type="button">&lt;</button>
              <span className="ref-page-num ref-page-num--active">1</span>
              <button className="ref-page-btn" disabled type="button">&gt;</button>
            </div>
          </div>
        </div>

        {/* Right Column: Ice Type Detail Form */}
        <div className="ref-right-panel">
          <form id="ice-type-details-form" onSubmit={handleSave}>
            {/* Section 1: ข้อมูลพื้นฐาน */}
            <div className="ref-section">
              <div className="ref-section-title">
                <h2>ข้อมูลพื้นฐาน</h2>
              </div>

              <div className="ref-form-grid ref-form-grid--three">
                <div className="ref-form-group">
                  <label>รหัส</label>
                  <input
                    placeholder="เช่น 04"
                    required
                    value={iceTypeDraft.code}
                    onChange={(event) => setIceTypeDraft({ ...iceTypeDraft, code: event.target.value })}
                  />
                </div>
                <div className="ref-form-group">
                  <label>ชื่อชนิดน้ำแข็ง</label>
                  <input
                    placeholder="เช่น เปลือย (หลอดใหญ่)"
                    required
                    value={iceTypeDraft.name}
                    onChange={(event) => setIceTypeDraft({ ...iceTypeDraft, name: event.target.value })}
                  />
                </div>
                <div className="ref-form-group">
                  <label>หน่วย</label>
                  <input
                    placeholder="เช่น ถุง"
                    required
                    value={iceTypeDraft.unit}
                    onChange={(event) => setIceTypeDraft({ ...iceTypeDraft, unit: event.target.value })}
                  />
                </div>
              </div>

              <div className="ref-form-status-row">
                <label className="ref-toggle-label">
                  <input
                    checked={iceTypeDraft.isActive}
                    onChange={(event) => setIceTypeDraft({ ...iceTypeDraft, isActive: event.target.checked })}
                    type="checkbox"
                  />
                  <span>เปิดใช้งานชนิดน้ำแข็งนี้</span>
                </label>
              </div>
            </div>
          </form>

          {/* Section 2: รูปสินค้า */}
          <IceTypeImageEditor
            iceType={iceTypes.find((iceType) => iceType.id === iceTypeDraft.id) ?? null}
            onIceTypeSaved={onIceTypeSaved}
            onPendingFileChange={!iceTypeDraft.id ? setPendingImageFile : undefined}
            pendingFile={!iceTypeDraft.id ? pendingImageFile : undefined}
          />

          {/* Section 3: ราคากลาง */}
          <IceTypePriceEditor iceType={iceTypes.find((iceType) => iceType.id === iceTypeDraft.id) ?? null} />

          {iceTypeError ? <p className="error-text" role="alert">{iceTypeError}</p> : null}
          {iceTypeSuccess ? <p aria-live="polite" className="success-text">{iceTypeSuccess}</p> : null}

          {/* Bottom Actions Bar */}
          <div className="ref-actions-bar">
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
              ยกเลิกการแก้ไข
            </button>
            <button
              className="primary-button"
              disabled={savingIceType}
              form="ice-type-details-form"
              type="submit"
            >
              {savingIceType ? 'กำลังบันทึก...' : 'บันทึกการเปลี่ยนแปลง'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
