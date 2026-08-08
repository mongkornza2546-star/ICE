import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, ClockCounterClockwise, FileText, ListBullets, WarningCircle } from '@phosphor-icons/react';
import { supabase } from './lib/supabase';
import { bangkokDayUtcRange, toBangkokDateString } from './lib/serviceDate';
import { MAX_PAYMENT_EVIDENCE_SIZE, uploadPaymentEvidence } from './lib/paymentEvidence';
import { getErrorMessage } from './lib/errorMessage';
import { printSalesDocument } from './lib/salesDocumentPrint';
import { usePendingRequests } from './features/employee-delivery/usePendingRequests';
import { CollectionRunSection } from './features/financial-operations/components/CollectionRunSection';
import { CollectionRunManager } from './features/financial-operations/components/CollectionRunManager';
import { CollectionDesk } from './features/financial-operations/components/CollectionDesk';
import { ManagerFinancialSections, PaymentHistorySection } from './features/financial-operations/components/FinancialOperationsPanels';
import { HistoryReceiptModal } from './features/financial-operations/components/HistoryReceiptModal';
import { PaymentModal } from './features/financial-operations/components/PaymentModal';
import { RefundQueuePanel } from './features/financial-operations/components/RefundQueuePanel';
import { DailyCreditAcknowledgementPanel } from './features/financial-operations/components/DailyCreditAcknowledgementPanel';
import { DeliveryCorrectionDialog } from './features/delivery-corrections/DeliveryCorrectionDialog';
import { AccountingPage } from './features/accounting/AccountingPage';
import type {
  Approval,
  Collector,
  DueDateRequest,
  HistoryReceiptDetail,
  PaymentHistoryItem,
  PaymentCorrectionTarget,
  PaymentReceipt,
  PaymentReceiptSnapshot,
  QueueShop,
  Receivable,
  ReceivableDetail,
  ReceiptItemRow,
} from './features/financial-operations/types';
import {
  USER_AVATAR_BUCKET,
  allocateOldestFirst,
  methodRequires,
  receiptChargesFromRows,
  receiptFromSnapshot,
  withSignedShopImages,
} from './features/financial-operations/utils';
import type { AppRole, CreditDueRule, PaymentMethod } from './types/app';
import { publishDataChange, subscribeToDataChange } from './lib/dataChange';

const PAYMENT_FIELDS = 'id, receipt_number, received_amount, allocated_amount, change_amount, payment_method, status, recorded_at, recorded_by, void_reason, shops(code,name)';
const COLLECTION_AUTO_REFRESH_MS = 30_000;

type FinancialOperationsDemoData = {
  serviceDate: string;
  queue: QueueShop[];
  paymentHistory: PaymentHistoryItem[];
  receivables?: Receivable[];
  approvals?: Approval[];
  dueDateRequests?: DueDateRequest[];
  collectors?: Collector[];
  memberIds?: string[];
  runId?: string | null;
  runOpenedAt?: string | null;
};

