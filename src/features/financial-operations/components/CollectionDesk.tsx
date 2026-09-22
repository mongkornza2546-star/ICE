import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Bank,
  CalendarBlank,
  CaretRight,
  Coins,
  ListNumbers,
  MagnifyingGlass,
  Money,
  Printer,
  Receipt,
  SquaresFour,
  Storefront,
  Table,
  X,
} from '@phosphor-icons/react';
import { shiftServiceDate } from '../../../lib/serviceDate';
import type { PaymentHistoryItem, QueueShop } from '../types';
import { formatCollectionShopIdentity, money, paymentMethodLabel, receiptDateTime } from '../utils';
import { isBoothSameAsName } from '../../employee-delivery/utils';

type QueueFilter = 'outstanding' | 'collected' | 'all';

const PAGE_SIZE = 20;

type CollectionRow = {
  id: string;
  kind: 'shop' | 'payment';
  shopCode: string;
  shopName: string;
  displayTitle: string;
  avatarText: string;
  transactionType: string;
  amount: number;
  document: string;
  latestDate: string;
  contextLabel: string | null;
  status: { label: string; tone: 'today' | 'warning' | 'danger' | 'success' | 'voided' };
  shop?: QueueShop;
  payment?: PaymentHistoryItem;
};

function dueLabel(shop: QueueShop, serviceDate: string) {
  const accountableDate = (charge: QueueShop['charges'][number]) => (
    charge.payment_term === 'credit' ? charge.due_date ?? charge.service_date : charge.service_date
  );
  const oldest = [...shop.charges].sort((left, right) => accountableDate(left).localeCompare(accountableDate(right)))[0];
  const oldestDate = oldest ? accountableDate(oldest) : null;
  if (!oldestDate || oldestDate === serviceDate) return { label: 'วันนี้', tone: 'today' as const };
  const elapsed = Math.max(1, Math.round((Date.parse(serviceDate) - Date.parse(oldestDate)) / 86_400_000));
  return { label: `เกินกำหนด ${elapsed} วัน`, tone: elapsed >= 5 ? 'danger' as const : 'warning' as const };
}

function outstandingType(shop: QueueShop) {
  const hasCredit = shop.charges.some((charge) => charge.payment_term === 'credit');
  const hasNonCredit = shop.charges.some((charge) => charge.payment_term !== 'credit');
  if (hasCredit && hasNonCredit) return 'ค้างชำระ (ผสม)';
  return hasCredit ? 'ค้างชำระ (เครดิต)' : 'ค้างชำระ';
}

const serviceDateTime = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'numeric', year: '2-digit' });

function eventContextLabel(
  item: Pick<QueueShop, 'destination_kind' | 'event_name' | 'event_location' | 'event_zone' | 'event_booth'>,
  isEventOnly = false,
) {
  if (item.destination_kind !== 'event' || isEventOnly) return null;
  return [item.event_name, item.event_location, item.event_zone,
    item.event_booth && `บูธ ${item.event_booth}`].filter(Boolean).join(' · ');
}

