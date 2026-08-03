import { CalendarBlank, CaretRight, ChartBar, Coins, CreditCard, FileText, Printer, UsersThree, WarningCircle, type Icon } from '@phosphor-icons/react';
import { useMemo, useState, type CSSProperties } from 'react';
import { shiftServiceDate } from '../../../lib/serviceDate';
import type { Approval, DueDateRequest, PaymentHistoryItem, Receivable, ReceivableCharge } from '../types';
import { money, paymentMethodLabel, receiptDateTime } from '../utils';

function chargeStatus(charge: ReceivableCharge) {
  if (charge.payment_status === 'paid') return 'ชำระครบแล้ว';
  if (charge.due_status === 'overdue') return `เกินกำหนด ${charge.days_overdue} วัน${charge.payment_status === 'partial' ? ' · ชำระบางส่วน' : ''}`;
  if (charge.due_status === 'due_today') return charge.payment_status === 'partial' ? 'ครบกำหนดวันนี้ · ชำระบางส่วน' : 'ครบกำหนดวันนี้';
  return charge.payment_status === 'partial' ? 'ยังไม่ถึงกำหนด · ชำระบางส่วน' : 'ยังไม่ถึงกำหนด';
}

function SectionTitle({
  icon: Icon,
  title,
  description,
}: {
  icon: Icon;
  title: string;
  description: string;
}) {
  return (
    <div className="financial-ops__title">
      <div><Icon /><span><h2>{title}</h2><p>{description}</p></span></div>
    </div>
  );
}

