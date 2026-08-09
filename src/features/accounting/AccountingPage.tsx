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
  AccountingShopInvoiceDetailEntry,
  AccountingShopSummaryResponse,
  AccountingShopSummaryRow,
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
const accountingDate = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok' });
const typeLabels: Record<string, string> = {
  FACTORY: 'รับจากโรงงาน', WITHDRAW: 'เบิกออก', TRANSFER: 'โอน', SALE: 'ขายสด', INV: 'ใบส่งของ',
  REC: 'รับเงิน', ADJ: 'ปรับปรุง', REF: 'คืนเงิน', DAMAGE: 'เสียหาย', RETURN: 'คืนรถ/โรงงาน',
};
const paymentTermLabels = { immediate: 'จ่ายทันที', end_of_day: 'เก็บท้ายวัน', credit: 'เครดิต', mixed: 'หลายเงื่อนไข' } as const;
const paymentStatusLabels = { paid: 'ชำระครบ', outstanding: 'รอชำระ', overdue: 'เกินกำหนด' } as const;
const invoicePaymentStatusLabels = { paid: 'ชำระแล้ว', partial: 'ชำระบางส่วน', unpaid: 'ค้างชำระ', voided: 'ยกเลิกแล้ว' } as const;
const paymentMethodLabels = { cash: 'เงินสด', bank_transfer: 'โอนธนาคาร', qr: 'QR' } as const;

function shiftDate(date: string, days: number) {
  const next = new Date(`${date}T12:00:00+07:00`);
  next.setDate(next.getDate() + days);
  return toBangkokDateString(next);
}

function emptyTransactions(): AccountingTransactionsResponse {
  return { rows: [], total_count: 0, facets: { ice_types: [], shops: [], employees: [], types: [] } };
}

function emptyShopSummary(): AccountingShopSummaryResponse {
  return {
    rows: [],
    total_count: 0,
    totals: { sales_amount: 0, paid_amount: 0, outstanding_amount: 0, overdue_amount: 0, outstanding_shop_count: 0, cash_received_in_period: 0 },
    facets: { shops: [], buildings: [], zones: [] },
  };
}

function lastPageIndex(totalCount: number) {
  return Math.max(0, Math.ceil(totalCount / PAGE_SIZE) - 1);
}

function SortButton({ column, label, sort, onChange }: { column: string; label: string; sort: AccountingSort; onChange: (sort: AccountingSort) => void }) {
  const active = sort.key === column;
  return <button className="accounting-table__sort" onClick={() => onChange({ key: column, direction: active && sort.direction === 'asc' ? 'desc' : 'asc' })} type="button">
    {label}<span aria-hidden="true">{active ? sort.direction === 'asc' ? ' ↑' : ' ↓' : ''}</span>
  </button>;
}