export function CollectionDesk({
  queue,
  todayPayments,
  paymentHistory,
  historyDate,
  serviceDate,
  selectedShop,
  busy,
  runId,
  paymentPanel,
  onRefresh,
  onHistoryDateChange,
  onOpenReceipt,
  onPrintReceipt,
  onSelectShop,
  onClearShop,
  onVoidPayment,
}: {
  queue: QueueShop[];
  todayPayments: PaymentHistoryItem[];
  paymentHistory: PaymentHistoryItem[];
  historyDate: string;
  serviceDate: string;
  selectedShop: QueueShop | null;
  busy: boolean;
  runId: string | null;
  paymentPanel: ReactNode;
  onRefresh: () => void;
  onHistoryDateChange: (serviceDate: string) => void;
  onOpenReceipt: (payment: PaymentHistoryItem, trigger: HTMLButtonElement) => void;
  onPrintReceipt: (payment: PaymentHistoryItem) => void;
  onSelectShop: (shop: QueueShop, trigger: HTMLButtonElement) => void;
  onClearShop: () => void;
  onVoidPayment: (payment: PaymentHistoryItem) => void;
}) {
  const [filter, setFilter] = useState<QueueFilter>('outstanding');
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const [query, setQuery] = useState('');
  const [buildingId, setBuildingId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [sort, setSort] = useState<'high' | 'low'>('high');
  const [page, setPage] = useState(0);
  const [selectedPayment, setSelectedPayment] = useState<PaymentHistoryItem | null>(null);
  const [previewImage, setPreviewImage] = useState<{ name: string; url: string } | null>(null);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const outstandingTotal = queue.reduce((sum, shop) => sum + Number(shop.outstanding_amount), 0);
  const collectedTotal = todayPayments.reduce((sum, payment) => sum + Number(payment.allocated_amount), 0);
  const cashTotal = todayPayments.filter((payment) => payment.payment_method === 'cash')
    .reduce((sum, payment) => sum + Number(payment.allocated_amount), 0);
  const transferTotal = todayPayments.filter((payment) => payment.payment_method !== 'cash')
    .reduce((sum, payment) => sum + Number(payment.allocated_amount), 0);

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
      if ((!buildingId || shop.building_id === buildingId) && shop.zone_id && shop.zone_name) {
        found.set(shop.zone_id, shop.zone_name);
      }
    });
    return [...found].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name, 'th'));
  }, [buildingId, queue]);

  useEffect(() => {
    setSelectedPayment((current) => current
      ? paymentHistory.find((payment) => payment.id === current.id) ?? null
      : null);
  }, [paymentHistory]);

  useEffect(() => {
    if (!previewImage) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewImage(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [previewImage]);

  const visibleRows = useMemo(() => {
    const shopRows: CollectionRow[] = queue
      .filter((shop) => {
        const matchesQuery = !normalizedQuery || `${shop.shop_code} ${shop.shop_name} ${shop.event_name ?? ''} ${shop.event_location ?? ''} ${shop.event_zone ?? ''} ${shop.event_booth ?? ''} ${shop.charges.map((charge) => charge.charge_number).join(' ')}`
          .toLocaleLowerCase().includes(normalizedQuery);
        const matchesBuilding = !buildingId || shop.building_id === buildingId;
        const matchesZone = !zoneId || shop.zone_id === zoneId;
        return matchesQuery && matchesBuilding && matchesZone;
      })
      .map((shop) => {
        const latest = [...shop.charges].sort((left, right) => right.service_date.localeCompare(left.service_date))[0];
        const identity = formatCollectionShopIdentity({
          destination_kind: shop.destination_kind,
          shop_code: shop.shop_code,
          shop_name: shop.shop_name,
          event_booth: shop.event_booth,
        });
        return {
          id: shop.queue_key ?? `regular:${shop.shop_id}`,
          kind: 'shop',
          shopCode: shop.shop_code,
          shopName: shop.shop_name,
          displayTitle: identity.title,
          avatarText: identity.avatarText,
          transactionType: outstandingType(shop),
          amount: Number(shop.outstanding_amount),
          document: latest?.charge_number ?? '—',
          latestDate: latest?.service_date ? serviceDateTime.format(new Date(`${latest.service_date}T12:00:00+07:00`)) : '—',
          contextLabel: eventContextLabel(shop, identity.isEventOnly),
          status: dueLabel(shop, serviceDate),
          shop,
        };
      });
    const paymentRows: CollectionRow[] = paymentHistory
      .filter((payment) => `${payment.shops?.code ?? ''} ${payment.shops?.name ?? ''} ${payment.event_name ?? ''} ${payment.event_location ?? ''} ${payment.event_zone ?? ''} ${payment.event_booth ?? ''} ${payment.receipt_number}`
        .toLocaleLowerCase().includes(normalizedQuery))
      .map((payment) => {
        const identity = formatCollectionShopIdentity({
          destination_kind: payment.destination_kind,
          shop_code: payment.shops?.code,
          shop_name: payment.shops?.name,
          event_booth: payment.event_booth,
        });
        return {
          id: payment.id,
          kind: 'payment',
          shopCode: payment.shops?.code ?? '—',
          shopName: payment.shops?.name ?? 'ไม่พบร้าน',
          displayTitle: identity.title,
          avatarText: identity.avatarText,
          transactionType: `รับ${paymentMethodLabel(payment.payment_method)}`,
          amount: Number(payment.allocated_amount),
          document: payment.receipt_number,
          latestDate: receiptDateTime.format(new Date(payment.recorded_at)),
          contextLabel: eventContextLabel(payment, identity.isEventOnly),
          status: payment.status === 'active'
            ? { label: 'รับเงินแล้ว', tone: 'success' as const }
            : { label: 'ยกเลิกแล้ว', tone: 'voided' as const },
          payment,
        };
      });
    const rows = filter === 'outstanding' ? shopRows
      : filter === 'collected' ? paymentRows
        : [...shopRows, ...paymentRows];
    return rows.sort((left, right) => (sort === 'high' ? 1 : -1) * (right.amount - left.amount));
  }, [buildingId, filter, normalizedQuery, paymentHistory, queue, serviceDate, sort, zoneId]);

  const totalCount = visibleRows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageRows = visibleRows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages - 1));
  }, [totalPages]);

  const stats = [
    { label: 'ยอดค้างทั้งหมด', value: outstandingTotal, note: `${queue.length} กลุ่มยอดค้าง`, icon: Receipt, tone: 'blue' },
    { label: 'เก็บเงินวันนี้', value: collectedTotal, note: `${todayPayments.length} รายการ`, icon: Coins, tone: 'green' },
    { label: 'รับเงินสดวันนี้', value: cashTotal, note: `${todayPayments.filter((item) => item.payment_method === 'cash').length} รายการ`, icon: Money, tone: 'orange' },
    { label: 'รับโอนวันนี้', value: transferTotal, note: `${todayPayments.filter((item) => item.payment_method !== 'cash').length} รายการ`, icon: Bank, tone: 'purple' },
  ] as const;

  const changeFilter = (nextFilter: QueueFilter) => {
    setFilter(nextFilter);
    setPage(0);
    if (nextFilter === 'outstanding') setSelectedPayment(null);
    if (nextFilter === 'collected') onClearShop();
  };

  const hasDetailPanel = Boolean(paymentPanel || selectedPayment);

  return (
    <div className="collection-desk">
      <header className="financial-ops__header collection-desk__header">
        <div>
          <p className="eyebrow">การเงินหน้าร้าน</p>
          <h1>คิวเก็บเงินของฉัน</h1>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            วันที่ธุรกิจ {serviceDate}
            <span className="collection-desk__auto-refresh"><i aria-hidden="true" />อัปเดตอัตโนมัติ 30 วิ</span>
          </span>
        </div>
        {runId ? (
          <button disabled={busy} onClick={onRefresh} type="button">
            รีเฟรชยอดล่าสุด
          </button>
        ) : null}
      </header>

      <section className="collection-desk__stats" aria-label="สรุปการเก็บเงิน">
        {stats.map(({ label, value, note, icon: Icon, tone }) => (
          <article key={label}>
            <span><small>{label}</small><strong>{money.format(value)}</strong><em>{note}</em></span>
            <span className={`collection-desk__stat-icon collection-desk__stat-icon--${tone}`}><Icon size={25} weight="duotone" /></span>
          </article>
        ))}
      </section>

      <div className={`collection-desk__workspace ${!hasDetailPanel ? 'collection-desk__workspace--full' : ''}`}>
        <section className="financial-ops__section collection-desk__section">
          <div className="financial-ops__title">
            <div>
              <Coins size={22} weight="duotone" />
              <span>
                <h2>คิวรับเงินร้านค้า</h2>
                <p>รวมยอดที่ถึงกำหนดและยอดค้างโดยอัตโนมัติ</p>
              </span>
            </div>
          </div>

          <div className="financial-ops__queue-filters">
            <label className="financial-ops__queue-search">
              <MagnifyingGlass aria-hidden="true" size={20} />
              <input
                aria-label="ค้นหาร้านค้า"
                onChange={(event) => { setQuery(event.target.value); setPage(0); }}
                placeholder="ค้นหารหัสร้าน หรือชื่อร้าน"
                type="search"
                value={query}
              />
            </label>
            <label>ตึก
              <select
                aria-label="เลือกตึก"
                onChange={(event) => { setBuildingId(event.target.value); setZoneId(''); setPage(0); }}
                value={buildingId}
              >
                <option value="">ทุกตึก {buildings.length > 0 ? `(${buildings.length})` : ''}</option>
                {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <label>โซน
              <select
                aria-label="เลือกโซน"
                disabled={!buildingId}
                onChange={(event) => { setZoneId(event.target.value); setPage(0); }}
                value={zoneId}
              >
                <option value="">ทุกโซน {zones.length > 0 ? `(${zones.length})` : ''}</option>
                {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
              </select>
            </label>
          </div>

          <div className="collection-desk__admin-bar">
            <div className="collection-desk__tabs" role="tablist" aria-label="กรองรายการร้านค้า">
              <button aria-selected={filter === 'outstanding'} onClick={() => changeFilter('outstanding')} role="tab" type="button">ค้างชำระทั้งหมด <b>{queue.length}</b></button>
              <button aria-selected={filter === 'collected'} onClick={() => changeFilter('collected')} role="tab" type="button">ประวัติรับเงิน <b>{paymentHistory.length}</b></button>
              <button aria-selected={filter === 'all'} onClick={() => changeFilter('all')} role="tab" type="button">ทั้งหมด</button>
            </div>
            <div className="collection-desk__subfilters">
              <select aria-label="เรียงรายการ" onChange={(event) => { setSort(event.target.value as 'high' | 'low'); setPage(0); }} value={sort}>
                <option value="high">เรียง: ยอดค้างมาก - น้อย</option>
                <option value="low">เรียง: ยอดค้างน้อย - มาก</option>
              </select>
              {filter === 'outstanding' ? (
                <div className="collection-desk__view-toggle" aria-label="เลือกมุมมอง">
                  <button
                    aria-pressed={viewMode === 'cards'}
                    className={viewMode === 'cards' ? 'is-active' : ''}
                    onClick={() => setViewMode('cards')}
                    title="มุมมองการ์ด (POS)"
                    type="button"
                  >
                    <SquaresFour size={18} weight={viewMode === 'cards' ? 'fill' : 'regular'} />
                    <span>การ์ด</span>
                  </button>
                  <button
                    aria-pressed={viewMode === 'table'}
                    className={viewMode === 'table' ? 'is-active' : ''}
                    onClick={() => setViewMode('table')}
                    title="มุมมองตาราง"
                    type="button"
                  >
                    <Table size={18} weight={viewMode === 'table' ? 'fill' : 'regular'} />
                    <span>ตาราง</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {filter !== 'outstanding' ? (
            <div className="collection-desk__history-date">
              <button onClick={() => onHistoryDateChange(shiftServiceDate(historyDate, -1))} type="button">‹ วันก่อนหน้า</button>
              <label><CalendarBlank aria-hidden="true" size={17} /><input
                aria-label="วันที่ประวัติรับเงิน"
                max={serviceDate}
                onChange={(event) => {
                  if (event.target.value && event.target.value <= serviceDate) onHistoryDateChange(event.target.value);
                }}
                type="date"
                value={historyDate}
              /></label>
              <button disabled={historyDate >= serviceDate} onClick={() => onHistoryDateChange(shiftServiceDate(historyDate, 1))} type="button">วันถัดไป ›</button>
            </div>
          ) : null}

          {viewMode === 'cards' ? (
            <div className="financial-ops__shop-grid">
              {pageRows.map((row) => {
                const isSelected = row.kind === 'shop'
                  ? !selectedPayment && (selectedShop?.queue_key ?? (selectedShop ? `regular:${selectedShop.shop_id}` : null)) === row.id
                  : selectedPayment?.id === row.id;
                if (row.kind === 'shop' && row.shop) {
                  const shop = row.shop;
                  return (
                    <button
                      aria-label={`เลือกรายการ ${row.displayTitle}`}
                      className={`financial-ops__shop-card ${isSelected ? 'is-selected' : ''}`}
                      key={`${row.kind}-${row.id}`}
                      onClick={(event) => {
                        setSelectedPayment(null);
                        onSelectShop(shop, event.currentTarget);
                      }}
                      type="button"
                    >
                      <span className="financial-ops__shop-visual">
                        {shop.image_url ? (
                          <img alt="" aria-hidden="true" loading="lazy" src={shop.image_url} />
                        ) : (
                          <span>
                            <Storefront aria-hidden="true" size={36} weight="duotone" />
                            <span className="sr-only">{row.avatarText}</span>
                          </span>
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
                        {row.contextLabel ? <small>{row.contextLabel}</small> : null}
                        <small><ListNumbers aria-hidden="true" size={15} /> {shop.charge_count} รายการค้าง</small>
                        <em>{money.format(row.amount)}</em>
                      </span>
                      <CaretRight aria-hidden="true" className="financial-ops__shop-arrow" size={20} />
                    </button>
                  );
                }

                const payment = row.payment!;
                return (
                  <button
                    aria-label={`เลือกรายการ ${row.displayTitle}`}
                    className={`financial-ops__shop-card ${isSelected ? 'is-selected' : ''}`}
                    key={`${row.kind}-${row.id}`}
                    onClick={(event) => {
                      onClearShop();
                      if (!paymentPanel || window.innerWidth < 1100) onOpenReceipt(payment, event.currentTarget);
                      else setSelectedPayment(payment);
                    }}
                    type="button"
                  >
                    <span className="financial-ops__shop-visual">
                      {payment.image_url ? (
                        <img alt="" aria-hidden="true" loading="lazy" src={payment.image_url} />
                      ) : (
                        <span>
                          <Receipt aria-hidden="true" size={36} weight="duotone" />
                          <span className="sr-only">{row.avatarText}</span>
                        </span>
                      )}
                    </span>
                    <span className="financial-ops__shop-body">
                      <strong>{payment.receipt_number}</strong>
                      <b>{row.shopName || payment.shops?.name || '-'}</b>
                      <small>{paymentMethodLabel(payment.payment_method)} · {receiptDateTime.format(new Date(payment.recorded_at))}</small>
                      <em>{money.format(row.amount)}</em>
                    </span>
                    <CaretRight aria-hidden="true" className="financial-ops__shop-arrow" size={20} />
                  </button>
                );
              })}
              {pageRows.length === 0 ? <p className="financial-ops__empty">ไม่พบรายการที่ค้นหา</p> : null}
            </div>
          ) : (
            <>
              <div className="collection-desk__table-head" aria-hidden="true">
                <span>ร้านค้า</span>
                <span>ประเภทรายการ</span>
                <span>ยอดเงิน</span>
                <span>เอกสารล่าสุด</span>
                <span>วันที่ล่าสุด</span>
                <span>สถานะ</span>
                <span />
              </div>
              <div className="collection-desk__rows">
                {pageRows.map((row, index) => {
                  const isSelected = row.kind === 'shop'
                    ? !selectedPayment
                      && (selectedShop?.queue_key ?? (selectedShop ? `regular:${selectedShop.shop_id}` : null)) === row.id
                    : selectedPayment?.id === row.id;
                  return (
                    <div className={isSelected ? 'collection-desk__row is-selected' : 'collection-desk__row'} key={`${row.kind}-${row.id}`}>
                      <button
                        aria-label={`เลือกรายการ ${row.displayTitle}`}
                        className="collection-desk__row-action"
                        onClick={(event) => {
                          if (row.shop) {
                            setSelectedPayment(null);
                            onSelectShop(row.shop, event.currentTarget);
                          } else if (row.payment) {
                            onClearShop();
                            if (!paymentPanel || window.innerWidth < 1100) onOpenReceipt(row.payment, event.currentTarget);
                            else setSelectedPayment(row.payment);
                          }
                        }}
                        type="button"
                      >
                        <span className="collection-desk__identity">
                          <span aria-hidden="true" className={`collection-desk__avatar collection-desk__avatar--${index % 5}`}>
                            {row.avatarText}
                          </span>
                          <span>
                            <strong>{row.displayTitle}</strong>
                            {row.contextLabel ? <small>{row.contextLabel}</small> : null}
                            <small>{row.kind === 'shop' ? `${row.shop?.charge_count ?? 0} รายการค้าง` : paymentMethodLabel(row.payment!.payment_method)}</small>
                          </span>
                        </span>
                        <span className="collection-desk__type">{row.transactionType}</span>
                        <b>{money.format(row.amount)}</b>
                        <span className="collection-desk__document"><strong>{row.document}</strong></span>
                        <time>{row.latestDate}</time>
                        <em className={`collection-desk__status collection-desk__status--${row.status.tone}`}>{row.status.label}</em>
                        <CaretRight aria-hidden="true" size={18} />
                      </button>
                      {row.shop?.image_url ? (
                        <button
                          aria-label={`ดูรูปร้าน ${row.displayTitle} ขนาดใหญ่`}
                          className="collection-desk__shop-image-button"
                          onClick={() => setPreviewImage({ name: row.displayTitle, url: row.shop!.image_url! })}
                          type="button"
                        >
                          <img alt="" src={row.shop.image_url} />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
                {pageRows.length === 0 ? <p className="collection-desk__empty-notice">ไม่พบรายการที่ค้นหา</p> : null}
              </div>
            </>
          )}

          <footer>
            <span>แสดง {pageRows.length ? `${currentPage * PAGE_SIZE + 1} - ${currentPage * PAGE_SIZE + pageRows.length}` : '0'} จาก {totalCount} รายการ</span>
            <span>
              <button aria-label="ก่อนหน้า" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} type="button">‹</button>
              <b>{currentPage + 1}</b>
              <button aria-label="ถัดไป" disabled={currentPage + 1 >= totalPages} onClick={() => setPage(currentPage + 1)} type="button">›</button>
            </span>
            <select aria-label="จำนวนรายการต่อหน้า" defaultValue={PAGE_SIZE}>
              <option value={PAGE_SIZE}>{PAGE_SIZE} รายการ/หน้า</option>
            </select>
          </footer>
        </section>

        {hasDetailPanel ? (
          <aside className="collection-desk__detail">
            <div className="collection-desk__detail-title">รายละเอียดการรับเงิน</div>
            {selectedPayment ? (
              <section className="collection-desk__payment-detail" aria-label={`รายละเอียด ${selectedPayment.receipt_number}`}>
                <header>
                  <span>
                    {(() => {
                      const paymentIdentity = formatCollectionShopIdentity({
                        destination_kind: selectedPayment.destination_kind,
                        shop_code: selectedPayment.shops?.code,
                        shop_name: selectedPayment.shops?.name,
                        event_booth: selectedPayment.event_booth,
                      });
                      return (
                        <>
                          {!paymentIdentity.isEventOnly ? <small>{selectedPayment.shops?.code ?? '—'}</small> : null}
                          <h2>{paymentIdentity.title}</h2>
                          {eventContextLabel(selectedPayment, paymentIdentity.isEventOnly) ? <small>{eventContextLabel(selectedPayment, paymentIdentity.isEventOnly)}</small> : null}
                        </>
                      );
                    })()}
                  </span>
                  <button aria-label="ปิดรายละเอียดรายการ" onClick={() => setSelectedPayment(null)} type="button">
                    <X aria-hidden="true" size={20} />
                  </button>
                </header>
                <div className="collection-desk__payment-detail-summary">
                  <span><small>ยอดรับชำระ</small><strong>{money.format(selectedPayment.allocated_amount)}</strong></span>
                  <span><small>เอกสารล่าสุด</small><b>{selectedPayment.receipt_number}</b></span>
                  <span><small>วิธีรับเงิน</small><b>{paymentMethodLabel(selectedPayment.payment_method)}</b></span>
                  <span><small>วันที่รับเงิน</small><b>{receiptDateTime.format(new Date(selectedPayment.recorded_at))}</b></span>
                  <span><small>สถานะ</small><em className={`collection-desk__status collection-desk__status--${selectedPayment.status === 'active' ? 'success' : 'voided'}`}>{selectedPayment.status === 'active' ? 'รับเงินแล้ว' : 'ยกเลิกแล้ว'}</em></span>
                </div>
                <div className="collection-desk__payment-detail-actions">
                  <button disabled={busy} onClick={(event) => onOpenReceipt(selectedPayment, event.currentTarget)} type="button">ดูบิล</button>
                  {selectedPayment.status === 'active' ? (
                    <>
                      <button disabled={busy} onClick={() => onPrintReceipt(selectedPayment)} type="button">
                        <Printer aria-hidden="true" size={16} />พิมพ์ซ้ำ
                      </button>
                      <button disabled={busy} onClick={() => onVoidPayment(selectedPayment)} type="button">ยกเลิกรายการ</button>
                    </>
                  ) : null}
                </div>
              </section>
            ) : paymentPanel}
          </aside>
        ) : null}
      </div>

      {previewImage ? (
        <div
          className="image-preview-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreviewImage(null);
          }}
          role="presentation"
        >
          <section aria-labelledby="collection-shop-image-preview-title" aria-modal="true" className="image-preview-dialog" role="dialog">
            <div className="image-preview-dialog__header">
              <h2 id="collection-shop-image-preview-title">รูปร้าน {previewImage.name}</h2>
              <button aria-label="ปิดรูปภาพ" className="image-preview-dialog__close" onClick={() => setPreviewImage(null)} type="button">
                <X size={22} weight="bold" />
              </button>
            </div>
            <img alt={`รูปร้าน ${previewImage.name}`} className="image-preview-dialog__image" src={previewImage.url} />
          </section>
        </div>
      ) : null}
    </div>
  );
}
