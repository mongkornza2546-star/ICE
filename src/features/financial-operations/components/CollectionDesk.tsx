import { useMemo, useState, type ReactNode } from 'react';
import {
  Bank,
  CaretRight,
  Coins,
  MagnifyingGlass,
  Money,
  Printer,
  Receipt,
} from '@phosphor-icons/react';
import type { PaymentHistoryItem, QueueShop } from '../types';
import { money } from '../utils';

type QueueFilter = 'outstanding' | 'collected' | 'all';

function initials(code: string) {
  return code.replace(/[^A-Za-zก-๙]/g, '').slice(0, 2).toUpperCase() || 'ร';
}

function dueLabel(shop: QueueShop, serviceDate: string) {
  const oldest = [...shop.charges].sort((left, right) => left.service_date.localeCompare(right.service_date))[0];
  if (!oldest || oldest.service_date === serviceDate) return { label: 'วันนี้', tone: 'today' };
  const elapsed = Math.max(1, Math.round((Date.parse(serviceDate) - Date.parse(oldest.service_date)) / 86_400_000));
  return { label: `เกินกำหนด ${elapsed} วัน`, tone: elapsed >= 5 ? 'danger' : 'warning' };
}

export function CollectionDesk({
  queue,
  todayPayments,
  serviceDate,
  selectedShop,
  busy,
  runId,
  paymentPanel,
  onRefresh,
  onSelectShop,
}: {
  queue: QueueShop[];
  todayPayments: PaymentHistoryItem[];
  serviceDate: string;
  selectedShop: QueueShop | null;
  busy: boolean;
  runId: string | null;
  paymentPanel: ReactNode;
  onRefresh: () => void;
  onSelectShop: (shop: QueueShop, trigger: HTMLButtonElement) => void;
}) {
  const [filter, setFilter] = useState<QueueFilter>('outstanding');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'high' | 'low'>('high');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const outstandingTotal = queue.reduce((sum, shop) => sum + Number(shop.outstanding_amount), 0);
  const collectedTotal = todayPayments.reduce((sum, payment) => sum + Number(payment.allocated_amount), 0);
  const cashTotal = todayPayments.filter((payment) => payment.payment_method === 'cash')
    .reduce((sum, payment) => sum + Number(payment.allocated_amount), 0);
  const transferTotal = todayPayments.filter((payment) => payment.payment_method !== 'cash')
    .reduce((sum, payment) => sum + Number(payment.allocated_amount), 0);
  const visibleQueue = useMemo(() => queue
    .filter((shop) => `${shop.shop_code} ${shop.shop_name} ${shop.charges.map((charge) => charge.charge_number).join(' ')}`
      .toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) => (sort === 'high' ? 1 : -1) * (Number(right.outstanding_amount) - Number(left.outstanding_amount))), [normalizedQuery, queue, sort]);
  const visiblePayments = useMemo(() => todayPayments
    .filter((payment) => `${payment.shops?.code ?? ''} ${payment.shops?.name ?? ''} ${payment.receipt_number}`
      .toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) => (sort === 'high' ? 1 : -1) * (Number(right.allocated_amount) - Number(left.allocated_amount))), [normalizedQuery, sort, todayPayments]);
  const visibleCount = (filter === 'outstanding' ? visibleQueue.length : 0)
    + (filter === 'collected' ? visiblePayments.length : 0)
    + (filter === 'all' ? visibleQueue.length + visiblePayments.length : 0);
  const totalCount = filter === 'outstanding' ? queue.length
    : filter === 'collected' ? todayPayments.length
      : queue.length + todayPayments.length;

  const stats = [
    { label: 'ยอดค้างทั้งหมด', value: outstandingTotal, note: `${queue.length} ร้าน`, icon: Receipt, tone: 'blue' },
    { label: 'เก็บเงินวันนี้', value: collectedTotal, note: `${todayPayments.length} รายการ`, icon: Coins, tone: 'green' },
    { label: 'รับเงินสดวันนี้', value: cashTotal, note: `${todayPayments.filter((item) => item.payment_method === 'cash').length} รายการ`, icon: Money, tone: 'orange' },
    { label: 'รับโอนวันนี้', value: transferTotal, note: `${todayPayments.filter((item) => item.payment_method !== 'cash').length} รายการ`, icon: Bank, tone: 'purple' },
  ] as const;

  return (
    <div className="collection-desk">
      <header className="collection-desk__header">
        <div><h1>เก็บเงินร้านค้า</h1><p>ติดตามยอดค้างชำระและรับชำระเงินจากร้านค้า</p></div>
        <div>
          <button className="collection-desk__print" onClick={() => window.print()} type="button"><Printer size={18} />พิมพ์ใบเสร็จรวม</button>
          {runId ? <button className="collection-desk__primary" disabled={busy} onClick={onRefresh} type="button">
            <span aria-hidden="true">＋</span>อัปเดตยอดล่าสุด
          </button> : null}
        </div>
      </header>

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
            <button aria-selected={filter === 'outstanding'} onClick={() => setFilter('outstanding')} role="tab" type="button">ค้างชำระทั้งหมด <b>{queue.length}</b></button>
            <button aria-selected={filter === 'collected'} onClick={() => setFilter('collected')} role="tab" type="button">เก็บเงินแล้ววันนี้ <b>{todayPayments.length}</b></button>
            <button aria-selected={filter === 'all'} onClick={() => setFilter('all')} role="tab" type="button">ทั้งหมด</button>
          </div>
          <div className="collection-desk__filters">
            <label><MagnifyingGlass size={18} /><input onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาร้านค้า / เลขที่เอกสาร" value={query} /></label>
            <select aria-label="สถานะ" onChange={(event) => setFilter(event.target.value as QueueFilter)} value={filter}>
              <option value="outstanding">สถานะ: ค้างชำระ</option>
              <option value="collected">สถานะ: รับเงินแล้ว</option>
              <option value="all">ทั้งหมด</option>
            </select>
            <select aria-label="เรียงรายการ" onChange={(event) => setSort(event.target.value as 'high' | 'low')} value={sort}><option value="high">เรียง: ยอดค้างมาก - น้อย</option><option value="low">เรียง: ยอดค้างน้อย - มาก</option></select>
          </div>

          <div className="collection-desk__table-head" aria-hidden="true"><span>ร้านค้า</span><span>ยอดค้างชำระ</span><span>เอกสารล่าสุด</span><span>วันที่ล่าสุด</span><span>สถานะ</span><span /></div>
          <div className="collection-desk__rows">
            {filter !== 'outstanding' ? visiblePayments.map((payment) => <div className="collection-desk__paid-row" key={payment.id}><span><strong>{payment.shops?.code ?? '—'} · {payment.shops?.name ?? 'ร้านค้า'}</strong><small>{payment.receipt_number}</small></span><b>{money.format(payment.allocated_amount)}</b><em>รับเงินแล้ว</em></div>) : null}
            {filter !== 'collected' ? visibleQueue.map((shop, index) => {
              const due = dueLabel(shop, serviceDate);
              const latest = [...shop.charges].sort((left, right) => right.service_date.localeCompare(left.service_date))[0];
              return (
                <button className={selectedShop?.shop_id === shop.shop_id ? 'is-selected' : ''} key={shop.shop_id} onClick={(event) => onSelectShop(shop, event.currentTarget)} type="button">
                  <span className={`collection-desk__avatar collection-desk__avatar--${index % 5}`}>{initials(shop.shop_code)}</span>
                  <span className="collection-desk__identity"><strong>{shop.shop_code} · {shop.shop_name}</strong><small>{shop.charge_count} รายการค้าง</small></span>
                  <b>{money.format(shop.outstanding_amount)}</b>
                  <span className="collection-desk__document"><strong>{latest?.charge_number ?? '—'}</strong><small>{shop.charge_count} รายการ</small></span>
                  <time>{latest?.service_date ? new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'numeric', year: '2-digit' }).format(new Date(`${latest.service_date}T12:00:00+07:00`)) : '—'}</time>
                  <em className={`collection-desk__status collection-desk__status--${due.tone}`}>{due.label}</em>
                  <CaretRight size={18} />
                </button>
              );
            }) : null}
            {visibleCount === 0 ? <p>ไม่พบรายการที่ค้นหา</p> : null}
          </div>
          <footer><span>แสดง {visibleCount ? `1 - ${visibleCount}` : '0'} จาก {totalCount} รายการ</span><span><button disabled type="button">‹</button><b>1</b><button disabled type="button">›</button></span><select aria-label="จำนวนรายการต่อหน้า"><option>20 รายการ/หน้า</option></select></footer>
        </section>

        <aside className="collection-desk__detail">
          <div className="collection-desk__detail-title">รายละเอียดการรับเงิน</div>
          {paymentPanel ?? <div className="collection-desk__empty-panel"><Coins size={38} weight="duotone" /><strong>เลือกร้านค้าเพื่อรับชำระเงิน</strong><span>รายละเอียดบิลและแบบฟอร์มรับเงินจะแสดงที่นี่</span></div>}
        </aside>
      </div>
    </div>
  );
}