export function FinancialOperations({
  userRole = 'round_lead',
  currentUserId,
  demoData,
  managerPage = 'collection',
  onManagerPageChange,
}: {
  userRole?: AppRole;
  currentUserId?: string;
  demoData?: FinancialOperationsDemoData;
  managerPage?: 'collection' | 'transactions' | 'credit' | 'refund';
  onManagerPageChange?: (page: 'collection' | 'transactions' | 'credit' | 'refund') => void;
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
  const [runOpenedAt, setRunOpenedAt] = useState<string | null>(demoData
    ? demoData.runOpenedAt === undefined ? `${serviceDate}T01:00:00.000Z` : demoData.runOpenedAt
    : null);
  const [queue, setQueue] = useState<QueueShop[]>(initialDemoRunId ? demoData?.queue ?? [] : []);
  const [receivables, setReceivables] = useState<Receivable[]>(demoData?.receivables ?? []);
  const [approvals, setApprovals] = useState<Approval[]>(demoData?.approvals ?? []);
  const [dueDateRequests, setDueDateRequests] = useState<DueDateRequest[]>(demoData?.dueDateRequests ?? []);
  const [collectors, setCollectors] = useState<Collector[]>(demoData?.collectors ?? []);
  const [collectorAvatarUrls, setCollectorAvatarUrls] = useState<Record<string, string>>({});
  const [failedCollectorAvatars, setFailedCollectorAvatars] = useState<Set<string>>(() => new Set());
  const [memberIds, setMemberIds] = useState<string[]>(demoData?.memberIds ?? []);
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
    const historyDay = bangkokDayUtcRange(historyDate);
    const historyResponse = await supabase
      .from('payments')
      .select(PAYMENT_FIELDS)
      .gte('recorded_at', historyDay.start)
      .lt('recorded_at', historyDay.end)
      .order('recorded_at', { ascending: false });
    if (requestId !== historyRequestRef.current) return;
    if (historyResponse.error) throw historyResponse.error;
    setPaymentHistory((historyResponse.data ?? []) as unknown as PaymentHistoryItem[]);
  }, [demoData, historyDate]);

  const load = useCallback(async (preferredShopId?: string) => {
    if (demoData) {
      if (preferredShopId) {
        const preferredShop = demoData.queue.find((shop) => shop.shop_id === preferredShopId);
        if (!preferredShop) throw new Error('ไม่พบร้านนี้ในรอบเก็บเงินปัจจุบัน');
        setQueue(demoData.queue);
        setSelectedShop(preferredShop);
        if (preferredShop.shop_id !== selectedShopRef.current?.shop_id) resetPaymentForm(preferredShop);
      }
      return;
    }
    if (!supabase) return;
    setError(null);
    const runResponse = await supabase
      .from('collection_runs')
      .select('id, opened_at')
      .eq('service_date', serviceDate)
      .eq('status', 'open')
      .maybeSingle();
    if (runResponse.error) throw runResponse.error;

    const nextRunId = runResponse.data?.id ?? null;
    setRunId(nextRunId);
    setRunOpenedAt(runResponse.data?.opened_at ?? null);
    if (nextRunId) {
      const queueResponse = await supabase.rpc('get_collection_run_queue', {
        p_collection_run_id: nextRunId,
      });
      if (queueResponse.error) throw queueResponse.error;
      const nextQueue = await withSignedShopImages((queueResponse.data ?? []) as QueueShop[]);
      const currentShop = selectedShopRef.current;
      const preferredShop = preferredShopId
        ? nextQueue.find((shop) => shop.shop_id === preferredShopId) ?? null
        : null;
      if (preferredShopId && !preferredShop) throw new Error('ไม่พบร้านนี้ในรอบเก็บเงินปัจจุบัน');
      const nextSelectedShop = preferredShop ?? (currentShop
        ? nextQueue.find((shop) => shop.shop_id === currentShop.shop_id) ?? null
        : (isManager && window.innerWidth >= 1100 ? nextQueue[0] ?? null : null));
      setQueue(nextQueue);
      setSelectedShop(nextSelectedShop);
      if (nextSelectedShop && nextSelectedShop.shop_id !== currentShop?.shop_id) resetPaymentForm(nextSelectedShop);
    } else {
      setQueue([]);
      setSelectedShop(null);
    }

    const paymentDay = bangkokDayUtcRange(serviceDate);
    const todayPaymentsPromise = supabase
      .from('payments')
      .select(PAYMENT_FIELDS)
      .eq('status', 'active')
      .gte('recorded_at', paymentDay.start)
      .lt('recorded_at', paymentDay.end)
      .order('recorded_at', { ascending: false });
    if (!isManager) {
      const todayPaymentsResponse = await todayPaymentsPromise;
      if (todayPaymentsResponse.error) throw todayPaymentsResponse.error;
      setTodayPayments((todayPaymentsResponse.data ?? []) as unknown as PaymentHistoryItem[]);
      return;
    }
    const [receivablesResponse, approvalsResponse, dueDateRequestsResponse, collectorsResponse, membersResponse, todayPaymentsResponse] = await Promise.all([
      supabase.rpc('get_credit_receivables', { p_as_of_date: serviceDate }),
      supabase
        .from('financial_approval_requests')
        .select('id, kind, requested_amount, reason, status, requested_at, shops(code,name), users!financial_approval_requests_requested_by_fkey(display_name)')
        .eq('status', 'pending')
        .order('requested_at'),
      supabase.rpc('get_credit_due_date_requests', { p_pending_only: true }),
      supabase.rpc('get_collection_collectors'),
      nextRunId
        ? supabase.from('collection_run_members').select('user_id').eq('collection_run_id', nextRunId)
        : Promise.resolve({ data: [], error: null }),
      todayPaymentsPromise,
    ]);
    if (receivablesResponse.error) throw receivablesResponse.error;
    if (approvalsResponse.error) throw approvalsResponse.error;
    if (dueDateRequestsResponse.error) throw dueDateRequestsResponse.error;
    if (collectorsResponse.error) throw collectorsResponse.error;
    if (membersResponse.error) throw membersResponse.error;
    if (todayPaymentsResponse.error) throw todayPaymentsResponse.error;
    setReceivables((receivablesResponse.data ?? []) as Receivable[]);
    setApprovals((approvalsResponse.data ?? []) as unknown as Approval[]);
    setDueDateRequests((dueDateRequestsResponse.data ?? []) as DueDateRequest[]);
    setCollectors((collectorsResponse.data ?? []) as Collector[]);
    setMemberIds((membersResponse.data ?? []).map((member) => member.user_id));
    setTodayPayments((todayPaymentsResponse.data ?? []) as unknown as PaymentHistoryItem[]);
  }, [demoData, isManager, resetPaymentForm, serviceDate]);

  const refreshFinancialData = useCallback(async () => {
    await Promise.all([load(), loadPaymentHistory()]);
  }, [load, loadPaymentHistory]);

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

  useEffect(() => subscribeToDataChange(['payment', 'receivable', 'refund'], autoRefreshFinancialData), [autoRefreshFinancialData]);

  useEffect(() => {
    void load().catch((loadError: unknown) => {
      setError(getErrorMessage(loadError));
    });
  }, [load]);

  useEffect(() => {
    void loadPaymentHistory().catch((loadError: unknown) => {
      setError(getErrorMessage(loadError));
    });
  }, [loadPaymentHistory]);

  useEffect(() => {
    if (demoData || !isManager || managerPage !== 'collection') return undefined;
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
  }, [autoRefreshFinancialData, demoData, isManager, managerPage]);

  useEffect(() => {
    if (!selectedShop || window.innerWidth >= 1100) return;
    const page = pageRef.current;
    const previousOverflow = document.body.style.overflow;
    const closeOnKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        if (receiptRef.current) {
          void refreshFinancialData().catch((loadError: unknown) => {
            setError(getErrorMessage(loadError));
          });
        }
        setReceipt(null);
        setSelectedShop(null);
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
  }, [selectedShop?.shop_id, refreshFinancialData]);

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

  useEffect(() => {
    if (!supabase?.storage) return;
    const avatarPaths = collectors
      .map((collector) => collector.avatar_path)
      .filter((path): path is string => Boolean(path));
    if (avatarPaths.length === 0) {
      setCollectorAvatarUrls({});
      return;
    }

    let cancelled = false;
    void supabase.storage.from(USER_AVATAR_BUCKET).createSignedUrls(avatarPaths, 3600)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setCollectorAvatarUrls({});
          setFailedCollectorAvatars(new Set(avatarPaths));
          return;
        }
        const urls = (data ?? []).reduce<Record<string, string>>((current, image) => {
          if (image.path && image.signedUrl) current[image.path] = image.signedUrl;
          return current;
        }, {});
        setFailedCollectorAvatars(new Set());
        setCollectorAvatarUrls(urls);
      })
      .catch(() => {
        if (cancelled) return;
        setCollectorAvatarUrls({});
        setFailedCollectorAvatars(new Set(avatarPaths));
      });
    return () => { cancelled = true; };
  }, [collectors]);

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

  const saveRun = (assignedMemberIds = memberIds) => runAction(async () => {
    if (demoData) {
      setMemberIds(assignedMemberIds);
      setRunId('demo-collection-run');
      setRunOpenedAt(new Date().toISOString());
      setQueue(demoData.queue);
      return;
    }
    if (!supabase) return;
    const { error: rpcError } = await supabase.rpc('open_collection_run', {
      p_service_date: serviceDate,
      p_member_ids: assignedMemberIds.map((userId) => ({ user_id: userId })),
    });
    if (rpcError) throw rpcError;
    setSuccess(runId ? 'บันทึกผู้เก็บเงินแล้ว' : 'เปิดรอบและมอบหมายผู้เก็บเงินแล้ว');
  });

  const closeRun = () => runAction(async () => {
    if (demoData) {
      setRunId(null);
      setRunOpenedAt(null);
      setMemberIds([]);
      setQueue([]);
      setSelectedShop(null);
      setSuccess('ปิดรอบเก็บเงินแล้ว ยอดค้างยังคงอยู่');
      return;
    }
    if (!supabase || !runId) return;
    const { error: rpcError } = await supabase.rpc('close_collection_run', {
      p_collection_run_id: runId,
    });
    if (rpcError) throw rpcError;
    setSelectedShop(null);
    setSuccess('ปิดรอบเก็บเงินแล้ว ยอดค้างยังคงอยู่');
  });

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
    ? method === 'bank_transfer' || methodRequires(selectedShop.payment_profile, method, 'evidence')
    : false;
  const paymentReady = Boolean(
    selectedShop
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
    if (!supabase) return [];
    const { data, error: rpcError } = await supabase.rpc('get_payment_receipt_items', {
      p_payment_id: paymentId,
    });
    if (rpcError) throw rpcError;
    return receiptChargesFromRows((data ?? []) as ReceiptItemRow[]);
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
      if (!supabase || !runId || !selectedShop || !paymentReady) return;
      const signature = `collection-payment:${JSON.stringify({
        runId,
        shopId: selectedShop.shop_id,
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
      const { data, error: rpcError } = await supabase.rpc('record_payment', {
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
      });
      if (rpcError) throw rpcError;
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

  const closePayment = () => {
    if (receiptRef.current) {
      void refreshFinancialData().catch((loadError: unknown) => {
        setError(getErrorMessage(loadError));
      });
    }
    setReceipt(null);
    setSelectedShop(null);
  };

  const printReceipt = (targetReceipt: PaymentReceipt, existingPrintWindow?: Window) => {
    const printed = printSalesDocument({
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
    const printWindow = window.open('', '_blank', 'popup,width=360,height=680');
    if (!printWindow) {
      setError('เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาตป๊อปอัปแล้วลองใหม่');
      return;
    }
    void runAction(async () => {
      try {
        const receiptSnapshot = await getReceiptSnapshot(paymentId);
        printReceipt(receiptSnapshot, printWindow);
      } catch (printError) {
        printWindow.close();
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

  const toggleCreditCollectionAssignment = (
    charge: Receivable['charges'][number],
    assigned: boolean,
  ) => runAction(async () => {
    if (!supabase || !runId) return;
    const { error: rpcError } = await supabase.rpc('set_credit_charge_collection_assignment', {
      p_collection_run_id: runId,
      p_charge_id: charge.charge_id,
      p_assigned: assigned,
    });
    if (rpcError) throw rpcError;
    setSuccess(assigned ? 'มอบหมายบิลเครดิตเข้ารอบเก็บเงินแล้ว' : 'ถอนบิลเครดิตออกจากรอบเก็บเงินแล้ว');
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
    await load(receivable.shop_id);
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
            collectors={collectors}
            collectorAvatarUrls={collectorAvatarUrls}
            failedCollectorAvatars={failedCollectorAvatars}
            isManager={false}
            memberIds={memberIds}
            onCloseRun={closeRun}
            onCollectorAvatarError={(path) => setFailedCollectorAvatars((current) => new Set(current).add(path))}
            onSaveRun={saveRun}
            onSelectShop={chooseShop}
            onToggleCollector={() => undefined}
            queue={queue}
            runId={runId}
            busy={busy}
          /> : employeeView === 'history' ? <PaymentHistorySection
            busy={busy}
            historyDate={historyDate}
            isManager={false}
            currentUserId={currentUserId}
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
          changeAmount={changeAmount}
          closeButtonRef={closeButtonRef}
          dialogRef={dialogRef}
          evidence={evidence}
          evidenceError={evidenceError}
          evidenceRequired={evidenceRequired}
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
        runManagement={<CollectionRunManager
          busy={busy}
          collectorAvatarUrls={collectorAvatarUrls}
          collectors={collectors}
          failedCollectorAvatars={failedCollectorAvatars}
          memberIds={memberIds}
          onCloseRun={() => { void closeRun(); }}
          onCollectorAvatarError={(path) => setFailedCollectorAvatars((current) => new Set(current).add(path))}
          onOpenRun={saveRun}
          openedAt={runOpenedAt}
          runId={runId}
        />}
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
        onToggleCreditCollectionAssignment={toggleCreditCollectionAssignment}
        onUpdateCreditSettings={updateCreditSettings}
        receivables={receivables}
        runId={runId}
        serviceDate={serviceDate}
        userRole={userRole}
      /> : null}

      {isManager && managerPage === 'refund' ? <RefundQueuePanel /> : null}

      {selectedShop && (!isManager || managerPage === 'collection') && (!isManager || window.innerWidth < 1100) ? createPortal(
        <PaymentModal
          allocatedAmount={allocatedAmount}
          amount={amount}
          busy={busy}
          changeAmount={changeAmount}
          closeButtonRef={closeButtonRef}
          dialogRef={dialogRef}
          evidence={evidence}
          evidenceError={evidenceError}
          evidenceRequired={evidenceRequired}
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
            && (isManager || (Boolean(currentUserId) && historyReceipt.payment.recorded_by === currentUserId)) ? () => {
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
