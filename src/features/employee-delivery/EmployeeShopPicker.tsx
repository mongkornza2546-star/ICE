import React, { useEffect, useRef, useState } from 'react';
import { MagnifyingGlass, Buildings, MapPin, Storefront, CaretRight, WarningCircle, X } from '@phosphor-icons/react';
import type { ShopCard, EmployeeStockState } from '../../types/app';
import { FilterChips } from './FilterChips';
import { EmployeeState } from './EmployeeState';
import { isBoothSameAsName, statusTone } from './utils';
import { STATUS_LABELS } from './constants';

function RegularShopVisual({
  card,
  onPreview,
  refreshImageUrl,
}: {
  card: ShopCard;
  onPreview: (event: React.MouseEvent<HTMLButtonElement>, imageUrl: string) => void;
  refreshImageUrl: (card: ShopCard) => Promise<string | null>;
}) {
  const [imageUrl, setImageUrl] = useState(card.image_url);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  const retryRequestId = useRef(0);

  useEffect(() => {
    retryRequestId.current += 1;
    setImageUrl(card.image_url);
    setLoadAttempt(0);
    setImageFailed(false);
  }, [card.image_url]);

  const retryImage = async () => {
    if (loadAttempt > 0) {
      setImageFailed(true);
      return;
    }
    const requestId = ++retryRequestId.current;
    setImageUrl(null);
    try {
      const refreshedUrl = await refreshImageUrl(card);
      if (retryRequestId.current !== requestId) return;
      if (!refreshedUrl) {
        setImageFailed(true);
        return;
      }
      setLoadAttempt(1);
      setImageUrl(refreshedUrl);
    } catch {
      if (retryRequestId.current === requestId) setImageFailed(true);
    }
  };

  if (!imageUrl || imageFailed) {
    return (
      <span className="employee-shop-tile__visual">
        <span className="employee-shop-tile__placeholder"><Storefront aria-hidden="true" size={34} /></span>
        <span className={`employee-status employee-status--${statusTone(card.stop_status)}`}>
          {STATUS_LABELS[card.stop_status]}
        </span>
      </span>
    );
  }

  return (
    <button
      aria-label={`ดูรูปร้าน ${card.shop_code} ${card.shop_name}`}
      className="employee-shop-tile__image-button"
      onClick={(event) => onPreview(event, imageUrl)}
      type="button"
    >
      <span className="employee-shop-tile__visual">
        <img
          alt=""
          aria-hidden="true"
          decoding="async"
          key={`${imageUrl}:${loadAttempt}`}
          loading="lazy"
          onError={() => void retryImage()}
          src={imageUrl}
        />
        <span className={`employee-status employee-status--${statusTone(card.stop_status)}`}>
          {STATUS_LABELS[card.stop_status]}
        </span>
      </span>
    </button>
  );
}

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
  destinationKind,
  setDestinationKind,
  selectedEventJobId,
  setSelectedEventJobId,
  eventOptions,
  loadingCards,
  eventCardsError,
  filteredCards,
  refreshShopImageUrl,
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
  destinationKind: 'regular' | 'event';
  setDestinationKind: (kind: 'regular' | 'event') => void;
  selectedEventJobId: string;
  setSelectedEventJobId: (id: string) => void;
  eventOptions: Array<{ id: string; name: string }>;
  loadingCards: boolean;
  eventCardsError: string | null;
  filteredCards: ShopCard[];
  refreshShopImageUrl: (card: ShopCard) => Promise<string | null>;
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

      {selectedRoundId ? <nav aria-label="ประเภทจุดส่ง" className={`employee-destination-tabs${casualCustomerEntryVisible ? '' : ' employee-destination-tabs--two'}`}>
        <button aria-pressed={destinationKind === 'regular'} onClick={() => setDestinationKind('regular')} type="button">ร้านประจำ</button>
        <button aria-pressed={destinationKind === 'event'} onClick={() => setDestinationKind('event')} type="button">อีเว้น</button>
        {casualCustomerEntryVisible ? <button aria-label="บันทึกลูกค้าขาจร" onClick={openCasualCustomer} ref={casualCustomerButtonRef} type="button">ลูกค้าขาจร</button> : null}
      </nav> : null}

      <label className="employee-search employee-search--standalone">
        <MagnifyingGlass aria-hidden="true" size={22} />
        <span className="employee-visually-hidden">ค้นหาร้าน</span>
        <input
          disabled={!selectedRoundId}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={destinationKind === 'event' ? 'ค้นชื่อร้าน เลขบูธ โซน หรือเบอร์โทร' : 'ค้นรหัสหรือชื่อร้าน'}
          type="search"
          value={query}
        />
      </label>

      {selectedRoundId ? (
        <>
          {destinationKind === 'regular' ? <FilterChips
            icon={<Buildings aria-hidden="true" size={19} />}
            label="ตึก"
            onChange={(value) => {
              setSelectedBuildingId(value);
              setSelectedZone('');
            }}
            options={[{ value: '', label: 'ทุกตึก' }, ...buildingOptions.map((item) => ({ value: item.id, label: item.name }))]}
            value={selectedBuildingId}
          /> : <FilterChips
            icon={<Storefront aria-hidden="true" size={19} />}
            label="งาน"
            onChange={(value) => {
              setSelectedEventJobId(value);
              setSelectedZone('');
            }}
            options={[{ value: '', label: 'ทุกงาน' }, ...eventOptions.map((item) => ({ value: item.id, label: item.name }))]}
            value={selectedEventJobId}
          />}
          <FilterChips
            icon={<MapPin aria-hidden="true" size={19} />}
            label="โซน"
            onChange={setSelectedZone}
            options={[{ value: '', label: 'ทุกโซน' }, ...zoneOptions.map((zone) => ({ value: zone, label: zone }))]}
            value={selectedZone}
          />
        </>
      ) : null}

      {destinationKind === 'event' && eventCardsError ? (
        <div className="employee-error" role="alert">
          <WarningCircle aria-hidden="true" size={22} weight="fill" />
          <span>โหลดร้านอีเว้นไม่สำเร็จ: {eventCardsError}</span>
        </div>
      ) : null}

      {!selectedRoundId ? (
        <EmployeeState title="เลือกรอบส่งก่อน" detail="หากมีหลายรอบ ต้องเลือกรอบที่กำลังทำงาน" />
      ) : loadingCards ? (
        <EmployeeState title="กำลังโหลดร้าน" detail="รอสักครู่" />
      ) : filteredCards.length === 0 ? (
        <EmployeeState title={destinationKind === 'event' ? 'ไม่พบร้านในอีเว้น' : 'ไม่พบร้าน'} detail={destinationKind === 'event' ? 'ลองเปลี่ยนงาน โซน หรือคำค้นหา' : 'ลองเปลี่ยนตึก โซน หรือคำค้นหา'} />
      ) : (
        <section aria-label={`ร้านที่พบ ${filteredCards.length} ร้าน`} className="employee-shop-section">
          <div className="employee-shop-section__heading">
            <h2>{destinationKind === 'event' ? 'ร้านในอีเว้น' : 'ร้านที่เลือกได้'}</h2>
            <span>{filteredCards.length} ร้าน</span>
          </div>
          <div className="employee-shop-grid">
            {filteredCards.map((card) => {
              const isEvent = card.destination_kind === 'event';
              const boothText = card.booth_number ? `บูธ ${card.booth_number}` : '';
              const sameAsBooth = isEvent && isBoothSameAsName(card.shop_name, card.booth_number);
              const eventPrimaryHeading = boothText || card.shop_name || 'ไม่ระบุบูธ';
              const eventSecondaryHeading = sameAsBooth ? null : card.shop_name;
              const buttonAriaLabel = isEvent
                ? `เลือกร้าน ${[boothText, card.shop_name].filter(Boolean).join(' ')}`
                : `เลือกร้าน ${card.shop_code} ${card.shop_name}`;

              return (
                <article
                  className="employee-shop-tile"
                  key={card.round_stop_id}
                >
                  {isEvent ? (
                    <span className="employee-shop-tile__visual employee-shop-tile__visual--booth">
                      <span className="employee-shop-tile__booth"><small>บูธ</small><strong>{card.booth_number || 'ไม่ระบุ'}</strong></span>
                      <span className={`employee-status employee-status--${statusTone(card.stop_status)}`}>
                        {STATUS_LABELS[card.stop_status]}
                      </span>
                    </span>
                  ) : (
                    <RegularShopVisual
                      card={card}
                      onPreview={(event, imageUrl) => setPreviewImage({
                        name: `${card.shop_code} · ${card.shop_name}`,
                        url: imageUrl,
                        trigger: event.currentTarget,
                      })}
                      refreshImageUrl={refreshShopImageUrl}
                    />
                  )}
                  <button
                    aria-label={buttonAriaLabel}
                    className="employee-shop-tile__select"
                    disabled={(enableAssignedStockFlow && !stockState)
                      || (isEvent && (!card.event_delivery_enabled || !card.is_operational))}
                    onClick={() => openCard(card)}
                    ref={(node) => {
                      if (node) shopButtonRefs.current.set(card.round_stop_id, node);
                      else shopButtonRefs.current.delete(card.round_stop_id);
                    }}
                    type="button"
                  >
                    <span className="employee-shop-tile__body">
                      {isEvent ? (
                        <>
                          <strong>{eventPrimaryHeading}</strong>
                          {eventSecondaryHeading ? <b>{eventSecondaryHeading}</b> : null}
                        </>
                      ) : (
                        <>
                          <strong>{card.shop_code}</strong>
                          <b>{card.shop_name}</b>
                        </>
                      )}
                      <small>{isEvent
                        ? `${card.event_name} · ${card.event_location}${card.event_zone ? ` · โซน ${card.event_zone}` : ''}`
                        : `${card.building_name} · ${card.floor_or_zone}`}</small>
                      {isEvent && !card.event_delivery_enabled
                        ? <span>ยังไม่เปิดบันทึกส่งน้ำแข็ง</span>
                        : null}
                    </span>
                    <CaretRight aria-hidden="true" className="employee-shop-tile__arrow" size={20} />
                  </button>
                </article>
              );
            })}
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
