import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle, Coins, CreditCard, UserCircle, WarningCircle } from '@phosphor-icons/react';
import { supabase } from './lib/supabase';
import { toBangkokDateString } from './lib/serviceDate';
import { uploadPaymentEvidence } from './lib/paymentEvidence';
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
  outstanding_amount: number;
  charge_count: number;
  has_new_charges: boolean;
  payment_profile: PaymentProfile;
  charges: Array<{ charge_id: string; outstanding_amount: number }>;
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

type PaymentHistoryItem = {
  id: string;
  received_amount: number;
  payment_method: PaymentMethod;
  status: 'active' | 'voided';
  recorded_at: string;
  void_reason: string | null;
  shops: { code: string; name: string } | null;
};

const money = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 2,
});

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
  const [selectedShop, setSelectedShop] = useState<QueueShop | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

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
      const queueResponse = await supabase.rpc('get_collection_run_queue', {
        p_collection_run_id: nextRunId,
      });
      if (queueResponse.error) throw queueResponse.error;
      const nextQueue = (queueResponse.data ?? []) as QueueShop[];
      setQueue(nextQueue);
      setSelectedShop((current) => (
        current ? nextQueue.find((shop) => shop.shop_id === current.shop_id) ?? null : null
      ));
    } else {
      setQueue([]);
      setSelectedShop(null);
    }

    if (!isManager) return;
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
      supabase
        .from('payments')
        .select('id, received_amount, payment_method, status, recorded_at, void_reason, shops(code,name)')
        .order('recorded_at', { ascending: false })
        .limit(30),
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
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
  }, [load]);

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

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
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

  const chooseShop = (shop: QueueShop) => {
    setSelectedShop(shop);
    setMethod(shop.payment_profile.default_payment_method);
    setAmount(String(shop.outstanding_amount));
    setReference('');
    setEvidence(null);
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

  const recordPayment = () => runAction(async () => {
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
    const { error: rpcError } = await supabase.rpc('record_payment', {
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
    clearPendingRequest(signature, request.key);
    setSelectedShop(null);
    setReference('');
    setEvidence(null);
    setSuccess('บันทึกรับเงินแล้ว');
  });

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
    <div className="financial-ops">
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
          <div className="financial-ops__list">
            {queue.map((shop) => (
              <button key={shop.shop_id} onClick={() => chooseShop(shop)} type="button">
                <span><strong>{shop.shop_code} · {shop.shop_name}</strong><small>{shop.charge_count} รายการค้าง{shop.has_new_charges ? ' · มียอดเพิ่ม' : ''}</small></span>
                <b>{money.format(shop.outstanding_amount)}</b>
              </button>
            ))}
          </div>
        )}
        {selectedShop ? (
          <div className="financial-ops__payment">
            <strong>รับเงิน {selectedShop.shop_name} · ค้าง {money.format(selectedShop.outstanding_amount)}</strong>
            <select onChange={(event) => setMethod(event.target.value as PaymentMethod)} value={method}>
              {selectedShop.payment_profile.allowed_payment_methods.map((allowedMethod) => (
                <option key={allowedMethod} value={allowedMethod}>
                  {allowedMethod === 'cash' ? 'เงินสด' : allowedMethod === 'bank_transfer' ? 'โอน' : 'QR'}
                </option>
              ))}
            </select>
            <input
              aria-label="ยอดรับเงินจริง"
              inputMode="decimal"
              min="0.01"
              onChange={(event) => setAmount(event.target.value)}
              step="0.01"
              type="number"
              value={amount}
            />
            <input
              aria-label="เลขอ้างอิง"
              onChange={(event) => setReference(event.target.value)}
              placeholder={referenceRequired ? 'เลขอ้างอิง *' : 'เลขอ้างอิง (ถ้ามี)'}
              required={referenceRequired}
              value={reference}
            />
            <label>
              <span>หลักฐาน{evidenceRequired ? ' *' : ''}</span>
              <input
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(event) => setEvidence(event.target.files?.[0] ?? null)}
                required={evidenceRequired}
                type="file"
              />
            </label>
            <button disabled={busy || !paymentReady} onClick={recordPayment} type="button">ยืนยันรับเงิน</button>
          </div>
        ) : null}
      </section>

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

          <section className="financial-ops__section">
            <div className="financial-ops__title"><div><Coins /><span><h2>ประวัติรับเงินล่าสุด</h2><p>ตรวจสอบหรือยกเลิกรายการที่บันทึกผิด</p></span></div></div>
            {paymentHistory.length === 0 ? <p className="financial-ops__empty">ยังไม่มีรายการรับเงิน</p> : (
              <div className="financial-ops__list">
                {paymentHistory.map((payment) => (
                  <div key={payment.id}>
                    <span>
                      <strong>{payment.shops?.code ?? '—'} · {payment.shops?.name ?? 'ไม่พบร้าน'}</strong>
                      <small>{payment.payment_method === 'cash' ? 'เงินสด' : payment.payment_method === 'bank_transfer' ? 'โอน' : 'QR'} · {new Intl.DateTimeFormat('th-TH', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(payment.recorded_at))}{payment.status === 'voided' ? ` · ยกเลิก: ${payment.void_reason ?? '—'}` : ''}</small>
                    </span>
                    <span>
                      <b>{money.format(payment.received_amount)}</b>
                      {payment.status === 'active' ? <button disabled={busy} onClick={() => voidPayment(payment)} type="button">ยกเลิกรายการ</button> : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
