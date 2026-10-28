import { translateUi, uiDateTimeFormat, useLanguage } from '../../../i18n';
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
import { formatCollectionShopIdentity, formatCollectionServiceDates, money, paymentMethodLabel, formatPaymentReceivedAt, receiptDateTime } from '../utils';
import { isBoothSameAsName } from '../../employee-delivery/utils';
import { AutoRefreshShopImage } from './AutoRefreshShopImage';
import './CollectionDesk.css';

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
  if (shop.billing_statement_id) return { label: 'ตามใบวางบิล', tone: 'today' as const };
  const accountableDate = (charge: QueueShop['charges'][number]) => (
    charge.payment_term === 'credit' ? charge.due_date ?? charge.service_date : charge.service_date
  );
  const oldest = [...shop.charges].sort((left, right) => accountableDate(left).localeCompare(accountableDate(right)))[0];
  const oldestDate = oldest ? accountableDate(oldest) : null;
  if (!oldestDate || oldestDate >= serviceDate) {
    return {
      label: shop.charges.some((charge) => charge.billing_statement_id) ? 'ตามใบวางบิล' : 'วันนี้',
      tone: 'today' as const,
    };
  }
  const elapsed = Math.max(1, Math.round((Date.parse(serviceDate) - Date.parse(oldestDate)) / 86_400_000));
  return { label: `เกินกำหนด ${elapsed} วัน`, tone: elapsed >= 5 ? 'danger' as const : 'warning' as const };
}

function outstandingType(shop: QueueShop) {
  if (shop.billing_statement_number) return `ใบวางบิล ${shop.billing_statement_number}`;
  const hasCredit = shop.charges.some((charge) => charge.payment_term === 'credit');
  const hasNonCredit = shop.charges.some((charge) => charge.payment_term !== 'credit');
  if (hasCredit && hasNonCredit) return 'ค้างชำระ (ผสม)';
  return hasCredit ? 'ค้างชำระ (เครดิต)' : 'ค้างชำระ';
}

const serviceDateTime = uiDateTimeFormat({ day: 'numeric', month: 'numeric', year: '2-digit' });

function collectionLocation(item: QueueShop | PaymentHistoryItem) {
  if (item.destination_kind === 'event') {
    // Keep older API responses usable while the event identity migration rolls out.
    const id = item.event_job_id ? `event:${item.event_job_id}`
      : `event:legacy:${JSON.stringify([item.event_name ?? '', item.event_location ?? ''])}`;
    const dates = [...new Set([item.event_start_date, item.event_end_date].filter((date): date is string => Boolean(date)))];
    const dateLabel = dates.map((date) => serviceDateTime.format(new Date(`${date}T12:00:00+07:00`))).join(' – ');
    return {
      id,
      name: [item.event_name || item.event_location || translateUi('อีเวนต์'), dateLabel].filter(Boolean).join(' · '),
      zoneId: item.event_zone ? `${id}:${JSON.stringify(item.event_zone)}` : null,
      zoneName: item.event_zone,
    };
  }
  return { id: item.building_id, name: item.building_name, zoneId: item.zone_id, zoneName: item.zone_name };
}

function eventContextLabel(
  item: Pick<QueueShop, 'destination_kind' | 'event_name' | 'event_location' | 'event_zone' | 'event_booth'>,
  isEventOnly = false,
) {
  if (item.destination_kind !== 'event') return null;
  return [item.event_name, item.event_location, item.event_zone,
    !isEventOnly && item.event_booth && `บูธ ${item.event_booth}`].filter(Boolean).join(' · ');
}

