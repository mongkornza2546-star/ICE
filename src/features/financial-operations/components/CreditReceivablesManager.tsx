import {
  ArrowSquareOut,
  CalendarBlank,
  CaretRight,
  ChartBar,
  Coins,
  CreditCard,
  FileText,
  MagnifyingGlass,
  PencilSimple,
  Play,
  Prohibit,
  Receipt,
  Storefront,
  UsersThree,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { useEffect, useState, type CSSProperties } from 'react';
import type { AppRole, CreditDueRule } from '../../../types/app';
import { CREDIT_COLLECTION_WEEKDAY_OPTIONS, formatCreditCollectionCycle } from '../../../lib/creditCollectionCycle';
import type {
  Approval,
  DueDateRequest,
  Receivable,
  ReceivableCharge,
  ReceivableDetail,
  ReceivablePayment,
} from '../types';
import { money, paymentMethodLabel, receiptDateTime } from '../utils';
import { DeliveryCorrectionDialog } from '../../delivery-corrections/DeliveryCorrectionDialog';

export type CreditAccountStatus = 'normal' | 'near_limit' | 'at_limit' | 'over_limit' | 'overdue' | 'suspended';

type CreditChanges = {
  credit_limit?: number | null;
  credit_due_rule?: CreditDueRule;
  credit_days?: number | null;
  credit_collection_weekday?: number | null;
  credit_suspended?: boolean;
  credit_suspension_reason?: string | null;
};

export type CreditReceivablesManagerProps = {
  approvals: Approval[];
  dueDateRequests: DueDateRequest[];
  receivables: Receivable[];
  busy: boolean;
  runId: string | null;
  serviceDate?: string;
  userRole?: AppRole;
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => void;
  onDecideDueDateRequest: (requestId: string, decision: 'approved' | 'rejected') => void;
  onLoadDetail?: (receivable: Receivable) => Promise<ReceivableDetail>;
  onRefreshReceivables?: () => Promise<void>;
  onToggleCreditCollectionAssignment: (charge: ReceivableCharge, assigned: boolean) => Promise<unknown> | void;
  onOpenCollection?: (receivable: Receivable) => void;
  onUpdateCreditSettings?: (receivable: Receivable, changes: CreditChanges) => Promise<void> | void;
};

const statusMeta: Record<CreditAccountStatus, { label: string; tone: string }> = {
  normal: { label: 'ปกติ', tone: 'normal' },
  near_limit: { label: 'ใกล้เต็มวงเงิน', tone: 'warning' },
  at_limit: { label: 'เต็มวงเงิน', tone: 'danger' },
  over_limit: { label: 'เกินวงเงิน', tone: 'danger' },
  overdue: { label: 'เกินกำหนด', tone: 'overdue' },
  suspended: { label: 'ระงับเครดิต', tone: 'suspended' },
};

const thaiShortDate = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
const thaiDate = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium' });

function parseDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(value: string | null, serviceDate: string) {
  if (!value) return '—';
  return value === serviceDate ? 'วันนี้' : thaiShortDate.format(parseDate(value));
}

function chargeStatus(charge: ReceivableCharge) {
  if (charge.payment_status === 'paid') return 'ชำระครบ';
  if (charge.due_status === 'overdue') return charge.payment_status === 'partial' ? 'ชำระบางส่วน · เกินกำหนด' : 'เกินกำหนด';
  if (charge.due_status === 'due_today') return charge.payment_status === 'partial' ? 'ชำระบางส่วน · ถึงกำหนดวันนี้' : 'ถึงกำหนดวันนี้';
  return charge.payment_status === 'partial' ? 'ชำระบางส่วน' : 'ยังไม่ถึงกำหนด';
}

export function getCreditAccountStatus(receivable: Receivable): CreditAccountStatus {
  if (receivable.credit_suspended) return 'suspended';
  if (receivable.credit_limit !== null && Number(receivable.outstanding_amount) > Number(receivable.credit_limit)) return 'over_limit';
  if (Number(receivable.overdue_amount) > 0) return 'overdue';
  if (receivable.credit_limit !== null && Number(receivable.outstanding_amount) === Number(receivable.credit_limit)) return 'at_limit';
  if (receivable.credit_limit !== null && Number(receivable.credit_limit) > 0
    && Number(receivable.outstanding_amount) / Number(receivable.credit_limit) >= .8) return 'near_limit';
  return 'normal';
}

function StatusBadge({ receivable }: { receivable: Receivable }) {
  const meta = statusMeta[getCreditAccountStatus(receivable)];
  return <span className={`credit-ar__status credit-ar__status--${meta.tone}`}>{meta.label}</span>;
}

function dueTodayAmount(receivable: Receivable) {
  return Number(receivable.due_today_amount ?? receivable.charges
    .filter((charge) => charge.due_status === 'due_today')
    .reduce((sum, charge) => sum + Number(charge.outstanding_amount), 0));
}

function overdueChargeCount(receivable: Receivable) {
  return Number(receivable.overdue_charge_count ?? receivable.charges
    .filter((charge) => charge.due_status === 'overdue').length);
}

function agingAmounts(receivable: Receivable) {
  const charges = receivable.charges;
  return {
    current: Number(receivable.aging_current_amount ?? charges
      .filter((charge) => charge.due_status === 'not_due' || charge.due_status === 'due_today')
      .reduce((sum, charge) => sum + Number(charge.outstanding_amount), 0)),
    days1To7: Number(receivable.aging_1_7_amount ?? charges
      .filter((charge) => charge.days_overdue >= 1 && charge.days_overdue <= 7)
      .reduce((sum, charge) => sum + Number(charge.outstanding_amount), 0)),
    days8To15: Number(receivable.aging_8_15_amount ?? charges
      .filter((charge) => charge.days_overdue >= 8 && charge.days_overdue <= 15)
      .reduce((sum, charge) => sum + Number(charge.outstanding_amount), 0)),
    days16To30: Number(receivable.aging_16_30_amount ?? charges
      .filter((charge) => charge.days_overdue >= 16 && charge.days_overdue <= 30)
      .reduce((sum, charge) => sum + Number(charge.outstanding_amount), 0)),
    over30: Number(receivable.aging_over_30_amount ?? charges
      .filter((charge) => charge.days_overdue > 30)
      .reduce((sum, charge) => sum + Number(charge.outstanding_amount), 0)),
  };
}

function SummaryCards({ receivables }: { receivables: Receivable[] }) {
  const total = receivables.reduce((sum, item) => sum + Number(item.outstanding_amount), 0);
  const dueToday = receivables.reduce((sum, item) => sum + dueTodayAmount(item), 0);
  const overdue = receivables.reduce((sum, item) => sum + Number(item.overdue_amount), 0);
  const overdueBills = receivables.reduce((sum, item) => sum + overdueChargeCount(item), 0);
  const suspended = receivables.filter((item) => item.credit_suspended).length;
  return <div className="credit-ar__summary-cards" aria-label="สรุปลูกหนี้เครดิต">
    <article><span>ลูกหนี้เครดิตทั้งหมด</span><strong>{money.format(total)}</strong><small>{receivables.length} ร้าน</small></article>
    <article><span>ถึงกำหนดวันนี้</span><strong>{money.format(dueToday)}</strong><small>ตามวันที่เลือก</small></article>
    <article className="is-danger"><span>เกินกำหนด</span><strong>{money.format(overdue)}</strong><small>{overdueBills} บิล</small></article>
    <article className="is-suspended"><span>ร้านถูกระงับเครดิต</span><strong>{suspended} ร้าน</strong><small>ไม่สามารถใช้เครดิต</small></article>
  </div>;
}

function ReceivableDrawer({
  busy,
  canAdminister,
  onLoadDetail,
  onClose,
  onOpenCollection,
  onRefreshReceivables,
  onToggleCreditCollectionAssignment,
  onUpdateCreditSettings,
  receivable,
  runId,
  serviceDate,
  userRole,
}: {
  busy: boolean;
  canAdminister: boolean;
  onLoadDetail?: (receivable: Receivable) => Promise<ReceivableDetail>;
  onClose: () => void;
  onOpenCollection?: (receivable: Receivable) => void;
  onRefreshReceivables?: () => Promise<void>;
  onToggleCreditCollectionAssignment: (charge: ReceivableCharge, assigned: boolean) => Promise<unknown> | void;
  onUpdateCreditSettings?: (receivable: Receivable, changes: CreditChanges) => Promise<void> | void;
  receivable: Receivable;
  runId: string | null;
  serviceDate: string;
  userRole: AppRole;
}) {
  const [billFilter, setBillFilter] = useState<'open' | 'all'>('open');
  const [selectedPayment, setSelectedPayment] = useState<ReceivablePayment | null>(null);
  const [selectedCharge, setSelectedCharge] = useState<ReceivableCharge | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const initialCycleRule = receivable.credit_due_rule
    ?? (receivable.credit_days ? 'net_days' : 'end_of_month');
  const [cycleEditorOpen, setCycleEditorOpen] = useState(false);
  const [cycleRule, setCycleRule] = useState<CreditDueRule>(initialCycleRule);
  const [cycleDays, setCycleDays] = useState(receivable.credit_days ?? 30);
  const [cycleWeekday, setCycleWeekday] = useState(receivable.credit_collection_weekday ?? 5);
  const [detail, setDetail] = useState<ReceivableDetail>({
    charges: receivable.charges,
    payments: receivable.payments ?? [],
  });
  const [detailLoading, setDetailLoading] = useState(Boolean(onLoadDetail));
  const charges = detail.charges.filter((charge) => billFilter === 'all' || charge.payment_status !== 'paid');
  const hasCollectibleBalance = detail.charges.some((charge) => charge.outstanding_amount > 0 && charge.due_date <= serviceDate);

  useEffect(() => {
    if (!onLoadDetail) return;
    let active = true;
    setDetailLoading(true);
    setActionError(null);
    void onLoadDetail(receivable).then((nextDetail) => {
      if (active) setDetail(nextDetail);
    }).catch((error: unknown) => {
      if (active) setActionError(error instanceof Error ? error.message : 'ไม่สามารถโหลดรายละเอียดลูกหนี้ได้');
    }).finally(() => {
      if (active) setDetailLoading(false);
    });
    return () => { active = false; };
  }, [onLoadDetail, receivable.shop_id]);

  const updateCredit = async (changes: CreditChanges) => {
    if (!onUpdateCreditSettings) return false;
    setActionBusy(true);
    setActionError(null);
    try {
      await onUpdateCreditSettings(receivable, changes);
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'ไม่สามารถบันทึกการเปลี่ยนแปลงได้');
      return false;
    } finally {
      setActionBusy(false);
    }
  };

  const resetCycleDraft = () => {
    setCycleRule(initialCycleRule);
    setCycleDays(receivable.credit_days ?? 30);
    setCycleWeekday(receivable.credit_collection_weekday ?? 5);
  };

  const openCycleEditor = () => {
    resetCycleDraft();
    setCycleEditorOpen(true);
  };

  const cancelCycleEditor = () => {
    resetCycleDraft();
    setCycleEditorOpen(false);
  };

  const editLimit = () => {
    const value = window.prompt('วงเงินเครดิตใหม่ (เว้นว่างสำหรับไม่จำกัด)', receivable.credit_limit === null ? '' : String(receivable.credit_limit));
    if (value === null) return;
    if (value.trim() !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
      setActionError('วงเงินเครดิตต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป');
      return;
    }
    void updateCredit({ credit_limit: value.trim() === '' ? null : Number(value) });
  };

  const saveCycle = async () => {
    if (cycleRule === 'net_days' && (!Number.isInteger(cycleDays) || cycleDays < 1)) {
      setActionError('จำนวนวันหลังส่งต้องเป็นจำนวนเต็มตั้งแต่ 1 วันขึ้นไป');
      return;
    }
    const saved = await updateCredit({
      credit_due_rule: cycleRule,
      credit_days: cycleRule === 'net_days' ? cycleDays : null,
      credit_collection_weekday: cycleRule === 'weekly' ? cycleWeekday : null,
    });
    if (saved) setCycleEditorOpen(false);
  };

  const toggleSuspension = () => {
    if (receivable.credit_suspended) {
      if (window.confirm(`เปิดใช้เครดิตของ ${receivable.shop_code} อีกครั้งหรือไม่`)) {
        void updateCredit({ credit_suspended: false, credit_suspension_reason: null });
      }
      return;
    }
    const reason = window.prompt('เหตุผลที่ระงับเครดิต');
    if (reason?.trim()) void updateCredit({ credit_suspended: true, credit_suspension_reason: reason.trim() });
  };

  const toggleCollectionPlan = async (charge: ReceivableCharge) => {
    const assigned = !charge.assigned_collection_run_id;
    setActionBusy(true);
    setActionError(null);
    try {
      const updated = await onToggleCreditCollectionAssignment(charge, assigned);
      if (updated === false) return;
      setDetail((current) => ({
        ...current,
        charges: current.charges.map((item) => item.charge_id === charge.charge_id
          ? { ...item, assigned_collection_run_id: assigned ? runId : null }
          : item),
      }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'ไม่สามารถแก้ไขแผนเก็บเงินได้');
    } finally {
      setActionBusy(false);
    }
  };

  const refreshAfterCorrection = async () => {
    await onRefreshReceivables?.();
    if (onLoadDetail) setDetail(await onLoadDetail(receivable));
    setSelectedCharge(null);
  };

  return <div className="credit-ar__drawer-layer">
    <button aria-label="ปิดรายละเอียดร้าน" className="credit-ar__drawer-backdrop" onClick={onClose} type="button" />
    <aside aria-label={`รายละเอียดลูกหนี้ ${receivable.shop_code}`} aria-modal="true" className="credit-ar__drawer" role="dialog">
      <header className="credit-ar__drawer-header">
        <span className="credit-ar__drawer-shop-icon"><Storefront size={22} weight="duotone" /></span>
        <span><small>{receivable.shop_code}</small><h2>{receivable.shop_name}</h2><StatusBadge receivable={receivable} /></span>
        <button aria-label="ปิดรายละเอียด" onClick={onClose} type="button"><X size={20} /></button>
      </header>

      <div className="credit-ar__drawer-actions">
        {canAdminister ? <>
          <button disabled={busy || actionBusy} onClick={editLimit} type="button"><PencilSimple size={16} />แก้ไขวงเงิน</button>
          <button disabled={busy || actionBusy} onClick={openCycleEditor} type="button"><CalendarBlank size={16} />แก้รอบเก็บเงิน</button>
          <button className={receivable.credit_suspended ? 'is-positive' : 'is-danger'} disabled={busy || actionBusy} onClick={toggleSuspension} type="button">{receivable.credit_suspended ? <Play size={16} /> : <Prohibit size={16} />}{receivable.credit_suspended ? 'เปิดใช้เครดิต' : 'ระงับเครดิต'}</button>
        </> : null}
        <button disabled={detailLoading || !onOpenCollection || !runId || !hasCollectibleBalance} onClick={() => onOpenCollection?.(receivable)} type="button"><Coins size={16} />บันทึกรับเงิน</button>
      </div>
      {actionError ? <p className="credit-ar__action-error" role="alert">{actionError}</p> : null}

      {cycleEditorOpen ? <div className="modal-backdrop">
        <section aria-labelledby="credit-cycle-editor-title" className="panel" role="dialog" style={{ maxWidth: 480, width: '90%' }}>
          <div className="panel-header"><h2 id="credit-cycle-editor-title">แก้รอบเก็บเงิน</h2><button aria-label="ปิดตัวแก้รอบเก็บเงิน" className="ghost-button" onClick={cancelCycleEditor} type="button"><X size={20} /></button></div>
          <div className="field-grid">
            <label>รอบเก็บเงิน<select aria-label="รอบเก็บเงิน" onChange={(event) => setCycleRule(event.target.value as CreditDueRule)} value={cycleRule}><option value="weekly">ทุกสัปดาห์</option><option value="end_of_month">ทุกสิ้นเดือน</option><option value="net_days">หลังส่งสินค้า X วัน</option></select></label>
            {cycleRule === 'weekly' ? <label>วันเก็บเงินประจำสัปดาห์<select aria-label="วันเก็บเงินประจำสัปดาห์" onChange={(event) => setCycleWeekday(Number(event.target.value))} value={cycleWeekday}>{CREDIT_COLLECTION_WEEKDAY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label> : null}
            {cycleRule === 'net_days' ? <label>จำนวนวันหลังส่งสินค้า<input aria-label="จำนวนวันหลังส่งสินค้า" min="1" onChange={(event) => setCycleDays(Number(event.target.value))} type="number" value={cycleDays} /></label> : null}
          </div>
          <p>{formatCreditCollectionCycle({ credit_due_rule: cycleRule, credit_days: cycleRule === 'net_days' ? cycleDays : null, credit_collection_weekday: cycleRule === 'weekly' ? cycleWeekday : null })}</p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button className="secondary-button" onClick={cancelCycleEditor} type="button">ยกเลิก</button><button className="primary-button" disabled={actionBusy} onClick={() => void saveCycle()} type="button">บันทึกรอบเก็บเงิน</button></div>
        </section>
      </div> : null}

      <section className="credit-ar__drawer-section">
        <div className="credit-ar__drawer-section-title"><span><CreditCard size={18} /><h3>สรุปเครดิต</h3></span></div>
        <div className="credit-ar__credit-summary">
          <span><small>วงเงินเครดิต</small><strong>{receivable.credit_limit === null ? 'ไม่จำกัด' : money.format(receivable.credit_limit)}</strong></span>
          <span><small>เครดิตที่ใช้ไป</small><strong>{money.format(receivable.outstanding_amount)}</strong></span>
          <span><small>เครดิตคงเหลือ</small><strong>{receivable.credit_limit === null ? 'ไม่จำกัด' : money.format(Number(receivable.credit_limit) - Number(receivable.outstanding_amount))}</strong></span>
          <span><small>ยอดค้างทั้งหมด</small><strong>{money.format(receivable.outstanding_amount)}</strong></span>
          <span className={Number(receivable.overdue_amount) > 0 ? 'is-danger' : ''}><small>ยอดเกินกำหนด</small><strong>{money.format(receivable.overdue_amount)}</strong></span>
          <span><small>รอบเก็บเงิน</small><strong>{formatCreditCollectionCycle(receivable)}</strong></span>
          <span><small>วันเก็บเงินล่าสุด</small><strong>{receivable.last_payment_at ? thaiDate.format(new Date(receivable.last_payment_at)) : 'ยังไม่มีข้อมูล'}</strong></span>
          <span><small>พื้นที่</small><strong>{[receivable.building_name, receivable.zone_name].filter(Boolean).join(' · ') || '—'}</strong></span>
        </div>
        {receivable.credit_suspended && receivable.credit_suspension_reason ? <p className="credit-ar__suspension-reason"><Prohibit size={16} />เหตุผลที่ระงับ: {receivable.credit_suspension_reason}</p> : null}
      </section>

      <section className="credit-ar__drawer-section">
        <div className="credit-ar__drawer-section-title"><span><Receipt size={18} /><h3>บิลเครดิต</h3></span><select aria-label="กรองบิลในรายละเอียดร้าน" onChange={(event) => setBillFilter(event.target.value as typeof billFilter)} value={billFilter}><option value="open">บิลที่ยังค้าง</option><option value="all">บิลทั้งหมด</option></select></div>
        {detailLoading ? <p className="financial-ops__empty">กำลังโหลดรายละเอียดบิล...</p> : <div className="credit-ar__bill-table-wrap"><table className="credit-ar__bill-table">
          <thead><tr><th>เลขที่บิล</th><th>วันที่ส่ง</th><th>ครบกำหนด</th><th>ยอดบิล</th><th>ชำระแล้ว</th><th>คงเหลือ</th><th>สถานะ</th><th>แผนเก็บเงิน</th></tr></thead>
          <tbody>{charges.map((charge) => <tr key={charge.charge_id}><td>{charge.payment_status === 'paid' ? charge.charge_number : <button aria-label={`เปิดรายละเอียดบิล ${charge.charge_number}`} className="credit-ar__bill-link" onClick={() => setSelectedCharge(charge)} type="button">{charge.charge_number}</button>}</td><td>{formatDate(charge.service_date, serviceDate)}</td><td>{formatDate(charge.due_date, serviceDate)}</td><td>{money.format(charge.original_amount)}</td><td>{money.format(charge.allocated_amount)}</td><td><strong>{money.format(charge.outstanding_amount)}</strong></td><td><span className={`credit-ar__bill-status credit-ar__bill-status--${charge.due_status}`}>{chargeStatus(charge)}</span></td><td>{charge.outstanding_amount <= 0 ? '—' : charge.due_date <= serviceDate ? <span>เข้าเก็บอัตโนมัติ</span> : <button disabled={busy || actionBusy || !runId} onClick={() => { void toggleCollectionPlan(charge); }} type="button">{charge.assigned_collection_run_id ? 'ถอนจากแผนเก็บ' : 'เพิ่มเข้าแผนเก็บ'}</button>}</td></tr>)}</tbody>
        </table></div>
        }
        {charges.length === 0 ? <p className="financial-ops__empty">ไม่มีบิลในตัวกรองนี้</p> : null}
      </section>

      <section className="credit-ar__drawer-section">
        <div className="credit-ar__drawer-section-title"><span><Coins size={18} /><h3>ประวัติการรับชำระ</h3></span></div>
        {detailLoading ? <p className="financial-ops__empty">กำลังโหลดประวัติรับชำระ...</p> : detail.payments.length === 0 ? <p className="financial-ops__empty">ยังไม่มีประวัติรับชำระ</p> : <div className="credit-ar__payment-list">{detail.payments.map((payment) => <button key={payment.id} onClick={() => setSelectedPayment(payment)} type="button"><span><strong>{payment.receipt_number}</strong><small>{receiptDateTime.format(new Date(payment.recorded_at))} · {paymentMethodLabel(payment.payment_method)} · ผู้รับ {payment.recorded_by ?? '—'}</small></span><b>{money.format(payment.received_amount)}</b><em className={payment.status === 'active' ? 'is-active' : ''}>{payment.status === 'active' ? 'สำเร็จ' : 'ยกเลิก'}</em><CaretRight size={16} /></button>)}</div>}
        {selectedPayment ? <div className="credit-ar__allocation-detail"><header><span><Receipt size={17} /><strong>การจัดสรร {selectedPayment.receipt_number}</strong></span><button aria-label="ปิดรายละเอียดการจัดสรร" onClick={() => setSelectedPayment(null)} type="button"><X size={16} /></button></header>{selectedPayment.allocations.map((allocation) => <div key={`${selectedPayment.id}-${allocation.charge_id}`}><span>{allocation.charge_number}</span><b>{money.format(allocation.amount)}</b></div>)}</div> : null}
      </section>
      {selectedCharge?.delivery_event_id ? <DeliveryCorrectionDialog eventId={selectedCharge.delivery_event_id} onClose={() => setSelectedCharge(null)} onSuccess={refreshAfterCorrection} userRole={userRole} /> : selectedCharge ? <p className="credit-ar__action-error">ไม่พบรายการส่งต้นทางของบิลนี้</p> : null}
    </aside>
  </div>;
}

export function CreditReceivablesManager({
  approvals,
  busy,
  dueDateRequests,
  onDecide,
  onDecideDueDateRequest,
  onLoadDetail,
  onOpenCollection,
  onRefreshReceivables,
  onToggleCreditCollectionAssignment,
  onUpdateCreditSettings,
  receivables,
  runId,
  serviceDate = new Date().toISOString().slice(0, 10),
  userRole = 'round_lead',
}: CreditReceivablesManagerProps) {
  const [activeView, setActiveView] = useState<'overview' | 'customers' | 'requests' | 'aging'>('customers');
  const [query, setQuery] = useState('');
  const [creditStatus, setCreditStatus] = useState<'all' | CreditAccountStatus>('all');
  const [dueStatus, setDueStatus] = useState<'all' | 'not_due' | 'due_today' | 'overdue'>('all');
  const [zone, setZone] = useState('all');
  const [responsible, setResponsible] = useState('all');
  const [sortBy, setSortBy] = useState<'due_date' | 'outstanding' | 'overdue'>('due_date');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = receivables
    .filter((item) => `${item.shop_code} ${item.shop_name}`.toLocaleLowerCase().includes(normalizedQuery))
    .filter((item) => creditStatus === 'all' || getCreditAccountStatus(item) === creditStatus)
    .filter((item) => dueStatus === 'all'
      || (dueStatus === 'overdue' && Number(item.overdue_amount) > 0)
      || (dueStatus === 'due_today' && dueTodayAmount(item) > 0)
      || (dueStatus === 'not_due' && Number(item.outstanding_amount) - Number(item.overdue_amount) - dueTodayAmount(item) > 0))
    .filter((item) => zone === 'all' || `${item.building_name ?? ''} · ${item.zone_name ?? ''}` === zone)
    .filter((item) => responsible === 'all' || item.responsible_name === responsible)
    .sort((left, right) => sortBy === 'outstanding'
      ? Number(right.outstanding_amount) - Number(left.outstanding_amount)
      : sortBy === 'overdue'
        ? Number(right.overdue_amount) - Number(left.overdue_amount)
        : (left.oldest_due_date ?? '9999-12-31').localeCompare(right.oldest_due_date ?? '9999-12-31'));
  const totalOutstanding = receivables.reduce((sum, item) => sum + Number(item.outstanding_amount), 0);
  const overdueReceivables = receivables.filter((item) => Number(item.overdue_amount) > 0);
  const totalOverdue = receivables.reduce((sum, item) => sum + Number(item.overdue_amount), 0);
  const pendingRequests = approvals.length + dueDateRequests.length;
  const zones = [...new Set(receivables.map((item) => `${item.building_name ?? ''} · ${item.zone_name ?? ''}`).filter((value) => value !== ' · '))].sort();
  const responsibles = [...new Set(receivables.map((item) => item.responsible_name).filter((value): value is string => Boolean(value)))].sort();
  const selected = receivables.find((item) => item.shop_id === selectedId) ?? null;
  const totalAging = receivables.reduce((totals, item) => {
    const amounts = agingAmounts(item);
    return {
      current: totals.current + amounts.current,
      days1To7: totals.days1To7 + amounts.days1To7,
      days8To15: totals.days8To15 + amounts.days8To15,
      days16To30: totals.days16To30 + amounts.days16To30,
      over30: totals.over30 + amounts.over30,
    };
  }, { current: 0, days1To7: 0, days8To15: 0, days16To30: 0, over30: 0 });
  const agingBuckets = [
    { label: 'ยังไม่ถึงกำหนด', amount: totalAging.current, tone: 'current' },
    { label: '1–7 วัน', amount: totalAging.days1To7, tone: 'watch' },
    { label: '8–15 วัน', amount: totalAging.days8To15, tone: 'late' },
    { label: '16–30 วัน', amount: totalAging.days16To30, tone: 'late' },
    { label: 'เกิน 30 วัน', amount: totalAging.over30, tone: 'critical' },
  ] as const;

  return <section className="credit-ar" aria-labelledby="credit-ar-title">
    <header className="credit-ar__header"><div><span className="credit-ar__header-icon"><CreditCard size={24} weight="duotone" /></span><span><p className="eyebrow">Credit &amp; AR Management</p><h1 id="credit-ar-title">ลูกหนี้เครดิต</h1><small>เห็นยอดค้าง กำหนดชำระ และความพร้อมใช้เครดิตของแต่ละร้านในที่เดียว</small></span></div><span className="credit-ar__as-of">ข้อมูล ณ {formatDate(serviceDate, '')}</span></header>
    <nav aria-label="เมนูลูกหนี้เครดิต" className="credit-ar__tabs">
      <button aria-current={activeView === 'overview' ? 'page' : undefined} onClick={() => setActiveView('overview')} type="button"><ChartBar size={18} weight="duotone" />ภาพรวม</button>
      <button aria-current={activeView === 'customers' ? 'page' : undefined} onClick={() => setActiveView('customers')} type="button"><UsersThree size={18} weight="duotone" />รายชื่อลูกหนี้</button>
      <button aria-current={activeView === 'requests' ? 'page' : undefined} onClick={() => setActiveView('requests')} type="button"><FileText size={18} weight="duotone" />คำขออนุมัติ{pendingRequests ? <b>{pendingRequests}</b> : null}</button>
      <button aria-current={activeView === 'aging' ? 'page' : undefined} onClick={() => setActiveView('aging')} type="button"><WarningCircle size={18} weight="duotone" />Aging Report</button>
    </nav>

    {activeView === 'overview' ? <><SummaryCards receivables={receivables} /><div className="credit-ar__overview-grid"><section className="credit-ar__panel"><div className="credit-ar__panel-heading"><span><ChartBar size={19} /><h2>อายุลูกหนี้</h2></span><button onClick={() => setActiveView('aging')} type="button">ดูรายงาน</button></div><div className="credit-ar__aging-bars">{agingBuckets.map((bucket) => <div key={bucket.label}><span>{bucket.label}</span><i className={`credit-ar__bar credit-ar__bar--${bucket.tone}`} style={{ '--aging-width': `${totalOutstanding ? Math.max(bucket.amount / totalOutstanding * 100, bucket.amount ? 5 : 0) : 0}%` } as CSSProperties} /><b>{money.format(bucket.amount)}</b></div>)}</div></section><section className="credit-ar__panel"><div className="credit-ar__panel-heading"><span><WarningCircle size={19} /><h2>ร้านที่ต้องติดตาม</h2></span><button onClick={() => setActiveView('customers')} type="button">ดูทั้งหมด</button></div><div className="credit-ar__follow-ups">{receivables.filter((item) => getCreditAccountStatus(item) !== 'normal').slice(0, 5).map((item) => <button key={item.shop_id} onClick={() => setSelectedId(item.shop_id)} type="button"><span><strong>{item.shop_code} · {item.shop_name}</strong><small>เกินกำหนด {money.format(item.overdue_amount)}</small></span><StatusBadge receivable={item} /></button>)}</div></section></div></> : null}

    {activeView === 'customers' ? <section className="financial-ops__section credit-ar__customers"><div className="financial-ops__title"><div><UsersThree /><span><h2>รายชื่อลูกหนี้เครดิต</h2><p>หนึ่งร้านต่อหนึ่งแถว ยอดทั้งหมดคำนวณจากยอดคงเหลือของบิล</p></span></div></div><SummaryCards receivables={receivables} /><div className="financial-ops__receivable-controls"><label className="credit-ar__search"><MagnifyingGlass size={17} /><input aria-label="ค้นหาร้านลูกหนี้เครดิต" onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหารหัสร้านหรือชื่อร้าน" type="search" value={query} /></label><label>สถานะเครดิต<select aria-label="กรองสถานะเครดิต" onChange={(event) => setCreditStatus(event.target.value as typeof creditStatus)} value={creditStatus}><option value="all">ทั้งหมด</option>{Object.entries(statusMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select></label><label>กำหนดชำระ<select aria-label="กรองสถานะการครบกำหนด" onChange={(event) => setDueStatus(event.target.value as typeof dueStatus)} value={dueStatus}><option value="all">ทั้งหมด</option><option value="not_due">ยังไม่ถึงกำหนด</option><option value="due_today">ถึงกำหนดวันนี้</option><option value="overdue">เกินกำหนด</option></select></label>{zones.length ? <label>อาคาร / โซน<select aria-label="กรองอาคารหรือโซน" onChange={(event) => setZone(event.target.value)} value={zone}><option value="all">ทั้งหมด</option>{zones.map((value) => <option key={value}>{value}</option>)}</select></label> : null}{responsibles.length ? <label>ผู้รับผิดชอบ<select aria-label="กรองผู้รับผิดชอบ" onChange={(event) => setResponsible(event.target.value)} value={responsible}><option value="all">ทั้งหมด</option>{responsibles.map((value) => <option key={value}>{value}</option>)}</select></label> : null}<label>เรียงตาม<select aria-label="เรียงลูกหนี้" onChange={(event) => setSortBy(event.target.value as typeof sortBy)} value={sortBy}><option value="due_date">วันครบกำหนด</option><option value="outstanding">ยอดค้าง</option><option value="overdue">ยอดเกินกำหนด</option></select></label></div>
      <div className="credit-ar__table-wrap"><table className="credit-ar__table"><thead><tr><th>ร้านค้า</th><th>รอบเก็บเงิน</th><th>วงเงิน</th><th>ใช้ไป</th><th>เครดิตคงเหลือ</th><th>ยอดค้าง</th><th>เกินกำหนด</th><th>ครบกำหนดถัดไป</th><th>สถานะ</th><th><span className="sr-only">จัดการ</span></th></tr></thead><tbody>{filtered.map((item) => <tr key={item.shop_id}><td><button className="credit-ar__shop-link" onClick={() => setSelectedId(item.shop_id)} type="button"><strong>{item.shop_code}</strong><span>{item.shop_name}</span><small>{[item.building_name, item.zone_name].filter(Boolean).join(' · ')}</small></button></td><td>{formatCreditCollectionCycle(item)}</td><td>{item.credit_limit === null ? 'ไม่จำกัด' : money.format(item.credit_limit)}</td><td>{money.format(item.outstanding_amount)}</td><td>{item.credit_limit === null ? 'ไม่จำกัด' : money.format(Number(item.credit_limit) - Number(item.outstanding_amount))}</td><td><strong>{money.format(item.outstanding_amount)}</strong></td><td className={Number(item.overdue_amount) > 0 ? 'is-danger' : ''}>{money.format(item.overdue_amount)}</td><td>{formatDate(item.oldest_due_date, serviceDate)}</td><td><StatusBadge receivable={item} /></td><td><button aria-label={`เปิดรายละเอียด ${item.shop_code}`} className="credit-ar__open-detail" onClick={() => setSelectedId(item.shop_id)} type="button"><ArrowSquareOut size={17} /></button></td></tr>)}</tbody></table></div>{filtered.length === 0 ? <p className="financial-ops__empty">ไม่พบร้านที่ตรงกับตัวกรอง</p> : null}</section> : null}

    {activeView === 'requests' ? <div className="credit-ar__request-grid"><section className="financial-ops__section"><div className="financial-ops__title"><div><CreditCard /><span><h2>คำขออนุมัติวงเงิน</h2><p>ตรวจค่าเดิม ค่าใหม่ เหตุผล และผู้ขอก่อนอนุมัติ</p></span></div></div>{approvals.length === 0 ? <p className="financial-ops__empty">ไม่มีคำขอรออนุมัติ</p> : <div className="financial-ops__cards">{approvals.map((approval) => <article key={approval.id}><strong>{approval.shops?.code} · {approval.shops?.name}</strong><span>{approval.kind === 'credit_limit' ? 'ขอเพิ่มวงเงินเครดิต' : 'ขอปรับยอดค้าง'} · {money.format(approval.requested_amount)}</span><p>{approval.reason}</p><small>ผู้ขอ {approval.users?.display_name ?? '—'} · {receiptDateTime.format(new Date(approval.requested_at))}</small><div><button disabled={busy} onClick={() => onDecide(approval.id, 'rejected')} type="button">ไม่อนุมัติ</button><button disabled={busy} onClick={() => onDecide(approval.id, 'approved')} type="button">อนุมัติ</button></div></article>)}</div>}</section><section className="financial-ops__section"><div className="financial-ops__title"><div><CalendarBlank /><span><h2>คำขอขยายวันครบกำหนด</h2><p>เก็บประวัติวันเดิมและวันใหม่ทุกครั้ง</p></span></div></div>{dueDateRequests.length === 0 ? <p className="financial-ops__empty">ไม่มีคำขอเลื่อนกำหนดชำระ</p> : <div className="financial-ops__cards">{dueDateRequests.map((request) => <article key={request.id}><strong>{request.shop_code} · {request.shop_name}</strong><span>{request.charge_number} · {formatDate(request.original_due_date, serviceDate)} → {formatDate(request.requested_due_date, serviceDate)}</span><p>{request.reason}</p><small>ผู้ขอ {request.requested_by} · {receiptDateTime.format(new Date(request.requested_at))}</small><div><button disabled={busy} onClick={() => onDecideDueDateRequest(request.id, 'rejected')} type="button">ไม่อนุมัติ</button><button disabled={busy} onClick={() => onDecideDueDateRequest(request.id, 'approved')} type="button">อนุมัติ</button></div></article>)}</div>}</section></div> : null}

    {activeView === 'aging' ? <section className="financial-ops__section credit-ar__aging-report"><div className="financial-ops__title"><div><ChartBar /><span><h2>รายงานอายุลูกหนี้</h2><p>คำนวณจากยอดคงเหลือหลังหักการรับชำระแล้ว</p></span></div></div><div className="credit-ar__aging-summary credit-ar__aging-summary--five">{agingBuckets.map((bucket) => <article className={`credit-ar__aging-summary-card credit-ar__aging-summary-card--${bucket.tone}`} key={bucket.label}><span>{bucket.label}</span><strong>{money.format(bucket.amount)}</strong><small>{totalOutstanding ? `${(bucket.amount / totalOutstanding * 100).toFixed(0)}% ของยอดค้าง` : 'ไม่มีรายการ'}</small></article>)}</div><div className="credit-ar__report-heading"><span><WarningCircle size={18} /><h2>ยอดค้างชำระเกินกำหนด</h2></span><b>{money.format(totalOverdue)}</b></div>{overdueReceivables.length === 0 ? <p className="financial-ops__empty">ไม่มีรายการค้างชำระเกินกำหนด</p> : <div className="financial-ops__receivable-charges">{overdueReceivables.map((item) => <article key={item.shop_id}><span><strong>{item.shop_code} · {item.shop_name}</strong><small>ครบกำหนดเก่าสุด {formatDate(item.oldest_due_date, serviceDate)} · {overdueChargeCount(item)} บิล</small></span><b>{money.format(item.overdue_amount)}</b><button onClick={() => setSelectedId(item.shop_id)} type="button">เปิดรายละเอียด</button></article>)}</div>}</section> : null}

    {selected ? <ReceivableDrawer busy={busy} canAdminister={userRole === 'admin'} key={selected.shop_id} onClose={() => setSelectedId(null)} onLoadDetail={onLoadDetail} onOpenCollection={onOpenCollection} onRefreshReceivables={onRefreshReceivables} onToggleCreditCollectionAssignment={onToggleCreditCollectionAssignment} onUpdateCreditSettings={onUpdateCreditSettings} receivable={selected} runId={runId} serviceDate={serviceDate} userRole={userRole} /> : null}
  </section>;
}