export function ManagerFinancialSections({
  approvals,
  dueDateRequests,
  receivables,
  busy,
  runId,
  onDecide,
  onDecideDueDateRequest,
  onToggleCreditCollectionAssignment,
}: {
  approvals: Approval[];
  dueDateRequests: DueDateRequest[];
  receivables: Receivable[];
  busy: boolean;
  runId: string | null;
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => void;
  onDecideDueDateRequest: (requestId: string, decision: 'approved' | 'rejected') => void;
  onToggleCreditCollectionAssignment: (charge: ReceivableCharge, assigned: boolean) => void;
}) {
  const [activeView, setActiveView] = useState<'overview' | 'requests' | 'customers' | 'aging'>('overview');
  const [shopQuery, setShopQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'not_due' | 'due_today' | 'overdue' | 'partial' | 'paid'>('all');
  const [sortBy, setSortBy] = useState<'due_date' | 'outstanding'>('due_date');
  const charges = useMemo(() => receivables.flatMap((shop) => shop.charges.map((charge) => ({
    ...charge,
    shopCode: shop.shop_code,
    shopName: shop.shop_name,
  }))).sort((left, right) => sortBy === 'outstanding'
    ? Number(right.outstanding_amount) - Number(left.outstanding_amount)
    : left.due_date.localeCompare(right.due_date)), [receivables, sortBy]);
  const matchesStatus = (charge: ReceivableCharge) => statusFilter === 'all'
    || charge.due_status === statusFilter
    || charge.payment_status === statusFilter;
  const filteredCharges = charges.filter(matchesStatus);
  const normalizedShopQuery = shopQuery.trim().toLocaleLowerCase();
  const filteredReceivables = receivables
    .filter((item) => `${item.shop_code} ${item.shop_name}`.toLocaleLowerCase().includes(normalizedShopQuery)
      && item.charges.some(matchesStatus))
    .sort((left, right) => sortBy === 'outstanding'
      ? Number(right.outstanding_amount) - Number(left.outstanding_amount)
      : (left.oldest_due_date ?? '9999-12-31').localeCompare(right.oldest_due_date ?? '9999-12-31'));
  const totalOutstanding = receivables.reduce((total, item) => total + Number(item.outstanding_amount), 0);
  const totalOverdue = receivables.reduce((total, item) => total + Number(item.overdue_amount), 0);
  const totalAvailableCredit = receivables.reduce((total, item) => (
    total + Number(item.available_credit_amount ?? 0)
  ), 0);
  const agingBuckets = [
    { label: 'ยังไม่เกินกำหนด', amount: charges.filter((charge) => charge.due_status === 'not_due' || charge.due_status === 'due_today').reduce((total, charge) => total + Number(charge.outstanding_amount), 0), tone: 'current' },
    { label: '1–7 วัน', amount: charges.filter((charge) => charge.days_overdue >= 1 && charge.days_overdue <= 7).reduce((total, charge) => total + Number(charge.outstanding_amount), 0), tone: 'watch' },
    { label: '8–30 วัน', amount: charges.filter((charge) => charge.days_overdue >= 8 && charge.days_overdue <= 30).reduce((total, charge) => total + Number(charge.outstanding_amount), 0), tone: 'late' },
    { label: 'เกิน 30 วัน', amount: charges.filter((charge) => charge.days_overdue > 30).reduce((total, charge) => total + Number(charge.outstanding_amount), 0), tone: 'critical' },
  ] as const;
  const overdueCharges = charges.filter((charge) => charge.due_status === 'overdue');
  const pendingRequests = approvals.length + dueDateRequests.length;

  const showView = (view: typeof activeView) => setActiveView(view);

  return (
    <section className="credit-ar" aria-labelledby="credit-ar-title">
      <header className="credit-ar__header">
        <div>
          <span className="credit-ar__header-icon"><CreditCard aria-hidden="true" size={24} weight="duotone" /></span>
          <span><p className="eyebrow">Credit &amp; AR Management</p><h1 id="credit-ar-title">จัดการลูกหนี้ &amp; เครดิต</h1><small>ติดตามวงเงินเครดิต ยอดค้างชำระ และการอนุมัติในที่เดียว</small></span>
        </div>
        <span className="credit-ar__as-of">ข้อมูลตามยอดปัจจุบัน</span>
      </header>

      <nav aria-label="เมนูจัดการลูกหนี้และเครดิต" className="credit-ar__tabs">
        <button aria-current={activeView === 'overview' ? 'page' : undefined} onClick={() => showView('overview')} type="button"><ChartBar aria-hidden="true" size={18} weight="duotone" />ภาพรวม</button>
        <button aria-current={activeView === 'requests' ? 'page' : undefined} onClick={() => showView('requests')} type="button"><FileText aria-hidden="true" size={18} weight="duotone" />คำขออนุมัติ{pendingRequests > 0 ? <b>{pendingRequests}</b> : null}</button>
        <button aria-current={activeView === 'customers' ? 'page' : undefined} onClick={() => showView('customers')} type="button"><UsersThree aria-hidden="true" size={18} weight="duotone" />ลูกหนี้เครดิต</button>
        <button aria-current={activeView === 'aging' ? 'page' : undefined} onClick={() => showView('aging')} type="button"><WarningCircle aria-hidden="true" size={18} weight="duotone" />Aging Report</button>
      </nav>

      {activeView === 'overview' ? <>
        <div className="credit-ar__metrics" aria-label="สรุปลูกหนี้เครดิต">
          <button onClick={() => showView('customers')} type="button"><span>ยอดลูกหนี้คงค้าง</span><strong>{money.format(totalOutstanding)}</strong><small>{receivables.length} ร้านเครดิต</small></button>
          <button className="credit-ar__metric--danger" onClick={() => showView('aging')} type="button"><span>ค้างชำระเกินกำหนด</span><strong>{money.format(totalOverdue)}</strong><small>{overdueCharges.length} เอกสารต้องติดตาม</small></button>
          <button onClick={() => showView('customers')} type="button"><span>วงเงินเครดิตคงเหลือ</span><strong>{money.format(totalAvailableCredit)}</strong><small>รวมทุกบัญชีที่กำหนดวงเงิน</small></button>
          <button onClick={() => showView('requests')} type="button"><span>คำขอรออนุมัติ</span><strong>{pendingRequests} รายการ</strong><small>วงเงินและขอเลื่อนชำระ</small></button>
        </div>
        <div className="credit-ar__overview-grid">
          <section className="credit-ar__panel">
            <div className="credit-ar__panel-heading"><span><ChartBar aria-hidden="true" size={19} /><h2>อายุลูกหนี้</h2></span><button onClick={() => showView('aging')} type="button">ดูรายงาน</button></div>
            <div className="credit-ar__aging-bars">
              {agingBuckets.map((bucket) => <div key={bucket.label}><span>{bucket.label}</span><i className={`credit-ar__bar credit-ar__bar--${bucket.tone}`} style={{ '--aging-width': `${totalOutstanding > 0 ? Math.max((bucket.amount / totalOutstanding) * 100, bucket.amount > 0 ? 5 : 0) : 0}%` } as CSSProperties} /><b>{money.format(bucket.amount)}</b></div>)}
            </div>
          </section>
          <section className="credit-ar__panel">
            <div className="credit-ar__panel-heading"><span><WarningCircle aria-hidden="true" size={19} /><h2>ต้องติดตามวันนี้</h2></span><button onClick={() => showView('aging')} type="button">ดูทั้งหมด</button></div>
            {overdueCharges.length === 0 ? <p className="financial-ops__empty">ไม่มีรายการค้างเกินกำหนด</p> : <div className="credit-ar__follow-ups">
              {overdueCharges.slice(0, 3).map((charge) => <div key={charge.charge_id}><span><strong>{charge.shopCode} · {charge.shopName}</strong><small>{charge.charge_number} · เกินกำหนด {charge.days_overdue} วัน</small></span><b>{money.format(charge.outstanding_amount)}</b></div>)}
            </div>}
          </section>
        </div>
      </> : null}

      {activeView === 'requests' ? <div className="credit-ar__request-grid">
        <section className="financial-ops__section">
          <SectionTitle icon={CreditCard} title="คำขออนุมัติวงเงิน" description="วงเงินเครดิตและยอดค้างที่ต้องพิจารณา" />
        {approvals.length === 0 ? <p className="financial-ops__empty">ไม่มีคำขอรออนุมัติ</p> : (
          <div className="financial-ops__cards">
            {approvals.map((approval) => (
              <article key={approval.id}>
                <strong>{approval.shops?.code} · {approval.shops?.name}</strong>
                <span>{approval.kind === 'credit_limit' ? 'เกินวงเงินเครดิต' : 'ขอค้างชำระ'} · {money.format(approval.requested_amount)}</span>
                <p>{approval.reason}</p>
                <small>ผู้ขอ {approval.users?.display_name ?? '—'}</small>
                <div><button disabled={busy} onClick={() => onDecide(approval.id, 'rejected')} type="button">ไม่อนุมัติ</button><button disabled={busy} onClick={() => onDecide(approval.id, 'approved')} type="button">อนุมัติ</button></div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="financial-ops__section">
        <SectionTitle icon={CreditCard} title="คำขอเลื่อนกำหนดชำระ" description="อนุมัติก่อนเปลี่ยนวันครบกำหนดจริง" />
        {dueDateRequests.length === 0 ? <p className="financial-ops__empty">ไม่มีคำขอเลื่อนกำหนดชำระ</p> : (
          <div className="financial-ops__cards">
            {dueDateRequests.map((request) => (
              <article key={request.id}>
                <strong>{request.shop_code} · {request.shop_name}</strong>
                <span>{request.charge_number} · {request.original_due_date} → {request.requested_due_date}</span>
                <p>{request.reason}</p><small>ผู้ขอ {request.requested_by}</small>
                <div><button disabled={busy} onClick={() => onDecideDueDateRequest(request.id, 'rejected')} type="button">ไม่อนุมัติ</button><button disabled={busy} onClick={() => onDecideDueDateRequest(request.id, 'approved')} type="button">อนุมัติ</button></div>
              </article>
            ))}
          </div>
        )}
      </section>
      </div> : null}

      {activeView === 'customers' ? <section className="financial-ops__section credit-ar__customers">
        <SectionTitle icon={UsersThree} title="รายชื่อลูกหนี้เครดิต" description="สถานะวงเงินคงเหลือ ยอดค้าง และเอกสารที่ต้องติดตาม" />
        {receivables.length === 0 ? <p className="financial-ops__empty">ไม่มีลูกหนี้เครดิตคงค้าง</p> : (
          <>
            <div className="financial-ops__receivable-controls">
              <label className="credit-ar__search"><span className="sr-only">ค้นหาร้านลูกหนี้เครดิต</span><input aria-label="ค้นหาร้านลูกหนี้เครดิต" onChange={(event) => setShopQuery(event.target.value)} placeholder="ค้นหาร้าน / รหัสร้าน" type="search" value={shopQuery} /></label>
              <label>สถานะ<select aria-label="กรองสถานะลูกหนี้" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">ทั้งหมด</option><option value="not_due">ยังไม่ถึงกำหนด</option><option value="due_today">ครบกำหนดวันนี้</option><option value="overdue">เกินกำหนด</option><option value="partial">ชำระบางส่วน</option><option value="paid">ชำระครบแล้ว</option></select></label>
              <label>เรียงตาม<select aria-label="เรียงลูกหนี้" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}><option value="due_date">วันครบกำหนด</option><option value="outstanding">ยอดค้าง</option></select></label>
            </div>
            <div className="financial-ops__list">
              {filteredReceivables.map((item) => (
                <div key={item.shop_id}>
                  <span><strong>{item.shop_code} · {item.shop_name}</strong><small>ยอดเกินกำหนด {money.format(item.overdue_amount)} · วงเงินคงเหลือ {item.available_credit_amount === null ? 'ไม่จำกัด' : money.format(item.available_credit_amount)}</small></span>
                  <b>{money.format(item.outstanding_amount)}</b>
                </div>
              ))}
            </div>
            <div className="financial-ops__receivable-charges">
              {filteredCharges.filter((charge) => `${charge.shopCode} ${charge.shopName}`.toLocaleLowerCase().includes(normalizedShopQuery)).map((charge) => <article key={charge.charge_id}>
                <span><strong>{charge.shopCode} · {charge.charge_number}</strong><small>ครบกำหนด {charge.due_date} · {chargeStatus(charge)}</small></span>
                <b>{money.format(charge.outstanding_amount)}</b>
                {charge.payment_status !== 'paid' && charge.due_status !== 'not_due' ? <button
                  disabled={busy || !runId}
                  onClick={() => onToggleCreditCollectionAssignment(charge, !charge.assigned_collection_run_id)}
                  type="button"
                >{charge.assigned_collection_run_id ? 'ถอนจากรอบเก็บ' : 'มอบหมายให้เก็บ'}</button> : null}
              </article>)}
            </div>
          </>
        )}
      </section> : null}

      {activeView === 'aging' ? <section className="financial-ops__section credit-ar__aging-report">
        <SectionTitle icon={ChartBar} title="รายงานอายุลูกหนี้" description="จัดกลุ่มจากวันครบกำหนดของเอกสารเครดิตที่ยังมียอดคงค้าง" />
        <div className="credit-ar__aging-summary">
          {agingBuckets.map((bucket) => <article className={`credit-ar__aging-summary-card credit-ar__aging-summary-card--${bucket.tone}`} key={bucket.label}><span>{bucket.label}</span><strong>{money.format(bucket.amount)}</strong><small>{totalOutstanding > 0 ? `${((bucket.amount / totalOutstanding) * 100).toFixed(0)}% ของยอดค้าง` : 'ไม่มีรายการ'}</small></article>)}
        </div>
        <div className="credit-ar__report-heading"><span><WarningCircle aria-hidden="true" size={18} /><h2>ยอดค้างชำระเกินกำหนด</h2></span><b>{money.format(totalOverdue)}</b></div>
        {overdueCharges.length === 0 ? <p className="financial-ops__empty">ไม่มีรายการค้างชำระเกินกำหนด</p> : <div className="financial-ops__receivable-charges">
          {overdueCharges.map((charge) => <article key={charge.charge_id}>
            <span><strong>{charge.shopCode} · {charge.shopName}</strong><small>{charge.charge_number} · ครบกำหนด {charge.due_date} · เกินกำหนด {charge.days_overdue} วัน</small></span>
            <b>{money.format(charge.outstanding_amount)}</b>
            <button disabled={busy || !runId} onClick={() => onToggleCreditCollectionAssignment(charge, !charge.assigned_collection_run_id)} type="button">{charge.assigned_collection_run_id ? 'ถอนจากรอบเก็บ' : 'มอบหมายให้เก็บ'}</button>
          </article>)}
        </div>}
      </section> : null}
    </section>
  );
}

export function PaymentHistorySection({
  paymentHistory,
  historyDate,
  serviceDate,
  isManager,
  busy,
  onHistoryDateChange,
  onOpenReceipt,
  onPrintReceipt,
  onVoidPayment,
}: {
  paymentHistory: PaymentHistoryItem[];
  historyDate: string;
  serviceDate: string;
  isManager: boolean;
  busy: boolean;
  onHistoryDateChange: (serviceDate: string) => void;
  onOpenReceipt: (payment: PaymentHistoryItem, trigger: HTMLButtonElement) => void;
  onPrintReceipt: (payment: PaymentHistoryItem) => void;
  onVoidPayment: (payment: PaymentHistoryItem) => void;
}) {
  return (
    <section className="financial-ops__section">
      <SectionTitle
        icon={Coins}
        title="ประวัติรับเงิน"
        description="เลือกวันที่เพื่อดูรายการย้อนหลังและพิมพ์ใบเสร็จซ้ำ"
      />
      <div className="financial-ops__history-date">
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
      {paymentHistory.length === 0 ? <p className="financial-ops__empty">ไม่มีรายการรับเงินในวันที่เลือก</p> : (
        <div className="financial-ops__list">
          {paymentHistory.map((payment) => (
            <article className="financial-ops__history-item" key={payment.id}>
              <button
                aria-label={`ดูบิล ${payment.receipt_number} ของ ${payment.shops?.name ?? 'ร้านค้า'}`}
                className="financial-ops__history-summary"
                onClick={(event) => onOpenReceipt(payment, event.currentTarget)}
                type="button"
              >
                <span>
                  <strong>{payment.shops?.code ?? '—'} · {payment.shops?.name ?? 'ไม่พบร้าน'}</strong>
                  <small>{payment.receipt_number} · {paymentMethodLabel(payment.payment_method)} · {receiptDateTime.format(new Date(payment.recorded_at))}{payment.status === 'voided' ? ` · ยกเลิก: ${payment.void_reason ?? '—'}` : ''}</small>
                </span>
                <span className="financial-ops__history-open-label">ดูบิล <CaretRight aria-hidden="true" size={19} /></span>
              </button>
              <span className="financial-ops__history-side">
                <b>{money.format(payment.allocated_amount)}</b>
                {payment.status === 'active' ? (
                  <span className="financial-ops__history-actions">
                    <button disabled={busy} onClick={() => onPrintReceipt(payment)} type="button"><Printer aria-hidden="true" size={16} />พิมพ์ซ้ำ</button>
                    {isManager ? <button disabled={busy} onClick={() => onVoidPayment(payment)} type="button">ยกเลิกรายการ</button> : null}
                  </span>
                ) : null}
              </span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