export function CollectionDesk({
  queue,
  todayPayments,
  paymentHistory,
  historyDate,
  serviceDate,
  selectedShop,
  busy,
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
  useLanguage();
  const [filter, setFilter] = useState<QueueFilter>('outstanding');
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const [historyViewMode, setHistoryViewMode] = useState<'cards' | 'table'>(() => window.innerWidth < 760 ? 'cards' : 'table');
  const [query, setQuery] = useState('');
  const [buildingId, setBuildingId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [sort, setSort] = useState<'recent' | 'oldest' | 'high' | 'low'>('high');
  const [paymentMethod, setPaymentMethod] = useState<'all' | 'cash' | 'transfer'>('all');
  const [paymentStatus, setPaymentStatus] = useState<'all' | 'active' | 'voided'>('all');
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
    const items = filter === 'outstanding' ? queue : filter === 'collected' ? paymentHistory : [...queue, ...paymentHistory];
    items.forEach((item) => {
      const location = collectionLocation(item);
      if (location.id && location.name) found.set(location.id, location.name);
    });
    return [...found].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name, 'th'));
  }, [filter, paymentHistory, queue]);

  const zones = useMemo(() => {
    const found = new Map<string, { name: string; buildingName: string | null }>();
    const items = filter === 'outstanding' ? queue : filter === 'collected' ? paymentHistory : [...queue, ...paymentHistory];
    items.forEach((item) => {
      const location = collectionLocation(item);
      if ((!buildingId || location.id === buildingId) && location.zoneId && location.zoneName) {
        found.set(location.zoneId, { name: location.zoneName, buildingName: location.name ?? null });
      }
    });
    return [...found].map(([id, zone]) => ({ id, ...zone }))
      .sort((left, right) => left.name.localeCompare(right.name, 'th') || (left.buildingName ?? '').localeCompare(right.buildingName ?? '', 'th'));
  }, [buildingId, filter, paymentHistory, queue]);

  useEffect(() => {
    if (buildingId && !buildings.some((building) => building.id === buildingId)) {
      setBuildingId('');
      setZoneId('');
    }
  }, [buildingId, buildings]);

  useEffect(() => {
    if (zoneId && !zones.some((zone) => zone.id === zoneId)) {
      setZoneId('');
    }
  }, [buildingId, zoneId, zones]);

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
        const matchesQuery = !normalizedQuery || `${shop.shop_code} ${shop.shop_name} ${shop.billing_statement_number ?? ''} ${shop.event_name ?? ''} ${shop.event_location ?? ''} ${shop.event_zone ?? ''} ${shop.event_booth ?? ''} ${shop.charges.map((charge) => `${charge.charge_number ?? ''} ${charge.billing_statement_number ?? ''}`).join(' ')}`
          .toLocaleLowerCase().includes(normalizedQuery);
        const location = collectionLocation(shop);
        const matchesBuilding = !buildingId || location.id === buildingId;
        const matchesZone = !zoneId || location.zoneId === zoneId;
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
          document: shop.billing_statement_number ?? latest?.charge_number ?? '—',
          latestDate: latest?.service_date ? serviceDateTime.format(new Date(`${latest.service_date}T12:00:00+07:00`)) : '—',
          contextLabel: shop.billing_statement_number
            ? `เก็บตามใบวางบิล ${shop.billing_statement_number}`
            : eventContextLabel(shop, identity.isEventOnly),
          status: dueLabel(shop, serviceDate),
          shop,
        };
      });
    const paymentRows: CollectionRow[] = paymentHistory
      .filter((payment) => {
        const matchesQuery = `${payment.shops?.code ?? ''} ${payment.shops?.name ?? ''} ${payment.event_name ?? ''} ${payment.event_location ?? ''} ${payment.event_zone ?? ''} ${payment.event_booth ?? ''} ${payment.receipt_number}`
          .toLocaleLowerCase().includes(normalizedQuery);
        const location = collectionLocation(payment);
        const matchesBuilding = !buildingId || location.id === buildingId;
        const matchesZone = !zoneId || location.zoneId === zoneId;
        const matchesMethod = filter !== 'collected' || paymentMethod === 'all' || (paymentMethod === 'cash' ? payment.payment_method === 'cash' : payment.payment_method !== 'cash');
        const matchesStatus = filter !== 'collected' || paymentStatus === 'all' || payment.status === paymentStatus;
        return matchesQuery && matchesBuilding && matchesZone && matchesMethod && matchesStatus;
      })
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
          latestDate: formatPaymentReceivedAt(payment),
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
    return rows.sort((left, right) => {
      if (sort === 'recent' || sort === 'oldest') {
        const byTime = (right.payment?.recorded_at ?? '').localeCompare(left.payment?.recorded_at ?? '');
        return (sort === 'recent' ? 1 : -1) * byTime || right.id.localeCompare(left.id);
      }
      return (sort === 'high' ? 1 : -1) * (right.amount - left.amount);
    });
  }, [buildingId, filter, normalizedQuery, paymentHistory, paymentMethod, paymentStatus, queue, serviceDate, sort, zoneId]);

  const totalCount = visibleRows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageRows = visibleRows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages - 1));
  }, [totalPages]);

  const stats = [
    { label: 'ยอดค้างทั้งหมด', value: outstandingTotal, note: `${queue.length} ${translateUi('กลุ่มยอดค้าง')}`, icon: Receipt, tone: 'blue' },
    { label: 'เก็บเงินวันนี้', value: collectedTotal, note: `${todayPayments.length} ${translateUi('รายการ')}`, icon: Coins, tone: 'green' },
    { label: 'รับเงินสดวันนี้', value: cashTotal, note: `${todayPayments.filter((item) => item.payment_method === 'cash').length} ${translateUi('รายการ')}`, icon: Money, tone: 'orange' },
    { label: 'รับโอนวันนี้', value: transferTotal, note: `${todayPayments.filter((item) => item.payment_method !== 'cash').length} ${translateUi('รายการ')}`, icon: Bank, tone: 'purple' },
  ] as const;

  const changeFilter = (nextFilter: QueueFilter) => {
    setFilter(nextFilter);
    setSort(nextFilter === 'collected' ? 'recent' : 'high');
    setPage(0);
    if (nextFilter === 'outstanding') setSelectedPayment(null);
    if (nextFilter === 'collected') onClearShop();
  };

  const hasDetailPanel = Boolean(paymentPanel || selectedPayment);
  const isHistory = filter === 'collected';
  const activeViewMode = isHistory ? historyViewMode : viewMode;
  const setActiveViewMode = isHistory ? setHistoryViewMode : setViewMode;
  const hasHistoryFilters = Boolean(query || buildingId || zoneId || paymentMethod !== 'all' || paymentStatus !== 'all');
  const historyTotal = visibleRows.reduce((sum, row) => sum + (row.payment?.status === 'active' ? row.amount : 0), 0);
  const clearHistoryFilters = () => {
    setQuery('');
    setBuildingId('');
    setZoneId('');
    setPaymentMethod('all');
    setPaymentStatus('all');
    setPage(0);
  };
  const queueTabs = (
    <div className="collection-desk__tabs" role="tablist" aria-label={translateUi('กรองรายการร้านค้า')}>
              <button aria-selected={filter === 'outstanding'} onClick={() => changeFilter('outstanding')} role="tab" type="button">{translateUi('ค้างชำระทั้งหมด ')}<b>{queue.length}</b></button>
              <button aria-selected={filter === 'collected'} onClick={() => changeFilter('collected')} role="tab" type="button">{translateUi('ประวัติรับเงิน ')}<b>{paymentHistory.length}</b></button>
              <button aria-selected={filter === 'all'} onClick={() => changeFilter('all')} role="tab" type="button">{translateUi('ทั้งหมด')}</button>
            </div>
  );
  const historyDateControl = (
    <div className="collection-desk__history-date">
      <button aria-label={translateUi('วันก่อนหน้า')} onClick={() => { setPage(0); onHistoryDateChange(shiftServiceDate(historyDate, -1)); }} type="button">‹</button>
      <label><CalendarBlank aria-hidden="true" size={17} /><input
        aria-label={translateUi('วันที่ประวัติรับเงิน')}
        max={serviceDate}
        onChange={(event) => {
          if (event.target.value && event.target.value <= serviceDate) {
            setPage(0);
            onHistoryDateChange(event.target.value);
          }
        }}
        type="date"
        value={historyDate}
      /></label>
      <button aria-label={translateUi('วันถัดไป')} disabled={historyDate >= serviceDate} onClick={() => { setPage(0); onHistoryDateChange(shiftServiceDate(historyDate, 1)); }} type="button">›</button>
      {isHistory ? <button disabled={historyDate === serviceDate} onClick={() => { setPage(0); onHistoryDateChange(serviceDate); }} type="button">{translateUi('วันนี้')}</button> : null}
    </div>
  );

  return (
    <div className="collection-desk">
      <header className="financial-ops__header collection-desk__header">
        <div>
          <p className="eyebrow">{translateUi('การเงินหน้าร้าน')}</p>
          <h1>{translateUi('คิวเก็บเงินของฉัน')}</h1>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            {translateUi('วันที่ธุรกิจ ')}{serviceDate}
            <span className="collection-desk__auto-refresh"><i aria-hidden="true" />{translateUi('อัปเดตอัตโนมัติ 30 วิ')}</span>
          </span>
        </div>
        <button disabled={busy} onClick={onRefresh} type="button">
          {translateUi('รีเฟรชยอดล่าสุด')}</button>
      </header>

      <section className="collection-desk__stats" aria-label={translateUi('สรุปการเก็บเงิน')}>
        {stats.map(({ label, value, note, icon: Icon, tone }) => (
          <article key={label}>
            <span><small>{translateUi(label)}</small><strong>{money.format(value)}</strong><em>{note}</em></span>
            <span className={`collection-desk__stat-icon collection-desk__stat-icon--${tone}`}><Icon size={25} weight="duotone" /></span>
          </article>
        ))}
      </section>

      <div className={`collection-desk__workspace ${!hasDetailPanel ? 'collection-desk__workspace--full' : ''}`}>
        <section className={`financial-ops__section collection-desk__section ${isHistory ? 'collection-desk__section--history' : ''}`}>
          <div className="financial-ops__title">
            <div>
              <Coins size={22} weight="duotone" />
              <span>
                <h2>{translateUi(isHistory ? 'ประวัติรับเงิน' : 'คิวรับเงินร้านค้า')}</h2>
                <p>{translateUi(isHistory ? 'ตรวจสอบรายการรับเงินและเปิดดูใบเสร็จ' : 'รวมยอดที่ถึงกำหนดและยอดค้างโดยอัตโนมัติ')}</p>
              </span>
            </div>
          </div>

          {isHistory ? <div className="collection-history__navigation">
            {queueTabs}
            {historyDateControl}
          </div> : null}

          <div className="financial-ops__queue-filters">
            <label className="financial-ops__queue-search">
              <MagnifyingGlass aria-hidden="true" size={20} />
              <input
                aria-label={translateUi('ค้นหาร้านค้า')}
                onChange={(event) => { setQuery(event.target.value); setPage(0); }}
                placeholder={translateUi(isHistory ? 'ค้นหาร้าน หรือเลขใบเสร็จ' : 'ค้นหารหัสร้าน หรือชื่อร้าน')}
                type="search"
                value={query}
              />
            </label>
            <label>{translateUi('ตึก / อีเวนต์')}<select
                aria-label={translateUi('เลือกตึกหรืออีเวนต์')}
                onChange={(event) => { setBuildingId(event.target.value); setZoneId(''); setPage(0); }}
                value={buildingId}
              >
                <option value="">{translateUi('ทุกตึก / อีเวนต์ ')}{buildings.length > 0 ? `(${buildings.length})` : ''}</option>
                {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <label>{translateUi('โซน')}<select
                aria-label={translateUi('เลือกโซน')}
                onChange={(event) => { setZoneId(event.target.value); setPage(0); }}
                value={zoneId}
              >
                <option value="">{translateUi('ทุกโซน ')}{zones.length > 0 ? `(${zones.length})` : ''}</option>
                {zones.map((z) => <option key={z.id} value={z.id}>{z.name}{!buildingId && z.buildingName ? ` · ${z.buildingName}` : ''}</option>)}
              </select>
            </label>
              {isHistory ? <>
                <label>{translateUi('วิธีรับเงิน')}<select aria-label={translateUi('กรองวิธีรับเงิน')} onChange={(event) => { setPaymentMethod(event.target.value as typeof paymentMethod); setPage(0); }} value={paymentMethod}>
                  <option value="all">{translateUi('ทุกวิธีรับเงิน')}</option>
                  <option value="cash">{translateUi('เงินสด')}</option>
                  <option value="transfer">{translateUi('โอนเงิน')}</option>
                </select></label>
                <label>{translateUi('สถานะ')}<select aria-label={translateUi('กรองสถานะรับเงิน')} onChange={(event) => { setPaymentStatus(event.target.value as typeof paymentStatus); setPage(0); }} value={paymentStatus}>
                  <option value="all">{translateUi('ทุกสถานะ')}</option>
                  <option value="active">{translateUi('รับเงินแล้ว')}</option>
                  <option value="voided">{translateUi('ยกเลิกแล้ว')}</option>
                </select></label>
              </> : null}
          </div>

          <div className="collection-desk__admin-bar">
            {isHistory ? (
              <div className="collection-history__results" role="status">
                <span>{translateUi('พบ {0} รายการ', { 0: totalCount })}</span>
                <span>{translateUi('ยอดรับสุทธิ')} <strong>{money.format(historyTotal)}</strong><small>{translateUi('ไม่รวมรายการยกเลิก')}</small></span>
                {hasHistoryFilters ? <button onClick={clearHistoryFilters} type="button"><X aria-hidden="true" size={14} />{translateUi('ล้างตัวกรอง')}</button> : null}
              </div>
            ) : queueTabs}
            <div className="collection-desk__subfilters">
              <select aria-label={translateUi('เรียงรายการ')} onChange={(event) => { setSort(event.target.value as typeof sort); setPage(0); }} value={sort}>
                {filter === 'collected' ? <>
                  <option value="recent">{translateUi('เรียง: รับเงินล่าสุดก่อน')}</option>
                  <option value="oldest">{translateUi('เรียง: รับเงินเก่าสุดก่อน')}</option>
                </> : null}
                <option value="high">{translateUi('เรียง: ')}{filter === 'collected' ? translateUi('ยอดรับ') : translateUi('ยอดค้าง')}{translateUi('มาก - น้อย')}</option>
                <option value="low">{translateUi('เรียง: ')}{filter === 'collected' ? translateUi('ยอดรับ') : translateUi('ยอดค้าง')}{translateUi('น้อย - มาก')}</option>
              </select>
              {filter === 'outstanding' || isHistory ? (
                <div className="collection-desk__view-toggle" role="group" aria-label={translateUi('เลือกมุมมอง')}>
                  <button
                    aria-pressed={activeViewMode === 'cards'}
                    className={activeViewMode === 'cards' ? 'is-active' : ''}
                    onClick={() => setActiveViewMode('cards')}
                    title={translateUi(isHistory ? 'การ์ด' : 'มุมมองการ์ด (POS)')}
                    type="button"
                  >
                    <SquaresFour size={18} weight={activeViewMode === 'cards' ? 'fill' : 'regular'} />
                    <span>{translateUi('การ์ด')}</span>
                  </button>
                  <button
                    aria-pressed={activeViewMode === 'table'}
                    className={activeViewMode === 'table' ? 'is-active' : ''}
                    onClick={() => setActiveViewMode('table')}
                    title={translateUi('มุมมองตาราง')}
                    type="button"
                  >
                    <Table size={18} weight={activeViewMode === 'table' ? 'fill' : 'regular'} />
                    <span>{translateUi('ตาราง')}</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {filter === 'all' ? historyDateControl : null}

          {isHistory ? (
            <div
              className={`collection-history__list collection-history__list--${historyViewMode}`}
              aria-label={translateUi('รายการประวัติรับเงิน')}
              role="region"
              tabIndex={historyViewMode === 'table' ? 0 : undefined}
            >
              <div className="collection-history__head" aria-hidden="true">
                <span>{translateUi('ร้านค้า / สถานที่')}</span>
                <span>{translateUi('ใบเสร็จ / วันที่รับเงิน')}</span>
                <span>{translateUi('วิธีรับเงิน')}</span>
                <span>{translateUi('สถานะ')}</span>
                <span>{translateUi('ยอดรับชำระ')}</span>
                <span />
              </div>
              {pageRows.map((row) => {
                const payment = row.payment!;
                const location = payment.destination_kind === 'event'
                  ? [payment.event_name, payment.event_location, payment.event_zone, payment.event_booth && `บูธ ${payment.event_booth}`].filter(Boolean).join(' · ')
                  : [payment.building_name, payment.zone_name].filter(Boolean).join(' · ');
                return (
                  <button
                    aria-label={translateUi('เลือกรายการ {0}', { 0: row.displayTitle })}
                    className={`collection-history__row ${payment.status === 'voided' ? 'collection-history__row--voided' : ''}`}
                    key={payment.id}
                    onClick={(event) => { onClearShop(); onOpenReceipt(payment, event.currentTarget); }}
                    type="button"
                  >
                    <span className="collection-history__shop">
                      <span className="collection-history__thumbnail">
                        <AutoRefreshShopImage alt="" imagePath={payment.image_path ?? null} imageUrl={payment.image_url}
                          loading="lazy" fallback={<Storefront aria-hidden="true" size={22} weight="duotone" />} />
                      </span>
                      <span><strong>{row.displayTitle}</strong>{location ? <small>{location}</small> : null}</span>
                    </span>
                    <span className="collection-history__receipt"><strong>{payment.receipt_number}</strong><time>{formatPaymentReceivedAt(payment)}</time></span>
                    <span className={`collection-history__method collection-history__method--${payment.payment_method === 'cash' ? 'cash' : 'transfer'}`}>
                      {payment.payment_method === 'cash' ? <Money aria-hidden="true" size={17} /> : <Bank aria-hidden="true" size={17} />}
                      {translateUi(paymentMethodLabel(payment.payment_method))}
                    </span>
                    <em className={`collection-history__status collection-desk__status--${row.status.tone}`}><i aria-hidden="true" />{translateUi(row.status.label)}</em>
                    <strong className="collection-history__amount">{money.format(row.amount)}</strong>
                    <CaretRight className="collection-history__arrow" aria-hidden="true" size={18} />
                  </button>
                );
              })}
              {pageRows.length === 0 ? <div className="collection-history__empty">
                <Receipt aria-hidden="true" size={32} weight="duotone" />
                <strong>{translateUi(paymentHistory.length ? 'ไม่พบรายการตามตัวกรอง' : 'ไม่มีรายการรับเงินในวันที่เลือก')}</strong>
                <span>{translateUi(paymentHistory.length ? 'ลองเปลี่ยนคำค้นหาหรือล้างตัวกรองเพื่อดูรายการทั้งหมด' : 'เลือกวันอื่นเพื่อดูประวัติรับเงิน')}</span>
                {hasHistoryFilters ? <button onClick={clearHistoryFilters} type="button">{translateUi('ล้างตัวกรอง')}</button> : null}
              </div> : null}
            </div>
          ) : viewMode === 'cards' ? (
            <div className="financial-ops__shop-grid">
              {pageRows.map((row) => {
                const isSelected = row.kind === 'shop'
                  ? !selectedPayment && (selectedShop?.queue_key ?? (selectedShop ? `regular:${selectedShop.shop_id}` : null)) === row.id
                  : selectedPayment?.id === row.id;
                if (row.kind === 'shop' && row.shop) {
                  const shop = row.shop;
                  return (
                    <button
                      aria-label={translateUi('เลือกรายการ {0}', { 0: row.displayTitle })}
                      className={`financial-ops__shop-card ${isSelected ? 'is-selected' : ''}`}
                      key={`${row.kind}-${row.id}`}
                      onClick={(event) => {
                        setSelectedPayment(null);
                        onSelectShop(shop, event.currentTarget);
                      }}
                      type="button"
                    >
                      <span className="financial-ops__shop-visual">
                        <AutoRefreshShopImage
                          alt=""
                          fallback={(
                            <span>
                              <Storefront aria-hidden="true" size={36} weight="duotone" />
                              <span className="sr-only">{row.avatarText}</span>
                            </span>
                          )}
                          imagePath={shop.image_path}
                          imageUrl={shop.image_url}
                          loading="lazy"
                        />
                        {shop.has_new_charges ? <small>{translateUi('มียอดเพิ่ม')}</small> : null}
                      </span>
                      <span className="financial-ops__shop-body">
                        <strong>{shop.destination_kind === 'event'
                          ? (shop.event_booth ? translateUi('บูธ {0}', { 0: shop.event_booth }) : shop.shop_name)
                          : shop.shop_code}</strong>
                        <b>{shop.destination_kind === 'event' && shop.event_booth && isBoothSameAsName(shop.shop_name, shop.event_booth)
                          ? ''
                          : shop.shop_name}</b>
                        {row.contextLabel ? <small>{row.contextLabel}</small> : null}
                        {shop.destination_kind === 'event' ? <>
                          <b>{formatCollectionServiceDates(shop) || row.latestDate}</b>
                          <small>{shop.charges.map((charge) => charge.charge_number).filter(Boolean).join(', ')}</small>
                        </> : null}
                        <small><ListNumbers aria-hidden="true" size={15} /> {shop.charge_count}{translateUi(' รายการค้าง')}</small>
                        <em>{money.format(row.amount)}</em>
                      </span>
                      <CaretRight aria-hidden="true" className="financial-ops__shop-arrow" size={20} />
                    </button>
                  );
                }

                const payment = row.payment!;
                return (
                  <button
                    aria-label={translateUi('เลือกรายการ {0}', { 0: row.displayTitle })}
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
                      <AutoRefreshShopImage
                        alt=""
                        fallback={(
                          <span>
                            <Receipt aria-hidden="true" size={36} weight="duotone" />
                            <span className="sr-only">{row.avatarText}</span>
                          </span>
                        )}
                        imagePath={null}
                        imageUrl={payment.image_url}
                        loading="lazy"
                      />
                      {payment.status === 'voided' ? <small className="financial-ops__shop-status financial-ops__shop-status--voided">{translateUi('ยกเลิกแล้ว')}</small> : null}
                    </span>
                    <span className="financial-ops__shop-body">
                      <strong>{payment.receipt_number}</strong>
                      <b>{row.shopName || payment.shops?.name || '-'}</b>
                      <small>{translateUi(paymentMethodLabel(payment.payment_method))} · {formatPaymentReceivedAt(payment)}</small>
                      <em>{money.format(row.amount)}</em>
                    </span>
                    <CaretRight aria-hidden="true" className="financial-ops__shop-arrow" size={20} />
                  </button>
                );
              })}
              {pageRows.length === 0 ? <p className="financial-ops__empty">{translateUi('ไม่พบรายการที่ค้นหา')}</p> : null}
            </div>
          ) : (
            <>
              <div className="collection-desk__table-head" aria-hidden="true">
                <span>{translateUi('ร้านค้า')}</span>
                <span>{translateUi('ประเภทรายการ')}</span>
                <span>{translateUi('ยอดเงิน')}</span>
                <span>{translateUi('เอกสารล่าสุด')}</span>
                <span>{translateUi('วันที่ล่าสุด')}</span>
                <span>{translateUi('สถานะ')}</span>
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
                        aria-label={translateUi('เลือกรายการ {0}', { 0: row.displayTitle })}
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
                            <small>{row.kind === 'shop' ? translateUi('{0} รายการค้าง', { 0: row.shop?.charge_count ?? 0 }) : paymentMethodLabel(row.payment!.payment_method)}</small>
                          </span>
                        </span>
                        <span className="collection-desk__type">{row.transactionType}</span>
                        <b>{money.format(row.amount)}</b>
                        <span className="collection-desk__document"><strong>{row.document}</strong></span>
                        <time>{row.latestDate}</time>
                        <em className={`collection-desk__status collection-desk__status--${row.status.tone}`}>{translateUi(row.status.label)}</em>
                        <CaretRight aria-hidden="true" size={18} />
                      </button>
                      {row.shop?.image_url ? (
                        <AutoRefreshShopImage
                          alt=""
                          fallback={null}
                          imagePath={row.shop.image_path}
                          imageUrl={row.shop.image_url}
                          renderImage={(src, onError) => (
                            <button
                              aria-label={translateUi('ดูรูปร้าน {0} ขนาดใหญ่', { 0: row.displayTitle })}
                              className="collection-desk__shop-image-button"
                              onClick={() => setPreviewImage({ name: row.displayTitle, url: src })}
                              type="button"
                            >
                              <img alt="" onError={onError} src={src} />
                            </button>
                          )}
                        />
                      ) : null}
                    </div>
                  );
                })}
                {pageRows.length === 0 ? <p className="collection-desk__empty-notice">{translateUi('ไม่พบรายการที่ค้นหา')}</p> : null}
              </div>
            </>
          )}

          <footer className="collection-desk__pagination">
            <span>{translateUi('แสดง ')}{pageRows.length ? `${currentPage * PAGE_SIZE + 1} - ${currentPage * PAGE_SIZE + pageRows.length}` : '0'}{translateUi(' จาก ')}{totalCount}{translateUi(' รายการ')}</span>
            <span>
              <button aria-label={translateUi('ก่อนหน้า')} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} type="button">‹</button>
              <b>{currentPage + 1}</b>
              <button aria-label={translateUi('ถัดไป')} disabled={currentPage + 1 >= totalPages} onClick={() => setPage(currentPage + 1)} type="button">›</button>
            </span>
            <span className="collection-desk__page-size">{PAGE_SIZE}{translateUi(' รายการ/หน้า')}</span>
          </footer>
        </section>

        {hasDetailPanel ? (
          <aside className="collection-desk__detail">
            <div className="collection-desk__detail-title">{translateUi('รายละเอียดการรับเงิน')}</div>
            {selectedPayment ? (
              <section className="collection-desk__payment-detail" aria-label={translateUi('รายละเอียด {0}', { 0: selectedPayment.receipt_number })}>
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
                  <button aria-label={translateUi('ปิดรายละเอียดรายการ')} onClick={() => setSelectedPayment(null)} type="button">
                    <X aria-hidden="true" size={20} />
                  </button>
                </header>
                <div className="collection-desk__payment-detail-summary">
                  <span><small>{translateUi('ยอดรับชำระ')}</small><strong>{money.format(selectedPayment.allocated_amount)}</strong></span>
                  <span><small>{translateUi('เอกสารล่าสุด')}</small><b>{selectedPayment.receipt_number}</b></span>
                  <span><small>{translateUi('วิธีรับเงิน')}</small><b>{translateUi(paymentMethodLabel(selectedPayment.payment_method))}</b></span>
                  <span><small>{translateUi('วันที่รับเงิน')}</small><b>{formatPaymentReceivedAt(selectedPayment)}</b></span>
                  {selectedPayment.entered_at ? <span><small>{translateUi('บันทึกเมื่อ')}</small><b>{receiptDateTime.format(new Date(selectedPayment.entered_at))}</b></span> : null}
                  <span><small>{translateUi('สถานะ')}</small><em className={`collection-desk__status collection-desk__status--${selectedPayment.status === 'active' ? 'success' : 'voided'}`}>{selectedPayment.status === 'active' ? translateUi('รับเงินแล้ว') : translateUi('ยกเลิกแล้ว')}</em></span>
                </div>
                <div className="collection-desk__payment-detail-actions">
                  <button disabled={busy} onClick={(event) => onOpenReceipt(selectedPayment, event.currentTarget)} type="button">{translateUi('ดูบิล')}</button>
                  {selectedPayment.status === 'active' ? (
                    <>
                      <button disabled={busy} onClick={() => onPrintReceipt(selectedPayment)} type="button">
                        <Printer aria-hidden="true" size={16} />{translateUi('พิมพ์ซ้ำ')}</button>
                      <button disabled={busy} onClick={() => onVoidPayment(selectedPayment)} type="button">{translateUi('ยกเลิกรายการ')}</button>
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
              <h2 id="collection-shop-image-preview-title">{translateUi('รูปร้าน ')}{previewImage.name}</h2>
              <button aria-label={translateUi('ปิดรูปภาพ')} className="image-preview-dialog__close" onClick={() => setPreviewImage(null)} type="button">
                <X size={22} weight="bold" />
              </button>
            </div>
            <img alt={translateUi('รูปร้าน {0}', { 0: previewImage.name })} className="image-preview-dialog__image" src={previewImage.url} />
          </section>
        </div>
      ) : null}
    </div>
  );
}
