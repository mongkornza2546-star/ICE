import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Bank,
  CalendarBlank,
  CaretRight,
  Coins,
  MagnifyingGlass,
  Money,
  Printer,
  Receipt,
  X,
} from '@phosphor-icons/react';
import { shiftServiceDate } from '../../../lib/serviceDate';
import type { PaymentHistoryItem, QueueShop } from '../types';
import { money, paymentMethodLabel, receiptDateTime } from '../utils';

type QueueFilter = 'outstanding' | 'collected' | 'all';

type CollectionRow = {
  id: string;
  kind: 'shop' | 'payment';
  shopCode: string;
  shopName: string;
  transactionType: string;
  amount: number;
  document: string;
  latestDate: string;
  status: { label: string; tone: 'today' | 'warning' | 'danger' | 'success' | 'voided' };
  shop?: QueueShop;
  payment?: PaymentHistoryItem;
};

function initials(code: string) {
  return code.replace(/[^A-Za-zก-๙]/g, '').slice(0, 2).toUpperCase() || 'ร';
}

function dueLabel(shop: QueueShop, serviceDate: string) {
  const oldest = [...shop.charges].sort((left, right) => left.service_date.localeCompare(right.service_date))[0];
  if (!oldest || oldest.service_date === serviceDate) return { label: 'วันนี้', tone: 'today' as const };
  const elapsed = Math.max(1, Math.round((Date.parse(serviceDate) - Date.parse(oldest.service_date)) / 86_400_000));
  return { label: `เกินกำหนด ${elapsed} วัน`, tone: elapsed >= 5 ? 'danger' as const : 'warning' as const };
}

function outstandingType(shop: QueueShop) {
  const hasCredit = shop.charges.some((charge) => charge.payment_term === 'credit');
  const hasNonCredit = shop.charges.some((charge) => charge.payment_term !== 'credit');
  if (hasCredit && hasNonCredit) return 'ค้างชำระ (ผสม)';
  return hasCredit ? 'ค้างชำระ (เครดิต)' : 'ค้างชำระ';
}

const serviceDateTime = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'numeric', year: '2-digit' });

