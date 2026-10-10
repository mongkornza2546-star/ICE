import { uiDateTimeFormat, translateUi, useLanguage } from '../../i18n';
import { formatReceiptDate } from '../../lib/salesDocumentPresentation';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowClockwise, CaretLeft, CaretRight, DownloadSimple, Funnel, MagnifyingGlass, WarningCircle, X } from '@phosphor-icons/react';
import { DeliveryCorrectionDialog } from '../delivery-corrections/DeliveryCorrectionDialog';
import { supabase } from '../../lib/supabase';
import { getHybridObjectUrl } from '../../lib/r2Storage';
import { getErrorMessage } from '../../lib/errorMessage';
import { publishDataChange, subscribeToDataChange } from '../../lib/dataChange';
import { toBangkokDateString } from '../../lib/serviceDate';
import { exportAccountingShopDaily, exportAccountingTransactions } from './exportAccounting';
import type {
  AccountingFilters,
  AccountingReconciliation,
  AccountingReviewResponse,
  AccountingShopDailyCell,
  AccountingShopDailyResponse,
  AccountingShopDailyStatus,
  AccountingShopInvoiceDetailEntry,
  AccountingShopSummaryResponse,
  AccountingShopSummaryGroup,
  AccountingShopSummaryRow,
  AccountingSort,
  AccountingTab,
  AccountingTransaction,
  AccountingTransactionType,
  AccountingTransactionsResponse,
} from './types';
import {
  cleanAreaName,
  formatAccountingGroupTitle,
  formatAccountingShopFacetLabel,
  formatAccountingShopTitle,
  formatAccountingZoneFacetLabel,
} from './utils';
import type { AppRole } from '../../types/app';
import type { StoredSalesDocument } from '../../lib/salesDocumentPrint';
import { AccountingLoading, ReceiptPreview, ReviewResolutionDialog, accountingDateTime, accountingStatus, useAccountingDialog } from './AccountingPresentation';
import './accounting.css';

const PAGE_SIZE = 100;
const EXPORT_PAGE_SIZE = 50_000;
const SHOP_EXPORT_PAGE_SIZE = 500;
const money = new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' });
const number = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 });
const accountingDate = uiDateTimeFormat({ timeZone: 'Asia/Bangkok' });
const typeLabels: Record<string, string> = {
  FACTORY: 'รับจากโรงงาน', WITHDRAW: 'เบิกออก', TRANSFER: 'โอน', SALE: 'ขายสด', INV: 'ใบส่งของ',
  REC: 'รับเงิน', FREE: 'แจกขาจร', ADJ: 'ปรับปรุง', REF: 'คืนเงิน', DAMAGE: 'เสียหาย', RETURN: 'คืนรถ/โรงงาน',
};
const financialTransactionTypes: AccountingTransactionType[] = ['SALE', 'INV', 'REC', 'FREE', 'REF', 'ADJ'];
const paymentTermLabels = { immediate: 'จ่ายทันที', end_of_day: 'เก็บท้ายวัน', credit: 'เครดิต', mixed: 'หลายเงื่อนไข' } as const;
const paymentStatusLabels = { paid: 'ชำระครบ', outstanding: 'รอชำระ', overdue: 'เกินกำหนด' } as const;
const invoicePaymentStatusLabels = { paid: 'ชำระแล้ว', partial: 'ชำระบางส่วน', unpaid: 'ค้างชำระ', voided: 'ยกเลิกแล้ว' } as const;
const paymentMethodLabels = { cash: 'เงินสด', bank_transfer: 'โอนธนาคาร', qr: 'QR' } as const;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const SHOP_EXPORT_RETRY_MESSAGE = 'ข้อมูลเปลี่ยนระหว่างส่งออก กรุณาลองใหม่';
type ShopDateWindow = 1 | 7 | 14 | 'month' | 'custom';

function dateKeyTimestamp(date: string) {
  if (!DATE_KEY_PATTERN.test(date)) return null;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) return null;
  return timestamp;
}

function shiftDate(date: string, days: number) {
  const timestamp = dateKeyTimestamp(date);
  if (timestamp == null) throw new Error('รูปแบบวันที่ไม่ถูกต้อง');
  return new Date(timestamp + days * DAY_MS).toISOString().slice(0, 10);
}

function getDateRange(fromDate: string, toDate: string) {
  if (!fromDate || !toDate) return { dates: [] as string[], error: 'กรุณาเลือกวันที่เริ่มและวันที่สิ้นสุด' };
  const fromTimestamp = dateKeyTimestamp(fromDate);
  const toTimestamp = dateKeyTimestamp(toDate);
  if (fromTimestamp == null || toTimestamp == null) return { dates: [] as string[], error: 'รูปแบบวันที่ไม่ถูกต้อง' };
  const days = Math.round((toTimestamp - fromTimestamp) / DAY_MS);
  if (days < 0) return { dates: [] as string[], error: 'วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด' };
  if (days > 30) return { dates: [] as string[], error: 'ดูข้อมูลได้สูงสุด 31 วันต่อครั้ง' };
  return {
    dates: Array.from({ length: days + 1 }, (_, index) => new Date(fromTimestamp + index * DAY_MS).toISOString().slice(0, 10)),
    error: null,
  };
}

function accountingAmountInCents(value: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new Error(SHOP_EXPORT_RETRY_MESSAGE);
  return Math.round(amount * 100);
}

function validateShopDailyExportPage(
  shops: AccountingShopSummaryRow[],
  daily: AccountingShopDailyResponse,
  dates: string[],
) {
  const expectedShopIds = new Set(shops.map((shop) => shop.shop_id));
  const dailyRows = new Map(daily.rows.map((row) => [row.shop_id, row]));
  if (expectedShopIds.size !== shops.length || dailyRows.size !== daily.rows.length
    || dailyRows.size !== expectedShopIds.size
    || daily.rows.some((row) => !expectedShopIds.has(row.shop_id))) {
    throw new Error(SHOP_EXPORT_RETRY_MESSAGE);
  }
  if (new Set(daily.ice_types.map((iceType) => iceType.ice_type_id)).size !== daily.ice_types.length) {
    throw new Error(SHOP_EXPORT_RETRY_MESSAGE);
  }

  const expectedDates = new Set(dates);
  shops.forEach((shop) => {
    const dailyRow = dailyRows.get(shop.shop_id);
    if (!dailyRow) throw new Error(SHOP_EXPORT_RETRY_MESSAGE);
    const days = new Map(dailyRow.days.map((day) => [day.service_date, day]));
    if (days.size !== dailyRow.days.length || days.size !== dates.length
      || dailyRow.days.some((day) => !expectedDates.has(day.service_date))) {
      throw new Error(SHOP_EXPORT_RETRY_MESSAGE);
    }
    const dailySales = dates.reduce((sum, date) => sum + accountingAmountInCents(days.get(date)?.sales_amount), 0);
    const dailyInvoiceCount = dates.reduce((sum, date) => sum + Number(days.get(date)?.invoice_count), 0);
    if (dailySales !== accountingAmountInCents(shop.sales_amount)
      || !Number.isInteger(dailyInvoiceCount) || dailyInvoiceCount !== Number(shop.invoice_count)) {
      throw new Error(SHOP_EXPORT_RETRY_MESSAGE);
    }
  });
}

function calendarMonthRange(anchorDate: string, today: string, offset = 0) {
  const safeAnchor = dateKeyTimestamp(anchorDate) != null && anchorDate <= today ? anchorDate : today;
  const anchor = new Date(`${safeAnchor}T00:00:00Z`);
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + offset;
  const fromDate = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const monthEnd = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  return { fromDate, toDate: monthEnd > today ? today : monthEnd };
}

function emptyTransactions(): AccountingTransactionsResponse {
  return { rows: [], total_count: 0, facets: { ice_types: [], shops: [], employees: [], types: [] } };
}

function emptyShopSummary(): AccountingShopSummaryResponse {
  return {
    rows: [],
    total_count: 0,
    totals: {
      sales_amount: 0, paid_amount: 0, outstanding_amount: 0, overdue_amount: 0,
      outstanding_shop_count: 0, cumulative_outstanding_amount: 0,
      cumulative_overdue_amount: 0, cumulative_outstanding_shop_count: 0,
      cash_received_in_period: 0, cash_in_period: 0, transfer_in_period: 0,
    },
    facets: { shops: [], buildings: [], zones: [] },
  };
}

function emptyShopDaily(): AccountingShopDailyResponse {
  return { ice_types: [], rows: [] };
}

function withFinancialTransactionTypes(filters: AccountingFilters): AccountingFilters {
  return { ...filters, types: filters.types?.length ? filters.types : financialTransactionTypes };
}

function lastPageIndex(totalCount: number) {
  return Math.max(0, Math.ceil(totalCount / PAGE_SIZE) - 1);
}

function SortButton({ column, label, sort, onChange }: { column: string; label: string; sort: AccountingSort; onChange: (sort: AccountingSort) => void }) {
  useLanguage();
  const active = sort.key === column;
  return <button className="accounting-table__sort" onClick={() => onChange({ key: column, direction: active && sort.direction === 'asc' ? 'desc' : 'asc' })} type="button">
    {translateUi(label)}<span aria-hidden="true">{active ? sort.direction === 'asc' ? ' ↑' : ' ↓' : ''}</span>
  </button>;
}

