import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, DownloadSimple, Funnel, MagnifyingGlass, WarningCircle, X } from '@phosphor-icons/react';
import { DeliveryCorrectionDialog } from '../delivery-corrections/DeliveryCorrectionDialog';
import { supabase } from '../../lib/supabase';
import { getErrorMessage } from '../../lib/errorMessage';
import { subscribeToDataChange } from '../../lib/dataChange';
import { toBangkokDateString } from '../../lib/serviceDate';
import { exportAccountingTransactions } from './exportAccounting';
import type {
  AccountingFilters,
  AccountingReconciliation,
  AccountingReviewResponse,
  AccountingSort,
  AccountingTab,
  AccountingTransaction,
  AccountingTransactionsResponse,
} from './types';
import type { AppRole } from '../../types/app';

const PAGE_SIZE = 100;
const EXPORT_PAGE_SIZE = 50_000;
const money = new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' });
const number = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 });
const typeLabels: Record<string, string> = {
  FACTORY: 'รับจากโรงงาน', WITHDRAW: 'เบิกออก', TRANSFER: 'โอน', SALE: 'ขายสด', INV: 'ใบส่งของ',
  REC: 'รับเงิน', ADJ: 'ปรับปรุง', REF: 'คืนเงิน', DAMAGE: 'เสียหาย', RETURN: 'คืนรถ/โรงงาน',
};

function shiftDate(date: string, days: number) {
  const next = new Date(`${date}T12:00:00+07:00`);
  next.setDate(next.getDate() + days);
  return toBangkokDateString(next);
}

function emptyTransactions(): AccountingTransactionsResponse {
  return { rows: [], total_count: 0, facets: { ice_types: [], shops: [], employees: [], types: [] } };
}

function SortButton({ column, label, sort, onChange }: { column: string; label: string; sort: AccountingSort; onChange: (sort: AccountingSort) => void }) {
  const active = sort.key === column;
  return <button className="accounting-table__sort" onClick={() => onChange({ key: column, direction: active && sort.direction === 'asc' ? 'desc' : 'asc' })} type="button">
    {label}<span aria-hidden="true">{active ? sort.direction === 'asc' ? ' ↑' : ' ↓' : ''}</span>
  </button>;
}