export function CollectionDesk({
  queue,
  todayPayments,
  paymentHistory,
  historyDate,
  serviceDate,
  selectedShop,
  busy,
  runId,
  runManagement,
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
  runManagement: ReactNode;
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
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'high' | 'low'>('high');
  const [selectedPayment, setSelectedPayment] = useState<PaymentHistoryItem | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const outstandingTotal = queue.reduce((sum, shop) => sum + Number(shop.outstanding_amount), 0);
  const collectedTotal = todayPayments.reduce((sum, payment) => sum + Number(payment.allocated_amount), 0);
  const cashTotal = todayPayments.filter((payment) => payment.payment_method === 'cash')
    .reduce((sum, payment) => sum + Number(payment.allocated_amount), 0);
  const transferTotal = todayPayments.filter((payment) => payment.payment_method !== 'cash')
    .reduce((sum, payment) => sum + Number(payment.allocated_amount), 0);

  useEffect(() => {
    setSelectedPayment((current) => current
      ? paymentHistory.find((payment) => payment.id === current.id) ?? null
      : null);
  }, [paymentHistory]);

  const visibleRows = useMemo(() => {
    const shopRows: CollectionRow[] = queue
      .filter((shop) => `${shop.shop_code} ${shop.shop_name} ${shop.charges.map((charge) => charge.charge_number).join(' ')}`
        .toLocaleLowerCase().includes(normalizedQuery))
      .map((shop) => {
        const latest = [...shop.charges].sort((left, right) => right.service_date.localeCompare(left.service_date))[0];
        return {
          id: shop.shop_id,
          kind: 'shop',
          shopCode: shop.shop_code,
          shopName: shop.shop_name,
          transactionType: outstandingType(shop),
          amount: Number(shop.outstanding_amount),
          document: latest?.charge_number ?? '—',
          latestDate: latest?.service_date ? serviceDateTime.format(new Date(`${latest.service_date}T12:00:00+07:00`)) : '—',
          status: dueLabel(shop, serviceDate),
          shop,
        };
      });
    const paymentRows: CollectionRow[] = paymentHistory
      .filter((payment) => `${payment.shops?.code ?? ''} ${payment.shops?.name ?? ''} ${payment.receipt_number}`
        .toLocaleLowerCase().includes(normalizedQuery))
      .map((payment) => ({
        id: payment.id,
        kind: 'payment',
        shopCode: payment.shops?.code ?? '—',
        shopName: payment.shops?.name ?? 'ไม่พบร้าน',
        transactionType: `รับ${paymentMethodLabel(payment.payment_method)}`,
        amount: Number(payment.allocated_amount),
        document: payment.receipt_number,
        latestDate: receiptDateTime.format(new Date(payment.recorded_at)),
        status: payment.status === 'active'
          ? { label: 'รับเงินแล้ว', tone: 'success' as const }
          : { label: 'ยกเลิกแล้ว', tone: 'voided' as const },
        payment,
      }));
    const rows = filter === 'outstanding' ? shopRows
      : filter === 'collected' ? paymentRows
        : [...shopRows, ...paymentRows];
    return rows.sort((left, right) => (sort === 'high' ? 1 : -1) * (right.amount - left.amount));
  }, [filter, normalizedQuery, paymentHistory, queue, serviceDate, sort]);

  const totalCount = filter === 'outstanding' ? queue.length
    : filter === 'collected' ? paymentHistory.length
      : queue.length + paymentHistory.length;

  const stats = [
    { label: 'ยอดค้างทั้งหมด', value: outstandingTotal, note: `${queue.length} ร้าน`, icon: Receipt, tone: 'blue' },
    { label: 'เก็บเงินวันนี้', value: collectedTotal, note: `${todayPayments.length} รายการ`, icon: Coins, tone: 'green' },
    { label: 'รับเงินสดวันนี้', value: cashTotal, note: `${todayPayments.filter((item) => item.payment_method === 'cash').length} รายการ`, icon: Money, tone: 'orange' },
    { label: 'รับโอนวันนี้', value: transferTotal, note: `${todayPayments.filter((item) => item.payment_method !== 'cash').length} รายการ`, icon: Bank, tone: 'purple' },
  ] as const;

  const changeFilter = (nextFilter: QueueFilter) => {
    setFilter(nextFilter);
    if (nextFilter === 'outstanding') setSelectedPayment(null);
    if (nextFilter === 'collected') onClearShop();
  };

  return (
    <div className="collection-desk">
      <header className="collection-desk__header">
        <div><h1>เก็บเงินร้านค้า</h1><p>ติดตามยอดค้างชำระและรับชำระเงินจากร้านค้า</p></div>
        <div>
          {runId ? <button className="collection-desk__primary" disabled={busy} onClick={onRefresh} type="button">
            <span aria-hidden="true">＋</span>อัปเดตยอดล่าสุด
          </button> : null}
        </div>
      </header>

      {runManagement}

      <section className="collection-desk__stats" aria-label="สรุปการเก็บเงิน">
        {stats.map(({ label, value, note, icon: Icon, tone }) => (
          <article key={label}>
            <span><small>{label}</small><strong>{money.format(value)}</strong><em>{note}</em></span>
            <span className={`collection-desk__stat-icon collection-desk__stat-icon--${tone}`}><Icon size={25} weight="duotone" /></span>
          </article>
        ))}
      </section>

      <div className="collection-desk__workspace">
        <section className="collection-desk__queue">
          <div className="collection-desk__tabs" role="tablist" aria-label="กรองรายการร้านค้า">
            <button aria-selected={filter === 'outstanding'} onClick={() => changeFilter('outstanding')} role="tab" type="button">ค้างชำระทั้งหมด <b>{queue.length}</b></button>
            <button aria-selected={filter === 'collected'} onClick={() => changeFilter('collected')} role="tab" type="button">ประวัติรับเงิน <b>{paymentHistory.length}</b></button>
            <button aria-selected={filter === 'all'} onClick={() => changeFilter('all')} role="tab" type="button">ทั้งหมด</button>
          </div>
          <>
            <div className="collection-desk__filters">
              <label><MagnifyingGlass size={18} /><input onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาร้านค้า / เลขที่เอกสาร" value={query} /></label>
              <select aria-label="สถานะ" onChange={(event) => changeFilter(event.target.value as QueueFilter)} value={filter}>
                <option value="outstanding">สถานะ: ค้างชำระ</option>
                <option value="collected">สถานะ: รับเงินแล้ว</option>
                <option value="all">ทั้งหมด</option>
              </select>
              <select aria-label="เรียงรายการ" onChange={(event) => setSort(event.target.value as 'high' | 'low')} value={sort}><option value="high">เรียง: ยอดค้างมาก - น้อย</option><option value="low">เรียง: ยอดค้างน้อย - มาก</option></select>
            </div>

            {filter !== 'outstanding' ? <div className="collection-desk__history-date">
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
            </div> : null}

            <div className="collection-desk__table-head" aria-hidden="true"><span>ร้านค้า</span><span>ประเภทรายการ</span><span>ยอดเงิน</span><span>เอกสารล่าสุด</span><span>วันที่ล่าสุด</span><span>สถานะ</span><span /></div>
            <div className="collection-desk__rows">
              {visibleRows.map((row, index) => (
                <button
                  aria-label={`เลือกรายการ ${row.shopCode} · ${row.shopName}`}
                  className={(row.kind === 'shop' ? !selectedPayment && selectedShop?.shop_id === row.id : selectedPayment?.id === row.id) ? 'is-selected' : ''}
                  key={`${row.kind}-${row.id}`}
                  onClick={(event) => {
                    if (row.shop) {
                      setSelectedPayment(null);
                      onSelectShop(row.shop, event.currentTarget);
                    } else if (row.payment) {
                      onClearShop();
                      if (window.innerWidth < 1100) onOpenReceipt(row.payment, event.currentTarget);
                      else setSelectedPayment(row.payment);
                    }
                  }}
                  type="button"
                >
                  <span className="collection-desk__identity"><span className={`collection-desk__avatar collection-desk__avatar--${index % 5}`}>{initials(row.shopCode)}</span><span><strong>{row.shopCode} · {row.shopName}</strong><small>{row.kind === 'shop' ? `${row.shop?.charge_count ?? 0} รายการค้าง` : paymentMethodLabel(row.payment!.payment_method)}</small></span></span>
                  <span className="collection-desk__type">{row.transactionType}</span>
                  <b>{money.format(row.amount)}</b>
                  <span className="collection-desk__document"><strong>{row.document}</strong></span>
                  <time>{row.latestDate}</time>
                  <em className={`collection-desk__status collection-desk__status--${row.status.tone}`}>{row.status.label}</em>
                  <CaretRight aria-hidden="true" size={18} />
                </button>
              ))}
              {visibleRows.length === 0 ? <p>ไม่พบรายการที่ค้นหา</p> : null}
            </div>
            <footer><span>แสดง {visibleRows.length ? `1 - ${visibleRows.length}` : '0'} จาก {totalCount} รายการ</span><span><button disabled type="button">‹</button><b>1</b><button disabled type="button">›</button></span><select aria-label="จำนวนรายการต่อหน้า"><option>20 รายการ/หน้า</option></select></footer>
          </>
        </section>

        <aside className="collection-desk__detail">
          <div className="collection-desk__detail-title">รายละเอียดการรับเงิน</div>
          {selectedPayment ? <section className="collection-desk__payment-detail" aria-label={`รายละเอียด ${selectedPayment.receipt_number}`}>
            <header>
              <span><small>{selectedPayment.shops?.code ?? '—'}</small><h2>{selectedPayment.shops?.name ?? 'ไม่พบร้าน'}</h2></span>
              <button aria-label="ปิดรายละเอียดรายการ" onClick={() => setSelectedPayment(null)} type="button"><X aria-hidden="true" size={20} /></button>
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
              {selectedPayment.status === 'active' ? <><button disabled={busy} onClick={() => onPrintReceipt(selectedPayment)} type="button"><Printer aria-hidden="true" size={16} />พิมพ์ซ้ำ</button><button disabled={busy} onClick={() => onVoidPayment(selectedPayment)} type="button">ยกเลิกรายการ</button></> : null}
            </div>
          </section> : paymentPanel ?? <div className="collection-desk__empty-panel"><Coins size={38} weight="duotone" /><strong>เลือกร้านค้าเพื่อรับชำระเงิน</strong><span>รายละเอียดบิลและแบบฟอร์มรับเงินจะแสดงที่นี่</span></div>}
        </aside>
      </div>
    </div>
  );
}
