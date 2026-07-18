import React from 'react';
import { MagnifyingGlass, Buildings, MapPin, Storefront, CaretRight } from '@phosphor-icons/react';
import type { ShopCard, EmployeeStockState, IceTypeOption } from '../../types/app';
import { FilterChips } from './FilterChips';
import { EmployeeState } from './EmployeeState';
import { statusTone, renderTotals } from './utils';
import { STATUS_LABELS } from './constants';

export function EmployeeShopPicker({
  enableAssignedStockFlow,
  items,
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
  openCard,
  stockState,
  shopButtonRefs,
  iceTypes,
}: {
  enableAssignedStockFlow: boolean;
  items: Array<{ ice_type_id: string; quantity: number }>;
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
  openCard: (card: ShopCard) => void;
  stockState: EmployeeStockState | null;
  shopButtonRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  iceTypes: IceTypeOption[];
}) {
  return (
    <section className="employee-entry-section employee-task-section" aria-labelledby="employee-shop-step">
      <div className="employee-entry-section__heading">
        <span>2</span>
        <div>
          <h2 id="employee-shop-step">เลือกร้านที่จะไปส่ง</h2>
          <p>{enableAssignedStockFlow ? 'แตะร้าน แล้วใส่จำนวนที่ส่งแต่ละชนิด' : items.length > 0 ? 'แตะร้านปลายทางของน้ำแข็งชุดนี้' : 'ใส่ยอดออกจากรถก่อน แล้วค่อยแตะร้าน'}</p>
        </div>
      </div>

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
              <button
                className="employee-shop-tile"
                disabled={enableAssignedStockFlow && !stockState}
                key={card.round_stop_id}
                onClick={() => openCard(card)}
                ref={(node) => {
                  if (node) shopButtonRefs.current.set(card.round_stop_id, node);
                  else shopButtonRefs.current.delete(card.round_stop_id);
                }}
                type="button"
              >
                <span className="employee-shop-tile__visual">
                  {card.image_url ? (
                    <img alt="" aria-hidden="true" loading="lazy" src={card.image_url} />
                  ) : (
                    <span className="employee-shop-tile__placeholder"><Storefront aria-hidden="true" size={34} /></span>
                  )}
                  <span className={`employee-status employee-status--${statusTone(card.stop_status)}`}>
                    {STATUS_LABELS[card.stop_status]}
                  </span>
                </span>
                <span className="employee-shop-tile__body">
                  <strong>{card.shop_code}</strong>
                  <b>{card.shop_name}</b>
                  <small>{card.building_name} · {card.floor_or_zone}</small>
                  <span>{Object.keys(card.today_totals).length > 0 ? `วันนี้ ${renderTotals(card.today_totals, iceTypes)}` : 'วันนี้ยังไม่มียอด'}</span>
                </span>
                <CaretRight aria-hidden="true" className="employee-shop-tile__arrow" size={20} />
              </button>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