export function AccountingPage({ userRole = 'round_lead', demoMode = false }: { userRole?: AppRole; demoMode?: boolean }) {
  const today = toBangkokDateString();
  const [tab, setTab] = useState<AccountingTab>('reconciliation');
  const [serviceDate, setServiceDate] = useState(today);
  const [fromDate, setFromDate] = useState(shiftDate(today, -6));
  const [toDate, setToDate] = useState(today);
  const [filters, setFilters] = useState<AccountingFilters>({});
  const [sort, setSort] = useState<AccountingSort>({ key: 'occurred_at', direction: 'desc' });
  const [page, setPage] = useState(0);
  const [reconciliation, setReconciliation] = useState<AccountingReconciliation | null>(null);
  const [transactions, setTransactions] = useState<AccountingTransactionsResponse>(emptyTransactions);
  const [reviews, setReviews] = useState<AccountingReviewResponse>({ rows: [], total_count: 0 });
  const [selected, setSelected] = useState<AccountingTransaction | null>(null);
  const [receiptSnapshot, setReceiptSnapshot] = useState<Record<string, unknown> | null>(null);
  const [correctionTargets, setCorrectionTargets] = useState<Array<{ charge_id: string; charge_number: string; delivery_event_id: string }>>([]);
  const [correctionEventId, setCorrectionEventId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const drawerRequestId = useRef(0);

  const validateRange = useCallback(() => {
    const days = Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000);
    if (days < 0) throw new Error('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด');
    if (days > 30) throw new Error('ดูข้อมูลได้สูงสุด 31 วันต่อครั้ง');
  }, [fromDate, toDate]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (demoMode) {
        setReconciliation({ service_date: serviceDate, aggregate: [], holders: [], financial: { effective_sales: 0, allocated_to_sales: 0, outstanding_collectible: 0, outstanding_credit: 0, cash_received: 0, cash_refunded: 0, net_cash: 0, pending_refunds: 0 } });
        setTransactions(emptyTransactions());
        setReviews({ rows: [], total_count: 0 });
        return;
      }
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      if (tab === 'reconciliation') {
        const response = await supabase.rpc('get_accounting_reconciliation', { p_service_date: serviceDate });
        if (response.error) throw response.error;
        setReconciliation(response.data as AccountingReconciliation);
      } else {
        validateRange();
        if (tab === 'transactions') {
          const response = await supabase.rpc('get_accounting_transactions', {
            p_from_date: fromDate, p_to_date: toDate, p_filters: filters, p_sort: sort,
            p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE,
          });
          if (response.error) throw response.error;
          setTransactions(response.data as unknown as AccountingTransactionsResponse);
        } else {
          const response = await supabase.rpc('get_accounting_review_queue', {
            p_from_date: fromDate, p_to_date: toDate, p_filters: filters,
            p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE,
          });
          if (response.error) throw response.error;
          setReviews(response.data as unknown as AccountingReviewResponse);
        }
      }
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [demoMode, filters, fromDate, page, serviceDate, sort, tab, toDate, validateRange]);

  useEffect(() => { void load(); }, [load, refreshToken]);
  useEffect(() => subscribeToDataChange(['accounting', 'payment', 'receivable', 'refund', 'stock', 'pos'], () => setRefreshToken((value) => value + 1)), []);

  const openRow = async (row: AccountingTransaction) => {
    const requestId = drawerRequestId.current + 1;
    drawerRequestId.current = requestId;
    setSelected(row);
    setReceiptSnapshot(null);
    setCorrectionTargets([]);
    if (row.type !== 'REC' || !row.payment_id || demoMode || !supabase) return;
    const [snapshot, targets] = await Promise.allSettled([
      supabase.rpc('get_payment_receipt_snapshot', { p_payment_id: row.payment_id }),
      supabase.rpc('get_payment_correction_targets', { p_payment_id: row.payment_id }),
    ]);
    if (drawerRequestId.current !== requestId) return;
    if (snapshot.status === 'fulfilled' && !snapshot.value.error) setReceiptSnapshot(snapshot.value.data as Record<string, unknown>);
    if (targets.status === 'fulfilled' && !targets.value.error) setCorrectionTargets((targets.value.data ?? []) as typeof correctionTargets);
  };

  const exportRows = async () => {
    setExporting(true);
    setError(null);
    try {
      validateRange();
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const rows: AccountingTransaction[] = [];
      let totalCount = 0;
      do {
        const response = await supabase.rpc('get_accounting_transactions', {
          p_from_date: fromDate, p_to_date: toDate, p_filters: filters, p_sort: sort,
          p_limit: EXPORT_PAGE_SIZE, p_offset: rows.length,
        });
        if (response.error) throw response.error;
        const pageData = response.data as unknown as AccountingTransactionsResponse;
        totalCount = pageData.total_count;
        if (pageData.rows.length === 0 && rows.length < totalCount) {
          throw new Error('ส่งออกไม่สำเร็จเพราะโหลดข้อมูลได้ไม่ครบ');
        }
        rows.push(...pageData.rows);
      } while (rows.length < totalCount);
      await exportAccountingTransactions(rows, fromDate, toDate);
    } catch (exportError) {
      setError(getErrorMessage(exportError));
    } finally {
      setExporting(false);
    }
  };

  const totalCount = tab === 'transactions' ? transactions.total_count : reviews.total_count;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const updateFilter = (change: Partial<AccountingFilters>) => { setFilters((current) => ({ ...current, ...change })); setPage(0); };

  return <section className="accounting-page">
    <header className="financial-ops__header accounting-page__header">
      <div><p className="eyebrow">การเงินและบัญชี</p><h1>บัญชี / รายการธุรกรรม</h1><span>ข้อมูลจากเอกสารและเหตุการณ์จริง · แก้ไขต้นทางเท่านั้น</span></div>
      <button disabled={loading} onClick={() => setRefreshToken((value) => value + 1)} type="button"><ArrowClockwise size={18} />รีเฟรช</button>
    </header>
    <nav aria-label="แท็บบัญชี" className="accounting-tabs">
      {([['reconciliation', 'สรุปเทียบยอด'], ['transactions', 'รายการแบบ Excel'], ['review', 'รายการต้องตรวจสอบ']] as const).map(([value, label]) => <button aria-current={tab === value ? 'page' : undefined} key={value} onClick={() => { setTab(value); setPage(0); }} type="button">{label}{value === 'review' && reviews.total_count ? <span>{reviews.total_count}</span> : null}</button>)}
    </nav>
    {tab === 'reconciliation' ? <ReconciliationPanel data={reconciliation} serviceDate={serviceDate} setServiceDate={setServiceDate} /> : <>
      <div className="accounting-filters">
        <label>จาก<input max={toDate} onChange={(event) => { setFromDate(event.target.value); setPage(0); }} type="date" value={fromDate} /></label>
        <label>ถึง<input max={today} min={fromDate} onChange={(event) => { setToDate(event.target.value); setPage(0); }} type="date" value={toDate} /></label>
        <label className="accounting-filters__search"><MagnifyingGlass size={17} /><span className="sr-only">ค้นเอกสาร</span><input onChange={(event) => updateFilter({ document: event.target.value })} placeholder="เลขเอกสาร / อ้างอิง" value={filters.document ?? ''} /></label>
        {tab === 'transactions' ? <>
          <select aria-label="ชนิดน้ำแข็ง" onChange={(event) => updateFilter({ ice_type_id: event.target.value || undefined })} value={filters.ice_type_id ?? ''}><option value="">ทุกชนิดน้ำแข็ง</option>{transactions.facets.ice_types.map((item) => <option key={item.value} value={item.value}>{item.label} ({item.count})</option>)}</select>
          <select aria-label="ร้าน" onChange={(event) => updateFilter({ shop_id: event.target.value || undefined })} value={filters.shop_id ?? ''}><option value="">ทุกร้าน</option>{transactions.facets.shops.map((item) => <option key={item.value} value={item.value}>{item.label} ({item.count})</option>)}</select>
          <select aria-label="พนักงาน" onChange={(event) => updateFilter({ employee_id: event.target.value || undefined })} value={filters.employee_id ?? ''}><option value="">ทุกพนักงาน</option>{transactions.facets.employees.map((item) => <option key={item.value} value={item.value}>{item.label} ({item.count})</option>)}</select>
          <select aria-label="ประเภทรายการ" onChange={(event) => updateFilter({ types: event.target.value ? [event.target.value as AccountingTransaction['type']] : undefined })} value={filters.types?.[0] ?? ''}><option value="">ทุกประเภท</option>{transactions.facets.types.map((item) => <option key={item.value} value={item.value}>{typeLabels[item.value] ?? item.label} ({item.count})</option>)}</select>
        </> : null}
        <label className="accounting-filters__checkbox"><input checked={Boolean(filters.issues_only)} onChange={(event) => updateFilter({ issues_only: event.target.checked || undefined })} type="checkbox" /><Funnel size={16} />เฉพาะมีประเด็น</label>
        {tab === 'transactions' ? <button disabled={exporting || loading} onClick={() => void exportRows()} type="button"><DownloadSimple size={18} />{exporting ? 'กำลังส่งออก...' : 'ส่งออก .xlsx'}</button> : null}
      </div>
      {tab === 'transactions' ? <TransactionsTable onOpen={(row) => void openRow(row)} rows={transactions.rows} setSort={setSort} sort={sort} /> : <ReviewQueue rows={reviews.rows} />}
      <div className="accounting-pagination"><span>ทั้งหมด {totalCount.toLocaleString('th-TH')} รายการ</span><button disabled={page === 0} onClick={() => setPage((value) => value - 1)} type="button">ก่อนหน้า</button><strong>{page + 1} / {totalPages}</strong><button disabled={page + 1 >= totalPages} onClick={() => setPage((value) => value + 1)} type="button">ถัดไป</button></div>
    </>}
    {loading ? <p className="accounting-page__loading">กำลังโหลดข้อมูล...</p> : null}
    {error ? <p className="credit-ar__action-error" role="alert"><WarningCircle size={18} />{error}</p> : null}
    {selected ? <TransactionDrawer correctionTargets={correctionTargets} onClose={() => {
      drawerRequestId.current += 1;
      setSelected(null);
      setReceiptSnapshot(null);
      setCorrectionTargets([]);
    }} onCorrect={setCorrectionEventId} receiptSnapshot={receiptSnapshot} row={selected} /> : null}
    {correctionEventId ? <DeliveryCorrectionDialog eventId={correctionEventId} onClose={() => setCorrectionEventId(null)} onSuccess={() => undefined} userRole={userRole} /> : null}
  </section>;
}

