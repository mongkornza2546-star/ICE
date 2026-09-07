import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, ClockCounterClockwise, FileText, ListBullets, WarningCircle } from '@phosphor-icons/react';
import { supabase } from './lib/supabase';
import { toBangkokDateString } from './lib/serviceDate';
import { MAX_PAYMENT_EVIDENCE_SIZE, uploadPaymentEvidence } from './lib/paymentEvidence';
import { getErrorMessage } from './lib/errorMessage';
import { printSalesDocumentForCurrentPlatform } from './lib/salesDocumentPrint';
import { isAndroidApp } from './lib/thermalPrinter';
import { usePendingRequests } from './features/employee-delivery/usePendingRequests';
import { CollectionRunSection } from './features/financial-operations/components/CollectionRunSection';
import { CollectionDesk } from './features/financial-operations/components/CollectionDesk';
import { ManagerFinancialSections, PaymentHistorySection } from './features/financial-operations/components/FinancialOperationsPanels';
import { HistoryReceiptModal } from './features/financial-operations/components/HistoryReceiptModal';
import { PaymentModal } from './features/financial-operations/components/PaymentModal';
import { DailyCreditAcknowledgementPanel } from './features/financial-operations/components/DailyCreditAcknowledgementPanel';
import { DeliveryCorrectionDialog } from './features/delivery-corrections/DeliveryCorrectionDialog';
import { AccountingPage } from './features/accounting/AccountingPage';
import type {
  Approval,
  DueDateRequest,
  HistoryReceiptDetail,
  PaymentHistoryItem,
  PaymentCorrectionTarget,
  PaymentReceipt,
  PaymentReceiptSnapshot,
  QueueShop,
  Receivable,
  ReceivableDetail,
} from './features/financial-operations/types';
import {
  allocateOldestFirst,
  methodRequires,
  receiptFromSnapshot,
  withPublicShopImages,
} from './features/financial-operations/utils';
import type { AppRole, CollectionFocusRequest, CreditDueRule, PaymentMethod } from './types/app';
import { publishDataChange, subscribeToDataChange } from './lib/dataChange';
import { ensureCurrentCollectionContext, invalidateCurrentCollectionContext } from './lib/collectionContext';

const COLLECTION_AUTO_REFRESH_MS = 2 * 60_000;

function queueIdentity(shop: QueueShop) {
  return shop.queue_key ?? `regular:${shop.shop_id}`;
}

type PaymentHistoryPage = {
  items?: PaymentHistoryItem[];
  next_cursor?: { recorded_at: string; id: string } | null;
};

async function fetchAllPaymentHistory(serviceDate: string) {
  if (!supabase) return [];
  const items: PaymentHistoryItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: PaymentHistoryPage['next_cursor'] = null;
  do {
    const response = await supabase.rpc('get_payment_history', {
      p_from_date: serviceDate,
      p_to_date: serviceDate,
      p_page_size: 100,
      p_before_recorded_at: cursor?.recorded_at ?? null,
      p_before_id: cursor?.id ?? null,
    });
    if (response.error) throw response.error;
    const page = response.data as PaymentHistoryPage | null;
    items.push(...(page?.items ?? []));
    cursor = page?.next_cursor ?? null;
    if (cursor) {
      const cursorKey = `${cursor.recorded_at}:${cursor.id}`;
      if (seenCursors.has(cursorKey)) throw new Error('เซิร์ฟเวอร์ส่งตัวชี้หน้าประวัติรับเงินซ้ำ');
      seenCursors.add(cursorKey);
    }
  } while (cursor);
  return items;
}

type FinancialOperationsDemoData = {
  serviceDate: string;
  queue: QueueShop[];
  paymentHistory: PaymentHistoryItem[];
  receivables?: Receivable[];
  approvals?: Approval[];
  dueDateRequests?: DueDateRequest[];
  runId?: string | null;
};

