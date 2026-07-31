import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowsLeftRight,
  Bank,
  CaretRight,
  CheckCircle,
  Coins,
  CreditCard,
  ListNumbers,
  Money,
  Printer,
  Storefront,
  UploadSimple,
  UserCircle,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { supabase } from './lib/supabase';
import { toBangkokDateString } from './lib/serviceDate';
import { uploadPaymentEvidence } from './lib/paymentEvidence';
import { getErrorMessage } from './lib/errorMessage';
import { usePendingRequests } from './features/employee-delivery/usePendingRequests';
import type { AppRole, PaymentMethod } from './types/app';

type PaymentProfile = {
  allowed_payment_methods: PaymentMethod[];
  default_payment_method: PaymentMethod;
  cash_reference_required: boolean;
  cash_evidence_required: boolean;
  bank_transfer_reference_required: boolean;
  bank_transfer_evidence_required: boolean;
  qr_reference_required: boolean;
  qr_evidence_required: boolean;
};

type QueueShop = {
  shop_id: string;
  shop_code: string;
  shop_name: string;
  image_path: string | null;
  image_url?: string | null;
  outstanding_amount: number;
  charge_count: number;
  has_new_charges: boolean;
  payment_profile: PaymentProfile;
  charges: Array<{
    charge_id: string;
    charge_number: string;
    service_date: string;
    original_amount: number;
    outstanding_amount: number;
  }>;
};

type Receivable = {
  shop_id: string;
  shop_code: string;
  shop_name: string;
  outstanding_amount: number;
  overdue_amount: number;
  oldest_due_date: string;
};

type Approval = {
  id: string;
  kind: 'credit_limit' | 'outstanding_balance';
  requested_amount: number;
  reason: string;
  status: 'pending';
  requested_at: string;
  shops: { code: string; name: string } | null;
  users: { display_name: string } | null;
};

type Collector = {
  id: string;
  code: string;
  display_name: string;
  nickname: string | null;
  avatar_path: string | null;
};

const USER_AVATAR_BUCKET = 'user-avatars';
const SHOP_IMAGE_BUCKET = 'shop-images';

type PaymentHistoryItem = {
  id: string;
  receipt_number: string;
  received_amount: number;
  payment_method: PaymentMethod;
  status: 'active' | 'voided';
  recorded_at: string;
  void_reason: string | null;
  shops: { code: string; name: string } | null;
};

type PaymentReceipt = {
  paymentId: string;
  receiptNumber: string;
  shopCode: string;
  shopName: string;
  method: PaymentMethod;
  receivedAmount: number;
  recordedAt: string;
  charges: ReceiptCharge[];
};

type HistoryReceiptDetail = {
  payment: PaymentHistoryItem;
  charges: ReceiptCharge[] | null;
  error: string | null;
};

type ReceiptItem = {
  name: string;
  unit: string;
  quantity: number;
  lineTotal: number;
};

type ReceiptCharge = {
  chargeNumber: string;
  receivedAmount: number;
  items: ReceiptItem[];
};

type ReceiptItemRow = {
  charge_number: string | null;
  received_amount: number | string;
  ice_type_name: string;
  ice_type_unit: string;
  quantity: number | string;
  line_total: number | string;
};

const money = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 2,
});
const MAX_PAYMENT_EVIDENCE_SIZE = 5 * 1024 * 1024;

const receiptDateTime = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'short',
  timeStyle: 'short',
});

function paymentMethodLabel(method: PaymentMethod) {
  return method === 'cash' ? 'เงินสด' : method === 'bank_transfer' ? 'โอนเงิน' : 'QR';
}

function receiptChargesFromRows(rows: ReceiptItemRow[]) {
  const charges = new Map<string, ReceiptCharge>();
  for (const row of rows) {
    const chargeNumber = row.charge_number ?? 'ไม่พบเลขที่บิล';
    const charge = charges.get(chargeNumber) ?? {
      chargeNumber,
      receivedAmount: Number(row.received_amount),
      items: [],
    };
    charge.items.push({
      name: row.ice_type_name,
      unit: row.ice_type_unit,
      quantity: Number(row.quantity),
      lineTotal: Number(row.line_total),
    });
    charges.set(chargeNumber, charge);
  }
  return [...charges.values()];
}

function methodRequires(profile: PaymentProfile, method: PaymentMethod, field: 'reference' | 'evidence') {
  if (method === 'cash') return profile[`cash_${field}_required`];
  if (method === 'bank_transfer') return profile[`bank_transfer_${field}_required`];
  return profile[`qr_${field}_required`];
}

function allocateOldestFirst(charges: QueueShop['charges'], amount: number) {
  let remaining = amount;
  const allocations: Array<{ charge_id: string; amount: number }> = [];
  for (const charge of charges) {
    if (remaining <= 0) break;
    const allocated = Math.min(remaining, Number(charge.outstanding_amount));
    if (allocated > 0) allocations.push({ charge_id: charge.charge_id, amount: allocated });
    remaining -= allocated;
  }
  return allocations;
}