function ReconciliationPanel({ data, serviceDate, setServiceDate }: { data: AccountingReconciliation | null; serviceDate: string; setServiceDate: (date: string) => void }) {
  const cards = data?.financial;
  return <div className="accounting-reconciliation">
    <label className="accounting-reconciliation__date">วันที่ธุรกรรม<input onChange={(event) => setServiceDate(event.target.value)} type="date" value={serviceDate} /></label>
    <div className="accounting-financial-cards">
      {[['ยอดขาย effective', cards?.effective_sales], ['จัดสรรเข้าบิลวันนี้', cards?.allocated_to_sales], ['ควรเก็บแล้ว', cards?.outstanding_collectible], ['ลูกหนี้เครดิต', cards?.outstanding_credit], ['รับเงินจริง', cards?.cash_received], ['คืนเงินจริง', cards?.cash_refunded], ['เงินสุทธิ', cards?.net_cash], ['ยอดรอคืน', cards?.pending_refunds]].map(([label, value]) => <article key={label}><span>{label}</span><strong>{money.format(Number(value ?? 0))}</strong></article>)}
    </div>
    <ReconciliationTable heading="สต๊อกรวมประจำวัน" rows={data?.aggregate ?? []} />
    <h2>รถใหญ่และจุดถือครอง</h2>
    {(data?.holders ?? []).map((holder) => <ReconciliationTable heading={`${holder.location_name}${holder.employee_name ? ` · ${holder.employee_name}` : ''}`} key={holder.location_id} rows={holder.items} />)}
  </div>;
}