export function FinancialOperations({
  userRole = 'round_lead',
  canCollectShopPayments = true,
  currentUserId,
  demoData,
  isActive = true,
  managerPage = 'collection',
  onManagerPageChange,
  focusRequest,
  onFocusedCollectionClose,
}: {
  userRole?: AppRole;
  canCollectShopPayments?: boolean;
  currentUserId?: string;
  demoData?: FinancialOperationsDemoData;
  isActive?: boolean;
  managerPage?: 'collection' | 'transactions' | 'credit';
  onManagerPageChange?: (page: 'collection' | 'transactions' | 'credit') => void;
  focusRequest?: CollectionFocusRequest | null;
  onFocusedCollectionClose?: (paymentRecorded: boolean) => void;
}) {
  const serviceDate = demoData?.serviceDate ?? toBangkokDateString();
  const isManager = userRole === 'admin' || userRole === 'round_lead';
  const initialDemoRunId = demoData
    ? demoData.runId === undefined ? 'demo-collection-run' : demoData.runId
    : null;
  const initialDemoShop = initialDemoRunId && isManager && window.innerWidth >= 1100
    ? demoData?.queue[0] ?? null
    : null;
  const { getOrCreatePendingRequest, clearPendingRequest } = usePendingRequests();
  const [runId, setRunId] = useState<string | null>(initialDemoRunId);
  const [queue, setQueue] = useState<QueueShop[]>(initialDemoRunId ? demoData?.queue ?? [] : []);
  const [receivables, setReceivables] = useState<Receivable[]>(demoData?.receivables ?? []);
  const [approvals, setApprovals] = useState<Approval[]>(demoData?.approvals ?? []);
  const [dueDateRequests, setDueDateRequests] = useState<DueDateRequest[]>(demoData?.dueDateRequests ?? []);
  const [historyDate, setHistoryDate] = useState(serviceDate);
  const [employeeView, setEmployeeView] = useState<'queue' | 'history' | 'credit_signoff'>('queue');
  const [paymentHistory, setPaymentHistory] = useState<PaymentHistoryItem[]>(() => demoData?.paymentHistory.filter((payment) => (
    toBangkokDateString(new Date(payment.recorded_at)) === serviceDate
  )) ?? []);
  const [todayPayments, setTodayPayments] = useState<PaymentHistoryItem[]>(() => demoData?.paymentHistory.filter((payment) => (
    payment.status === 'active' && toBangkokDateString(new Date(payment.recorded_at)) === serviceDate
  )) ?? []);
  const [method, setMethod] = useState<PaymentMethod>(initialDemoShop?.payment_profile.default_payment_method ?? 'cash');
  const [amount, setAmount] = useState(initialDemoShop ? Number(initialDemoShop.outstanding_amount).toFixed(2) : '');
  const [reference, setReference] = useState('');
  const [evidence, setEvidence] = useState<File | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [selectedShop, setSelectedShop] = useState<QueueShop | null>(initialDemoShop);
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);
  const [historyReceipt, setHistoryReceipt] = useState<HistoryReceiptDetail | null>(null);
  const [correctionEventId, setCorrectionEventId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const historyDialogRef = useRef<HTMLDivElement>(null);
  const historyCloseButtonRef = useRef<HTMLButtonElement>(null);
  const historyReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const historyRequestRef = useRef(0);
  const autoRefreshRunningRef = useRef(false);
  const selectedShopRef = useRef<QueueShop | null>(selectedShop);
  const busyRef = useRef(busy);
  const receiptRef = useRef<PaymentReceipt | null>(receipt);
  const handledFocusChargeIdRef = useRef<string | null>(null);
  busyRef.current = busy;
  receiptRef.current = receipt;
  selectedShopRef.current = selectedShop;

  const resetPaymentForm = useCallback((shop: QueueShop) => {
    setReceipt(null);
    setMethod(shop.payment_profile.default_payment_method);
    setAmount(Number(shop.outstanding_amount).toFixed(2));
    setReference('');
    setEvidence(null);
    setEvidenceError(null);
    setError(null);
  }, []);

  const loadPaymentHistory = useCallback(async () => {
    const requestId = ++historyRequestRef.current;
    if (demoData) {
      setPaymentHistory(demoData.paymentHistory.filter((payment) => (
        toBangkokDateString(new Date(payment.recorded_at)) === historyDate
      )));
      return;
    }
    if (!supabase) return;
    const historyItems = await fetchAllPaymentHistory(historyDate);
    if (requestId !== historyRequestRef.current) return;
    setPaymentHistory(historyItems);
  }, [demoData, historyDate]);

  const load = useCallback(async (preferredQueueKey?: string, preferredChargeId?: string) => {
    if (demoData) {
      if (preferredQueueKey) {
        const preferredShop = demoData.queue.find((shop) => queueIdentity(shop) === preferredQueueKey);
        if (!preferredShop) throw new Error('ไม่พบร้านนี้ในคิวรับเงินล่าสุด');
        if (preferredChargeId && !preferredShop.charges.some((charge) => charge.charge_id === preferredChargeId)) {
          throw new Error('ไม่พบยอดส่งรอบล่าสุดในคิวรับเงิน');
        }
        setQueue(demoData.queue);
        setSelectedShop(preferredShop);
        resetPaymentForm(preferredShop);
      }
      return;
    }
    if (!supabase) return;
    setError(null);

    if (!preferredQueueKey && isManager && managerPage === 'transactions') return;
    if (!preferredQueueKey && isManager && managerPage === 'credit') {
      const [receivablesResponse, approvalsResponse, dueDateRequestsResponse] = await Promise.all([
        supabase.rpc('get_credit_receivables', { p_as_of_date: serviceDate }),
        supabase
          .from('financial_approval_requests')
          .select('id, kind, requested_amount, reason, status, requested_at, shops(code,name), users!financial_approval_requests_requested_by_fkey(display_name)')
          .eq('status', 'pending')
          .order('requested_at'),
        supabase.rpc('get_credit_due_date_requests', { p_pending_only: true }),
      ]);
      if (receivablesResponse.error) throw receivablesResponse.error;
      if (approvalsResponse.error) throw approvalsResponse.error;
      if (dueDateRequestsResponse.error) throw dueDateRequestsResponse.error;
      setReceivables((receivablesResponse.data ?? []) as Receivable[]);
      setApprovals((approvalsResponse.data ?? []) as unknown as Approval[]);
      setDueDateRequests((dueDateRequestsResponse.data ?? []) as DueDateRequest[]);
      return;
    }

    const context = await ensureCurrentCollectionContext(serviceDate);
    const nextRunId = context.collection_run_id;
    setRunId(nextRunId);
    if (nextRunId) {
      const queueResponse = await supabase.rpc('get_collection_run_queue', {
        p_collection_run_id: nextRunId,
      });
      if (queueResponse.error) {
        invalidateCurrentCollectionContext(true);
        throw queueResponse.error;
      }
      const nextQueue = await withPublicShopImages((queueResponse.data ?? []) as QueueShop[]);
      const currentShop = selectedShopRef.current;
      const preferredShop = preferredQueueKey
        ? nextQueue.find((shop) => queueIdentity(shop) === preferredQueueKey) ?? null
        : null;
      if (preferredQueueKey && !preferredShop) throw new Error('ไม่พบร้านนี้ในคิวรับเงินล่าสุด');
      if (preferredChargeId && preferredShop
        && !preferredShop.charges.some((charge) => charge.charge_id === preferredChargeId)) {
        throw new Error('ไม่พบยอดส่งรอบล่าสุดในคิวรับเงิน');
      }
      const nextSelectedShop = preferredShop ?? (currentShop
        ? nextQueue.find((shop) => queueIdentity(shop) === queueIdentity(currentShop)) ?? null
        : (isManager && window.innerWidth >= 1100 ? nextQueue[0] ?? null : null));
      setQueue(nextQueue);
      setSelectedShop(nextSelectedShop);
      if (nextSelectedShop && (preferredShop
        || queueIdentity(nextSelectedShop) !== (currentShop && queueIdentity(currentShop)))) {
        resetPaymentForm(nextSelectedShop);
      }
    } else {
      setQueue([]);
      setSelectedShop(null);
    }

    if (!isManager) return;

    const todayHistory = await fetchAllPaymentHistory(serviceDate);
    setTodayPayments(todayHistory.filter((payment) => payment.status === 'active'));
  }, [demoData, isManager, managerPage, resetPaymentForm, serviceDate]);

  const loadPendingFocus = useCallback(async () => {
    const pendingFocus = focusRequest?.chargeId !== handledFocusChargeIdRef.current
      ? focusRequest
      : null;
    if (pendingFocus) setEmployeeView('queue');
    await load(pendingFocus?.queueKey, pendingFocus?.chargeId);
    if (pendingFocus) handledFocusChargeIdRef.current = pendingFocus.chargeId;
  }, [focusRequest, load]);

  const refreshFinancialData = useCallback(async () => {
    await loadPendingFocus();
    if ((isManager && managerPage === 'collection') || (!isManager && employeeView === 'history')) {
      await loadPaymentHistory();
    }
  }, [employeeView, isManager, loadPaymentHistory, loadPendingFocus, managerPage]);

  const autoRefreshFinancialData = useCallback(() => {
    if (busyRef.current || autoRefreshRunningRef.current) return;
    autoRefreshRunningRef.current = true;
    void refreshFinancialData()
      .catch((loadError: unknown) => {
        setError(getErrorMessage(loadError));
      })
      .finally(() => {
        autoRefreshRunningRef.current = false;
      });
  }, [refreshFinancialData]);

  const closePayment = useCallback(() => {
    const currentShop = selectedShopRef.current;
    const closingFocusedCollection = Boolean(
      focusRequest && currentShop && focusRequest.queueKey === queueIdentity(currentShop),
    );
    const paymentRecorded = Boolean(receiptRef.current);
    if (receiptRef.current) {
      void refreshFinancialData().catch((loadError: unknown) => {
        setError(getErrorMessage(loadError));
      });
    }
    setReceipt(null);
    setSelectedShop(null);
    if (closingFocusedCollection) onFocusedCollectionClose?.(paymentRecorded);
  }, [focusRequest, onFocusedCollectionClose, refreshFinancialData]);

  useEffect(() => {
    if (!isActive) return undefined;
    return subscribeToDataChange(['payment', 'receivable', 'refund'], autoRefreshFinancialData);
  }, [autoRefreshFinancialData, isActive]);

  useEffect(() => {
    if (!isActive) return;
    void loadPendingFocus().catch((loadError: unknown) => {
      setError(getErrorMessage(loadError));
    });
  }, [isActive, loadPendingFocus]);

  useEffect(() => {
    if (!isActive
      || (isManager && managerPage !== 'collection')
      || (!isManager && employeeView !== 'history')) return;
    void loadPaymentHistory().catch((loadError: unknown) => {
      setError(getErrorMessage(loadError));
    });
  }, [employeeView, isActive, isManager, loadPaymentHistory, managerPage]);

  useEffect(() => {
    if (!isActive || demoData || !isManager || managerPage !== 'collection') return undefined;
    const refreshWhenActive = () => {
      if (document.visibilityState !== 'hidden') autoRefreshFinancialData();
    };
    const intervalId = window.setInterval(refreshWhenActive, COLLECTION_AUTO_REFRESH_MS);
    window.addEventListener('focus', refreshWhenActive);
    document.addEventListener('visibilitychange', refreshWhenActive);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshWhenActive);
      document.removeEventListener('visibilitychange', refreshWhenActive);
    };
  }, [autoRefreshFinancialData, demoData, isActive, isManager, managerPage]);

  useEffect(() => {
    if (!selectedShop || (isManager && window.innerWidth >= 1100)) return;
    const page = pageRef.current;
    const previousOverflow = document.body.style.overflow;
    const closeOnKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        closePayment();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    if (page) page.inert = true;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();
    window.addEventListener('keydown', closeOnKeydown);
    return () => {
      if (page) page.inert = false;
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnKeydown);
      returnFocusRef.current?.focus();
    };
  }, [closePayment, isManager, selectedShop ? queueIdentity(selectedShop) : null]);

  useEffect(() => {
    if (!historyReceipt) return;
    const page = pageRef.current;
    const previousOverflow = document.body.style.overflow;
    const closeOnKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setHistoryReceipt(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(historyDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    if (page) page.inert = true;
    document.body.style.overflow = 'hidden';
    historyCloseButtonRef.current?.focus();
    window.addEventListener('keydown', closeOnKeydown);
    return () => {
      if (page) page.inert = false;
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnKeydown);
      historyReturnFocusRef.current?.focus();
    };
  }, [historyReceipt?.payment.id]);

  const runAction = async (action: () => Promise<void>, reload = true) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      if (reload) await load();
      return true;
    } catch (actionError) {
      setError(getErrorMessage(actionError));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const chooseShop = (shop: QueueShop, trigger: HTMLButtonElement) => {
    returnFocusRef.current = trigger;
    setSelectedShop(shop);
    resetPaymentForm(shop);
  };

  const choosePaymentMethod = (nextMethod: PaymentMethod) => {
    if (!selectedShop || nextMethod === method) return;
    if (!selectedShop.payment_profile.allowed_payment_methods.includes(nextMethod)) return;
    setMethod(nextMethod);
    setAmount(Number(selectedShop.outstanding_amount).toFixed(2));
    setReference('');
    setEvidence(null);
    setEvidenceError(null);
  };

  const openChargeCorrection = (charge: QueueShop['charges'][number]) => {
    if (charge.delivery_event_id) setCorrectionEventId(charge.delivery_event_id);
  };

  const receivedAmount = Number(amount);
  const allocatedAmount = selectedShop
    ? Math.min(Number.isFinite(receivedAmount) ? receivedAmount : 0, Number(selectedShop.outstanding_amount))
    : 0;
  const evidenceRequired = selectedShop
    ? methodRequires(selectedShop.payment_profile, method, 'evidence')
    : false;
  const paymentReady = Boolean(
    canCollectShopPayments
    && selectedShop
    && Number.isFinite(receivedAmount)
    && receivedAmount > 0
    && (method === 'cash' || receivedAmount <= selectedShop.outstanding_amount)
    && (!evidenceRequired || evidence),
  );
  const allocations = useMemo(
    () => selectedShop ? allocateOldestFirst(selectedShop.charges, allocatedAmount) : [],
    [allocatedAmount, selectedShop],
  );
  const changeAmount = selectedShop && method === 'cash'
    ? Math.max(0, (Number.isFinite(receivedAmount) ? receivedAmount : 0) - Number(selectedShop.outstanding_amount))
    : 0;
  const remainingAmount = selectedShop
    ? Math.max(0, Number(selectedShop.outstanding_amount) - allocatedAmount)
    : 0;

  const getReceiptCharges = async (paymentId: string) => {
    const snapshot = await getReceiptSnapshot(paymentId);
    return snapshot.charges;
  };

  const getReceiptSnapshot = async (paymentId: string) => {
    if (!supabase) throw new Error('ระบบยังไม่พร้อมโหลดใบเสร็จ');
    const { data, error: rpcError } = await supabase.rpc('get_payment_receipt_snapshot', {
      p_payment_id: paymentId,
    });
    if (rpcError) throw rpcError;
    if (!data || typeof data !== 'object' || !('payment_id' in data)) {
      throw new Error('ไม่พบภาพใบเสร็จที่บันทึกไว้');
    }
    return receiptFromSnapshot(data as PaymentReceiptSnapshot);
  };

  const getPaymentCorrectionTargets = async (paymentId: string) => {
    if (!supabase) return [];
    const { data, error: rpcError } = await supabase.rpc('get_payment_correction_targets', {
      p_payment_id: paymentId,
    });
    if (rpcError) throw rpcError;
    return (data ?? []) as PaymentCorrectionTarget[];
  };

  const recordPayment = () => {
    return runAction(async () => {
      if (!canCollectShopPayments || !supabase || !runId || !selectedShop || !paymentReady) return;
      const signature = `collection-payment:${JSON.stringify({
        runId,
        queueKey: queueIdentity(selectedShop),
        allocations,
        method,
        receivedAmount,
        reference: reference.trim() || null,
        evidence: evidence ? {
          name: evidence.name,
          size: evidence.size,
          lastModified: evidence.lastModified,
        } : null,
      })}`;
      const request = getOrCreatePendingRequest(signature);
      const evidencePath = evidence ? await uploadPaymentEvidence(evidence, request.key) : null;
      const paymentArgs = selectedShop.destination_kind === 'event' ? {
        p_expected_settlement_context_id: selectedShop.event_settlement_context_id,
        p_expected_participation_id: selectedShop.event_participation_id,
        p_expected_service_date: selectedShop.settlement_service_date,
        p_expected_policy_fingerprint: selectedShop.settlement_policy_fingerprint,
        p_allocations: allocations,
        p_payment_method: method,
        p_received_amount: receivedAmount,
        p_reference_number: reference.trim() || null,
        p_evidence_path: evidencePath,
        p_collection_run_id: runId,
        p_expected_outstanding_amount: selectedShop.outstanding_amount,
        p_idempotency_key: request.key,
      } : {
        p_shop_id: selectedShop.shop_id,
        p_allocations: allocations,
        p_payment_method: method,
        p_received_amount: receivedAmount,
        p_reference_number: reference.trim() || null,
        p_evidence_path: evidencePath,
        p_collection_run_id: runId,
        p_expected_outstanding_amount: selectedShop.outstanding_amount,
        p_approval_id: null,
        p_idempotency_key: request.key,
      };
      const paymentRpc = selectedShop.destination_kind === 'event'
        ? 'record_event_payment'
        : 'record_payment';
      const { data, error: rpcError } = await supabase.rpc(paymentRpc, paymentArgs);
      if (rpcError) {
        invalidateCurrentCollectionContext(true);
        throw rpcError;
      }
      if (!data?.payment_id || !data.receipt_number || !data.recorded_at) {
        throw new Error('ระบบไม่ได้ส่งเลขที่หรือเวลาของใบเสร็จกลับมา');
      }
      clearPendingRequest(signature, request.key);
      const nextReceipt: PaymentReceipt = {
        paymentId: data.payment_id,
        receiptNumber: data.receipt_number,
        shopCode: selectedShop.shop_code,
        shopName: selectedShop.shop_name,
        method,
        receivedAmount,
        allocatedAmount: Number(data.allocated_amount),
        changeAmount: Number(data.change_amount),
        recordedAt: data.recorded_at,
        charges: [],
      };
      setReceipt(nextReceipt);
      setSuccess('บันทึกรับเงินแล้ว');
      publishDataChange(['accounting', 'payment', 'receivable']);
    }, false);
  };

  const selectEvidence = (file: File | null) => {
    if (file && file.size > MAX_PAYMENT_EVIDENCE_SIZE) {
      setEvidence(null);
      setEvidenceError('หลักฐานต้องมีขนาดไม่เกิน 5 MB');
      return;
    }
    setEvidence(file);
    setEvidenceError(null);
  };

  const printReceipt = async (targetReceipt: PaymentReceipt, existingPrintWindow?: Window | null) => {
    const printed = await printSalesDocumentForCurrentPlatform({
      documentType: 'REC',
      documentNumber: targetReceipt.receiptNumber,
      title: targetReceipt.title ?? 'ใบเสร็จรับเงิน',
      status: targetReceipt.status ?? 'active',
      issuedAt: targetReceipt.recordedAt,
      serviceDate: targetReceipt.serviceDate ?? null,
      shop: {
        code: targetReceipt.shopCode,
        name: targetReceipt.shopName,
        location: targetReceipt.shopLocation ?? null,
      },
      paymentTerm: targetReceipt.paymentTerm ?? null,
      paymentMethod: targetReceipt.method,
      items: targetReceipt.charges.flatMap((charge) => charge.items.map((item) => ({
        name: item.name,
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.unitPrice ?? null,
        lineTotal: item.lineTotal,
      }))),
      allocations: targetReceipt.charges.map((charge) => ({
        documentNumber: charge.chargeNumber,
        amount: charge.receivedAmount,
      })),
      totals: {
        total: targetReceipt.allocatedAmount,
        received: targetReceipt.receivedAmount,
        change: targetReceipt.changeAmount,
      },
      voidInfo: targetReceipt.voidInfo ?? null,
    }, existingPrintWindow);
    if (!printed) setError('เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาตป๊อปอัปแล้วลองใหม่');
    return;

  };

  const printStoredReceipt = (paymentId: string) => {
    const nativeAndroid = isAndroidApp();
    const printWindow = nativeAndroid ? null : window.open('', '_blank', 'popup,width=360,height=680');
    if (!nativeAndroid && !printWindow) {
      setError('เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาตป๊อปอัปแล้วลองใหม่');
      return;
    }
    void runAction(async () => {
      try {
        const receiptSnapshot = await getReceiptSnapshot(paymentId);
        await printReceipt(receiptSnapshot, printWindow);
      } catch (printError) {
        printWindow?.close();
        throw printError;
      }
    }, false);
  };

  const printHistoryReceipt = (payment: PaymentHistoryItem) => {
    printStoredReceipt(payment.id);
  };

  const openHistoryReceipt = (payment: PaymentHistoryItem, trigger: HTMLButtonElement) => {
    historyReturnFocusRef.current = trigger;
    setHistoryReceipt({
      payment,
      charges: null,
      error: null,
      correctionTargets: isManager ? null : [],
      correctionError: null,
    });
    void getReceiptCharges(payment.id)
      .then((charges) => {
        setHistoryReceipt((current) => current?.payment.id === payment.id
          ? { ...current, charges }
          : current);
      })
      .catch((receiptError: unknown) => {
        setHistoryReceipt((current) => current?.payment.id === payment.id
          ? { ...current, error: getErrorMessage(receiptError) }
          : current);
      });
    if (isManager) {
      void getPaymentCorrectionTargets(payment.id)
        .then((correctionTargets) => {
          setHistoryReceipt((current) => current?.payment.id === payment.id
            ? { ...current, correctionTargets }
            : current);
        })
        .catch((targetError: unknown) => {
          setHistoryReceipt((current) => current?.payment.id === payment.id
            ? { ...current, correctionTargets: [], correctionError: getErrorMessage(targetError) }
            : current);
        });
    }
  };

  const openHistoryChargeCorrection = (target: PaymentCorrectionTarget) => {
    historyReturnFocusRef.current = null;
    setHistoryReceipt(null);
    setCorrectionEventId(target.delivery_event_id);
  };

  const decide = (approvalId: string, decision: 'approved' | 'rejected') => runAction(async () => {
    if (!supabase) return;
    const reason = decision === 'rejected'
      ? window.prompt('เหตุผลที่ไม่อนุมัติ')?.trim()
      : null;
    if (decision === 'rejected' && !reason) return;
    const { error: rpcError } = await supabase.rpc('decide_financial_approval', {
      p_approval_id: approvalId,
      p_decision: decision,
      p_reason: reason,
    });
    if (rpcError) throw rpcError;
    setSuccess(decision === 'approved' ? 'อนุมัติคำขอแล้ว' : 'ไม่อนุมัติคำขอแล้ว');
  });

  const voidPayment = (payment: PaymentHistoryItem) => {
    if (!isManager && !canCollectShopPayments) return Promise.resolve(false);
    const reason = window.prompt(`เหตุผลที่ยกเลิกรับเงินจาก ${payment.shops?.name ?? 'ร้านค้า'}`)?.trim();
    if (!reason) return Promise.resolve(false);
    return runAction(async () => {
      if (!supabase) return;
      const { error: rpcError } = await supabase.rpc('void_payment', {
        p_payment_id: payment.id,
        p_reason: reason,
      });
      if (rpcError) throw rpcError;
      publishDataChange(['accounting', 'payment', 'receivable']);
      await Promise.allSettled([refreshFinancialData()]);
      setSuccess('ยกเลิกรายการรับเงินแล้ว ยอดค้างถูกคำนวณใหม่');
    }, false);
  };

  const requestDueDate = (charge: QueueShop['charges'][number]) => runAction(async () => {
    if (!supabase) return;
    const requestedDueDate = window.prompt(`วันครบกำหนดใหม่สำหรับ ${charge.charge_number ?? 'รายการเครดิต'} (YYYY-MM-DD)`)?.trim();
    if (!requestedDueDate) return;
    const reason = window.prompt('เหตุผลที่ขอเลื่อนกำหนดชำระ')?.trim();
    if (!reason) return;
    const { error: rpcError } = await supabase.rpc('request_credit_due_date_change', {
      p_charge_id: charge.charge_id,
      p_requested_due_date: requestedDueDate,
      p_reason: reason,
    });
    if (rpcError) throw rpcError;
    setSuccess('ส่งคำขอเลื่อนกำหนดชำระแล้ว');
  });

  const decideDueDateRequest = (requestId: string, decision: 'approved' | 'rejected') => runAction(async () => {
    if (!supabase) return;
    const reason = decision === 'rejected' ? window.prompt('เหตุผลที่ไม่อนุมัติ')?.trim() : null;
    if (decision === 'rejected' && !reason) return;
    const { error: rpcError } = await supabase.rpc('decide_credit_due_date_request', {
      p_request_id: requestId,
      p_decision: decision,
      p_reason: reason,
    });
    if (rpcError) throw rpcError;
    setSuccess(decision === 'approved' ? 'อนุมัติการเลื่อนกำหนดชำระแล้ว' : 'ไม่อนุมัติการเลื่อนกำหนดชำระแล้ว');
  });

  const updateCreditSettings = async (
    receivable: Receivable,
    changes: {
      credit_limit?: number | null;
      credit_due_rule?: CreditDueRule;
      credit_days?: number | null;
      credit_collection_weekday?: number | null;
      credit_suspended?: boolean;
      credit_suspension_reason?: string | null;
    },
  ) => {
    if (demoData) {
      setReceivables((current) => current.map((item) => item.shop_id === receivable.shop_id ? {
        ...item,
        ...changes,
        available_credit_amount: changes.credit_limit === undefined
          ? item.available_credit_amount
          : changes.credit_limit === null
            ? null
            : Number(changes.credit_limit) - Number(item.outstanding_amount),
      } : item));
      return;
    }
    if (!supabase) throw new Error('ไม่พบการเชื่อมต่อฐานข้อมูล');
    const response = await supabase.rpc('update_credit_account_settings', {
      p_shop_id: receivable.shop_id,
      p_changes: changes,
    });
    if (response.error) throw response.error;
    await load();
  };

  const loadCreditReceivableDetail = useCallback(async (receivable: Receivable): Promise<ReceivableDetail> => {
    if (demoData) {
      const iceTypes = [...new Map(receivable.charges.flatMap((charge) => charge.items ?? []).map((item) => [item.ice_type_id, {
        id: item.ice_type_id,
        code: item.ice_type_id,
        name: item.name,
        unit: item.unit,
      }])).values()];
      return { charges: receivable.charges, payments: receivable.payments ?? [], ice_types: iceTypes };
    }
    if (!supabase) throw new Error('ไม่พบการเชื่อมต่อฐานข้อมูล');
    const response = await supabase.rpc('get_credit_receivable_detail', {
      p_as_of_date: serviceDate,
      p_shop_id: receivable.shop_id,
    });
    if (response.error) throw response.error;
    const detail = response.data as Partial<ReceivableDetail> | null;
    return { charges: detail?.charges ?? [], payments: detail?.payments ?? [], ice_types: detail?.ice_types ?? [] };
  }, [demoData, serviceDate]);

  const openReceivableCollection = async (receivable: Receivable) => {
    await load(`regular:${receivable.shop_id}`);
    onManagerPageChange?.('collection');
  };

  const changeHistoryDate = (nextHistoryDate: string) => {
    if (nextHistoryDate === historyDate) return;
    historyRequestRef.current += 1;
    setError(null);
    setPaymentHistory([]);
    setHistoryDate(nextHistoryDate);
  };

  return (
    <div className="financial-ops" ref={pageRef}>
      {error ? <p className="employee-error" role="alert"><WarningCircle />{error}</p> : null}
      {success ? <p className="employee-success"><CheckCircle weight="fill" />{success}</p> : null}

      {!isManager ? <div className="financial-ops__employee-workspace">
        <nav aria-label="เมนูเก็บเงิน" className="financial-ops__employee-nav">
          <button
            aria-current={employeeView === 'queue' ? 'page' : undefined}
            onClick={() => setEmployeeView('queue')}
            type="button"
          >
            <ListBullets aria-hidden="true" size={21} weight="duotone" />
            <span>คิวเก็บเงิน</span>
          </button>
          <button
            aria-current={employeeView === 'history' ? 'page' : undefined}
            onClick={() => setEmployeeView('history')}
            type="button"
          >
            <ClockCounterClockwise aria-hidden="true" size={21} weight="duotone" />
            <span>ประวัติรับเงิน</span>
          </button>
          <button
            aria-current={employeeView === 'credit_signoff' ? 'page' : undefined}
            onClick={() => setEmployeeView('credit_signoff')}
            type="button"
          >
            <FileText aria-hidden="true" size={21} weight="duotone" />
            <span>ใบเซ็นเครดิต</span>
          </button>
        </nav>

        <div className="financial-ops__employee-page">
          <header className="financial-ops__header">
            <div>
              <p className="eyebrow">การเงินหน้าร้าน</p>
              <h1>{employeeView === 'queue' ? 'คิวเก็บเงินของฉัน' : employeeView === 'history' ? 'ประวัติรับเงินของฉัน' : 'ใบเซ็นเครดิตรายวัน'}</h1>
              <span>วันที่ธุรกิจ {serviceDate}</span>
            </div>
            <button disabled={busy} onClick={() => void refreshFinancialData().catch((loadError: unknown) => setError(getErrorMessage(loadError)))} type="button">รีเฟรชยอดล่าสุด</button>
          </header>

          {employeeView === 'queue' ? <CollectionRunSection
            onSelectShop={chooseShop}
            queue={queue}
            runId={runId}
          /> : employeeView === 'history' ? <PaymentHistorySection
            busy={busy}
            historyDate={historyDate}
            isManager={false}
            currentUserId={canCollectShopPayments ? currentUserId : undefined}
            onHistoryDateChange={changeHistoryDate}
            onOpenReceipt={openHistoryReceipt}
            onPrintReceipt={printHistoryReceipt}
            onVoidPayment={voidPayment}
            paymentHistory={paymentHistory}
            serviceDate={serviceDate}
          /> : <DailyCreditAcknowledgementPanel serviceDate={serviceDate} />}
        </div>
      </div> : null}

      {isManager && managerPage === 'collection' ? <CollectionDesk
        busy={busy}
        historyDate={historyDate}
        onHistoryDateChange={changeHistoryDate}
        onOpenReceipt={openHistoryReceipt}
        onPrintReceipt={printHistoryReceipt}
        onRefresh={() => void refreshFinancialData().catch((loadError: unknown) => setError(getErrorMessage(loadError)))}
        onClearShop={closePayment}
        onSelectShop={chooseShop}
        onVoidPayment={voidPayment}
        paymentPanel={selectedShop && window.innerWidth >= 1100 ? <PaymentModal
          allocatedAmount={allocatedAmount}
          amount={amount}
          busy={busy}
          canRecordPayment={canCollectShopPayments}
          changeAmount={changeAmount}
          closeButtonRef={closeButtonRef}
          dialogRef={dialogRef}
          evidence={evidence}
          evidenceError={evidenceError}
          evidenceRequired={evidenceRequired}
          focusedChargeId={focusRequest?.queueKey === queueIdentity(selectedShop) ? focusRequest.chargeId : null}
          method={method}
          onAmountChange={setAmount}
          onClose={closePayment}
          onEvidenceChange={selectEvidence}
          onEditCharge={openChargeCorrection}
          onPaymentMethodChange={choosePaymentMethod}
          onPrintReceipt={(targetReceipt) => printStoredReceipt(targetReceipt.paymentId)}
          onRecordPayment={recordPayment}
          onRequestDueDate={requestDueDate}
          onReferenceChange={setReference}
          paymentReady={paymentReady}
          presentation="panel"
          receipt={receipt}
          reference={reference}
          remainingAmount={remainingAmount}
          selectedShop={selectedShop}
          serviceDate={serviceDate}
        /> : null}
        paymentHistory={paymentHistory}
        queue={queue}
        runId={runId}
        selectedShop={selectedShop}
        serviceDate={serviceDate}
        todayPayments={todayPayments}
      /> : null}

      {isManager && managerPage === 'transactions' ? <AccountingPage userRole={userRole} demoMode={Boolean(demoData)} /> : null}

      {isManager && managerPage === 'credit' ? <ManagerFinancialSections
        approvals={approvals}
        busy={busy}
        dueDateRequests={dueDateRequests}
        onDecide={decide}
        onDecideDueDateRequest={decideDueDateRequest}
        onLoadDetail={loadCreditReceivableDetail}
        onOpenCollection={(receivable) => { void openReceivableCollection(receivable).catch((openError: unknown) => setError(getErrorMessage(openError))); }}
        onRefreshReceivables={() => load()}
        onUpdateCreditSettings={updateCreditSettings}
        receivables={receivables}
        serviceDate={serviceDate}
        userRole={userRole}
      /> : null}

      {selectedShop && (!isManager || managerPage === 'collection') && (!isManager || window.innerWidth < 1100) ? createPortal(
        <PaymentModal
          allocatedAmount={allocatedAmount}
          amount={amount}
          busy={busy}
          canRecordPayment={canCollectShopPayments}
          changeAmount={changeAmount}
          closeButtonRef={closeButtonRef}
          dialogRef={dialogRef}
          evidence={evidence}
          evidenceError={evidenceError}
          evidenceRequired={evidenceRequired}
          focusedChargeId={focusRequest?.queueKey === queueIdentity(selectedShop) ? focusRequest.chargeId : null}
          method={method}
          onAmountChange={setAmount}
          onClose={closePayment}
          onEvidenceChange={selectEvidence}
          onEditCharge={openChargeCorrection}
          onPaymentMethodChange={choosePaymentMethod}
          onPrintReceipt={(targetReceipt) => printStoredReceipt(targetReceipt.paymentId)}
          onRecordPayment={recordPayment}
          onRequestDueDate={requestDueDate}
          onReferenceChange={setReference}
          paymentReady={paymentReady}
          receipt={receipt}
          reference={reference}
          remainingAmount={remainingAmount}
          selectedShop={selectedShop}
          serviceDate={serviceDate}
        />,
        document.body,
      ) : null}

      {historyReceipt ? createPortal(
        <HistoryReceiptModal
          busy={busy}
          closeButtonRef={historyCloseButtonRef}
          dialogRef={historyDialogRef}
          historyReceipt={historyReceipt}
          onClose={() => setHistoryReceipt(null)}
          onPrint={() => printHistoryReceipt(historyReceipt.payment)}
          onCorrect={isManager ? openHistoryChargeCorrection : undefined}
          onVoid={historyReceipt.payment.status === 'active'
            && (isManager || (canCollectShopPayments && Boolean(currentUserId) && historyReceipt.payment.recorded_by === currentUserId)) ? () => {
            void voidPayment(historyReceipt.payment).then((voided) => {
              if (voided) setHistoryReceipt(null);
            });
          } : undefined}
        />,
        document.body,
      ) : null}

      {correctionEventId ? createPortal(
        <DeliveryCorrectionDialog
          eventId={correctionEventId}
          onClose={() => setCorrectionEventId(null)}
          onSuccess={(message) => {
            setSuccess(message);
          }}
          userRole={userRole}
        />,
        document.body,
      ) : null}

    </div>
  );
}