export function AccountingPage({ userRole = 'round_lead', demoMode = false }: { userRole?: AppRole; demoMode?: boolean }) {
  useLanguage();
  const today = toBangkokDateString();
  const [tab, setTab] = useState<AccountingTab>('shops');
  const [serviceDate, setServiceDate] = useState(today);
  const [fromDate, setFromDate] = useState(shiftDate(today, -6));
  const [toDate, setToDate] = useState(today);
  const [shopWindowMode, setShopWindowMode] = useState<ShopDateWindow>(7);
  const [shopView, setShopView] = useState<'daily' | 'totals'>('totals');
  const [transactionFilters, setTransactionFilters] = useState<AccountingFilters>({});
  const [reviewFilters, setReviewFilters] = useState<AccountingFilters>({});
  const filters = tab === 'review' ? reviewFilters : transactionFilters;
  const [shopFilters, setShopFilters] = useState<AccountingFilters>({});
  const [sort, setSort] = useState<AccountingSort>({ key: 'occurred_at', direction: 'desc' });
  const [pages, setPages] = useState<Record<AccountingTab, number>>({ shops: 0, reconciliation: 0, transactions: 0, review: 0 });
  const page = pages[tab];
  const setPage = useCallback((update: number | ((current: number) => number)) => {
    setPages((current) => ({ ...current, [tab]: typeof update === 'function' ? update(current[tab]) : update }));
  }, [tab]);
  const [reconciliation, setReconciliation] = useState<AccountingReconciliation | null>(null);
  const [shopSummary, setShopSummary] = useState<AccountingShopSummaryResponse>(emptyShopSummary);
  const [shopDaily, setShopDaily] = useState<AccountingShopDailyResponse>(emptyShopDaily);
  const [transactions, setTransactions] = useState<AccountingTransactionsResponse>(emptyTransactions);
  const [reviews, setReviews] = useState<AccountingReviewResponse>({ rows: [], total_count: 0 });
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [selectedShop, setSelectedShop] = useState<AccountingShopSummaryRow | null>(null);
  const [selectedShopRange, setSelectedShopRange] = useState<{ from: string; to: string } | null>(null);
  const [shopHistory, setShopHistory] = useState<AccountingShopInvoiceDetailEntry[]>([]);
  const [shopHistoryLoading, setShopHistoryLoading] = useState(false);
  const [shopHistoryError, setShopHistoryError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AccountingTransaction | null>(null);
  const [receiptSnapshot, setReceiptSnapshot] = useState<StoredSalesDocument | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [correctionTargets, setCorrectionTargets] = useState<Array<{ charge_id: string; charge_number: string; delivery_event_id: string }>>([]);
  const [correctionEventId, setCorrectionEventId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [resolvingIssueId, setResolvingIssueId] = useState<string | null>(null);
  const [resolutionItem, setResolutionItem] = useState<AccountingReviewResponse['rows'][number] | null>(null);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [sourceReturn, setSourceReturn] = useState<{ tab: AccountingTab; from: string; to: string; window: ShopDateWindow } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const loadRequestId = useRef(0);
  const reviewCountRequestId = useRef(0);
  const drawerRequestId = useRef(0);
  const shopHistoryRequestId = useRef(0);
  const loadedQuery = useRef<string | null>(null);
  const queryKey = JSON.stringify([demoMode, tab, fromDate, toDate, serviceDate, page, filters, shopFilters, sort]);
  const unavailable = Boolean(error) && loadedQuery.current !== queryKey;

  const validateRange = useCallback(() => {
    const { error: rangeError } = getDateRange(fromDate, toDate);
    if (rangeError) throw new Error(rangeError);
  }, [fromDate, toDate]);

  const load = useCallback(async () => {
    const requestId = loadRequestId.current + 1;
    loadRequestId.current = requestId;
    // Realtime invalidates data, not the user's workspace. Keep a successful
    // report mounted until its replacement is ready for this same query.
    const background = loadedQuery.current === queryKey;
    setLoading(!background);
    setRefreshing(background);
    setError(null);
    if (!background) {
      loadedQuery.current = null;
      if (tab === 'shops') {
        setShopSummary((current) => ({ ...emptyShopSummary(), facets: current.facets }));
        setShopDaily(emptyShopDaily());
        shopHistoryRequestId.current += 1;
        setSelectedShop(null);
        setShopHistory([]);
        setShopHistoryError(null);
        setShopHistoryLoading(false);
      } else if (tab === 'reconciliation') {
        setReconciliation(null);
      } else if (tab === 'transactions') {
        setTransactions((current) => ({ ...emptyTransactions(), facets: current.facets }));
      } else {
        setReviews({ rows: [], total_count: 0 });
      }
    }
    try {
      if (demoMode) {
        if (loadRequestId.current !== requestId) return;
        setReconciliation({ service_date: serviceDate, aggregate: [], holders: [], financial: { effective_sales: 0, allocated_to_sales: 0, outstanding_collectible: 0, outstanding_credit: 0, cash_received: 0, cash_refunded: 0, net_cash: 0, pending_refunds: 0 } });
        setShopSummary(emptyShopSummary());
        setShopDaily(emptyShopDaily());
        setTransactions(emptyTransactions());
        setReviews({ rows: [], total_count: 0 });
        loadedQuery.current = queryKey;
        setLastUpdated(new Date().toISOString());
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
        const dailyResponse = await supabase.rpc('get_accounting_shop_daily_matrix', {
          p_from_date: fromDate,
          p_to_date: toDate,
          p_shop_ids: summaryData.rows.map((row) => row.shop_id),
        });
        if (loadRequestId.current !== requestId) return;
        if (dailyResponse.error) throw dailyResponse.error;
        setShopSummary(summaryData);
        setShopDaily(dailyResponse.data as unknown as AccountingShopDailyResponse);
      } else if (tab === 'reconciliation') {
        const response = await supabase.rpc('get_accounting_reconciliation', { p_service_date: serviceDate });
        if (loadRequestId.current !== requestId) return;
        if (response.error) throw response.error;
        setReconciliation(response.data as AccountingReconciliation);
      } else {
        validateRange();
        if (tab === 'transactions') {
          const response = await supabase.rpc('get_accounting_transactions', {
            p_from_date: fromDate, p_to_date: toDate,
            p_filters: withFinancialTransactionTypes(filters), p_sort: sort,
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
        }
      }
      loadedQuery.current = queryKey;
      setLastUpdated(new Date().toISOString());
    } catch (loadError) {
      if (loadRequestId.current === requestId) setError(getErrorMessage(loadError));
    } finally {
      if (loadRequestId.current === requestId) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [demoMode, filters, fromDate, page, queryKey, serviceDate, setPage, shopFilters, sort, tab, toDate, validateRange]);

  const loadReviewCount = useCallback(async () => {
    const requestId = reviewCountRequestId.current + 1;
    reviewCountRequestId.current = requestId;
    if (demoMode) {
      setReviewCount(0);
      return;
    }
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

  useEffect(() => {
    void load();
    return () => { loadRequestId.current += 1; };
  }, [load, refreshToken]);
  useEffect(() => { setReviewCount(null); }, [loadReviewCount]);
  useEffect(() => {
    void loadReviewCount();
    return () => { reviewCountRequestId.current += 1; };
  }, [loadReviewCount, refreshToken]);
  useEffect(() => subscribeToDataChange(['accounting', 'payment', 'receivable', 'refund', 'stock', 'pos'], () => setRefreshToken((value) => value + 1)), []);

  const openRow = async (row: AccountingTransaction) => {
    const requestId = drawerRequestId.current + 1;
    drawerRequestId.current = requestId;
    setSelected(row);
    setReceiptSnapshot(null);
    setReceiptError(null);
    setReceiptLoading(false);
    setCorrectionTargets([]);
    if (row.type !== 'REC' || demoMode || !supabase) return;
    setReceiptLoading(true);
    try {
    if (row.source_table === 'casual_transactions') {
      const snapshot = await supabase.rpc('get_casual_receipt_snapshot', { p_transaction_id: row.source_id });
      if (drawerRequestId.current === requestId && !snapshot.error) {
        setReceiptSnapshot(snapshot.data as StoredSalesDocument);
      }
      if (snapshot.error) throw snapshot.error;
      return;
    }
    if (!row.payment_id) throw new Error('รายการนี้ไม่มีข้อมูลอ้างอิงใบเสร็จ');
    const [snapshot, targets] = await Promise.allSettled([
      supabase.rpc('get_payment_receipt_snapshot', { p_payment_id: row.payment_id }),
      supabase.rpc('get_payment_correction_targets', { p_payment_id: row.payment_id }),
    ]);
    if (drawerRequestId.current !== requestId) return;
    if (snapshot.status === 'fulfilled' && !snapshot.value.error) setReceiptSnapshot(snapshot.value.data as StoredSalesDocument);
    if (targets.status === 'fulfilled' && !targets.value.error) setCorrectionTargets((targets.value.data ?? []) as typeof correctionTargets);
    if (snapshot.status === 'rejected') throw snapshot.reason;
    if (snapshot.value.error) throw snapshot.value.error;
    if (targets.status === 'rejected' || targets.value.error) setReceiptError('โหลดข้อมูลการดำเนินการต้นทางไม่สำเร็จ กรุณาลองใหม่');
    } catch (detailError) {
      if (drawerRequestId.current === requestId) setReceiptError(getErrorMessage(detailError));
    } finally {
      if (drawerRequestId.current === requestId) setReceiptLoading(false);
    }
  };

  const resolveReviewIssue = async (item: AccountingReviewResponse['rows'][number], resolutionNote: string, externalReference: string | null) => {
    if (!item.issue_id.startsWith('daily-close-') || demoMode || !supabase || resolvingIssueId) return;
    setResolvingIssueId(item.issue_id);
    setResolutionError(null);
    try {
      const response = await supabase.rpc('resolve_daily_close_reconciliation_issue', {
        p_issue_id: item.source_id,
        p_resolution_note: resolutionNote,
        p_external_reference: externalReference,
      });
      if (response.error) throw response.error;
      setResolutionItem(null);
      publishDataChange(['accounting']);
      setRefreshToken((value) => value + 1);
    } catch (resolveError) {
      setResolutionError(getErrorMessage(resolveError));
    } finally {
      setResolvingIssueId(null);
    }
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
          p_from_date: fromDate, p_to_date: toDate,
          p_filters: withFinancialTransactionTypes(filters), p_sort: sort,
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

  const exportShopDaily = async () => {
    setExporting(true);
    setError(null);
    try {
      validateRange();
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { dates } = getDateRange(fromDate, toDate);
      const rows: AccountingShopSummaryRow[] = [];
      const dailyRows: AccountingShopDailyResponse['rows'] = [];
      let casualDays: AccountingShopDailyResponse['casual_days'];
      const iceTypes = new Map<string, AccountingShopDailyResponse['ice_types'][number]>();
      const seenShopIds = new Set<string>();
      let expectedTotalCount: number | null = null;
      do {
        const summaryResponse = await supabase.rpc('get_accounting_shop_summary', {
          p_from_date: fromDate, p_to_date: toDate, p_filters: shopFilters,
          p_limit: SHOP_EXPORT_PAGE_SIZE, p_offset: rows.length,
        });
        if (summaryResponse.error) throw summaryResponse.error;
        const pageData = summaryResponse.data as unknown as AccountingShopSummaryResponse;
        if (!Number.isInteger(pageData.total_count) || pageData.total_count < 0) {
          throw new Error(SHOP_EXPORT_RETRY_MESSAGE);
        }
        if (expectedTotalCount == null) expectedTotalCount = pageData.total_count;
        else if (pageData.total_count !== expectedTotalCount) throw new Error(SHOP_EXPORT_RETRY_MESSAGE);
        const remaining = expectedTotalCount - rows.length;
        if (!pageData.rows.length && remaining > 0) throw new Error(SHOP_EXPORT_RETRY_MESSAGE);
        if (pageData.rows.length > remaining) throw new Error(SHOP_EXPORT_RETRY_MESSAGE);
        pageData.rows.forEach((row) => {
          if (seenShopIds.has(row.shop_id)) throw new Error(SHOP_EXPORT_RETRY_MESSAGE);
          seenShopIds.add(row.shop_id);
          rows.push(row);
        });
      } while (rows.length < (expectedTotalCount ?? 0));
      if (rows.length !== expectedTotalCount) throw new Error(SHOP_EXPORT_RETRY_MESSAGE);

      for (let offset = 0; offset < Math.max(rows.length, 1); offset += SHOP_EXPORT_PAGE_SIZE) {
        const shopPage = rows.slice(offset, offset + SHOP_EXPORT_PAGE_SIZE);
        const dailyResponse = await supabase.rpc('get_accounting_shop_daily_matrix', {
          p_from_date: fromDate, p_to_date: toDate,
          p_shop_ids: shopPage.map((row) => row.shop_id),
        });
        if (dailyResponse.error) throw dailyResponse.error;
        const dailyPage = dailyResponse.data as unknown as AccountingShopDailyResponse;
        if (offset === 0) casualDays = dailyPage.casual_days;
        else if (JSON.stringify(casualDays) !== JSON.stringify(dailyPage.casual_days)) throw new Error(SHOP_EXPORT_RETRY_MESSAGE);
        validateShopDailyExportPage(shopPage, dailyPage, dates);
        dailyPage.ice_types.forEach((iceType) => {
          const existing = iceTypes.get(iceType.ice_type_id);
          if (existing && (existing.code !== iceType.code || existing.name !== iceType.name || existing.unit !== iceType.unit)) {
            throw new Error(SHOP_EXPORT_RETRY_MESSAGE);
          }
          iceTypes.set(iceType.ice_type_id, iceType);
        });
        const rowsByShop = new Map(dailyPage.rows.map((row) => [row.shop_id, row]));
        dailyRows.push(...shopPage.map((shop) => rowsByShop.get(shop.shop_id)!));
      }
      await exportAccountingShopDaily(rows, { ice_types: [...iceTypes.values()], rows: dailyRows, casual_days: casualDays }, fromDate, toDate);
    } catch (exportError) {
      setError(getErrorMessage(exportError));
    } finally {
      setExporting(false);
    }
  };

  const totalCount = tab === 'shops' ? shopSummary.total_count : tab === 'transactions' ? transactions.total_count : reviews.total_count;
  const updateFilter = (change: Partial<AccountingFilters>) => {
    (tab === 'review' ? setReviewFilters : setTransactionFilters)((current) => ({ ...current, ...change })); setPage(0);
  };
  const changeTab = (next: AccountingTab) => {
    if (next === tab) return;
    if (sourceReturn) {
      setFromDate(sourceReturn.from); setToDate(sourceReturn.to); setShopWindowMode(sourceReturn.window);
      setSourceReturn(null);
    }
    if (next === 'reconciliation') setServiceDate(sourceReturn?.to ?? toDate);
    setTab(next);
  };
  const openDocument = (document: string, date?: string) => {
    setSourceReturn({ tab, from: fromDate, to: toDate, window: shopWindowMode });
    setTransactionFilters({ document });
    if (date && (date < fromDate || date > toDate)) { setFromDate(date); setToDate(date); setShopWindowMode('custom'); }
    setSelectedShop(null); setTab('transactions'); setPages((current) => ({ ...current, transactions: 0 }));
  };
  const openReviewSource = (item: AccountingReviewResponse['rows'][number]) => {
    if (item.document_number) openDocument(item.document_number, item.service_date);
    else {
      setSourceReturn({ tab, from: fromDate, to: toDate, window: shopWindowMode });
      setServiceDate(item.service_date); setTab('reconciliation');
    }
  };
  const updateShopFilter = (change: Partial<AccountingFilters>) => { setShopFilters((current) => ({ ...current, ...change })); setPage(0); };
  const openShopInvoices = async (shop: AccountingShopSummaryRow, serviceDate?: string) => {
    const requestId = shopHistoryRequestId.current + 1;
    shopHistoryRequestId.current = requestId;
    const detailRange = serviceDate ? { from: serviceDate, to: serviceDate } : { from: fromDate, to: toDate };
    setSelectedShop(shop);
    setSelectedShopRange(detailRange);
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
          p_from_date: detailRange.from,
          p_to_date: detailRange.to,
          p_filters: {},
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
    setSelectedShopRange(null);
    setShopHistory([]);
    setShopHistoryError(null);
    setShopHistoryLoading(false);
  };

  return <section className="accounting-page">
    <header className="financial-ops__header accounting-page__header">
      <div><h1>{translateUi('บัญชี / เอกสารและการเงิน')}</h1><span>{translateUi('ตรวจสอบยอดและเอกสาร · แก้ไขที่ต้นทาง')}</span></div>
      <div className="accounting-header-actions"><small>{loading || refreshing ? translateUi('กำลังอัปเดต…') : lastUpdated ? translateUi('โหลดล่าสุด {0}', { 0: accountingDateTime(lastUpdated) }) : translateUi('ยังไม่ได้โหลดข้อมูล')}{error ? translateUi(' · โหลดครั้งล่าสุดไม่สำเร็จ') : ''}</small><div><button disabled={loading || refreshing} onClick={() => setRefreshToken((value) => value + 1)} type="button"><ArrowClockwise size={18} />{translateUi('รีเฟรช')}</button>{tab === 'shops' || tab === 'transactions' ? <button disabled={loading || refreshing || exporting || Boolean(error)} onClick={() => void (tab === 'shops' ? exportShopDaily() : exportRows())} type="button"><DownloadSimple size={18} />{exporting ? translateUi('กำลังส่งออก...') : translateUi('ส่งออก Excel')}</button> : null}</div></div>
    </header>
    <nav aria-label={translateUi('แท็บบัญชี')} className="accounting-tabs">
      {([['shops', 'สรุปรายร้าน'], ['reconciliation', 'สรุปเทียบยอด'], ['transactions', 'เอกสารและการเงิน'], ['review', 'รายการต้องตรวจสอบ']] as const).map(([value, label]) => <button aria-current={tab === value ? 'page' : undefined} key={value} onClick={() => changeTab(value)} type="button">{translateUi(label)}{value === 'review' && reviewCount ? <span>{reviewCount}</span> : null}</button>)}
    </nav>
    {sourceReturn ? <div className="accounting-source-context"><span>{translateUi('กำลังดูต้นทางจาก')}{sourceReturn.tab === 'shops' ? translateUi('สรุปรายร้าน') : translateUi('รายการต้องตรวจสอบ')}</span><button type="button" onClick={() => changeTab(sourceReturn.tab)}>{translateUi('กลับไป')}{sourceReturn.tab === 'shops' ? translateUi('สรุปรายร้าน') : translateUi('รายการต้องตรวจสอบ')}</button></div> : null}
    {tab === 'shops' ? <>
      <ShopSummaryPanel
        daily={shopDaily}
        data={shopSummary}
        filters={shopFilters}
        fromDate={fromDate}
        loading={loading}
        unavailable={unavailable}
        view={shopView}
        onViewChange={setShopView}
        onClearFilters={() => { setShopFilters({}); setPage(0); }}
        onOpenShop={(shop, date) => void openShopInvoices(shop, date)}
        onOpenReview={() => { setReviewFilters({}); setPages((current) => ({ ...current, review: 0 })); changeTab('review'); }}
        reviewCount={reviewCount}
        setFromDate={(date) => { setFromDate(date); setPage(0); }}
        setToDate={(date) => { setToDate(date); setPage(0); }}
        setWindowMode={setShopWindowMode}
        toDate={toDate}
        today={today}
        updateFilter={updateShopFilter}
        windowMode={shopWindowMode}
      />
      {!loading && !unavailable ? <AccountingPagination page={page} pageSize={PAGE_SIZE} setPage={setPage} totalCount={totalCount} /> : null}
      {selectedShop ? createPortal(
        <div className="accounting-shop-detail-layer">
          <button aria-label={translateUi('ปิดหน้าต่างรายละเอียดร้าน')} className="accounting-shop-detail-backdrop" onClick={closeShopInvoices} type="button" />
          <ShopInvoiceDetail
            entries={shopHistory}
            error={shopHistoryError}
            fromDate={selectedShopRange?.from ?? fromDate}
            loading={shopHistoryLoading}
            onClose={closeShopInvoices}
            onOpenDocument={openDocument}
            shop={selectedShop}
            toDate={selectedShopRange?.to ?? toDate}
          />
        </div>,
        document.body,
      ) : null}
    </> : tab === 'reconciliation' ? <ReconciliationPanel data={reconciliation} loading={loading} serviceDate={serviceDate} setServiceDate={setServiceDate} /> : <>
      <div className={tab === 'review' ? 'accounting-filters accounting-filters--review' : 'accounting-filters'}>
        <label className="accounting-filters__range"><span>{translateUi('ช่วงเวลา')}</span><span><input aria-label={translateUi('จาก')} max={toDate} onChange={(event) => { setShopWindowMode('custom'); setFromDate(event.target.value); setPage(0); }} type="date" value={fromDate} /><span aria-hidden="true">{translateUi('ถึง')}</span><input aria-label={translateUi('ถึง')} max={today} min={fromDate} onChange={(event) => { setShopWindowMode('custom'); setToDate(event.target.value); setPage(0); }} type="date" value={toDate} /></span></label>
        <label className="accounting-filters__search"><span>{translateUi('ค้นหาเอกสาร')}</span><span className="accounting-filters__input-wrap"><MagnifyingGlass size={17} /><input aria-label={translateUi('ค้นเอกสาร')} onChange={(event) => updateFilter({ document: event.target.value })} placeholder={translateUi('เลขเอกสาร / อ้างอิง')} value={filters.document ?? ''} /></span></label>
        {tab === 'transactions' ? <>
          <label className="accounting-filters__select"><span>{translateUi('ชนิดน้ำแข็ง')}</span><select aria-label={translateUi('ชนิดน้ำแข็ง')} onChange={(event) => updateFilter({ ice_type_id: event.target.value || undefined })} value={filters.ice_type_id ?? ''}><option value="">{translateUi('ทุกชนิดน้ำแข็ง')}</option>{transactions.facets.ice_types.map((item) => <option key={item.value} value={item.value}>{item.label} ({item.count})</option>)}</select></label>
          <label className="accounting-filters__select"><span>{translateUi('ร้านค้า')}</span><select aria-label={translateUi('ร้าน')} onChange={(event) => updateFilter({ shop_id: event.target.value || undefined })} value={filters.shop_id ?? ''}><option value="">{translateUi('ทุกร้าน')}</option>{transactions.facets.shops.map((item) => <option key={item.value} value={item.value}>{formatAccountingShopFacetLabel(item.label)} ({item.count})</option>)}</select></label>
          <label className="accounting-filters__select"><span>{translateUi('พนักงาน')}</span><select aria-label={translateUi('พนักงาน')} onChange={(event) => updateFilter({ employee_id: event.target.value || undefined })} value={filters.employee_id ?? ''}><option value="">{translateUi('ทุกพนักงาน')}</option>{transactions.facets.employees.map((item) => <option key={item.value} value={item.value}>{item.label} ({item.count})</option>)}</select></label>
          <label className="accounting-filters__select"><span>{translateUi('ประเภทเอกสาร')}</span><select aria-label={translateUi('ประเภทเอกสารและการเงิน')} onChange={(event) => updateFilter({ types: event.target.value ? [event.target.value as AccountingTransaction['type']] : undefined })} value={filters.types?.[0] ?? ''}><option value="">{translateUi('ทุกเอกสารและการเงิน')}</option>{financialTransactionTypes.map((type) => <option key={type} value={type}>{translateUi(typeLabels[type])}</option>)}</select></label>
        </> : null}
        {tab === 'transactions' ? <label className="accounting-filters__checkbox"><input checked={Boolean(filters.issues_only)} onChange={(event) => updateFilter({ issues_only: event.target.checked || undefined })} type="checkbox" /><Funnel size={16} />{translateUi('เฉพาะมีประเด็น')}</label> : null}
        {Object.values(filters).some(Boolean) ? <button onClick={() => { (tab === 'review' ? setReviewFilters : setTransactionFilters)({}); setPage(0); }} type="button">{translateUi('ล้างตัวกรอง')}</button> : null}
      </div>
      <p className="accounting-context-note">{getDateRange(fromDate, toDate).error ?? `${accountingDate.format(new Date(`${fromDate}T12:00:00+07:00`))} – ${accountingDate.format(new Date(`${toDate}T12:00:00+07:00`))}`}{tab === 'review' ? translateUi(' · ประเด็นทั้งหมดในช่วง ไม่ตามตัวกรองร้านของแท็บสรุป') : translateUi(' · แสดงรายการตามเอกสารต้นทาง')}</p>
      {loading ? <AccountingLoading /> : unavailable ? null : tab === 'transactions' ? <TransactionsTable onOpen={(row) => void openRow(row)} rows={transactions.rows} setSort={setSort} sort={sort} /> : <ReviewQueue onOpenSource={openReviewSource} onResolve={(item) => { setResolutionError(null); setResolutionItem(item); }} resolvingIssueId={resolvingIssueId} rows={reviews.rows} />}
      {!loading && !unavailable ? <AccountingPagination page={page} pageSize={PAGE_SIZE} setPage={setPage} totalCount={totalCount} /> : null}
    </>}
    {error ? <div className="accounting-error" role="alert"><WarningCircle size={18} /><span>{translateUi(error)}</span><button disabled={loading || refreshing} onClick={() => setRefreshToken((value) => value + 1)} type="button">{translateUi('ลองใหม่')}</button></div> : null}
    {selected ? <TransactionDrawer correctionTargets={correctionTargets} onClose={() => {
      drawerRequestId.current += 1;
      setSelected(null);
      setReceiptSnapshot(null);
      setCorrectionTargets([]);
    }} onCorrect={(id) => { setSelected(null); setCorrectionEventId(id); }} onRetry={() => void openRow(selected)} receiptLoading={receiptLoading} receiptError={receiptError} receiptSnapshot={receiptSnapshot} row={selected} /> : null}
    {resolutionItem ? createPortal(<ReviewResolutionDialog item={resolutionItem} busy={Boolean(resolvingIssueId)} error={resolutionError} onClose={() => setResolutionItem(null)} onSubmit={(note, reference) => void resolveReviewIssue(resolutionItem, note, reference)} />, document.body) : null}
    {correctionEventId ? <DeliveryCorrectionDialog eventId={correctionEventId} onClose={() => setCorrectionEventId(null)} onSuccess={() => undefined} userRole={userRole} /> : null}
  </section>;
}

function ShopSummaryPanel({ daily, data, loading, unavailable, view, onViewChange, filters, fromDate, onClearFilters, onOpenReview, onOpenShop, reviewCount, setFromDate, setToDate, setWindowMode, toDate, today, updateFilter, windowMode }: {
  daily: AccountingShopDailyResponse;
  data: AccountingShopSummaryResponse;
  loading: boolean;
  unavailable: boolean;
  view: 'daily' | 'totals';
  onViewChange: (view: 'daily' | 'totals') => void;
  filters: AccountingFilters;
  fromDate: string;
  onClearFilters: () => void;
  onOpenReview: () => void;
  onOpenShop: (shop: AccountingShopSummaryRow, serviceDate?: string) => void;
  reviewCount: number | null;
  setFromDate: (date: string) => void;
  setToDate: (date: string) => void;
  setWindowMode: (mode: ShopDateWindow) => void;
  toDate: string;
  today: string;
  updateFilter: (change: Partial<AccountingFilters>) => void;
  windowMode: ShopDateWindow;
}) {
  useLanguage();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [extraFiltersOpen, setExtraFiltersOpen] = useState(false);
  const rangeError = getDateRange(fromDate, toDate).error;
  const activeFilters = Object.entries(filters).filter(([key, value]) => key !== 'shop_sort' && Boolean(value));
  const extraCount = [filters.payment_term, filters.shop_id].filter(Boolean).length;
  const chooseWindow = (mode: Exclude<ShopDateWindow, 'custom'>) => {
    setWindowMode(mode);
    const next = mode === 'month' ? calendarMonthRange(today, today) : { fromDate: shiftDate(today, -(mode - 1)), toDate: today };
    setFromDate(next.fromDate); setToDate(next.toDate);
  };
  const totals = data.totals;
  const filterLabels: Record<string, string> = {
    shop_search: `ค้นหา: ${filters.shop_search ?? ''}`,
    shop_id: data.facets.shops.find((item) => item.value === filters.shop_id)?.label ?? 'ร้านที่เลือก',
    building_id: data.facets.buildings.find((item) => item.value === filters.building_id)?.label ?? 'อาคารที่เลือก',
    zone_id: data.facets.zones.find((item) => item.value === filters.zone_id)?.label ?? 'โซนที่เลือก',
    payment_status: filters.payment_status ? paymentStatusLabels[filters.payment_status] : '',
    payment_term: filters.payment_term ? paymentTermLabels[filters.payment_term] : '',
  };
  return <div className="accounting-shop-summary">
    <div className="accounting-filter-panel">
      <div className="accounting-period-bar"><div className="accounting-period-presets" role="group" aria-label={translateUi('ช่วงวันที่รายงาน')}>
        {([[1, 'วันนี้'], [7, '7 วัน'], [14, '14 วัน'], ['month', 'เดือนนี้']] as const).map(([mode, label]) => <button key={mode} type="button" aria-pressed={windowMode === mode} onClick={() => chooseWindow(mode)}>{translateUi(label)}</button>)}
        <button type="button" aria-pressed={windowMode === 'custom'} onClick={() => setWindowMode('custom')}>{translateUi('กำหนดเอง')}</button>
      </div><span>{rangeError ? translateUi('เลือกช่วงวันที่ได้สูงสุด 31 วัน') : `${accountingDate.format(new Date(`${fromDate}T12:00:00+07:00`))} – ${accountingDate.format(new Date(`${toDate}T12:00:00+07:00`))}`}</span></div>
      <div className="accounting-filters accounting-filters--shop-summary">
        <label className="accounting-filters__range"><span>{translateUi('ช่วงวันที่รายงาน')}</span><span><input aria-describedby={rangeError ? 'accounting-shop-date-error' : undefined} aria-invalid={Boolean(rangeError)} aria-label={translateUi('จาก')} max={toDate} onChange={(event) => { setWindowMode('custom'); setFromDate(event.target.value); }} type="date" value={fromDate} /><span aria-hidden="true">{translateUi('ถึง')}</span><input aria-describedby={rangeError ? 'accounting-shop-date-error' : undefined} aria-invalid={Boolean(rangeError)} aria-label={translateUi('ถึง')} max={today} min={fromDate} onChange={(event) => { setWindowMode('custom'); setToDate(event.target.value); }} type="date" value={toDate} /></span></label>
        <label className="accounting-filters__search"><span>{translateUi('ค้นหาร้าน')}</span><span className="accounting-filters__input-wrap"><MagnifyingGlass size={17} /><input aria-label={translateUi('ค้นหาร้าน')} onChange={(event) => updateFilter({ shop_search: event.target.value })} placeholder={translateUi('ชื่อหรือรหัสร้าน')} value={filters.shop_search ?? ''} /></span></label>
        <div className="accounting-filters__field"><span>{translateUi('พื้นที่ปัจจุบันของร้าน')}</span><span>
          <select aria-label={translateUi('อาคาร')} onChange={(event) => updateFilter({ building_id: event.target.value || undefined, zone_id: undefined })} value={filters.building_id ?? ''}><option value="">{translateUi('ทุกอาคาร')}</option>{data.facets.buildings.map((item) => <option key={item.value} value={item.value}>{cleanAreaName(item.label)} ({item.count})</option>)}</select>
          <select aria-label={translateUi('โซน')} onChange={(event) => updateFilter({ zone_id: event.target.value || undefined })} value={filters.zone_id ?? ''}><option value="">{translateUi('ทุกโซน')}</option>{data.facets.zones.map((item) => <option key={item.value} value={item.value}>{formatAccountingZoneFacetLabel(item.label, ' / ')} ({item.count})</option>)}</select>
        </span></div>
        <label><span>{translateUi('สถานะชำระสะสม')}</span><select aria-label={translateUi('สถานะชำระ')} onChange={(event) => updateFilter({ payment_status: (event.target.value || undefined) as AccountingFilters['payment_status'] })} value={filters.payment_status ?? ''}><option value="">{translateUi('ทุกสถานะ')}</option>{Object.entries(paymentStatusLabels).map(([value, label]) => <option key={value} value={value}>{translateUi(label)}</option>)}</select></label>
        <button aria-expanded={extraFiltersOpen} className="accounting-filters__more" onClick={() => setExtraFiltersOpen((open) => !open)} type="button"><Funnel size={17} />{translateUi('ตัวกรองเพิ่มเติม')}{extraCount ? ` (${extraCount})` : ''}</button>
        {extraFiltersOpen ? <div className="accounting-filters__extra">
          <label><span>{translateUi('เงื่อนไขชำระปัจจุบัน')}</span><select aria-label={translateUi('เงื่อนไขชำระ')} onChange={(event) => updateFilter({ payment_term: (event.target.value || undefined) as AccountingFilters['payment_term'] })} value={filters.payment_term ?? ''}><option value="">{translateUi('ทุกเงื่อนไข')}</option>{Object.entries(paymentTermLabels).filter(([value]) => value !== 'mixed').map(([value, label]) => <option key={value} value={value}>{translateUi(label)}</option>)}</select></label>
          <label><span>{translateUi('เลือกร้านโดยตรง')}</span><select aria-label={translateUi('ร้าน')} onChange={(event) => updateFilter({ shop_id: event.target.value || undefined })} value={filters.shop_id ?? ''}><option value="">{translateUi('ทุกร้าน')}</option>{data.facets.shops.map((item) => <option key={item.value} value={item.value}>{formatAccountingShopFacetLabel(item.label)}</option>)}</select></label>
        </div> : null}
      </div>
      {activeFilters.length ? <div className="accounting-filter-chips" aria-label={translateUi('ตัวกรองที่ใช้อยู่')}>{activeFilters.map(([key]) => <button type="button" key={key} onClick={() => updateFilter(key === 'building_id' ? { building_id: undefined, zone_id: undefined } : { [key]: undefined })}>{translateUi(filterLabels[key] ?? key)}<X size={13} aria-label={translateUi('นำตัวกรองออก')} /></button>)}<button type="button" onClick={onClearFilters}>{translateUi('ล้างตัวกรองทั้งหมด')}</button></div> : null}
      {rangeError ? <p className="accounting-context-note" id="accounting-shop-date-error">{translateUi(rangeError)}</p> : null}
    </div>
    {loading ? <AccountingLoading /> : unavailable || rangeError ? null : <>
      <div className="accounting-overview" aria-label={translateUi('สรุปยอดการเงิน')}>
        <article className="accounting-metric accounting-metric--sales"><span>{translateUi('ยอดขายรายร้านในช่วง')}</span><strong>{money.format(totals.sales_amount)}</strong><div className="accounting-metric__breakdown"><span>{translateUi('รับชำระแล้ว ')}<b>{money.format(totals.paid_amount)}</b></span><span>{translateUi('ค้างของบิลช่วงนี้ ')}<b>{money.format(totals.outstanding_amount)}</b></span></div><small>{translateUi('รับชำระและค้างเป็นยอดปัจจุบัน รวมการชำระหลังช่วงรายงาน')}</small></article>
        <article className="accounting-metric accounting-metric--received"><span>{translateUi('เงินรับจริงจากร้านในช่วง')}</span><strong>{money.format(totals.cash_received_in_period)}</strong><div className="accounting-metric__breakdown"><span>{translateUi('เงินสด ')}<b>{money.format(totals.cash_in_period ?? 0)}</b></span><span>{translateUi('โอน ')}<b>{money.format(totals.transfer_in_period ?? 0)}</b></span></div><small>{translateUi('ตามวันที่รับเงิน รวมรับหนี้เก่าและร้านปิดใช้งาน')}</small><small>{translateUi('ตามร้าน/พื้นที่ · ไม่ตามสถานะหรือเงื่อนไขชำระ')}</small></article>
        <article className="accounting-metric accounting-metric--debt"><span>{translateUi('ยอดค้างสะสมของร้าน')}</span><strong>{money.format(totals.cumulative_outstanding_amount)}</strong><div className="accounting-metric__breakdown"><span>{totals.cumulative_outstanding_shop_count.toLocaleString('th-TH')}{translateUi(' ร้าน ')}<b>{translateUi('เกินกำหนด ')}{money.format(totals.cumulative_overdue_amount)}</b></span></div><small>{translateUi('หนี้ปัจจุบันทุกวันที่ขาย · เกินกำหนดรวมอยู่ในยอดค้าง')}</small></article>
        <button className="accounting-metric accounting-metric--review" aria-label={translateUi('เปิดหน้ารายการตรวจสอบ')} onClick={onOpenReview} type="button"><span>{translateUi('รายการต้องตรวจสอบ')}</span><strong>{reviewCount == null ? '—' : reviewCount.toLocaleString('th-TH')}<small>{translateUi(' รายการ')}</small></strong><small>{translateUi('ทั้งช่วงวันที่ · ไม่ตามตัวกรองร้าน')}</small><b>{translateUi('เปิดรายการตรวจสอบ →')}</b></button>
      </div>

      <div className="accounting-shop-view-actions">
        <div className="accounting-shop-view-switch" role="group" aria-label={translateUi('มุมมองสรุปรายร้าน')}><button aria-pressed={view === 'totals'} onClick={() => onViewChange('totals')} type="button">{translateUi('ยอดรวมช่วงวันที่')}</button><button aria-pressed={view === 'daily'} onClick={() => onViewChange('daily')} type="button">{translateUi('ตารางรายวัน')}</button></div>
      <details className="accounting-casual-summary"><summary><span>{translateUi('ลูกค้าขาจร ')}<small>{translateUi('ทั้งช่วงวันที่ ทุกพื้นที่ · ไม่ตามตัวกรองร้าน')}</small></span><strong>{translateUi('ยอดขาย ')}{totals.casual_sales_amount == null ? '—' : money.format(totals.casual_sales_amount)}</strong></summary><dl>{([
        ['รับเงิน', totals.casual_received_amount], ['คืนเงิน', totals.casual_refunded_amount], ['เงินสุทธิ', totals.casual_net_cash],
      ] as const).map(([label, value]) => <div key={label}><dt>{translateUi(String(label))}</dt><dd>{value == null ? '—' : money.format(value)}</dd></div>)}<div><dt>{translateUi('รายการแจก')}</dt><dd>{totals.casual_free_count?.toLocaleString('th-TH') ?? '—'}{translateUi(' ครั้ง')}</dd></div></dl></details>
        <label className="accounting-sort-label">{translateUi('เรียงตาม ')}<select aria-label={translateUi('เรียงลำดับ')} onChange={(event) => updateFilter({ shop_sort: event.target.value === 'area' ? undefined : event.target.value as AccountingFilters['shop_sort'] })} value={filters.shop_sort ?? 'area'}><option value="area">{translateUi('พื้นที่ / ลำดับส่ง')}</option><option value="outstanding">{translateUi('ค้างมากสุด')}</option><option value="overdue">{translateUi('เกินกำหนดมากสุด')}</option><option value="sales">{translateUi('ยอดขายมากสุด')}</option><option value="name">{translateUi('ชื่อร้าน')}</option><option value="code">{translateUi('รหัสร้าน')}</option></select></label>
      </div>
    {view === 'daily' ? <ShopDailyMatrix
      collapsedGroups={collapsedGroups}
      daily={daily}
      data={data}
      fromDate={fromDate}
      grouped={(filters.shop_sort ?? 'area') === 'area'}
      onOpenShop={onOpenShop}
      onShiftRange={(direction) => {
        if (windowMode === 'month') {
          const nextRange = calendarMonthRange(fromDate, today, direction);
          setFromDate(nextRange.fromDate);
          setToDate(nextRange.toDate);
          return;
        }
        const { dates, error: rangeError } = getDateRange(fromDate, toDate);
        if (rangeError) return;
        const days = windowMode === 'custom' ? dates.length : windowMode;
        if (direction < 0) {
          const nextToDate = shiftDate(fromDate, -1);
          setFromDate(shiftDate(nextToDate, -(days - 1)));
          setToDate(nextToDate);
          return;
        }
        const nextFromDate = shiftDate(toDate, 1);
        if (nextFromDate > today) return;
        setFromDate(nextFromDate);
        const nextToDate = shiftDate(nextFromDate, days - 1);
        setToDate(nextToDate > today ? today : nextToDate);
      }}
      onToggleGroup={(key) => setCollapsedGroups((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      })}
      toDate={toDate}
    /> : <ShopSummaryTable
      collapsedGroups={collapsedGroups}
      data={data}
      grouped={(filters.shop_sort ?? 'area') === 'area'}
      onOpenShop={onOpenShop}
      onToggleGroup={(key) => setCollapsedGroups((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      })}
    />}
    </>}
  </div>;
}

function shopGroupKey(row: Pick<AccountingShopSummaryRow, 'building_id' | 'current_zone_id'>) {
  return `${row.building_id}:${row.current_zone_id ?? 'none'}`;
}

function derivedShopGroup(rows: AccountingShopSummaryRow[]): AccountingShopSummaryGroup {
  const first = rows[0];
  return {
    building_id: first.building_id, building_name: first.building_name,
    current_zone_id: first.current_zone_id, current_zone_name: first.current_zone_name,
    building_sort_order: first.building_sort_order ?? 0, zone_sort_order: first.zone_sort_order ?? 0,
    total_shop_count: rows.length,
    purchased_shop_count: rows.filter((row) => row.sales_amount > 0).length,
    closed_shop_count: rows.filter((row) => row.period_activity_status === 'closed_shop').length,
    recorded_no_sale_shop_count: rows.filter((row) => row.period_activity_status === 'recorded_no_sale').length,
    not_recorded_shop_count: rows.filter((row) => row.period_activity_status === 'not_recorded' || row.sales_amount === 0 && !row.period_activity_status).length,
    sales_amount: rows.reduce((sum, row) => sum + row.sales_amount, 0),
    cumulative_outstanding_amount: rows.reduce((sum, row) => sum + row.cumulative_outstanding_amount, 0),
  };
}

const dailyStatusLabels: Record<AccountingShopDailyStatus, string> = {
  purchased: 'ซื้อแล้ว',
  recorded_no_sale: 'มีบันทึกแต่ไม่มีการขาย',
  no_purchase: 'ไม่ซื้อ',
  closed_shop: 'ปิดร้าน',
  not_recorded: 'ยังไม่บันทึก',
  not_scheduled: 'ไม่อยู่ในรอบ',
  skipped: 'ข้ามร้าน',
};

const dailyDate = uiDateTimeFormat({
  day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok', weekday: 'short',
});

function dayItemQuantity(day: AccountingShopDailyCell | undefined, iceTypeId: string) {
  return Number(day?.items.find((item) => item.ice_type_id === iceTypeId)?.quantity ?? 0);
}

function ShopDailyMatrix({ collapsedGroups, daily, data, fromDate, grouped, onOpenShop, onShiftRange, onToggleGroup, toDate }: {
  collapsedGroups: Set<string>;
  daily: AccountingShopDailyResponse;
  data: AccountingShopSummaryResponse;
  fromDate: string;
  grouped: boolean;
  onOpenShop: (shop: AccountingShopSummaryRow, serviceDate?: string) => void;
  onShiftRange: (direction: -1 | 1) => void;
  onToggleGroup: (key: string) => void;
  toDate: string;
}) {
  useLanguage();
  const { dates, error: rangeError } = getDateRange(fromDate, toDate);
  if (rangeError) return <p className="accounting-daily-matrix__state" id="accounting-shop-date-error">{translateUi(rangeError)}</p>;
  const dailyRows = new Map(daily.rows.map((row) => [row.shop_id, row]));
  const groups = new Map<string, AccountingShopSummaryRow[]>();
  data.rows.forEach((row) => {
    const key = shopGroupKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  });
  const dayColumnCount = daily.ice_types.length + 4;
  const totalColumnCount = 2 + dates.length * dayColumnCount;
  const tableWidth = 262 + dates.length * (daily.ice_types.length * 110 + 444);

  const renderDayCells = (shop: AccountingShopSummaryRow, day: AccountingShopDailyCell | undefined, date: string) => {
    if (!day) return <Fragment key={date}>
      {daily.ice_types.map((iceType) => <td className="accounting-daily-matrix__quantity" key={iceType.ice_type_id}><span aria-label={translateUi('{0} {1} {2} ไม่มีข้อมูล', { 0: shop.shop_code, 1: date, 2: iceType.name })}>—</span></td>)}
      <td className="accounting-daily-matrix__quantity"><span aria-label={translateUi('{0} {1} ถัง ไม่มีข้อมูล', { 0: shop.shop_code, 1: date })}>—</span></td>
      <td className="accounting-daily-matrix__money"><span aria-label={translateUi('{0} {1} ยอดขาย ไม่มีข้อมูล', { 0: shop.shop_code, 1: date })}>—</span></td>
      <td className="accounting-daily-matrix__money"><span aria-label={translateUi('{0} {1} เงินสด ไม่มีข้อมูล', { 0: shop.shop_code, 1: date })}>—</span></td>
      <td className="accounting-daily-matrix__money accounting-daily-matrix__received"><span aria-label={translateUi('{0} {1} โอน ไม่มีข้อมูล', { 0: shop.shop_code, 1: date })}>—</span></td>
    </Fragment>;

    const interactive = day.status === 'purchased';
    return <Fragment key={date}>
      {daily.ice_types.map((iceType, index) => {
        const quantity = dayItemQuantity(day, iceType.ice_type_id);
        const content = !interactive && index === 0
          ? <span className={`accounting-daily-status accounting-daily-status--${day.status}`}>{translateUi(dailyStatusLabels[day.status])}</span>
          : quantity ? number.format(quantity) : '—';
        return <td className="accounting-daily-matrix__quantity" key={iceType.ice_type_id}>
          {interactive ? <button aria-label={`${shop.shop_code} ${date} ${iceType.name}`} onClick={() => onOpenShop(shop, date)} type="button">{content}</button>
            : <span aria-label={`${shop.shop_code} ${date} ${index === 0 ? translateUi('สถานะ {0}', { 0: translateUi(dailyStatusLabels[day.status]) }) : iceType.name}`}>{content}</span>}
        </td>;
      })}
      <td className="accounting-daily-matrix__quantity"><span aria-label={translateUi('{0} {1} ถัง', { 0: shop.shop_code, 1: date })}>{Number(day.tank_quantity) ? number.format(Number(day.tank_quantity)) : '—'}</span></td>
      <td className="accounting-daily-matrix__money">
        {interactive ? <button aria-label={translateUi('{0} {1} ยอดขาย', { 0: shop.shop_code, 1: date })} onClick={() => onOpenShop(shop, date)} type="button"><strong>{money.format(Number(day.sales_amount))}</strong>{day.invoice_count > 1 ? <small>{day.invoice_count}{translateUi(' บิล')}</small> : null}</button>
          : <span aria-label={translateUi('{0} {1} ยอดขาย สถานะ {2}', { 0: shop.shop_code, 1: date, 2: translateUi(dailyStatusLabels[day.status]) })}><strong>{money.format(Number(day.sales_amount))}</strong>{!daily.ice_types.length ? <span className={`accounting-daily-status accounting-daily-status--${day.status}`}>{translateUi(dailyStatusLabels[day.status])}</span> : null}</span>}
      </td>
      <td className="accounting-daily-matrix__money"><span aria-label={translateUi('{0} {1} เงินสด', { 0: shop.shop_code, 1: date })}>{money.format(Number(day.cash_received))}</span></td>
      <td className="accounting-daily-matrix__money accounting-daily-matrix__received"><span aria-label={translateUi('{0} {1} โอน', { 0: shop.shop_code, 1: date })}>{money.format(Number(day.transfer_received ?? 0))}</span></td>
    </Fragment>;
  };

  const renderShopRow = (shop: AccountingShopSummaryRow) => {
    const row = dailyRows.get(shop.shop_id);
    const days = new Map((row?.days ?? []).map((day) => [day.service_date, day]));
    return <tr className={shop.payment_status === 'overdue' ? 'accounting-row--issue' : ''} key={shop.shop_id}>
      <td className="accounting-daily-matrix__sequence">{shop.delivery_sequence?.toLocaleString('th-TH') ?? '—'}</td>
      <th className="accounting-daily-matrix__shop"><button className="accounting-link" onClick={() => onOpenShop(shop)} type="button">{formatAccountingShopTitle(shop)}</button></th>
      {dates.map((date) => renderDayCells(shop, days.get(date), date))}
    </tr>;
  };

  return <div className="accounting-daily-matrix">
    <div className="accounting-daily-matrix__toolbar">
      <div className="accounting-daily-matrix__period">
        <button aria-label={translateUi('ช่วงก่อนหน้า')} onClick={() => onShiftRange(-1)} type="button"><CaretLeft size={18} /></button>
        <strong aria-live="polite">{accountingDate.format(new Date(`${fromDate}T12:00:00+07:00`))} – {accountingDate.format(new Date(`${toDate}T12:00:00+07:00`))}</strong>
        <button aria-label={translateUi('ช่วงถัดไป')} disabled={toDate >= toBangkokDateString()} onClick={() => onShiftRange(1)} type="button"><CaretRight size={18} /></button>
      </div>

    </div>
    <div className="accounting-table-wrap accounting-table-wrap--ledger accounting-daily-matrix__scroll"><table className="accounting-table accounting-daily-matrix__table" style={{ '--matrix-width': `${tableWidth}px` } as React.CSSProperties}>
      <colgroup>
        <col className="accounting-daily-matrix__col-sequence" /><col className="accounting-daily-matrix__col-shop" />
        {dates.flatMap((date) => [
          ...daily.ice_types.map((iceType) => <col className="accounting-daily-matrix__col-quantity" key={`${date}:${iceType.ice_type_id}`} />),
          <col className="accounting-daily-matrix__col-tank" key={`${date}:tank`} />,
          <col className="accounting-daily-matrix__col-money" key={`${date}:sales`} />,
          <col className="accounting-daily-matrix__col-money" key={`${date}:cash`} />,
          <col className="accounting-daily-matrix__col-money" key={`${date}:transfer`} />,
        ])}
      </colgroup>
      <thead>
        <tr><th className="accounting-daily-matrix__sequence" rowSpan={2}>{translateUi('ลำดับ')}</th><th className="accounting-daily-matrix__shop" rowSpan={2}>{translateUi('ร้าน')}</th>
          {dates.map((date) => <th className="accounting-daily-matrix__date" colSpan={dayColumnCount} key={date}>{dailyDate.format(new Date(`${date}T12:00:00+07:00`))}</th>)}
        </tr>
        <tr>{dates.flatMap((date) => [
          ...daily.ice_types.map((iceType) => <th key={`${date}:${iceType.ice_type_id}`} title={iceType.name}>{iceType.name}</th>),
          <th key={`${date}:tank`}>{translateUi('ถัง')}</th>, <th key={`${date}:sales`}>{translateUi('ยอดขาย')}</th>,
          <th key={`${date}:cash`}>{translateUi('เงินสด')}</th>, <th key={`${date}:transfer`}>{translateUi('โอน')}</th>,
        ])}</tr>
      </thead>
      <tbody>
        <tr className="accounting-daily-matrix__casual">
          <td className="accounting-daily-matrix__sequence">—</td>
          <th className="accounting-daily-matrix__shop">{translateUi('ลูกค้าขาจร')}<small>{translateUi('รวมทุกจุดถือครอง · ไม่ขึ้นกับตัวกรองร้าน/โซน')}</small></th>
          {dates.map((date) => {
            const day = daily.casual_days?.find((item) => item.service_date === date);
            return <Fragment key={`casual:${date}`}>
              {daily.ice_types.map((iceType) => {
                const item = day?.items.find((item) => item.ice_type_id === iceType.ice_type_id);
                return <td className="accounting-daily-matrix__quantity" key={iceType.ice_type_id} aria-label={translateUi('ลูกค้าขาจร {0} {1}', { 0: date, 1: iceType.name })}>
                  {day ? number.format(Number(item?.quantity ?? 0)) : '—'}
                  {Number(item?.automatic_quantity) > 0 ? <small>{translateUi('รวมจากยอดเงิน ')}{number.format(item!.automatic_quantity)} {iceType.unit}</small> : null}
                  {Number(item?.free_quantity) > 0 ? <small>{translateUi('รวมแจกฟรี ')}{number.format(item!.free_quantity)} {iceType.unit}</small> : null}
                  {Number(item?.loose_count) > 0 ? <small>{translateUi('แบ่งขาย/แจก ')}{item!.loose_count}{translateUi(' ครั้ง · ')}{money.format(item!.loose_sales_amount)}</small> : null}
                  {Number(item?.remainder_amount) > 0 ? <small>{translateUi('ยังไม่ครบถุง ')}{money.format(item!.remainder_amount)}</small> : null}
                  {Number(item?.unconverted_amount) > 0 ? <small>{translateUi('ยังไม่แปลงเป็นถุง ')}{money.format(item!.unconverted_amount!)}{translateUi(' · รายการเดิมปิดวันแล้วหรือไม่มีราคากลาง')}</small> : null}
                </td>;
              })}
              <td className="accounting-daily-matrix__quantity" aria-label={translateUi('ลูกค้าขาจร {0} ถัง', { 0: date })}>—</td>
              <td className="accounting-daily-matrix__money" aria-label={translateUi('ลูกค้าขาจร {0} ยอดขาย', { 0: date })}>{day ? money.format(day.sales_amount) : '—'}</td>
              <td className="accounting-daily-matrix__money" aria-label={translateUi('ลูกค้าขาจร {0} เงินสด', { 0: date })}>{day ? money.format(day.cash_received) : '—'}{day && day.cash_refunded > 0 ? <small>{translateUi('คืนเงิน ')}{money.format(day.cash_refunded)}{translateUi(' · สุทธิ ')}{money.format(day.cash_received - day.cash_refunded)}</small> : null}</td>
              <td className="accounting-daily-matrix__money accounting-daily-matrix__received" aria-label={translateUi('ลูกค้าขาจร {0} โอน', { 0: date })}>{day ? money.format(day.transfer_received ?? 0) : '—'}{day && Number(day.transfer_refunded) > 0 ? <small>{translateUi('คืนเงิน ')}{money.format(day.transfer_refunded!)}{translateUi(' · สุทธิ ')}{money.format(Number(day.transfer_received ?? 0) - day.transfer_refunded!)}</small> : null}</td>
            </Fragment>;
          })}
        </tr>
        {!data.rows.length ? <tr><td colSpan={totalColumnCount}>{translateUi('ไม่พบร้านที่ตรงกับตัวกรอง')}</td></tr> : !grouped ? data.rows.map(renderShopRow) : [...groups.entries()].map(([key, rows]) => {
          const group = derivedShopGroup(rows);
          const collapsed = collapsedGroups.has(key);
          const groupDailyRows = rows.map((row) => dailyRows.get(row.shop_id)).filter(Boolean);
          const groupDailyComplete = rows.every((row) => {
            const dailyRow = dailyRows.get(row.shop_id);
            return dates.every((date) => dailyRow?.days.some((day) => day.service_date === date));
          });
          const groupDayCells = groupDailyRows.flatMap((row) => dates.map((date) => row?.days.find((day) => day.service_date === date)).filter((day): day is AccountingShopDailyCell => Boolean(day)));
          const groupReceived = groupDailyComplete ? groupDayCells.reduce((sum, day) => sum + Number(day.cash_received) + Number(day.transfer_received ?? 0), 0) : null;
          const statusCounts = groupDayCells.reduce((counts, day) => {
            counts[day.status] += 1;
            return counts;
          }, { purchased: 0, recorded_no_sale: 0, no_purchase: 0, closed_shop: 0, not_recorded: 0, not_scheduled: 0, skipped: 0 } as Record<AccountingShopDailyStatus, number>);
          return <Fragment key={key}>
            <tr className="accounting-shop-group accounting-daily-matrix__group"><th colSpan={totalColumnCount}><button aria-expanded={!collapsed} onClick={() => onToggleGroup(key)} type="button"><span aria-hidden="true">{collapsed ? '▶' : '▼'}</span><strong>{formatAccountingGroupTitle(group.building_name, group.current_zone_name)}</strong><span>{translateUi('หน้านี้ ')}{group.total_shop_count.toLocaleString('th-TH')}{translateUi(' ร้าน')}</span>{groupDailyComplete ? <><span>{translateUi('ซื้อแล้ว ')}{statusCounts.purchased.toLocaleString('th-TH')}</span>{statusCounts.recorded_no_sale ? <span>{translateUi('มีบันทึกแต่ไม่มีการขาย ')}{statusCounts.recorded_no_sale.toLocaleString('th-TH')}</span> : null}<span>{translateUi('ไม่ซื้อ ')}{statusCounts.no_purchase.toLocaleString('th-TH')}</span><span>{translateUi('ยังไม่บันทึก ')}{statusCounts.not_recorded.toLocaleString('th-TH')}</span></> : <span>{translateUi('ข้อมูลรายวันไม่ครบ')}</span>}<span>{translateUi('ยอดขาย ')}{money.format(group.sales_amount)}</span><span>{translateUi('รับจริงเฉพาะร้านในหน้านี้ ')}{groupReceived == null ? '—' : money.format(groupReceived)}</span><span>{translateUi('ค้าง ')}{money.format(group.cumulative_outstanding_amount)}</span></button></th></tr>
            {collapsed ? null : <>
              {rows.map(renderShopRow)}
              <tr className="accounting-daily-matrix__totals"><th colSpan={2}>{translateUi('รวมร้านในหน้านี้ ')}{formatAccountingGroupTitle(group.building_name, group.current_zone_name)}</th>
                {dates.map((date) => {
                  const dayCells = rows.map((shop) => dailyRows.get(shop.shop_id)?.days.find((day) => day.service_date === date));
                  const complete = dayCells.every(Boolean);
                  return <Fragment key={date}>
                    {daily.ice_types.map((iceType) => <td key={iceType.ice_type_id}>{complete ? number.format(dayCells.reduce((sum, day) => sum + dayItemQuantity(day, iceType.ice_type_id), 0)) : '—'}</td>)}
                    <td>{complete ? number.format(dayCells.reduce((sum, day) => sum + Number(day?.tank_quantity ?? 0), 0)) : '—'}</td>
                    <td>{complete ? money.format(dayCells.reduce((sum, day) => sum + Number(day?.sales_amount), 0)) : '—'}</td>
                    <td>{complete ? money.format(dayCells.reduce((sum, day) => sum + Number(day?.cash_received), 0)) : '—'}</td>
                    <td>{complete ? money.format(dayCells.reduce((sum, day) => sum + Number(day?.transfer_received ?? 0), 0)) : '—'}</td>
                  </Fragment>;
                })}
              </tr>
            </>}
          </Fragment>;
        })}
      </tbody>
    </table></div>
    <div className="accounting-daily-matrix__legend" aria-label={translateUi('ความหมายสถานะ')}>
      <span>{translateUi('แถวลูกค้าขาจรรวมยอดทุกจุดถือครองในช่วงวันที่เลือก ไม่รวมซ้ำในยอดของกลุ่มร้าน')}</span>
      {(Object.entries(dailyStatusLabels) as Array<[AccountingShopDailyStatus, string]>).filter(([status]) => status !== 'purchased').map(([status, label]) => <span key={status}><i className={`accounting-daily-status accounting-daily-status--${status}`} />{translateUi(label)}</span>)}
    </div>
  </div>;
}

function ShopSummaryTable({ collapsedGroups, data, grouped, onOpenShop, onToggleGroup }: {
  collapsedGroups: Set<string>;
  data: AccountingShopSummaryResponse;
  grouped: boolean;
  onOpenShop: (shop: AccountingShopSummaryRow) => void;
  onToggleGroup: (key: string) => void;
}) {
  useLanguage();
  const groups = new Map<string, AccountingShopSummaryRow[]>();
  data.rows.forEach((row) => {
    const key = shopGroupKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  });
  return <div className="accounting-table-wrap accounting-table-wrap--ledger"><table className="accounting-table accounting-shop-table"><thead><tr className="accounting-column-groups"><th rowSpan={2}>{translateUi('ร้าน')}</th><th colSpan={3}>{translateUi('บิลในช่วงที่เลือก · ยอดรับชำระปัจจุบัน')}</th><th colSpan={2}>{translateUi('หนี้สะสมปัจจุบัน')}</th><th rowSpan={2}>{translateUi('จำนวนบิล')}</th><th rowSpan={2}>{translateUi('ครบกำหนดเก่าสุด')}</th><th rowSpan={2}>{translateUi('สถานะชำระ')}</th></tr><tr><th>{translateUi('ยอดขายช่วงนี้')}</th><th>{translateUi('รับแล้วของยอดช่วงนี้')}</th><th>{translateUi('ค้างของบิลช่วงนี้')}</th><th>{translateUi('ค้างสะสม')}</th><th>{translateUi('เกินกำหนดสะสม')}</th></tr></thead><tbody>
    {!data.rows.length ? <tr><td colSpan={9}>{translateUi('ไม่พบร้านที่ตรงกับตัวกรอง')}</td></tr>
      : grouped ? [...groups.entries()].map(([key, rows]) => {
        const group = derivedShopGroup(rows);
        const collapsed = collapsedGroups.has(key);
        return <Fragment key={key}>
          <tr className="accounting-shop-group"><th colSpan={9}><button aria-expanded={!collapsed} onClick={() => onToggleGroup(key)} type="button"><span aria-hidden="true">{collapsed ? '▶' : '▼'}</span><strong>{formatAccountingGroupTitle(group.building_name, group.current_zone_name, ' / ')}</strong><span>{translateUi('หน้านี้ ')}{group.total_shop_count.toLocaleString('th-TH')}{translateUi(' ร้าน')}</span><span>{translateUi('ซื้อ ')}{group.purchased_shop_count.toLocaleString('th-TH')}</span>{group.recorded_no_sale_shop_count ? <span>{translateUi('มีบันทึกแต่ไม่มีการขาย ')}{group.recorded_no_sale_shop_count.toLocaleString('th-TH')}</span> : null}{group.closed_shop_count ? <span>{translateUi('ปิดร้าน ')}{group.closed_shop_count.toLocaleString('th-TH')}</span> : null}<span>{translateUi('ยังไม่มีบันทึก ')}{group.not_recorded_shop_count.toLocaleString('th-TH')}</span><span>{translateUi('ยอด ')}{money.format(group.sales_amount)}</span><span>{translateUi('ค้าง ')}{money.format(group.cumulative_outstanding_amount)}</span></button></th></tr>
          {collapsed ? null : rows.map((row) => <ShopSummaryRow key={row.shop_id} onOpenShop={onOpenShop} row={row} />)}
        </Fragment>;
      }) : data.rows.map((row) => <ShopSummaryRow key={row.shop_id} onOpenShop={onOpenShop} row={row} />)}
  </tbody></table></div>;
}

function ShopSummaryRow({ onOpenShop, row }: { onOpenShop: (shop: AccountingShopSummaryRow) => void; row: AccountingShopSummaryRow }) {
  useLanguage();
  return <tr className={row.payment_status === 'overdue' ? 'accounting-row--issue' : ''} onClick={() => onOpenShop(row)}><th><button aria-label={formatAccountingShopTitle(row)} aria-describedby={`accounting-shop-${row.shop_id}`} className="accounting-link accounting-shop-identity" onClick={(event) => { event.stopPropagation(); onOpenShop(row); }} type="button"><span>{formatAccountingShopTitle(row)}</span><small id={`accounting-shop-${row.shop_id}`}>{formatAccountingGroupTitle(row.building_name, row.current_zone_name, ' / ')} · {row.payment_term ? translateUi(paymentTermLabels[row.payment_term]) : translateUi('ไม่ระบุเงื่อนไข')} · {row.delivery_sequence == null ? translateUi('ยังไม่ได้กำหนดลำดับส่ง') : translateUi('ลำดับส่ง {0}', { 0: row.delivery_sequence.toLocaleString('th-TH') })}</small></button></th><td>{money.format(row.sales_amount)}</td><td>{money.format(row.paid_amount)}</td><td>{money.format(row.outstanding_amount)}</td><td>{money.format(row.cumulative_outstanding_amount)}</td><td>{money.format(row.cumulative_overdue_amount)}</td><td>{row.invoice_count.toLocaleString('th-TH')}</td><td>{row.oldest_outstanding_due_date ? accountingDate.format(new Date(`${row.oldest_outstanding_due_date}T12:00:00+07:00`)) : '—'}</td><td><span className={`accounting-payment-status accounting-payment-status--${row.payment_status}`}>{translateUi(paymentStatusLabels[row.payment_status])}</span></td></tr>;
}

function ShopInvoiceDetail({ entries, error, fromDate, loading, onClose, onOpenDocument, shop, toDate }: {
  entries: AccountingShopInvoiceDetailEntry[]; error: string | null; fromDate: string; loading: boolean;
  onClose: () => void; onOpenDocument: (document: string, date?: string) => void;
  shop: AccountingShopSummaryRow; toDate: string;
}) {
  useLanguage();
  const ref = useAccountingDialog(onClose);
  const [slipError, setSlipError] = useState<string | null>(null);
  const openSlip = async (path: string) => {
    const client = supabase;
    if (!client) return;
    const slipWindow = window.open('', '_blank');
    if (!slipWindow) {
      setSlipError('เบราว์เซอร์บล็อกหน้าต่างสลิป กรุณาอนุญาตป๊อปอัปแล้วลองใหม่');
      return;
    }
    setSlipError(null);
    try {
      const url = await getHybridObjectUrl('payment-evidence', path, async () => {
        const { data, error: urlError } = await client.storage.from('payment-evidence').createSignedUrl(path, 3600);
        if (urlError || !data?.signedUrl) throw urlError ?? new Error('ไม่สามารถเปิดสลิปได้');
        return data.signedUrl;
      });
      slipWindow.location.href = url;
    } catch (viewError) {
      slipWindow.close();
      setSlipError(getErrorMessage(viewError));
    }
  };
  const inPeriod = entries.filter((entry) => entry.service_date >= fromDate && entry.service_date <= toDate);
  const outsidePeriod = entries.filter((entry) => entry.service_date < fromDate || entry.service_date > toDate);
  return <section ref={ref} tabIndex={-1} aria-label={translateUi('รายละเอียดบิลของ {0}', { 0: formatAccountingShopTitle(shop) })} aria-modal="true" className="accounting-shop-detail" role="dialog">
    <header><div><p className="eyebrow">{translateUi('รายละเอียดตามใบส่งของ / ใบแจ้งหนี้')}</p><h2>{formatAccountingShopTitle(shop)}</h2><span>{translateUi('ช่วงสรุปและบิลค้างนอกช่วง: ')}{accountingDate.format(new Date(`${fromDate}T12:00:00+07:00`))} – {accountingDate.format(new Date(`${toDate}T12:00:00+07:00`))}</span><small>{translateUi('ยอดรับแล้วและยอดค้างเป็นยอดปัจจุบัน จึงรวมการรับชำระหลังช่วงสรุป')}</small></div><button aria-label={translateUi('ปิดรายละเอียดร้าน')} onClick={onClose} type="button"><X size={19} /></button></header>
    <div className="accounting-invoice-scroll">
      {slipError ? <p className="credit-ar__action-error" role="alert">{translateUi(slipError)}</p> : null}
      <div className="accounting-invoice-overview"><span>{translateUi('ค้างสะสมปัจจุบันของร้าน ')}<strong>{money.format(shop.cumulative_outstanding_amount)}</strong></span><span>{translateUi('ในจำนวนนี้เกินกำหนด ')}<strong>{money.format(shop.cumulative_overdue_amount)}</strong></span></div>
      {loading ? <AccountingLoading /> : error ? <p className="credit-ar__action-error" role="alert">{translateUi(error)}</p> : entries.length ? ([['บิลในช่วงที่เลือก', inPeriod], ['บิลค้างนอกช่วง', outsidePeriod]] as const).map(([heading, group]) => group.length ? <section className="accounting-invoice-group" key={heading}><h3>{heading} <small>{group.length}{translateUi(' รายการ')}</small></h3>{group.map((entry) => {
        const status = entry.delivery_status === 'replaced' ? 'ถูกแทนที่แล้ว' : entry.delivery_status === 'cancelled' || entry.charge_status === 'voided' ? 'ยกเลิกแล้ว' : entry.payment_status ? invoicePaymentStatusLabels[entry.payment_status] : 'ข้อมูลเดิม';
        const outsideLabel = entry.service_date < fromDate ? 'หนี้ค้างก่อนช่วง' : entry.service_date > toDate ? 'บิลค้างหลังช่วง' : null;
        return <details className="accounting-invoice" key={entry.delivery_event_id}><summary>
          <span><strong>{entry.charge_number ?? translateUi('รายการเดิมก่อนใช้ระบบบิล')}</strong><small>{accountingDate.format(new Date(`${entry.service_date}T12:00:00+07:00`))}{outsideLabel ? ` · ${outsideLabel}` : ''}</small></span>
          <span><small>{translateUi('ยอดขาย')}</small><strong>{entry.total_amount == null ? '—' : money.format(Number(entry.total_amount))}</strong></span>
          <span><small>{translateUi('รับแล้ว')}</small><strong>{money.format(Number(entry.allocated_amount))}</strong></span>
          <span><small>{translateUi('ค้าง')}</small><strong>{money.format(Number(entry.outstanding_amount))}</strong></span>
          <span className={`accounting-payment-status accounting-payment-status--${entry.payment_status === 'paid' ? 'paid' : 'outstanding'}`}>{status}</span>
        </summary><div className="accounting-invoice-body">
          <p>{translateUi('พื้นที่ ณ เวลาขาย: ')}{[entry.building_name, entry.historical_zone_name].filter(Boolean).join(' / ') || '—'}{translateUi(' · ผู้บันทึก: ')}{entry.recorded_by_name || '—'} · {accountingDateTime(entry.recorded_at)}</p>
          {entry.event_name ? <p>{translateUi('งาน ')}{entry.event_name} · {[entry.event_location, entry.event_zone, entry.event_booth].filter(Boolean).join(' / ')}</p> : null}
          <div className="accounting-invoice-sections"><section><h4>{translateUi('สินค้าและราคา')}</h4>{entry.items.length ? <ul>{entry.items.map((item) => <li key={item.ice_type_id}><span>{item.name} {Number(item.quantity).toLocaleString('th-TH')} {item.unit}<small>{translateUi('ราคาต่อหน่วย ')}{item.unit_price == null ? '—' : money.format(Number(item.unit_price))}</small></span><strong>{item.line_total == null ? '—' : money.format(Number(item.line_total))}</strong></li>)}</ul> : <p>{translateUi('ไม่มีรายละเอียดสินค้า')}</p>}</section>
          <section><h4>{translateUi('ประวัติรับชำระ')}</h4>{entry.payments.length ? <ul>{entry.payments.map((payment) => <li key={payment.payment_id}><span>{translateUi(paymentMethodLabels[payment.payment_method])}<small>{payment.received_date_override ? formatReceiptDate(payment.received_date_override) : accountingDateTime(payment.recorded_at)}</small>{payment.entered_at ? <small>{translateUi('บันทึกเมื่อ ')}{accountingDateTime(payment.entered_at)}</small> : null}{payment.payment_method !== 'cash' && payment.evidence_path ? <button className="accounting-payment-slip" onClick={() => void openSlip(payment.evidence_path!)} type="button">{translateUi('ดูสลิป')}</button> : null}</span><strong>{money.format(Number(payment.amount))}</strong></li>)}</ul> : <p>{translateUi('ยังไม่มีการรับชำระ')}</p>}</section></div>
          {entry.adjustments.length ? <section><h4>{translateUi('ประวัติปรับปรุง')}</h4><div className="accounting-shop-detail__adjustments">{entry.adjustments.map((adjustment) => <div key={adjustment.id}><strong>{adjustment.reason}</strong><small>{accountingDateTime(adjustment.created_at)}</small>{adjustment.items.map((item) => <p key={item.ice_type_id}>{translateUi('{0} {1} {2} → แก้เป็น {3} {4} (เปลี่ยน {5})', { 0: item.name, 1: Number(item.original_quantity).toLocaleString('th-TH'), 2: item.unit, 3: Number(item.corrected_quantity).toLocaleString('th-TH'), 4: item.unit, 5: Number(item.quantity_delta).toLocaleString('th-TH') })}</p>)}<p>{translateUi('ยอดปรับ ')}{money.format(Number(adjustment.amount_delta))}</p><p>{translateUi('ยอดหลังปรับ ')}{adjustment.corrected_total == null ? '—' : money.format(Number(adjustment.corrected_total))}</p></div>)}</div></section> : null}
          {entry.charge_number ? <button className="accounting-source-button" type="button" onClick={() => onOpenDocument(entry.charge_number!, entry.service_date)}>{translateUi('ดูเอกสารต้นทาง ')}{entry.charge_number}</button> : <small>{translateUi('รายการเดิมไม่มีเลขเอกสารอ้างอิง')}</small>}
        </div></details>;
      })}</section> : null) : <p>{translateUi('ไม่พบบิลในช่วงสรุปและไม่มีบิลค้างนอกช่วง')}</p>}
    </div>
  </section>;
}

function AccountingPagination({ page, pageSize, setPage, totalCount }: { page: number; pageSize: number; setPage: (update: (value: number) => number) => void; totalCount: number }) {
  useLanguage();
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  return <div className="accounting-pagination"><span>{translateUi('ทั้งหมด ')}{totalCount.toLocaleString('th-TH')}{translateUi(' รายการ')}</span><button disabled={page === 0} onClick={() => setPage((value) => value - 1)} type="button">{translateUi('ก่อนหน้า')}</button><strong>{page + 1} / {totalPages}</strong><button disabled={page + 1 >= totalPages} onClick={() => setPage((value) => value + 1)} type="button">{translateUi('ถัดไป')}</button></div>;
}

function ReconciliationPanel({ data, loading, serviceDate, setServiceDate }: { data: AccountingReconciliation | null; loading: boolean; serviceDate: string; setServiceDate: (date: string) => void }) {
  useLanguage();
  const financial = data?.financial;
  const sections = financial ? [
    { title: 'ยอดขายและการชำระบิล', rows: [['ยอดขายหลังปรับปรุง', financial.effective_sales], ['รับชำระบิลของวันนี้แล้ว', financial.allocated_to_sales], ['ค้างที่ต้องเก็บ', financial.outstanding_collectible], ['ลูกหนี้เครดิต', financial.outstanding_credit]], note: 'ตามวันที่ขาย · ยอดรับชำระเป็นยอดปัจจุบัน' },
    { title: 'เงินรับและคืน', rows: [['รับเงินจริง', financial.cash_received], ['คืนเงินจริง', financial.cash_refunded], ['เงินสุทธิ', financial.net_cash], ['ยอดรอคืน', financial.pending_refunds]], note: 'ตามวันที่รับและคืนเงินจริง' },
    { title: 'ลูกค้าขาจร', rows: [['ยอดขายขาจร', financial.casual_sales], ['รับเงินจริงขาจร', financial.casual_received], ['คืนเงินจริงขาจร', financial.casual_refunded]], note: 'รวมอยู่ในยอดขายและเงินรับ–คืนด้านซ้ายแล้ว' },
  ] : [];
  return <div className="accounting-reconciliation">
    <label className="accounting-reconciliation__date">{translateUi('วันที่เทียบยอด ')}<input aria-label={translateUi('วันที่เทียบยอด')} max={toBangkokDateString()} onChange={(event) => { if (dateKeyTimestamp(event.target.value) != null && event.target.value <= toBangkokDateString()) setServiceDate(event.target.value); }} type="date" value={serviceDate} /></label>
    {loading ? <AccountingLoading /> : data ? <><div className="accounting-reconciliation-groups">{sections.map((section) => <article key={section.title}><h3>{translateUi(section.title)}</h3><small>{translateUi(section.note)}</small><dl>{section.rows.map(([label, value]) => <div key={String(label)}><dt>{translateUi(String(label))}</dt><dd>{value == null ? '—' : money.format(Number(value))}</dd></div>)}</dl></article>)}</div>
      <ReconciliationTable heading={translateUi('สต๊อกรวมประจำวัน')} rows={data.aggregate} />
      <details className="accounting-holder-details"><summary>{translateUi('สต๊อกแยกจุดถือครอง ')}<span>{data.holders.length}{translateUi(' จุด')}</span></summary>{data.holders.length ? data.holders.map((holder) => <ReconciliationTable key={holder.location_id} heading={`${holder.location_name}${holder.employee_name ? ` · ${holder.employee_name}` : ''}`} rows={holder.items} />) : <p>{translateUi('ไม่มีข้อมูลจุดถือครองในวันนี้')}</p>}</details>
    </> : null}
  </div>;
}

function ReconciliationTable({ heading, rows }: { heading: string; rows: AccountingReconciliation['aggregate'] }) {
  useLanguage();
  return <article className="accounting-reconciliation__table"><h3>{heading}</h3><div className="accounting-table-wrap"><table><thead><tr><th>{translateUi('ชนิด')}</th><th>{translateUi('โรงงานเข้า')}</th><th>{translateUi('ขาย')}</th><th>{translateUi('เติมเดิม')}</th><th>{translateUi('เสียหาย')}</th><th>{translateUi('ควรเหลือ')}</th><th>{translateUi('นับจริง')}</th><th>{translateUi('คืนตอนปิด')}</th><th>{translateUi('ต่าง')}</th><th>{translateUi('สถานะ')}</th></tr></thead><tbody>{rows.length ? rows.map((row) => <tr className={row.variance || row.count_status === 'stale' ? 'accounting-row--issue' : ''} key={row.ice_type_id}><th>{row.ice_type_name}<small>{translateUi('หน่วย: ')}{row.unit}</small></th><td>{number.format(row.factory_in)}</td><td>{number.format(row.sold)}</td><td>{number.format(row.legacy_refill ?? 0)}</td><td>{number.format(row.damaged)}</td><td>{number.format(row.expected)}</td><td>{row.actual == null ? '—' : number.format(row.actual)}</td><td>{number.format(row.closed_returned_to_factory ?? 0)}</td><td>{row.variance == null ? '—' : number.format(row.variance)}</td><td>{row.count_status === 'incomplete' ? translateUi('ยังนับไม่ครบ') : row.count_status === 'stale' ? translateUi('ยอดนับล้าสมัย') : row.variance ? translateUi('ต้องตรวจสอบ') : translateUi('ตรงยอด')}</td></tr>) : <tr><td colSpan={10}>{translateUi('ยังไม่มีข้อมูล')}</td></tr>}</tbody></table></div></article>;
}

function TransactionsTable({ rows, sort, setSort, onOpen }: { rows: AccountingTransaction[]; sort: AccountingSort; setSort: (sort: AccountingSort) => void; onOpen: (row: AccountingTransaction) => void }) {
  useLanguage();
  const columns = [['occurred_at', 'วัน/เวลา'], ['document_number', 'เอกสาร'], ['type', 'ประเภท'], ['shop_name', 'ร้าน'], ['sales_amount', 'ยอดขาย'], ['cash_in', 'เงินเข้า'], ['cash_out', 'เงินออก'], ['status', 'สถานะ']] as const;
  return <div className="accounting-table-wrap accounting-table-wrap--ledger"><table className="accounting-table accounting-transactions-table"><thead><tr>{columns.map(([key, label]) => <th key={key} aria-sort={sort.key === key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><SortButton column={key} label={label} onChange={setSort} sort={sort} /></th>)}<th>{translateUi('รายละเอียด')}</th></tr></thead><tbody>{rows.length ? rows.map((row) => <tr className={row.issue_code ? 'accounting-row--issue' : `accounting-row--${row.type.toLowerCase()}`} key={`${row.type}-${row.source_id}-${row.ice_type_id ?? ''}`} onClick={() => onOpen(row)}>
    <td>{accountingDateTime(row.occurred_at)}</td><td><button className="accounting-link" onClick={(event) => { event.stopPropagation(); onOpen(row); }} type="button">{row.document_number}</button>{row.ice_type_name ? <small>{row.ice_type_name}</small> : null}</td><td><span className={`accounting-type accounting-type--${row.type.toLowerCase()}`}>{translateUi(typeLabels[row.type] ?? row.type)}</span></td><td>{row.shop_name ?? '—'}</td><td>{money.format(row.sales_amount)}</td><td>{money.format(row.cash_in)}</td><td>{money.format(row.cash_out)}</td><td>{translateUi(row.issue_label ?? accountingStatus(row.status))}</td><td><button type="button" className="accounting-link" onClick={(event) => { event.stopPropagation(); onOpen(row); }}>{translateUi('ดูรายละเอียด')}</button></td></tr>) : <tr><td colSpan={9}>{translateUi('ไม่พบรายการที่ตรงตัวกรอง')}</td></tr>}</tbody></table></div>;
}

function ReviewQueue({ onOpenSource, onResolve, resolvingIssueId, rows }: {
  onOpenSource: (item: AccountingReviewResponse['rows'][number]) => void;
  onResolve: (item: AccountingReviewResponse['rows'][number]) => void;
  resolvingIssueId: string | null; rows: AccountingReviewResponse['rows'];
}) {
  useLanguage();
  return <div className="accounting-table-wrap"><table className="accounting-table accounting-review-table"><thead><tr><th>{translateUi('ความสำคัญ')}</th><th>{translateUi('ประเด็นที่ต้องตรวจสอบ')}</th><th>{translateUi('เอกสาร / ผู้เกี่ยวข้อง')}</th><th>{translateUi('วันที่')}</th><th>{translateUi('ดำเนินการ')}</th></tr></thead><tbody>{rows.length ? rows.map((item) => <tr key={item.issue_id}>
    <td><span className={`accounting-severity accounting-severity--${item.severity}`}><WarningCircle size={16} />{item.severity === 'critical' ? translateUi('เร่งด่วน') : translateUi('ตรวจสอบ')}</span></td><td><strong>{item.title}</strong><p>{item.description}</p></td><td>{item.document_number ?? '—'}{item.shop_name ? <small>{item.shop_name}</small> : null}</td><td>{accountingDate.format(new Date(`${item.service_date}T12:00:00+07:00`))}</td><td><div className="accounting-review-actions">{item.document_number || ['STOCK_VARIANCE', 'CASH_VARIANCE'].includes(item.issue_type) ? <button type="button" onClick={() => onOpenSource(item)}>{item.document_number ? translateUi('ดูเอกสารต้นทาง') : translateUi('ดูยอดประจำวัน')}</button> : null}{item.issue_id.startsWith('daily-close-') ? <button disabled={Boolean(resolvingIssueId)} onClick={() => onResolve(item)} type="button">{translateUi('ปิดประเด็น')}</button> : null}</div></td>
  </tr>) : <tr><td colSpan={5}>{translateUi('ไม่มีรายการต้องตรวจสอบที่ตรงกับช่วงวันที่และตัวกรอง')}</td></tr>}</tbody></table></div>;
}

function TransactionDrawer({ row, receiptSnapshot, receiptLoading, receiptError, correctionTargets, onClose, onCorrect, onRetry }: {
  row: AccountingTransaction; receiptSnapshot: StoredSalesDocument | null; receiptLoading: boolean; receiptError: string | null;
  correctionTargets: Array<{ charge_id: string; charge_number: string; delivery_event_id: string }>;
  onClose: () => void; onCorrect: (eventId: string) => void; onRetry: () => void;
}) {
  useLanguage();
  const ref = useAccountingDialog(onClose);
  return <div className="accounting-drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><aside ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={translateUi('รายละเอียด {0}', { 0: row.document_number })} className="accounting-drawer">
    <header><div><p className="eyebrow">{translateUi(typeLabels[row.type])} · {row.type}</p><h2>{row.document_number}</h2></div><button aria-label={translateUi('ปิด')} onClick={onClose} type="button"><X size={20} /></button></header>
    <dl><div><dt>{translateUi('สถานะ')}</dt><dd>{translateUi(row.issue_label ?? accountingStatus(row.status))}</dd></div><div><dt>{translateUi('วันเวลาบันทึก')}</dt><dd>{accountingDateTime(row.occurred_at)}</dd></div><div><dt>{translateUi('ร้าน')}</dt><dd>{row.shop_name ?? '—'}</dd></div><div><dt>{translateUi('เลขอ้างอิง')}</dt><dd>{row.reference_number ?? '—'}</dd></div><div><dt>{translateUi('จุดถือครอง')}</dt><dd>{row.holder_name ?? '—'}</dd></div><div><dt>{translateUi('ผู้บันทึก')}</dt><dd>{row.employee_name ?? '—'}</dd></div><div><dt>{translateUi('ชนิดน้ำแข็ง')}</dt><dd>{row.ice_type_name ?? '—'}</dd></div><div><dt>{translateUi('ปริมาณเข้า / ออก')}</dt><dd>{number.format(row.quantity_in)} / {number.format(row.quantity_out)} {row.unit ?? ''}</dd></div><div><dt>{translateUi('ยอดขาย')}</dt><dd>{money.format(row.sales_amount)}</dd></div><div><dt>{translateUi('ผลต่อลูกหนี้')}</dt><dd>{money.format(row.receivable_delta)}</dd></div><div><dt>{translateUi('เงินเข้า')}</dt><dd>{money.format(row.cash_in)}</dd></div><div><dt>{translateUi('เงินออก')}</dt><dd>{money.format(row.cash_out)}</dd></div></dl>
    {row.note ? <section><h3>{translateUi('หมายเหตุ')}</h3><p>{row.note}</p></section> : null}
    {receiptLoading ? <p role="status">{translateUi('กำลังโหลดสำเนาใบเสร็จ…')}</p> : null}
    {receiptSnapshot ? <ReceiptPreview receipt={receiptSnapshot} /> : !receiptLoading && row.type === 'REC' && !receiptError ? <p>{translateUi('ไม่มีสำเนาใบเสร็จสำหรับรายการนี้')}</p> : null}
    {receiptError ? <div className="accounting-error" role="alert"><span>{translateUi(receiptError)}</span><button type="button" onClick={onRetry}>{translateUi('ลองโหลดรายละเอียดอีกครั้ง')}</button></div> : null}
    <footer><small>{translateUi('ดำเนินการที่เอกสารต้นทางตามสิทธิ์ของคุณ')}</small>{row.type === 'INV' && row.can_correct && row.delivery_event_id ? <button className="accounting-danger-button" onClick={() => onCorrect(row.delivery_event_id!)} type="button">{translateUi('ยกเลิกใบส่งน้ำแข็ง')}</button> : null}{row.type === 'REC' ? correctionTargets.map((target) => <button className="accounting-danger-button" key={target.charge_id} onClick={() => onCorrect(target.delivery_event_id)} type="button">{translateUi('ยกเลิกใบส่ง ')}{target.charge_number}</button>) : null}</footer>
  </aside></div>;
}
