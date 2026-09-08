import {
  CaretRight,
  Coins,
  ListNumbers,
  MagnifyingGlass,
  Storefront,
} from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import type { QueueShop } from '../types';
import { money } from '../utils';
import { isBoothSameAsName } from '../../employee-delivery/utils';

export function CollectionRunSection({
  runId,
  queue,
  showQueue = true,
  onSelectShop,
}: {
  runId: string | null;
  queue: QueueShop[];
  showQueue?: boolean;
  onSelectShop: (shop: QueueShop, trigger: HTMLButtonElement) => void;
}) {
  const [buildingId, setBuildingId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [query, setQuery] = useState('');
  const buildings = useMemo(() => {
    const found = new Map<string, string>();
    queue.forEach((shop) => {
      if (shop.building_id && shop.building_name) found.set(shop.building_id, shop.building_name);
    });
    return [...found].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name, 'th'));
  }, [queue]);
  const zones = useMemo(() => {
    const found = new Map<string, string>();
    queue.forEach((shop) => {
      if (shop.building_id === buildingId && shop.zone_id && shop.zone_name) found.set(shop.zone_id, shop.zone_name);
    });
    return [...found].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name, 'th'));
  }, [buildingId, queue]);
  const normalizedQuery = query.trim().toLocaleLowerCase('th-TH');
  const visibleQueue = queue.filter((shop) => {
    const matchesQuery = !normalizedQuery
      || shop.shop_code.toLocaleLowerCase('th-TH').includes(normalizedQuery)
      || shop.shop_name.toLocaleLowerCase('th-TH').includes(normalizedQuery)
      || (shop.event_name ?? '').toLocaleLowerCase('th-TH').includes(normalizedQuery)
      || (shop.event_booth ?? '').toLocaleLowerCase('th-TH').includes(normalizedQuery);
    return matchesQuery
      && (!buildingId || shop.building_id === buildingId)
      && (!zoneId || shop.zone_id === zoneId);
  });

  return (
    <section className="financial-ops__section">
      <div className="financial-ops__title">
        <div><Coins /><span><h2>คิวรับเงินร้านค้า</h2><p>รวมยอดที่ถึงกำหนดและยอดค้างโดยอัตโนมัติ</p></span></div>
      </div>
      {showQueue && !runId ? <p className="financial-ops__empty">ไม่สามารถเปิดคิวรับเงินของวันนี้ได้</p> : null}
      {showQueue && runId && queue.length > 0 ? <div className="financial-ops__queue-filters">
        <label className="financial-ops__queue-search">
          <MagnifyingGlass aria-hidden="true" size={20} />
          <input
            aria-label="ค้นหาร้านค้า"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ค้นหารหัสร้าน หรือชื่อร้าน"
            type="search"
            value={query}
          />
        </label>
        <label>ตึก
          <select aria-label="เลือกตึก" onChange={(event) => { setBuildingId(event.target.value); setZoneId(''); }} value={buildingId}>
            <option value="">ทุกตึก</option>
            {buildings.map((building) => <option key={building.id} value={building.id}>{building.name}</option>)}
          </select>
        </label>
        <label>โซน
          <select aria-label="เลือกโซน" disabled={!buildingId} onChange={(event) => setZoneId(event.target.value)} value={zoneId}>
            <option value="">ทุกโซน</option>
            {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
          </select>
        </label>
      </div> : null}
      {showQueue && runId && (queue.length === 0 ? <p className="financial-ops__empty">ไม่มียอดค้างที่ต้องเก็บ</p> : visibleQueue.length === 0 ? <p className="financial-ops__empty">{normalizedQuery ? 'ไม่พบร้านค้าที่ค้นหา' : 'ไม่พบยอดค้างในตึกหรือโซนที่เลือก'}</p> : (
        <div className="financial-ops__shop-grid">
          {visibleQueue.map((shop) => (
            <button
              aria-label={`${shop.shop_code} · ${shop.shop_name} ค้าง ${money.format(shop.outstanding_amount)}`}
              className="financial-ops__shop-card"
              key={shop.queue_key ?? `regular:${shop.shop_id}`}
              onClick={(event) => onSelectShop(shop, event.currentTarget)}
              type="button"
            >
              <span className="financial-ops__shop-visual">
                {shop.image_url ? (
                  <img alt="" aria-hidden="true" loading="lazy" src={shop.image_url} />
                ) : (
                  <span><Storefront aria-hidden="true" size={36} weight="duotone" /></span>
                )}
                {shop.has_new_charges ? <small>มียอดเพิ่ม</small> : null}
              </span>
              <span className="financial-ops__shop-body">
                <strong>{shop.destination_kind === 'event'
                  ? (shop.event_booth ? `บูธ ${shop.event_booth}` : shop.shop_name)
                  : shop.shop_code}</strong>
                <b>{shop.destination_kind === 'event' && shop.event_booth && isBoothSameAsName(shop.shop_name, shop.event_booth)
                  ? ''
                  : shop.shop_name}</b>
                {shop.destination_kind === 'event' ? <small>{[shop.event_name, shop.event_zone && `โซน ${shop.event_zone}`].filter(Boolean).join(' · ')}</small> : null}
                <small><ListNumbers aria-hidden="true" size={15} /> {shop.charge_count} รายการค้าง</small>
                <em>{money.format(shop.outstanding_amount)}</em>
              </span>
              <CaretRight aria-hidden="true" className="financial-ops__shop-arrow" size={20} />
            </button>
          ))}
        </div>
      ))}
    </section>
  );
}