function ReconciliationTable({ heading, rows }: { heading: string; rows: AccountingReconciliation['aggregate'] }) {
  return <article className="accounting-reconciliation__table"><h3>{heading}</h3><div className="accounting-table-wrap"><table><thead><tr><th>ชนิด</th><th>โรงงานเข้า</th><th>ขาย</th><th>เสียหาย</th><th>คืนโรงงาน</th><th>ควรเหลือ</th><th>นับจริง</th><th>ต่าง</th><th>สถานะ</th></tr></thead><tbody>{rows.length ? rows.map((row) => <tr className={row.variance ? 'accounting-row--issue' : ''} key={row.ice_type_id}><th>{row.ice_type_name}</th><td>{number.format(row.factory_in)}</td><td>{number.format(row.sold)}</td><td>{number.format(row.damaged)}</td><td>{number.format(row.returned_to_factory)}</td><td>{number.format(row.expected)}</td><td>{row.actual == null ? '—' : number.format(row.actual)}</td><td>{row.variance == null ? '—' : number.format(row.variance)}</td><td>{row.count_status !== 'complete' ? 'ยังนับไม่ครบ' : row.variance ? 'ต้องตรวจสอบ' : 'ตรงยอด'}</td></tr>) : <tr><td colSpan={9}>ยังไม่มีข้อมูล</td></tr>}</tbody></table></div></article>;
}

