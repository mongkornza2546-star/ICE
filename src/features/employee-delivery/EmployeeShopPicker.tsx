import React, { useEffect, useState } from 'react';
import { MagnifyingGlass, Buildings, MapPin, Storefront, CaretRight, X } from '@phosphor-icons/react';
import type { ShopCard, EmployeeStockState } from '../../types/app';
import { FilterChips } from './FilterChips';
import { EmployeeState } from './EmployeeState';
import { statusTone } from './utils';
import { STATUS_LABELS } from './constants';

export function EmployeeShopPicker({
  casualCustomerButtonRef,
  casualCustomerEntryVisible,
  enableAssignedStockFlow,
  selectedRoundId,
  query,
  setQuery,
  selectedBuildingId,
  setSelectedBuildingId,
  buildingOptions,
  selectedZone,
  setSelectedZone,
  zoneOptions,
  loadingCards,
  filteredCards,
  openCasualCustomer,
  openCard,
  stockState,
  shopButtonRefs,
}: {
  casualCustomerButtonRef: React.RefObject<HTMLButtonElement>;
  casualCustomerEntryVisible: boolean;
  enableAssignedStockFlow: boolean;
  selectedRoundId: string;
  query: string;
  setQuery: (query: string) => void;
  selectedBuildingId: string;
  setSelectedBuildingId: (id: string) => void;
  buildingOptions: Array<{ id: string; name: string }>;
  selectedZone: string;
  setSelectedZone: (zone: string) => void;
  zoneOptions: string[];
  loadingCards: boolean;
  filteredCards: ShopCard[];
  openCasualCustomer: () => void;
  openCard: (card: ShopCard) => void;
  stockState: EmployeeStockState | null;
  shopButtonRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
}) {
  const [previewImage, setPreviewImage] = useState<{ name: string; url: string; trigger: HTMLButtonElement } | null>(null);

  useEffect(() => {
    if (!previewImage) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const trigger = previewImage.trigger;
        setPreviewImage(null);
        window.requestAnimationFrame(() => trigger.focus());
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [previewImage]);

  const closePreview = () => {
    const trigger = previewImage?.trigger;
    setPreviewImage(null);
    if (trigger) window.requestAnimationFrame(() => trigger.focus());
  };

  return (
    <section className="employee-entry-section employee-task-section" aria-labelledby="employee-shop-step">
      <div className="employee-entry-section__heading">
        <span>{enableAssignedStockFlow ? '2' : '1'}</span>
        <div>
          <h2 id="employee-shop-step">เลือกร้านที่จะไปส่ง</h2>
          <p>{enableAssignedStockFlow ? 'แตะร้าน แล้วใส่จำนวนที่ส่งแต่ละชนิด' : 'แตะร้านก่อน ระบบจะโหลดสต๊อก ราคา และเงื่อนไขชำระของร้านนั้น'}</p>
        </div>
      </div>

      {casualCustomerEntryVisible && selectedRoundId ? <div className="employee-casual-entry">
        <button
          aria-label="บันทึกลูกค้าขาจร"
          onClick={openCasualCustomer}
          ref={casualCustomerButtonRef}
          type="button"
        >ลูกค้าขาจร</button>
      </div> : null}

      <label className="employee-search employee-search--standalone">
        <MagnifyingGlass aria-hidden="true" size={22} />
        <span className="employee-visually-hidden">ค้นหาร้าน</span>
        <input
          disabled={!selectedRoundId}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="ค้นรหัสหรือชื่อร้าน"
          type="search"
          value={query}
        />
      </label>

      {selectedRoundId ? (
        <>
          <FilterChips
            icon={<Buildings aria-hidden="true" size={19} />}
            label="ตึก"
            onChange={(value) => {
              setSelectedBuildingId(value);
              setSelectedZone('');
            }}
            options={[{ value: '', label: 'ทุกตึก' }, ...buildingOptions.map((item) => ({ value: item.id, label: item.name }))]}
            value={selectedBuildingId}
          />
          <FilterChips
            icon={<MapPin aria-hidden="true" size={19} />}
            label="โซน"
            onChange={setSelectedZone}
            options={[{ value: '', label: 'ทุกโซน' }, ...zoneOptions.map((zone) => ({ value: zone, label: zone }))]}
            value={selectedZone}
          />
        </>
      ) : null}

      {!selectedRoundId ? (
        <EmployeeState title="เลือกรอบส่งก่อน" detail="หากมีหลายรอบ ต้องเลือกรอบที่กำลังทำงาน" />
      ) : loadingCards ? (
        <EmployeeState title="กำลังโหลดร้าน" detail="รอสักครู่" />
      ) : filteredCards.length === 0 ? (
        <EmployeeState title="ไม่พบร้าน" detail="ลองเปลี่ยนตึก โซน หรือคำค้นหา" />
      ) : (
        <section aria-label={`ร้านที่พบ ${filteredCards.length} ร้าน`} className="employee-shop-section">
          <div className="employee-shop-section__heading">
            <h2>ร้านที่เลือกได้</h2>
            <span>{filteredCards.length} ร้าน</span>
          </div>
          <div className="employee-shop-grid">
            {filteredCards.map((card) => (
              <article
                className="employee-shop-tile"
                key={card.round_stop_id}
              >
                {card.image_url ? (
                  <button
                    aria-label={`ดูรูปร้าน ${card.shop_code} ${card.shop_name}`}
                    className="employee-shop-tile__image-button"
                    onClick={(event) => setPreviewImage({
                      name: `${card.shop_code} · ${card.shop_name}`,
                      url: card.image_url!,
                      trigger: event.currentTarget,
                    })}
                    type="button"
                  >
                    <span className="employee-shop-tile__visual">
                      <img alt="" aria-hidden="true" loading="lazy" src={card.image_url} />
                      <span className={`employee-status employee-status--${statusTone(card.stop_status)}`}>
                        {STATUS_LABELS[card.stop_status]}
                      </span>
                    </span>
                  </button>
                ) : (
                  <span className="employee-shop-tile__visual">
                    <span className="employee-shop-tile__placeholder"><Storefront aria-hidden="true" size={34} /></span>
                    <span className={`employee-status employee-status--${statusTone(card.stop_status)}`}>
                      {STATUS_LABELS[card.stop_status]}
                    </span>
                  </span>
                )}
                <button
                  aria-label={`เลือกร้าน ${card.shop_code} ${card.shop_name}`}
                  className="employee-shop-tile__select"
                  disabled={enableAssignedStockFlow && !stockState}
                  onClick={() => openCard(card)}
                  ref={(node) => {
                    if (node) shopButtonRefs.current.set(card.round_stop_id, node);
                    else shopButtonRefs.current.delete(card.round_stop_id);
                  }}
                  type="button"
                >
                  <span className="employee-shop-tile__body">
                    <strong>{card.shop_code}</strong>
                    <b>{card.shop_name}</b>
                    <small>{card.building_name} · {card.floor_or_zone}</small>
                  </span>
                  <CaretRight aria-hidden="true" className="employee-shop-tile__arrow" size={20} />
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      {previewImage ? <div className="image-preview-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePreview();
      }} role="presentation">
        <section aria-labelledby="employee-shop-image-preview-title" aria-modal="true" className="image-preview-dialog" role="dialog">
          <div className="image-preview-dialog__header">
            <h2 id="employee-shop-image-preview-title">รูปร้าน {previewImage.name}</h2>
            <button aria-label="ปิดรูปภาพ" autoFocus className="image-preview-dialog__close" onClick={closePreview} type="button"><X size={22} weight="bold" /></button>
          </div>
          <img alt={`รูปร้าน ${previewImage.name}`} className="image-preview-dialog__image" src={previewImage.url} />
        </section>
      </div> : null}
    </section>
  );
}