export function AccountingPage({ userRole = 'round_lead', demoMode = false }: { userRole?: AppRole; demoMode?: boolean }) {
  const today = toBangkokDateString();
  const [tab, setTab] = useState<AccountingTab>('shops');
  const [serviceDate, setServiceDate] = useState(today);
  const [fromDate, setFromDate] = useState(shiftDate(today, -6));
  const [toDate, setToDate] = useState(today);
  const [filters, setFilters] = useState<AccountingFilters>({});
  const [shopFilters, setShopFilters] = useState<AccountingFilters>({});
  const [sort, setSort] = useState<AccountingSort>({ key: 'occurred_at', direction: 'desc' });
  const [page, setPage] = useState(0);
  const [reconciliation, setReconciliation] = useState<AccountingReconciliation | null>(null);
  const [shopSummary, setShopSummary] = useState<AccountingShopSummaryResponse>(emptyShopSummary);
  const [transactions, setTransactions] = useState<AccountingTransactionsResponse>(emptyTransactions);
  const [reviews, setReviews] = useState<AccountingReviewResponse>({ rows: [], total_count: 0 });
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [selectedShop, setSelectedShop] = useState<AccountingShopSummaryRow | null>(null);
  const [shopHistory, setShopHistory] = useState<AccountingShopInvoiceDetailEntry[]>([]);
  const [shopHistoryLoading, setShopHistoryLoading] = useState(false);
  const [shopHistoryError, setShopHistoryError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AccountingTransaction | null>(null);
  const [receiptSnapshot, setReceiptSnapshot] = useState<Record<string, unknown> | null>(null);
  const [correctionTargets, setCorrectionTargets] = useState<Array<{ charge_id: string; charge_number: string; delivery_event_id: string }>>([]);
  const [correctionEventId, setCorrectionEventId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const loadRequestId = useRef(0);
  const reviewCountRequestId = useRef(0);
  const drawerRequestId = useRef(0);
  const shopHistoryRequestId = useRef(0);

  const validateRange = useCallback(() => {
    const days = Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000);
    if (days < 0) throw new Error('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด');
    if (days > 30) throw new Error('ดูข้อมูลได้สูงสุด 31 วันต่อครั้ง');
  }, [fromDate, toDate]);

  const load = useCallback(async () => {
    const requestId = loadRequestId.current + 1;
    loadRequestId.current = requestId;
    setLoading(true);
    setError(null);
    if (tab === 'shops') {
      setShopSummary((current) => ({ ...emptyShopSummary(), facets: current.facets }));
      shopHistoryRequestId.current += 1;
      setSelectedShop(null);
      setShopHistory([]);
      setShopHistoryError(null);
      setShopHistoryLoading(false);
    } else if (tab === 'reconciliation') {
      setReconciliation(null);
    }
    try {
      if (demoMode) {
        if (loadRequestId.current !== requestId) return;
        setReconciliation({ service_date: serviceDate, aggregate: [], holders: [], financial: { effective_sales: 0, allocated_to_sales: 0, outstanding_collectible: 0, outstanding_credit: 0, cash_received: 0, cash_refunded: 0, net_cash: 0, pending_refunds: 0 } });
        setShopSummary(emptyShopSummary());
        setTransactions(emptyTransactions());
        setReviews({ rows: [], total_count: 0 });
        return;
      }
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      if (tab === 'shops') {
        validateRange();
        const summaryResponse = await supabase.rpc('get_accounting_shop_summary', {
          p_from_date: fromDate, p_to_date: toDate, p_filters: shopFilters,
          p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE,
        });
        if (loadRequestId.current !== requestId) return;
        if (summaryResponse.error) throw summaryResponse.error;
        const summaryData = summaryResponse.data as unknown as AccountingShopSummaryResponse;
        const lastPage = lastPageIndex(summaryData.total_count);
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setShopSummary(summaryData);
      } else if (tab === 'reconciliation') {
        const response = await supabase.rpc('get_accounting_reconciliation', { p_service_date: serviceDate });
        if (loadRequestId.current !== requestId) return;
        if (response.error) throw response.error;
        setReconciliation(response.data as AccountingReconciliation);
      } else {
        validateRange();
        if (tab === 'transactions') {
          const response = await supabase.rpc('get_accounting_transactions', {
            p_from_date: fromDate, p_to_date: toDate, p_filters: filters, p_sort: sort,
            p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE,
          });
          if (loadRequestId.current !== requestId) return;
          if (response.error) throw response.error;
          const transactionData = response.data as unknown as AccountingTransactionsResponse;
          const lastPage = lastPageIndex(transactionData.total_count);
          if (page > lastPage) {
            setPage(lastPage);
            return;
          }
          setTransactions(transactionData);
        } else {
          const response = await supabase.rpc('get_accounting_review_queue', {
            p_from_date: fromDate, p_to_date: toDate, p_filters: filters,
            p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE,
          });
          if (loadRequestId.current !== requestId) return;
          if (response.error) throw response.error;
          const reviewData = response.data as unknown as AccountingReviewResponse;
          const lastPage = lastPageIndex(reviewData.total_count);
          if (page > lastPage) {
            setPage(lastPage);
            return;
          }
          setReviews(reviewData);
          setReviewCount(reviewData.total_count);
        }
      }
    } catch (loadError) {
      if (loadRequestId.current === requestId) setError(getErrorMessage(loadError));
    } finally {
      if (loadRequestId.current === requestId) setLoading(false);
    }
  }, [demoMode, filters, fromDate, page, serviceDate, shopFilters, sort, tab, toDate, validateRange]);

  const loadReviewCount = useCallback(async () => {
    const requestId = reviewCountRequestId.current + 1;
    reviewCountRequestId.current = requestId;
    if (demoMode) {
      setReviewCount(0);
      return;
    }
    setReviewCount(null);
    if (!supabase) return;
    try {
      validateRange();
      const response = await supabase.rpc('get_accounting_review_queue', {
        p_from_date: fromDate, p_to_date: toDate, p_filters: {}, p_limit: 1, p_offset: 0,
      });
      if (reviewCountRequestId.current !== requestId || response.error) return;
      setReviewCount((response.data as unknown as AccountingReviewResponse).total_count);
    } catch {
      // The review badge is supplemental; shop-summary errors are handled by load().
    }
  }, [demoMode, fromDate, toDate, validateRange]);

  useEffect(() => { void load(); }, [load, refreshToken]);
  useEffect(() => {
    if (tab === 'review') {
      reviewCountRequestId.current += 1;
      return;
    }
    void loadReviewCount();
    return () => { reviewCountRequestId.current += 1; };
  }, [loadReviewCount, refreshToken, tab]);
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

  const totalCount = tab === 'shops' ? shopSummary.total_count : tab === 'transactions' ? transactions.total_count : reviews.total_count;
  const updateFilter = (change: Partial<AccountingFilters>) => { setFilters((current) => ({ ...current, ...change })); setPage(0); };
  const updateShopFilter = (change: Partial<AccountingFilters>) => { setShopFilters((current) => ({ ...current, ...change })); setPage(0); };
  const openShopInvoices = async (shop: AccountingShopSummaryRow) => {
    const requestId = shopHistoryRequestId.current + 1;
    shopHistoryRequestId.current = requestId;
    setSelectedShop(shop);
    setShopHistory([]);
    setShopHistoryError(null);
    setShopHistoryLoading(true);
    try {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const entries: AccountingShopInvoiceDetailEntry[] = [];
      let offset = 0;
      while (true) {
        const response = await supabase.rpc('get_accounting_shop_invoice_detail', {
          p_shop_id: shop.shop_id,
          p_from_date: fromDate,
          p_to_date: toDate,
          p_filters: shopFilters,
          p_limit: PAGE_SIZE,
          p_offset: offset,
        });
        if (shopHistoryRequestId.current !== requestId) return;
        if (response.error) throw response.error;
        const nextEntries = (response.data ?? []) as AccountingShopInvoiceDetailEntry[];
        entries.push(...nextEntries);
        if (nextEntries.length < PAGE_SIZE) break;
        offset += nextEntries.length;
      }
      if (shopHistoryRequestId.current === requestId) {
        setShopHistory(entries);
      }
    } catch (historyError) {
      if (shopHistoryRequestId.current === requestId) setShopHistoryError(getErrorMessage(historyError));
    } finally {
      if (shopHistoryRequestId.current === requestId) setShopHistoryLoading(false);
    }
  };
  const closeShopInvoices = () => {
    shopHistoryRequestId.current += 1;
    setSelectedShop(null);
    setShopHistory([]);
    setShopHistoryError(null);
    setShopHistoryLoading(false);
  };

  return <section className="accounting-page">
    <header className="financial-ops__header accounting-page__header">
      <div><p className="eyebrow">การเงินและบัญชี</p><h1>บัญชี / รายการธุรกรรม</h1><span>ข้อมูลจากเอกสารและเหตุการณ์จริง · แก้ไขต้นทางเท่านั้น</span></div>
      <button disabled={loading} onClick={() => setRefreshToken((value) => value + 1)} type="button"><ArrowClockwise size={18} />รีเฟรช</button>
    </header>
    <nav aria-label="แท็บบัญชี" className="accounting-tabs">
      {([['shops', 'สรุปรายร้าน'], ['reconciliation', 'สรุปเทียบยอด'], ['transactions', 'รายการแบบ Excel'], ['review', 'รายการต้องตรวจสอบ']] as const).map(([value, label]) => <button aria-current={tab === value ? 'page' : undefined} key={value} onClick={() => { setTab(value); setPage(0); }} type="button">{label}{value === 'review' && reviewCount ? <span>{reviewCount}</span> : null}</button>)}
    </nav>
    {tab === 'shops' ? <>
      <ShopSummaryPanel
        data={shopSummary}
        filters={shopFilters}
        fromDate={fromDate}
        onOpenShop={(shop) => void openShopInvoices(shop)}
        reviewCount={reviewCount}
        setFromDate={(date) => { setFromDate(date); setPage(0); }}
        setToDate={(date) => { setToDate(date); setPage(0); }}
        toDate={toDate}
        today={today}
        updateFilter={updateShopFilter}
      />
      <AccountingPagination page={page} pageSize={PAGE_SIZE} setPage={setPage} totalCount={totalCount} />
      {selectedShop ? <ShopInvoiceDetail
        entries={shopHistory}
        error={shopHistoryError}
        fromDate={fromDate}
        loading={shopHistoryLoading}
        onClose={closeShopInvoices}
        shop={selectedShop}
        toDate={toDate}
      /> : null}
    </> : tab === 'reconciliation' ? <ReconciliationPanel data={reconciliation} serviceDate={serviceDate} setServiceDate={setServiceDate} /> : <>
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
      <AccountingPagination page={page} pageSize={PAGE_SIZE} setPage={setPage} totalCount={totalCount} />
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

function ShopSummaryPanel({ data, filters, fromDate, onOpenShop, reviewCount, setFromDate, setToDate, toDate, today, updateFilter }: {
  data: AccountingShopSummaryResponse;
  filters: AccountingFilters;
  fromDate: string;
  onOpenShop: (shop: AccountingShopSummaryRow) => void;
  reviewCount: number | null;
  setFromDate: (date: string) => void;
  setToDate: (date: string) => void;
  toDate: string;
  today: string;
  updateFilter: (change: Partial<AccountingFilters>) => void;
}) {
  const cards: Array<[string, number | null, 'money' | 'count', string?]> = [
    ['ยอดขายช่วงนี้', data.totals.sales_amount, 'money'],
    ['รับแล้วของยอดขายช่วงนี้', data.totals.paid_amount, 'money', 'นับเงินที่จัดสรรเข้าบิลซึ่งขายในช่วงวันที่เลือก'],
    ['ค้างของยอดขายช่วงนี้', data.totals.outstanding_amount, 'money'],
    ['เกินกำหนด', data.totals.overdue_amount, 'money'],
    ['เงินรับจริงช่วงนี้', data.totals.cash_received_in_period, 'money', 'นับตามวันที่รับเงินจริง รวมบิลเก่า และไม่เปลี่ยนตามเงื่อนไขหรือสถานะบิล; เมื่อกรองอาคารจะแบ่งตามการจัดสรรในใบเสร็จเดิม'],
    ['ร้านที่ยังค้าง', data.totals.outstanding_shop_count, 'count'],
    ['รายการต้องตรวจสอบ', reviewCount, 'count'],
  ];

  return <div className="accounting-shop-summary">
    <div className="accounting-financial-cards">
      {cards.map(([label, value, format, title]) => <article key={label} title={title}><span>{label}</span><strong>{value == null ? '—' : format === 'money' ? money.format(value) : value.toLocaleString('th-TH')}</strong></article>)}
    </div>
    <div className="accounting-filters">
      <label>จาก<input max={toDate} onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} /></label>
      <label>ถึง<input max={today} min={fromDate} onChange={(event) => setToDate(event.target.value)} type="date" value={toDate} /></label>
      <label className="accounting-filters__search"><MagnifyingGlass size={17} /><span className="sr-only">ค้นหาร้าน</span><input onChange={(event) => updateFilter({ shop_search: event.target.value })} placeholder="ชื่อหรือรหัสร้าน" value={filters.shop_search ?? ''} /></label>
      <select aria-label="อาคาร" onChange={(event) => updateFilter({ building_id: event.target.value || undefined, zone_id: undefined })} value={filters.building_id ?? ''}><option value="">ทุกอาคาร</option>{data.facets.buildings.map((item) => <option key={item.value} value={item.value}>{item.label} ({item.count})</option>)}</select>
      <select aria-label="โซน" onChange={(event) => updateFilter({ zone_id: event.target.value || undefined })} title="ตัวกรองโซนใช้ตำแหน่งปัจจุบันของร้าน" value={filters.zone_id ?? ''}><option value="">ทุกโซน</option>{data.facets.zones.map((item) => <option key={item.value} value={item.value}>{item.label} ({item.count})</option>)}</select>
      <select aria-label="ร้าน" onChange={(event) => updateFilter({ shop_id: event.target.value || undefined })} value={filters.shop_id ?? ''}><option value="">ทุกร้าน</option>{data.facets.shops.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
      <select aria-label="เงื่อนไขชำระ" onChange={(event) => updateFilter({ payment_term: (event.target.value || undefined) as AccountingFilters['payment_term'] })} value={filters.payment_term ?? ''}><option value="">ทุกเงื่อนไขชำระ</option>{Object.entries(paymentTermLabels).filter(([value]) => value !== 'mixed').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select aria-label="สถานะชำระ" onChange={(event) => updateFilter({ payment_status: (event.target.value || undefined) as AccountingFilters['payment_status'] })} value={filters.payment_status ?? ''}><option value="">ทุกสถานะ</option>{Object.entries(paymentStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
    </div>
    <div className="accounting-table-wrap accounting-table-wrap--ledger"><table className="accounting-table accounting-shop-table"><thead><tr><th>ร้าน</th><th>อาคาร / โซน</th><th>เงื่อนไขชำระ</th><th>ยอดขาย</th><th>รับแล้ว</th><th>ค้าง</th><th>เกินกำหนด</th><th>จำนวนบิล</th><th>ครบกำหนด</th><th>สถานะ</th></tr></thead><tbody>{data.rows.length ? data.rows.map((row) => <tr className={row.payment_status === 'overdue' ? 'accounting-row--issue' : ''} key={row.shop_id} onClick={() => onOpenShop(row)}><th><button className="accounting-link" onClick={(event) => { event.stopPropagation(); onOpenShop(row); }} type="button">{row.shop_code} · {row.shop_name}</button><small>{row.employee_names ?? '—'}</small></th><td>{[row.building_name, row.historical_zone_name].filter(Boolean).join(' / ')}</td><td>{row.payment_term ? paymentTermLabels[row.payment_term] : '—'}</td><td>{money.format(row.sales_amount)}</td><td>{money.format(row.paid_amount)}</td><td>{money.format(row.outstanding_amount)}</td><td>{money.format(row.overdue_amount)}</td><td>{row.invoice_count.toLocaleString('th-TH')}</td><td>{row.due_date ? accountingDate.format(new Date(`${row.due_date}T12:00:00+07:00`)) : '—'}</td><td><span className={`accounting-payment-status accounting-payment-status--${row.payment_status}`}>{paymentStatusLabels[row.payment_status]}</span></td></tr>) : <tr><td colSpan={10}>ไม่พบยอดขายที่ตรงตัวกรองในช่วงนี้</td></tr>}</tbody></table></div>
  </div>;
}

function ShopInvoiceDetail({ entries, error, fromDate, loading, onClose, shop, toDate }: {
  entries: AccountingShopInvoiceDetailEntry[];
  error: string | null;
  fromDate: string;
  loading: boolean;
  onClose: () => void;
  shop: AccountingShopSummaryRow;
  toDate: string;
}) {
  return <section aria-label={`รายละเอียดบิลของ ${shop.shop_code} · ${shop.shop_name}`} className="accounting-shop-detail">
    <header>
      <div><p className="eyebrow">รายละเอียดตามใบส่งของ / ใบแจ้งหนี้</p><h2>{shop.shop_code} · {shop.shop_name}</h2><span>ช่วงเดียวกับสรุป: {accountingDate.format(new Date(`${fromDate}T12:00:00+07:00`))} – {accountingDate.format(new Date(`${toDate}T12:00:00+07:00`))}</span><small>ยอดรับแล้วและยอดค้างเป็นยอดปัจจุบัน จึงรวมการรับชำระหลังช่วงสรุป</small></div>
      <button aria-label="ปิดรายละเอียดร้าน" onClick={onClose} type="button"><X size={19} /></button>
    </header>
    {loading ? <p className="accounting-shop-detail__state">กำลังโหลดรายละเอียดบิล...</p>
      : error ? <p className="credit-ar__action-error" role="alert"><WarningCircle size={18} />{error}</p>
        : <div className="accounting-table-wrap accounting-table-wrap--ledger"><table><thead><tr><th>วันที่</th><th>เอกสาร</th><th>รายการ</th><th>รายการปรับปรุง</th><th>ยอดขาย</th><th>รับแล้ว</th><th>การรับชำระ</th><th>ค้าง</th><th>สถานะ</th></tr></thead><tbody>{entries.length ? entries.map((entry) => {
          const status = entry.delivery_status === 'replaced' ? 'ถูกแทนที่แล้ว'
            : entry.delivery_status === 'cancelled' || entry.charge_status === 'voided' ? 'ยกเลิกแล้ว'
              : entry.payment_status ? invoicePaymentStatusLabels[entry.payment_status] : 'ข้อมูลเดิม';
          return <tr key={entry.delivery_event_id}><td>{accountingDate.format(new Date(`${entry.service_date}T12:00:00+07:00`))}</td><th>{entry.charge_number ?? 'รายการเดิมก่อนใช้ระบบบิล'}</th><td><div className="accounting-shop-detail__items">{entry.items.length ? entry.items.map((item) => <span key={item.ice_type_id}><strong>{item.name} {Number(item.quantity).toLocaleString('th-TH')} {item.unit}</strong></span>) : '—'}</div></td><td><div className="accounting-shop-detail__adjustments">{entry.adjustments.length ? entry.adjustments.map((adjustment) => <span key={adjustment.id}><strong>{adjustment.reason}</strong>{adjustment.items.map((item) => <small key={item.ice_type_id}>{`${item.name} ${Number(item.original_quantity).toLocaleString('th-TH')} ${item.unit} → แก้เป็น ${Number(item.corrected_quantity).toLocaleString('th-TH')} ${item.unit} (เปลี่ยน ${Number(item.quantity_delta).toLocaleString('th-TH')})`}</small>)}<small>ยอดปรับ {money.format(Number(adjustment.amount_delta))}</small><small>ยอดหลังปรับ {adjustment.corrected_total == null ? '—' : money.format(Number(adjustment.corrected_total))}</small></span>) : '—'}</div></td><td>{entry.total_amount == null ? '—' : money.format(Number(entry.total_amount))}</td><td>{money.format(Number(entry.allocated_amount))}</td><td><div className="accounting-shop-detail__payments">{entry.payments.length ? entry.payments.map((payment) => <span key={payment.payment_id}>{paymentMethodLabels[payment.payment_method]} · {money.format(Number(payment.amount))} · {accountingDate.format(new Date(payment.recorded_at))}</span>) : '—'}</div></td><td>{money.format(Number(entry.outstanding_amount))}</td><td>{status}</td></tr>;
        }) : <tr><td colSpan={9}>ไม่พบบิลของร้านนี้ในช่วงวันที่สรุป</td></tr>}</tbody></table></div>}
  </section>;
}

function AccountingPagination({ page, pageSize, setPage, totalCount }: { page: number; pageSize: number; setPage: (update: (value: number) => number) => void; totalCount: number }) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  return <div className="accounting-pagination"><span>ทั้งหมด {totalCount.toLocaleString('th-TH')} รายการ</span><button disabled={page === 0} onClick={() => setPage((value) => value - 1)} type="button">ก่อนหน้า</button><strong>{page + 1} / {totalPages}</strong><button disabled={page + 1 >= totalPages} onClick={() => setPage((value) => value + 1)} type="button">ถัดไป</button></div>;
}

function ReconciliationPanel({ data, serviceDate, setServiceDate }: { data: AccountingReconciliation | null; serviceDate: string; setServiceDate: (date: string) => void }) {
  const cards = data?.financial;
  return <div className="accounting-reconciliation">
    <label className="accounting-reconciliation__date">วันที่ธุรกรรม<input onChange={(event) => setServiceDate(event.target.value)} type="date" value={serviceDate} /></label>
    {data ? <><div className="accounting-financial-cards">
      {[['ยอดขาย effective', cards?.effective_sales], ['จัดสรรเข้าบิลวันนี้', cards?.allocated_to_sales], ['ควรเก็บแล้ว', cards?.outstanding_collectible], ['ลูกหนี้เครดิต', cards?.outstanding_credit], ['รับเงินจริง', cards?.cash_received], ['คืนเงินจริง', cards?.cash_refunded], ['เงินสุทธิ', cards?.net_cash], ['ยอดรอคืน', cards?.pending_refunds]].map(([label, value]) => <article key={label}><span>{label}</span><strong>{money.format(Number(value ?? 0))}</strong></article>)}
    </div>
    <ReconciliationTable heading="สต๊อกรวมประจำวัน" rows={data.aggregate} /></> : null}
  </div>;
}

function ReconciliationTable({ heading, rows }: { heading: string; rows: AccountingReconciliation['aggregate'] }) {
  return <article className="accounting-reconciliation__table"><h3>{heading}</h3><div className="accounting-table-wrap"><table><thead><tr><th>ชนิด</th><th>โรงงานเข้า</th><th>ขาย</th><th>เติมเดิม</th><th>เสียหาย</th><th>คืนก่อนปิด</th><th>ควรเหลือ</th><th>นับจริง</th><th>คืนตอนปิด</th><th>ต่าง</th><th>สถานะ</th></tr></thead><tbody>{rows.length ? rows.map((row) => <tr className={row.variance || row.count_status === 'stale' ? 'accounting-row--issue' : ''} key={row.ice_type_id}><th>{row.ice_type_name}</th><td>{number.format(row.factory_in)}</td><td>{number.format(row.sold)}</td><td>{number.format(row.legacy_refill ?? 0)}</td><td>{number.format(row.damaged)}</td><td>{number.format(row.returned_to_factory)}</td><td>{number.format(row.expected)}</td><td>{row.actual == null ? '—' : number.format(row.actual)}</td><td>{number.format(row.closed_returned_to_factory ?? 0)}</td><td>{row.variance == null ? '—' : number.format(row.variance)}</td><td>{row.count_status === 'incomplete' ? 'ยังนับไม่ครบ' : row.count_status === 'stale' ? 'ยอดนับล้าสมัย' : row.variance ? 'ต้องตรวจสอบ' : 'ตรงยอด'}</td></tr>) : <tr><td colSpan={11}>ยังไม่มีข้อมูล</td></tr>}</tbody></table></div></article>;
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