function TransactionsTable({ rows, sort, setSort, onOpen }: { rows: AccountingTransaction[]; sort: AccountingSort; setSort: (sort: AccountingSort) => void; onOpen: (row: AccountingTransaction) => void }) {
  const columns = [['occurred_at', 'วัน/เวลา'], ['document_number', 'เอกสาร'], ['type', 'ประเภท'], ['shop_name', 'ร้าน'], ['holder_name', 'จุดถือครอง'], ['employee_name', 'พนักงาน'], ['ice_type_name', 'ชนิดน้ำแข็ง'], ['quantity_in', 'เข้า'], ['quantity_out', 'ออก'], ['sales_amount', 'ยอดขาย'], ['cash_in', 'เงินเข้า'], ['cash_out', 'เงินออก'], ['receivable_delta', 'ลูกหนี้'], ['status', 'สถานะ'], ['can_correct', 'ดำเนินการ']] as const;
  return <div className="accounting-table-wrap accounting-table-wrap--ledger"><table className="accounting-table"><thead><tr>{columns.map(([key, label]) => <th key={key}><SortButton column={key} label={label} onChange={setSort} sort={sort} /></th>)}</tr></thead><tbody>{rows.length ? rows.map((row) => <tr className={row.issue_code ? 'accounting-row--issue' : `accounting-row--${row.type.toLowerCase()}`} key={`${row.type}-${row.source_id}-${row.ice_type_id ?? ''}`} onClick={() => onOpen(row)} tabIndex={0}><td>{new Date(row.occurred_at).toLocaleString('th-TH')}</td><td><button className="accounting-link" onClick={(event) => { event.stopPropagation(); onOpen(row); }} type="button">{row.document_number}</button></td><td><span className={`accounting-type accounting-type--${row.type.toLowerCase()}`}>{row.type} · {typeLabels[row.type]}</span></td><td>{row.shop_name ?? '—'}</td><td>{row.holder_name ?? '—'}</td><td>{row.employee_name ?? '—'}</td><td>{row.ice_type_name ?? '—'}</td><td>{row.quantity_in || '—'}</td><td>{row.quantity_out || '—'}</td><td>{row.sales_amount ? money.format(row.sales_amount) : '—'}</td><td>{row.cash_in ? money.format(row.cash_in) : '—'}</td><td>{row.cash_out ? money.format(row.cash_out) : '—'}</td><td>{row.receivable_delta ? money.format(row.receivable_delta) : '—'}</td><td>{row.issue_label ?? row.status}</td><td>{row.can_correct ? 'แก้ไขได้' : 'ดูเท่านั้น'}</td></tr>) : <tr><td colSpan={15}>ไม่พบรายการที่ตรงตัวกรอง</td></tr>}</tbody></table></div>;
}

function ReviewQueue({ rows }: { rows: AccountingReviewResponse['rows'] }) {
  return <div className="accounting-review-list">{rows.length ? rows.map((item) => <article key={item.issue_id}><WarningCircle size={22} weight="fill" /><div><span>{item.issue_type} · {item.service_date}</span><h3>{item.title}</h3><p>{item.description}</p><small>{[item.document_number, item.shop_name].filter(Boolean).join(' · ')}</small></div><strong>{item.severity === 'critical' ? 'เร่งด่วน' : 'ตรวจสอบ'}</strong></article>) : <p className="financial-ops__empty">ไม่มีรายการต้องตรวจสอบในช่วงนี้</p>}</div>;
}

function TransactionDrawer({ row, receiptSnapshot, correctionTargets, onClose, onCorrect }: { row: AccountingTransaction; receiptSnapshot: Record<string, unknown> | null; correctionTargets: Array<{ charge_id: string; charge_number: string; delivery_event_id: string }>; onClose: () => void; onCorrect: (eventId: string) => void }) {
  return <div className="accounting-drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><aside aria-label={`รายละเอียด ${row.document_number}`} className="accounting-drawer"><header><div><p className="eyebrow">{row.type} · {typeLabels[row.type]}</p><h2>{row.document_number}</h2></div><button aria-label="ปิด" onClick={onClose} type="button"><X size={20} /></button></header><dl><div><dt>สถานะ</dt><dd>{row.issue_label ?? row.status}</dd></div><div><dt>ร้าน</dt><dd>{row.shop_name ?? '—'}</dd></div><div><dt>จุดถือครอง</dt><dd>{row.holder_name ?? '—'}</dd></div><div><dt>ผู้บันทึก</dt><dd>{row.employee_name ?? '—'}</dd></div><div><dt>Payment</dt><dd>{row.payment_id ?? '—'}</dd></div><div><dt>หมายเหตุ</dt><dd>{row.note ?? '—'}</dd></div></dl>{receiptSnapshot ? <section><h3>สำเนาใบเสร็จเดิม</h3><pre>{JSON.stringify(receiptSnapshot, null, 2)}</pre></section> : null}<footer>{row.type === 'INV' && row.can_correct && row.delivery_event_id ? <button className="primary-button" onClick={() => onCorrect(row.delivery_event_id!)} type="button">แก้ไขรายการส่ง</button> : null}{row.type === 'REC' ? correctionTargets.map((target) => <button className="primary-button" key={target.charge_id} onClick={() => onCorrect(target.delivery_event_id)} type="button">แก้ไข {target.charge_number}</button>) : null}</footer></aside></div>;
}