async function withSignedShopImages(shops: QueueShop[]) {
  if (!supabase?.storage) return shops;
  const imagePaths = shops
    .map((shop) => shop.image_path)
    .filter((path): path is string => Boolean(path));
  if (imagePaths.length === 0) return shops;

  try {
    const { data, error } = await supabase.storage
      .from(SHOP_IMAGE_BUCKET)
      .createSignedUrls(imagePaths, 3600);
    if (error) return shops;
    const imageUrls = new Map(
      (data ?? [])
        .filter((image) => image.path && image.signedUrl)
        .map((image) => [image.path!, image.signedUrl!]),
    );
    return shops.map((shop) => ({
      ...shop,
      image_url: shop.image_path ? imageUrls.get(shop.image_path) ?? null : null,
    }));
  } catch {
    return shops;
  }
}

export function FinancialOperations({ userRole = 'round_lead' }: { userRole?: AppRole }) {
  const serviceDate = toBangkokDateString();
  const isManager = userRole === 'admin' || userRole === 'round_lead';
  const { getOrCreatePendingRequest, clearPendingRequest } = usePendingRequests();
  const [runId, setRunId] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueShop[]>([]);
  const [receivables, setReceivables] = useState<Receivable[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [collectors, setCollectors] = useState<Collector[]>([]);
  const [collectorAvatarUrls, setCollectorAvatarUrls] = useState<Record<string, string>>({});
  const [failedCollectorAvatars, setFailedCollectorAvatars] = useState<Set<string>>(() => new Set());
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [paymentHistory, setPaymentHistory] = useState<PaymentHistoryItem[]>([]);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [evidence, setEvidence] = useState<File | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [printReceiptWanted, setPrintReceiptWanted] = useState(true);
  const [selectedShop, setSelectedShop] = useState<QueueShop | null>(null);
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);
  const [receiptWarning, setReceiptWarning] = useState<string | null>(null);
  const [historyReceipt, setHistoryReceipt] = useState<HistoryReceiptDetail | null>(null);
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
  const busyRef = useRef(busy);
  const receiptRef = useRef<PaymentReceipt | null>(receipt);
  busyRef.current = busy;
  receiptRef.current = receipt;

  const load = useCallback(async () => {
    if (!supabase) return;
    setError(null);
    const runResponse = await supabase
      .from('collection_runs')
      .select('id')
      .eq('service_date', serviceDate)
      .eq('status', 'open')
      .maybeSingle();
    if (runResponse.error) throw runResponse.error;

    const nextRunId = runResponse.data?.id ?? null;
    setRunId(nextRunId);
    if (nextRunId) {
      const queueResponse = await supabase.rpc(
        isManager ? 'get_collection_run_queue' : 'get_today_collection_run_queue',
        {
          p_collection_run_id: nextRunId,
        },
      );
      if (queueResponse.error) throw queueResponse.error;
      const nextQueue = await withSignedShopImages((queueResponse.data ?? []) as QueueShop[]);
      setQueue(nextQueue);
      setSelectedShop((current) => (
        current ? nextQueue.find((shop) => shop.shop_id === current.shop_id) ?? null : null
      ));
    } else {
      setQueue([]);
      setSelectedShop(null);
    }

    const paymentsPromise = supabase
      .from('payments')
      .select('id, receipt_number, received_amount, payment_method, status, recorded_at, void_reason, shops(code,name)')
      .order('recorded_at', { ascending: false })
      .limit(30);
    if (!isManager) {
      const paymentsResponse = await paymentsPromise;
      if (paymentsResponse.error) throw paymentsResponse.error;
      setPaymentHistory((paymentsResponse.data ?? []) as unknown as PaymentHistoryItem[]);
      return;
    }
    const [receivablesResponse, approvalsResponse, collectorsResponse, membersResponse, paymentsResponse] = await Promise.all([
      supabase.rpc('get_credit_receivables', { p_as_of_date: serviceDate }),
      supabase
        .from('financial_approval_requests')
        .select('id, kind, requested_amount, reason, status, requested_at, shops(code,name), users!financial_approval_requests_requested_by_fkey(display_name)')
        .eq('status', 'pending')
        .order('requested_at'),
      supabase.rpc('get_collection_collectors'),
      nextRunId
        ? supabase.from('collection_run_members').select('user_id').eq('collection_run_id', nextRunId)
        : Promise.resolve({ data: [], error: null }),
      paymentsPromise,
    ]);
    if (receivablesResponse.error) throw receivablesResponse.error;
    if (approvalsResponse.error) throw approvalsResponse.error;
    if (collectorsResponse.error) throw collectorsResponse.error;
    if (membersResponse.error) throw membersResponse.error;
    if (paymentsResponse.error) throw paymentsResponse.error;
    setReceivables((receivablesResponse.data ?? []) as Receivable[]);
    setApprovals((approvalsResponse.data ?? []) as unknown as Approval[]);
    setCollectors((collectorsResponse.data ?? []) as Collector[]);
    setMemberIds((membersResponse.data ?? []).map((member) => member.user_id));
    setPaymentHistory((paymentsResponse.data ?? []) as unknown as PaymentHistoryItem[]);
  }, [isManager, serviceDate]);

  useEffect(() => {
    void load().catch((loadError: unknown) => {
      setError(getErrorMessage(loadError));
    });
  }, [load]);

  useEffect(() => {
    if (!selectedShop) return;
    const page = pageRef.current;
    const previousOverflow = document.body.style.overflow;
    const closeOnKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        if (receiptRef.current) {
          void load().catch((loadError: unknown) => {
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
  }, [selectedShop?.shop_id]);

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
    } catch (actionError) {
      setError(getErrorMessage(actionError));
    } finally {
      setBusy(false);
    }
  };

  const saveRun = () => runAction(async () => {
    if (!supabase) return;
    const { error: rpcError } = await supabase.rpc('open_collection_run', {
      p_service_date: serviceDate,
      p_member_ids: memberIds.map((userId) => ({ user_id: userId })),
    });
    if (rpcError) throw rpcError;
    setSuccess(runId ? 'บันทึกผู้เก็บเงินแล้ว' : 'เปิดรอบและมอบหมายผู้เก็บเงินแล้ว');
  });

  const closeRun = () => runAction(async () => {
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
    setReceipt(null);
    setReceiptWarning(null);
    setSelectedShop(shop);
    setMethod(shop.payment_profile.default_payment_method);
    setAmount(Number(shop.outstanding_amount).toFixed(2));
    setReference('');
    setEvidence(null);
    setEvidenceError(null);
    setPrintReceiptWanted(true);
    setError(null);
  };

  const receivedAmount = Number(amount);
  const allocatedAmount = selectedShop
    ? Math.min(Number.isFinite(receivedAmount) ? receivedAmount : 0, Number(selectedShop.outstanding_amount))
    : 0;
  const referenceRequired = selectedShop
    ? methodRequires(selectedShop.payment_profile, method, 'reference')
    : false;
  const evidenceRequired = selectedShop
    ? methodRequires(selectedShop.payment_profile, method, 'evidence')
    : false;
  const paymentReady = Boolean(
    selectedShop
    && Number.isFinite(receivedAmount)
    && receivedAmount > 0
    && (method === 'cash' || receivedAmount <= selectedShop.outstanding_amount)
    && (!referenceRequired || reference.trim())
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

  const recordPayment = () => {
    const printWindow = printReceiptWanted
      ? window.open('', '_blank', 'popup,width=360,height=680')
      : null;
    return runAction(async () => {
      try {
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
          recordedAt: data.recorded_at,
          charges: [],
        };
        setReceipt(nextReceipt);
        setReceiptWarning(printReceiptWanted && !printWindow
          ? 'บันทึกรับเงินแล้ว แต่เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณากดพิมพ์ใบเสร็จอีกครั้ง'
          : null);
        setSuccess('บันทึกรับเงินแล้ว');
        void getReceiptCharges(data.payment_id)
          .then((charges) => {
            const printableReceipt = { ...nextReceipt, charges };
            setReceipt((current) => (
              current?.paymentId === data.payment_id ? printableReceipt : current
            ));
            if (printWindow) printReceipt(printableReceipt, printWindow);
          })
          .catch((receiptError: unknown) => {
            printWindow?.close();
            setReceiptWarning(
              `บันทึกรับเงินแล้ว แต่โหลดรายละเอียดรายการสำหรับใบเสร็จไม่สำเร็จ: ${getErrorMessage(receiptError)}`,
            );
          });
      } catch (paymentError) {
        printWindow?.close();
        throw paymentError;
      }
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
      void load().catch((loadError: unknown) => {
        setError(getErrorMessage(loadError));
      });
    }
    setReceipt(null);
    setReceiptWarning(null);
    setSelectedShop(null);
  };

  const printReceipt = (targetReceipt: PaymentReceipt, existingPrintWindow?: Window) => {
    const receiptHeightMm = Math.min(
      180,
      Math.max(42, 31 + targetReceipt.charges.length * 4.5 + targetReceipt.charges.reduce(
        (total, charge) => total + charge.items.length * 5,
        0,
      )),
    );
    const printWindow = existingPrintWindow
      ?? window.open('', '_blank', `popup,width=360,height=${Math.ceil(receiptHeightMm * 3.78)}`);
    if (!printWindow) {
      setError('เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาตป๊อปอัปแล้วลองใหม่');
      return;
    }

    const printDocument = printWindow.document;
    const style = printDocument.createElement('style');
    style.textContent = `
      @page { size: 57mm ${receiptHeightMm}mm; margin: 0; }
      * { box-sizing: border-box; }
      html, body { width: 57mm; min-height: ${receiptHeightMm}mm; margin: 0; }
      body {
        padding: 2mm 2.5mm;
        color: #000;
        background: #fff;
        font-family: "Noto Sans Thai", Tahoma, sans-serif;
        font-size: 7.5pt;
        line-height: 1.12;
      }
      main { display: grid; align-content: start; gap: .7mm; }
      strong { font-size: 9pt; text-align: center; }
      span, small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .items { display: grid; gap: .7mm; margin-top: .5mm; padding-top: .8mm; border-top: .25mm dashed #000; }
      .charge { display: grid; gap: .35mm; }
      .charge-number { font-size: 6.5pt; font-weight: 700; }
      .item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1mm; font-size: 7pt; }
      .item-name { overflow: visible; text-overflow: clip; white-space: normal; }
      .charge-payment { font-size: 6.5pt; text-align: right; }
      .total {
        display: flex;
        justify-content: space-between;
        margin-top: .5mm;
        padding-top: .8mm;
        border-top: .25mm dashed #000;
        font-size: 9pt;
        font-weight: 700;
      }
      small { font-size: 6.5pt; }
    `;
    printDocument.head.replaceChildren(style);

    const receiptElement = printDocument.createElement('main');
    const addLine = (tag: 'strong' | 'span' | 'small', text: string, className?: string) => {
      const element = printDocument.createElement(tag);
      element.textContent = text;
      if (className) element.className = className;
      receiptElement.append(element);
    };
    addLine('strong', 'ใบเสร็จรับเงิน');
    addLine('span', `${targetReceipt.shopCode} · ${targetReceipt.shopName}`);
    addLine('span', `${receiptDateTime.format(new Date(targetReceipt.recordedAt))} · ${paymentMethodLabel(targetReceipt.method)}`);

    const items = printDocument.createElement('section');
    items.className = 'items';
    if (targetReceipt.charges.length === 0) {
      const empty = printDocument.createElement('small');
      empty.textContent = 'ไม่มีรายละเอียดรายการสั่งซื้อ';
      items.append(empty);
    }
    for (const charge of targetReceipt.charges) {
      const chargeElement = printDocument.createElement('div');
      chargeElement.className = 'charge';
      const chargeNumber = printDocument.createElement('span');
      chargeNumber.className = 'charge-number';
      chargeNumber.textContent = `รายการสั่งซื้อ ${charge.chargeNumber}`;
      chargeElement.append(chargeNumber);
      for (const item of charge.items) {
        const itemElement = printDocument.createElement('div');
        itemElement.className = 'item';
        const itemName = printDocument.createElement('span');
        itemName.className = 'item-name';
        itemName.textContent = `${item.name} × ${item.quantity} ${item.unit}`;
        const itemAmount = printDocument.createElement('span');
        itemAmount.textContent = money.format(item.lineTotal);
        itemElement.append(itemName, itemAmount);
        chargeElement.append(itemElement);
      }
      const chargePayment = printDocument.createElement('small');
      chargePayment.className = 'charge-payment';
      chargePayment.textContent = `รับชำระบิลนี้ ${money.format(charge.receivedAmount)}`;
      chargeElement.append(chargePayment);
      items.append(chargeElement);
    }
    receiptElement.append(items);

    const total = printDocument.createElement('span');
    total.className = 'total';
    const totalLabel = printDocument.createElement('b');
    totalLabel.textContent = 'ยอดรับเงิน';
    const totalAmount = printDocument.createElement('b');
    totalAmount.textContent = money.format(targetReceipt.receivedAmount);
    total.append(totalLabel, totalAmount);
    receiptElement.append(total);
    addLine('small', `เลขที่ ${targetReceipt.receiptNumber}`);
    printDocument.body.replaceChildren(receiptElement);

    printWindow.addEventListener('afterprint', () => printWindow.close(), { once: true });
    printWindow.focus();
    printWindow.print();
  };

  const printHistoryReceipt = (payment: PaymentHistoryItem) => {
    const printWindow = window.open('', '_blank', 'popup,width=360,height=680');
    if (!printWindow) {
      setError('เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาตป๊อปอัปแล้วลองใหม่');
      return;
    }
    void runAction(async () => {
      try {
        const charges = await getReceiptCharges(payment.id);
        printReceipt({
          paymentId: payment.id,
          receiptNumber: payment.receipt_number,
          shopCode: payment.shops?.code ?? '—',
          shopName: payment.shops?.name ?? 'ไม่พบร้าน',
          method: payment.payment_method,
          receivedAmount: payment.received_amount,
          recordedAt: payment.recorded_at,
          charges,
        }, printWindow);
      } catch (printError) {
        printWindow.close();
        throw printError;
      }
    }, false);
  };

  const openHistoryReceipt = (payment: PaymentHistoryItem, trigger: HTMLButtonElement) => {
    historyReturnFocusRef.current = trigger;
    setHistoryReceipt({ payment, charges: null, error: null });
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

  const voidPayment = (payment: PaymentHistoryItem) => runAction(async () => {
    if (!supabase) return;
    const reason = window.prompt(`เหตุผลที่ยกเลิกรับเงินจาก ${payment.shops?.name ?? 'ร้านค้า'}`)?.trim();
    if (!reason) return;
    const { error: rpcError } = await supabase.rpc('void_payment', {
      p_payment_id: payment.id,
      p_reason: reason,
    });
    if (rpcError) throw rpcError;
    setSuccess('ยกเลิกรายการรับเงินแล้ว ยอดค้างถูกคำนวณใหม่');
  });

  return (
    <div className="financial-ops" ref={pageRef}>
      <header className="financial-ops__header">
        <div>
          <p className="eyebrow">การเงินหน้าร้าน</p>
          <h1>{isManager ? 'เก็บเงิน อนุมัติ และลูกหนี้' : 'คิวเก็บเงินของฉัน'}</h1>
          <span>วันที่ธุรกิจ {serviceDate}</span>
        </div>
        <button disabled={busy} onClick={() => void load()} type="button">รีเฟรชยอดล่าสุด</button>
      </header>
      {error ? <p className="employee-error" role="alert"><WarningCircle />{error}</p> : null}
      {success ? <p className="employee-success"><CheckCircle weight="fill" />{success}</p> : null}

      <section className="financial-ops__section">
        <div className="financial-ops__title">
          <div><Coins /><span><h2>รอบเก็บเงินท้ายวัน</h2><p>รวมยอดจากทุกครั้งที่ส่งในวันนี้</p></span></div>
          {isManager && runId ? <button disabled={busy} onClick={closeRun} type="button">ปิดรอบ</button> : null}
        </div>
        {isManager ? (
          <fieldset className="financial-ops__collectors">
            <legend>มอบหมายพนักงานผู้เก็บ</legend>
            {collectors.map((collector) => (
              <label className="financial-ops__collector" key={collector.id}>
                <input
                  checked={memberIds.includes(collector.id)}
                  onChange={(event) => setMemberIds((current) => event.target.checked
                    ? [...current, collector.id]
                    : current.filter((id) => id !== collector.id))}
                  type="checkbox"
                />
                <span className="financial-ops__collector-avatar" aria-hidden="true">
                  {collector.avatar_path
                    && collectorAvatarUrls[collector.avatar_path]
                    && !failedCollectorAvatars.has(collector.avatar_path) ? (
                      <img
                        alt=""
                        onError={() => setFailedCollectorAvatars((current) => new Set(current).add(collector.avatar_path!))}
                        src={collectorAvatarUrls[collector.avatar_path]}
                      />
                    ) : <UserCircle size={32} weight="duotone" />}
                </span>
                <span className="financial-ops__collector-identity">
                  <strong>{collector.nickname || collector.display_name}</strong>
                  <small>{collector.code} · {collector.display_name}</small>
                </span>
              </label>
            ))}
            <button disabled={busy || memberIds.length === 0} onClick={saveRun} type="button">
              {runId ? 'บันทึกผู้เก็บเงิน' : 'เปิดรอบและมอบหมาย'}
            </button>
          </fieldset>
        ) : null}
        {!runId ? <p className="financial-ops__empty">{isManager
          ? 'เลือกรายชื่อผู้เก็บเงินเพื่อเปิดรอบ'
          : 'วันนี้ยังไม่มีรอบเก็บเงินที่มอบหมายให้คุณ'}</p> : null}
        {runId && queue.length === 0 ? <p className="financial-ops__empty">ไม่มียอดท้ายวันที่ต้องเก็บ</p> : (
          <div className="financial-ops__shop-grid">
            {queue.map((shop) => (
              <button
                aria-label={`${shop.shop_code} · ${shop.shop_name} ค้าง ${money.format(shop.outstanding_amount)}`}
                className="financial-ops__shop-card"
                key={shop.shop_id}
                onClick={(event) => chooseShop(shop, event.currentTarget)}
                type="button"
              >
                <span className="financial-ops__shop-visual">
                  {shop.image_url ? (
                    <img alt="" aria-hidden="true" loading="lazy" src={shop.image_url} />
                  ) : (
                    <span><Storefront aria-hidden="true" size={36} weight="duotone" /></span>
                  )}
                  {shop.has_new_charges ? <small>มียอดเพิ่ม</small> : null}
                </span>
                <span className="financial-ops__shop-body">
                  <strong>{shop.shop_code}</strong>
                  <b>{shop.shop_name}</b>
                  <small><ListNumbers aria-hidden="true" size={15} /> {shop.charge_count} รายการค้าง</small>
                  <em>{money.format(shop.outstanding_amount)}</em>
                </span>
                <CaretRight aria-hidden="true" className="financial-ops__shop-arrow" size={20} />
              </button>
            ))}
          </div>
        )}
      </section>

      {selectedShop ? createPortal((
        <div
          aria-label={`รับเงิน ${selectedShop.shop_name}`}
          aria-modal="true"
          className="financial-ops__modal"
          ref={dialogRef}
          role="dialog"
        >
          <div
            className="financial-ops__modal-backdrop"
            onClick={() => {
              if (!busy) closePayment();
            }}
          />
          <article className="financial-ops__payment-card">
            <header>
              <span className="financial-ops__payment-image">
                {selectedShop.image_url ? (
                  <img alt={`ร้าน ${selectedShop.shop_name}`} src={selectedShop.image_url} />
                ) : (
                  <Storefront aria-hidden="true" size={40} weight="duotone" />
                )}
              </span>
              <span>
                <small>{selectedShop.shop_code} · {selectedShop.shop_name}</small>
                <h2>บันทึกรับเงิน</h2>
                <b>ยอดค้าง {money.format(selectedShop.outstanding_amount)}</b>
              </span>
              <button
                aria-label="ปิดหน้ารับเงิน"
                disabled={busy}
                onClick={closePayment}
                ref={closeButtonRef}
                type="button"
              >
                <X aria-hidden="true" size={22} />
              </button>
            </header>

            <section className="financial-ops__charge-list sr-only" aria-label="รายการส่งที่นำมาเก็บ">
              {selectedShop.charges.map((charge) => (
                <div key={charge.charge_id}>
                  <span>{charge.charge_number}</span>
                  <span>ค้าง {money.format(charge.outstanding_amount)}</span>
                </div>
              ))}
            </section>

            {receipt ? (
              <div className="financial-ops__payment-complete">
                <CheckCircle aria-hidden="true" size={24} weight="fill" />
                <span><strong>บันทึกรับเงินเรียบร้อย</strong><small>เลือกพิมพ์ใบเสร็จสำหรับร้านที่ต้องการ</small></span>
                {receiptWarning ? <small className="financial-ops__receipt-warning" role="status">{receiptWarning}</small> : null}
                {printReceiptWanted ? <button onClick={() => printReceipt(receipt)} type="button"><Printer aria-hidden="true" size={19} />พิมพ์ใบเสร็จ</button> : null}
                <button onClick={closePayment} type="button">เสร็จสิ้น</button>
              </div>
            ) : (
              <div className="financial-ops__payment">
                <section className="financial-ops__payment-methods" aria-labelledby="payment-method-label">
                  <h3 id="payment-method-label">1. วิธีการรับเงิน</h3>
                  <div style={{
                    gridTemplateColumns: `repeat(${selectedShop.payment_profile.allowed_payment_methods.length}, minmax(0, 1fr))`,
                  }}>
                    {selectedShop.payment_profile.allowed_payment_methods.map((allowedMethod) => {
                      const Icon = allowedMethod === 'cash' ? Money : allowedMethod === 'bank_transfer' ? Bank : ArrowsLeftRight;
                      return (
                        <button
                          aria-pressed={method === allowedMethod}
                          className={method === allowedMethod ? 'is-selected' : ''}
                          key={allowedMethod}
                          onClick={() => setMethod(allowedMethod)}
                          type="button"
                        >
                          <Icon aria-hidden="true" size={21} weight="duotone" />
                          {paymentMethodLabel(allowedMethod)}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <label className="financial-ops__payment-amount">
                  <span>2. ยอดรับเงินจริง</span>
                  <span className="financial-ops__currency" aria-hidden="true">฿</span>
                  <input
                    aria-label="ยอดรับเงินจริง"
                    inputMode="decimal"
                    min="0.01"
                    onChange={(event) => setAmount(event.target.value)}
                    step="0.01"
                    type="number"
                    value={amount}
                  />
                </label>

                <div className="financial-ops__quick-amounts" aria-label="เลือกยอดรับเงินด่วน">
                  {[100, 200, 500, 1000].map((value) => (
                    <button key={value} onClick={() => setAmount(value.toFixed(2))} type="button">
                      {value.toLocaleString('th-TH')}
                    </button>
                  ))}
                </div>

                <section className="financial-ops__payment-summary" aria-label="สรุปยอดรับเงิน">
                  <span><small>ตัดยอด</small><strong>{money.format(allocatedAmount)}</strong></span>
                  <span><small>เงินทอน</small><strong>{money.format(changeAmount)}</strong></span>
                  <span><small>คงเหลือหลังรายการ</small><b>{money.format(remainingAmount)}</b></span>
                </section>

                <label className="financial-ops__payment-reference">
                  <span>3. เลขอ้างอิง / หมายเหตุ <small>({referenceRequired ? 'บังคับกรอก' : 'ไม่บังคับ'})</small></span>
                  <input
                    aria-label="เลขอ้างอิง"
                    onChange={(event) => setReference(event.target.value)}
                    placeholder={referenceRequired ? 'กรอกเลขอ้างอิง' : `รับชำระค่าน้ำแข็ง วันที่ ${serviceDate}`}
                    required={referenceRequired}
                    value={reference}
                  />
                </label>

                <label className="financial-ops__payment-evidence">
                  <span>4. หลักฐานการชำระ <small>({evidenceRequired ? 'บังคับ' : 'ไม่บังคับ'})</small></span>
                  <input
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    aria-label="หลักฐานการชำระ"
                    onChange={(event) => selectEvidence(event.target.files?.[0] ?? null)}
                    required={evidenceRequired}
                    type="file"
                  />
                  <span className="financial-ops__dropzone">
                    <UploadSimple aria-hidden="true" size={31} weight="duotone" />
                    <b>{evidence ? evidence.name : 'คลิกหรือลากไฟล์มาวางที่นี่'}</b>
                    <small>รองรับไฟล์ JPG, PNG, PDF (ไม่เกิน 5MB)</small>
                  </span>
                  {evidenceError ? <small className="financial-ops__evidence-error" role="alert">{evidenceError}</small> : null}
                </label>
                <label className="financial-ops__print-choice">
                  <input checked={printReceiptWanted} disabled={busy} onChange={(event) => setPrintReceiptWanted(event.target.checked)} type="checkbox" />
                  <span>ต้องการพิมพ์ใบรับเงิน</span>
                </label>
                <footer className="financial-ops__payment-actions">
                  <button disabled={busy} onClick={closePayment} type="button">ยกเลิก</button>
                  <button disabled={busy || !paymentReady} onClick={recordPayment} type="button">
                    <CheckCircle aria-hidden="true" size={21} weight="regular" />
                    {busy ? 'กำลังบันทึก...' : 'ยืนยันรับเงิน'}
                  </button>
                </footer>
              </div>
            )}
          </article>
        </div>
      ), document.body) : null}

      {historyReceipt ? createPortal((
        <div
          aria-label={`รายละเอียดใบเสร็จ ${historyReceipt.payment.receipt_number}`}
          aria-modal="true"
          className="financial-ops__modal"
          ref={historyDialogRef}
          role="dialog"
        >
          <div className="financial-ops__modal-backdrop" onClick={() => setHistoryReceipt(null)} />
          <article className="financial-ops__payment-card financial-ops__receipt-detail-card">
            <header>
              <span className="financial-ops__receipt-detail-icon" aria-hidden="true"><Coins size={34} weight="duotone" /></span>
              <span>
                <small>ใบเสร็จรับเงิน</small>
                <h2>{historyReceipt.payment.receipt_number}</h2>
                <b>{historyReceipt.payment.shops?.code ?? '—'} · {historyReceipt.payment.shops?.name ?? 'ไม่พบร้าน'}</b>
              </span>
              <button
                aria-label="ปิดรายละเอียดใบเสร็จ"
                onClick={() => setHistoryReceipt(null)}
                ref={historyCloseButtonRef}
                type="button"
              >
                <X aria-hidden="true" size={22} />
              </button>
            </header>

            <section className="financial-ops__receipt-summary" aria-label="ข้อมูลการรับเงิน">
              <span><small>วันที่รับเงิน</small><strong>{receiptDateTime.format(new Date(historyReceipt.payment.recorded_at))}</strong></span>
              <span><small>วิธีรับเงิน</small><strong>{paymentMethodLabel(historyReceipt.payment.payment_method)}</strong></span>
              <span><small>ยอดรับเงิน</small><b>{money.format(historyReceipt.payment.received_amount)}</b></span>
            </section>

            {historyReceipt.payment.status === 'voided' ? (
              <p className="financial-ops__voided-receipt" role="status">รายการนี้ถูกยกเลิก: {historyReceipt.payment.void_reason ?? '—'}</p>
            ) : null}

            <section className="financial-ops__receipt-charges" aria-label="บิลที่ชำระ">
              <strong><ListNumbers aria-hidden="true" size={18} /> บิลที่ชำระ</strong>
              {historyReceipt.charges === null && !historyReceipt.error ? <p>กำลังโหลดรายละเอียดบิล...</p> : null}
              {historyReceipt.error ? <p className="employee-error" role="alert">โหลดรายละเอียดบิลไม่สำเร็จ: {historyReceipt.error}</p> : null}
              {historyReceipt.charges?.length === 0 ? <p>ไม่พบรายการบิลในใบเสร็จนี้</p> : null}
              {historyReceipt.charges?.map((charge) => (
                <article key={charge.chargeNumber}>
                  <header><strong>{charge.chargeNumber}</strong><b>{money.format(charge.receivedAmount)}</b></header>
                  {charge.items.map((item, index) => (
                    <div key={`${item.name}-${index}`}>
                      <span>{item.name} × {item.quantity} {item.unit}</span>
                      <b>{money.format(item.lineTotal)}</b>
                    </div>
                  ))}
                </article>
              ))}
            </section>

            <div className="financial-ops__receipt-actions">
              <button disabled={busy} onClick={() => printHistoryReceipt(historyReceipt.payment)} type="button"><Printer aria-hidden="true" size={19} />พิมพ์ซ้ำ</button>
              <button onClick={() => setHistoryReceipt(null)} type="button">ปิด</button>
            </div>
          </article>
        </div>
      ), document.body) : null}

      {isManager ? (
        <>
          <section className="financial-ops__section">
            <div className="financial-ops__title"><div><CreditCard /><span><h2>คำขออนุมัติ</h2><p>วงเงินเครดิตและยอดค้าง</p></span></div></div>
            {approvals.length === 0 ? <p className="financial-ops__empty">ไม่มีคำขอรออนุมัติ</p> : (
              <div className="financial-ops__cards">
                {approvals.map((approval) => (
                  <article key={approval.id}>
                    <strong>{approval.shops?.code} · {approval.shops?.name}</strong>
                    <span>{approval.kind === 'credit_limit' ? 'เกินวงเงินเครดิต' : 'ขอค้างชำระ'} · {money.format(approval.requested_amount)}</span>
                    <p>{approval.reason}</p>
                    <small>ผู้ขอ {approval.users?.display_name ?? '—'}</small>
                    <div><button disabled={busy} onClick={() => decide(approval.id, 'rejected')} type="button">ไม่อนุมัติ</button><button disabled={busy} onClick={() => decide(approval.id, 'approved')} type="button">อนุมัติ</button></div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="financial-ops__section">
            <div className="financial-ops__title"><div><CreditCard /><span><h2>ลูกหนี้เครดิต</h2><p>ยอดคงค้างและวันครบกำหนด</p></span></div></div>
            {receivables.length === 0 ? <p className="financial-ops__empty">ไม่มีลูกหนี้เครดิตคงค้าง</p> : (
              <div className="financial-ops__list">
                {receivables.map((item) => (
                  <div key={item.shop_id}>
                    <span><strong>{item.shop_code} · {item.shop_name}</strong><small>ครบกำหนดเก่าสุด {item.oldest_due_date}{item.overdue_amount > 0 ? ` · เกินกำหนด ${money.format(item.overdue_amount)}` : ''}</small></span>
                    <b>{money.format(item.outstanding_amount)}</b>
                  </div>
                ))}
              </div>
            )}
          </section>

        </>
      ) : null}

      <section className="financial-ops__section">
        <div className="financial-ops__title"><div><Coins /><span><h2>ประวัติรับเงินล่าสุด</h2><p>พิมพ์ใบเสร็จซ้ำจากข้อมูลเดิม{isManager ? ' หรือตรวจสอบรายการที่บันทึกผิด' : ''}</p></span></div></div>
        {paymentHistory.length === 0 ? <p className="financial-ops__empty">ยังไม่มีรายการรับเงิน</p> : (
          <div className="financial-ops__list">
            {paymentHistory.map((payment) => (
              <article className="financial-ops__history-item" key={payment.id}>
                <button
                  aria-label={`ดูบิล ${payment.receipt_number} ของ ${payment.shops?.name ?? 'ร้านค้า'}`}
                  className="financial-ops__history-summary"
                  onClick={(event) => openHistoryReceipt(payment, event.currentTarget)}
                  type="button"
                >
                  <span>
                    <strong>{payment.shops?.code ?? '—'} · {payment.shops?.name ?? 'ไม่พบร้าน'}</strong>
                    <small>{payment.receipt_number} · {paymentMethodLabel(payment.payment_method)} · {receiptDateTime.format(new Date(payment.recorded_at))}{payment.status === 'voided' ? ` · ยกเลิก: ${payment.void_reason ?? '—'}` : ''}</small>
                  </span>
                  <span className="financial-ops__history-open-label">ดูบิล <CaretRight aria-hidden="true" size={19} /></span>
                </button>
                <span className="financial-ops__history-side">
                  <b>{money.format(payment.received_amount)}</b>
                  {payment.status === 'active' ? (
                    <span className="financial-ops__history-actions">
                      <button disabled={busy} onClick={() => printHistoryReceipt(payment)} type="button"><Printer aria-hidden="true" size={16} />พิมพ์ซ้ำ</button>
                      {isManager ? <button disabled={busy} onClick={() => voidPayment(payment)} type="button">ยกเลิกรายการ</button> : null}
                    </span>
                  ) : null}
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
