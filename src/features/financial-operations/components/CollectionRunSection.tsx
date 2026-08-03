import {
  CaretRight,
  Coins,
  ListNumbers,
  Storefront,
  UserCircle,
} from '@phosphor-icons/react';
import type { Collector, QueueShop } from '../types';
import { money } from '../utils';

export function CollectionRunSection({
  isManager,
  runId,
  busy,
  collectors,
  collectorAvatarUrls,
  failedCollectorAvatars,
  memberIds,
  queue,
  onCloseRun,
  onToggleCollector,
  onCollectorAvatarError,
  onSaveRun,
  onSelectShop,
}: {
  isManager: boolean;
  runId: string | null;
  busy: boolean;
  collectors: Collector[];
  collectorAvatarUrls: Record<string, string>;
  failedCollectorAvatars: Set<string>;
  memberIds: string[];
  queue: QueueShop[];
  onCloseRun: () => void;
  onToggleCollector: (collectorId: string, checked: boolean) => void;
  onCollectorAvatarError: (path: string) => void;
  onSaveRun: () => void;
  onSelectShop: (shop: QueueShop, trigger: HTMLButtonElement) => void;
}) {
  return (
    <section className="financial-ops__section">
      <div className="financial-ops__title">
        <div><Coins /><span><h2>รอบเก็บเงินท้ายวัน</h2><p>รวมยอดค้างเดิมและยอดส่งวันนี้</p></span></div>
        {isManager && runId ? <button disabled={busy} onClick={onCloseRun} type="button">ปิดรอบ</button> : null}
      </div>
      {isManager ? (
        <fieldset className="financial-ops__collectors">
          <legend>มอบหมายพนักงานผู้เก็บ</legend>
          {collectors.map((collector) => (
            <label className="financial-ops__collector" key={collector.id}>
              <input
                checked={memberIds.includes(collector.id)}
                onChange={(event) => onToggleCollector(collector.id, event.target.checked)}
                type="checkbox"
              />
              <span className="financial-ops__collector-avatar" aria-hidden="true">
                {collector.avatar_path
                  && collectorAvatarUrls[collector.avatar_path]
                  && !failedCollectorAvatars.has(collector.avatar_path) ? (
                    <img
                      alt=""
                      onError={() => onCollectorAvatarError(collector.avatar_path!)}
                      src={collectorAvatarUrls[collector.avatar_path]}
                    />
                  ) : <UserCircle size={32} weight="duotone" />}
              </span>
              <span className="financial-ops__collector-identity">
                <strong>{collector.nickname || collector.display_name}</strong>
                <small>{collector.code} · {collector.display_name}</small>
              </span>
            </label>
          ))}
          <button disabled={busy || memberIds.length === 0} onClick={onSaveRun} type="button">
            {runId ? 'บันทึกผู้เก็บเงิน' : 'เปิดรอบและมอบหมาย'}
          </button>
        </fieldset>
      ) : null}
      {!runId ? <p className="financial-ops__empty">{isManager
        ? 'เลือกรายชื่อผู้เก็บเงินเพื่อเปิดรอบ'
        : 'วันนี้ยังไม่มีรอบเก็บเงินที่มอบหมายให้คุณ'}</p> : null}
      {runId && queue.length === 0 ? <p className="financial-ops__empty">ไม่มียอดค้างที่ต้องเก็บ</p> : (
        <div className="financial-ops__shop-grid">
          {queue.map((shop) => (
            <button
              aria-label={`${shop.shop_code} · ${shop.shop_name} ค้าง ${money.format(shop.outstanding_amount)}`}
              className="financial-ops__shop-card"
              key={shop.shop_id}
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
                <strong>{shop.shop_code}</strong>
                <b>{shop.shop_name}</b>
                <small><ListNumbers aria-hidden="true" size={15} /> {shop.charge_count} รายการค้าง</small>
                <em>{money.format(shop.outstanding_amount)}</em>
              </span>
              <CaretRight aria-hidden="true" className="financial-ops__shop-arrow" size={20} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
