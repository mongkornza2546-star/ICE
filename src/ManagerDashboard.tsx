import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Icon } from '@phosphor-icons/react';
import {
  CaretRight,
  CheckCircle,
  ClipboardText,
  CurrencyDollar,
  DotsThreeVertical,
  Factory,
  MapPin,
  Package,
  Storefront,
  Truck,
  User,
  UsersThree,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react';
import { supabase } from './lib/supabase';
import type {
  DailyWorkDashboard,
  StockControlSummary,
} from './types/app';

export interface StockTotal {
  iceTypeId: string;
  name: string;
  unit: string;
  quantity: number;
}

export type ManagerDashboardView =
  | 'factory_order'
  | 'delivery'
  | 'stock_operations'
  | 'stock_audit'
  | 'location_management';

const QUICK_ACTIONS: Array<{
  view: ManagerDashboardView;
  label: string;
  description: string;
  icon: Icon;
  tone: 'blue' | 'teal' | 'sky' | 'purple';
}> = [
  { view: 'factory_order', label: 'สั่งจากโรงงาน', description: 'สั่งซื้อน้ำแข็งจากโรงงาน', icon: Truck, tone: 'blue' },
  { view: 'delivery', label: 'บันทึกส่งน้ำแข็ง', description: 'บันทึกการส่งน้ำแข็งให้ร้านค้า', icon: UsersThree, tone: 'teal' },
  { view: 'stock_operations', label: 'โอนย้ายสต๊อก', description: 'โอนย้ายและจัดการสต๊อก', icon: ClipboardText, tone: 'sky' },
  { view: 'stock_operations', label: 'ตรวจนับสิ้นวัน', description: 'ตรวจนับและสรุปยอดสิ้นวัน', icon: CheckCircle, tone: 'purple' },
];

function todayIsoDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function formatServiceDate(value: string) {
  return new Intl.DateTimeFormat('th-TH', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${value}T12:00:00`));
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency: 'THB',
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatQuantity(value: number) {
  return value.toLocaleString('th-TH', { maximumFractionDigits: 1 });
}

function summarizeStock(stock: StockControlSummary | null): StockTotal[] {
  const totals = new Map<string, StockTotal>();

  for (const location of stock?.locations ?? []) {
    for (const balance of location.balances) {
      const current = totals.get(balance.ice_type_id);
      if (current) {
        current.quantity += balance.quantity;
      } else {
        totals.set(balance.ice_type_id, {
          iceTypeId: balance.ice_type_id,
          name: balance.ice_type_name,
          unit: balance.unit,
          quantity: balance.quantity,
        });
      }
    }
  }

  return [...totals.values()];
}

function summarizeQuantity(items: Array<{ unit: string; quantity: number }>) {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.unit, (totals.get(item.unit) ?? 0) + item.quantity);
  }

  const unitTotals = [...totals.entries()];
  if (unitTotals.length === 0) {
    return { value: '0', unit: undefined, total: 0 };
  }
  if (unitTotals.length === 1) {
    const [unit, quantity] = unitTotals[0];
    return { value: formatQuantity(quantity), unit, total: quantity };
  }
  return {
    value: unitTotals.map(([unit, quantity]) => `${formatQuantity(quantity)} ${unit}`).join(' · '),
    unit: undefined,
    total: null,
  };
}

export function ManagerDashboard({
  isActive,
  profileRole,
  onNavigate,
  demoDashboard,
  demoStockSummary,
}: {
  isActive: boolean;
  profileRole: 'round_lead' | 'admin';
  onNavigate: (view: ManagerDashboardView) => void;
  demoDashboard?: DailyWorkDashboard;
  demoStockSummary?: StockControlSummary;
}) {
  const [dashboard, setDashboard] = useState<DailyWorkDashboard | null>(null);
  const [stockSummary, setStockSummary] = useState<StockControlSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const requestId = useRef(0);
  const [showCancelMenu, setShowCancelMenu] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    if (!isActive) return undefined;
    const currentRequest = ++requestId.current;

    if (demoDashboard && demoStockSummary) {
      setDashboard(demoDashboard);
      setStockSummary(demoStockSummary);
      setError(null);
      setLoading(false);
      return undefined;
    }

    if (!supabase) {
      setDashboard(null);
      setError('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase');
      setLoading(false);
      return;
    }
    const client = supabase;

    async function loadDashboardData() {
      setLoading(true);
      setError(null);

      try {
        const serviceDate = todayIsoDate();
        const [dashRes, stockRes] = await Promise.all([
          client.rpc('get_daily_work_dashboard', { p_service_date: serviceDate }),
          client.rpc('get_stock_control_summary', { p_service_date: serviceDate }),
        ]);

        if (currentRequest !== requestId.current) return;
        if (dashRes.error) throw new Error(dashRes.error.message);
        if (stockRes.error) throw new Error(stockRes.error.message);

        setDashboard(dashRes.data as DailyWorkDashboard);
        setStockSummary(stockRes.data as StockControlSummary);
        setLoading(false);
      } catch (loadError) {
        if (currentRequest !== requestId.current) return;
        setDashboard(null);
        setError(loadError instanceof Error ? loadError.message : 'โหลดข้อมูลงานวันนี้ไม่สำเร็จ');
        setLoading(false);
      }
    }

    void loadDashboardData();
    return () => {
      requestId.current += 1;
    };
  }, [isActive, reloadKey]);

  const handleCancelSession = async () => {
    if (!cancelReason.trim()) {
      setCancelError('กรุณาระบุเหตุผลในการยกเลิกงาน');
      return;
    }
    if (!supabase) return;

    setCancelSubmitting(true);
    setCancelError(null);
    try {
      const serviceDate = dashboard?.session.service_date ?? todayIsoDate();
      const { error: rpcError } = await supabase.rpc('cancel_daily_work_session', {
        p_service_date: serviceDate,
        p_reason: cancelReason.trim(),
      });
      if (rpcError) throw new Error(rpcError.message);

      setShowCancelModal(false);
      setCancelReason('');
      setReloadKey((key) => key + 1);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'ยกเลิกงานไม่สำเร็จ');
    } finally {
      setCancelSubmitting(false);
    }
  };

  const serviceDate = dashboard?.session.service_date ?? todayIsoDate();

  if (loading) {
    return <DashboardState title="ภาพรวมงานวันนี้" detail={formatServiceDate(serviceDate)} message="กำลังโหลดข้อมูลงานวันนี้..." />;
  }

  if (error || !dashboard) {
    return (
      <div className="manager-dashboard">
        <DashboardHeading title="ภาพรวมงานวันนี้" detail={formatServiceDate(serviceDate)} />
        <section className="dashboard-state dashboard-state--error" role="alert">
          <WarningCircle size={28} weight="fill" />
          <div>
            <strong>โหลดข้อมูลไม่สำเร็จ</strong>
            <p>{error ?? 'ไม่พบข้อมูลงานวันนี้'}</p>
          </div>
          <button className="secondary-button" onClick={() => setReloadKey((key) => key + 1)} type="button">ลองโหลดอีกครั้ง</button>
        </section>
      </div>
    );
  }

  const { session, deliverySummary, salesSummary, readiness, cancellationState, problems } = dashboard;
  const locations = (stockSummary?.locations ?? []).filter((location) => location.holds_inventory === true);
  const stockTotals = summarizeStock(stockSummary ? { ...stockSummary, locations } : null);
  const totalStock = summarizeQuantity(stockTotals);
  const hasStartedWork = session.status !== 'not_started';
  const pendingCount = hasStartedWork
    ? readiness.filter((item) => item.status !== 'current').length
    : 0;
  const completedCount = readiness.filter((item) => item.status === 'current').length;
  const statusLabel: Record<string, string> = {
    not_started: 'ยังไม่เริ่มงาน',
    in_progress: 'กำลังทำงาน',
    completed: 'ปิดงานแล้ว',
    cancelled: 'ยกเลิกแล้ว',
  };
  const lowStockTotals = stockTotals.filter((stock) => stock.quantity <= 0).length;
  const alertItems = [
    ...(lowStockTotals > 0 ? [{ tone: 'danger' as const, title: 'สต๊อกไม่เพียงพอ', detail: `พบสินค้า ${lowStockTotals} ชนิดที่สต๊อกหมด`, count: `${lowStockTotals} รายการ`, icon: WarningCircle, view: 'stock_operations' as const }] : []),
    ...(problems.length > 0 ? [{ tone: 'warning' as const, title: 'มีปัญหาหน้างานที่ต้องติดตาม', detail: problems[0].shop_name, count: `${problems.length} รายการ`, icon: User, view: 'delivery' as const }] : []),
    ...(pendingCount > 0 ? [{ tone: 'amber' as const, title: 'มีจุดถือครองที่ต้องตรวจนับ', detail: `ตรวจนับปัจจุบันแล้ว ${completedCount} จาก ${readiness.length || 0} จุด`, count: `${pendingCount} จุด`, icon: ClipboardText, view: 'stock_operations' as const }] : []),
  ];

  return (
    <div className="manager-dashboard manager-dashboard--reference">
      <DashboardHeading
        title="ภาพรวมงานวันนี้"
        detail={formatServiceDate(serviceDate)}
        status={statusLabel[session.status] ?? session.status}
        statusTone={session.status}
      >
        {profileRole === 'admin' && session.status === 'in_progress' ? (
          <div className="dashboard-more-menu">
            <button aria-expanded={showCancelMenu} aria-label="ตัวเลือกเพิ่มเติม" className="dashboard-more-menu__button" onClick={() => setShowCancelMenu((open) => !open)} type="button">
              <DotsThreeVertical size={21} weight="bold" />
            </button>
            {showCancelMenu ? (
              <div className="dashboard-more-menu__panel">
                <button
                  disabled={!cancellationState.can_cancel}
                  onClick={() => { setShowCancelMenu(false); setShowCancelModal(true); }}
                  title={cancellationState.blocker_reason ?? 'ยกเลิกงานวันนี้'}
                  type="button"
                >
                  <XCircle size={17} /> ยกเลิกงานวันนี้
                </button>
                {!cancellationState.can_cancel && cancellationState.blocker_reason ? <p>{cancellationState.blocker_reason}</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </DashboardHeading>

      <section className="dashboard-overview-grid" aria-label="ตัวเลขสรุปวันนี้">
        <OverviewCard icon={Truck} label="สต๊อกคงเหลือ" value={totalStock.value} unit={totalStock.unit} detail={`จาก ${locations.length} จุดถือครอง`} tone="blue" />
        <OverviewCard icon={CurrencyDollar} label="ยอดขายสุทธิ" value={formatCurrency(salesSummary.netSalesValue)} detail="ยอดขายที่บันทึกแล้ววันนี้" tone="green" />
        <OverviewCard icon={Storefront} label="ส่งร้านแล้ว" value={formatQuantity(deliverySummary.actualShopCount)} unit="ร้าน" detail={`${formatQuantity(deliverySummary.activeDeliveryCount)} รายการส่ง`} tone="sky" />
        <OverviewCard
          detail={!hasStartedWork ? 'ยังไม่เริ่มงานวันนี้' : pendingCount ? 'รอตรวจนับใหม่ก่อนปิดวัน' : 'ตรวจนับครบแล้ว'}
          icon={ClipboardText}
          label="เหลือตรวจนับ"
          tone="orange"
          unit="จุด"
          value={formatQuantity(pendingCount)}
        />
      </section>

      <div className="dashboard-mid-grid">
        <section className="dashboard-panel dashboard-flow-panel">
          <PanelHeading title="สรุปเส้นทางการกระจายน้ำแข็งวันนี้" />
          <div className="dashboard-flow" aria-label="เส้นทางกระจายสต๊อก">
            <FlowStep icon={Factory} label="โรงงาน" value={totalStock.value} unit={totalStock.unit} state="พร้อมส่ง" />
            {locations.slice(0, 4).map((location, index) => {
              const quantity = summarizeQuantity(location.balances);
              const hasStock = location.balances.some((balance) => balance.quantity > 0);
              return (
                <FlowStep
                  icon={index === 0 ? Truck : MapPin}
                  key={location.id}
                  label={location.name}
                  value={quantity.value}
                  unit={quantity.unit}
                  state={hasStock ? 'พร้อมใช้งาน' : 'รอตรวจนับ'}
                  muted={!hasStock}
                />
              );
            })}
            {locations.length === 0 ? <p className="dashboard-flow__empty">ยังไม่มีจุดถือครองสำหรับวันนี้</p> : null}
          </div>
        </section>

        <section className="dashboard-panel dashboard-alert-panel">
          <PanelHeading title="การแจ้งเตือนที่ต้องดำเนินการ" />
          <div className="dashboard-alert-list">
            {alertItems.map((alert) => {
              const AlertIcon = alert.icon;
              return <button className={`dashboard-alert dashboard-alert--${alert.tone}`} key={alert.title} onClick={() => onNavigate(alert.view)} type="button"><AlertIcon size={24} weight="fill" /><span><strong>{alert.title}</strong><small>{alert.detail}</small></span><b>{alert.count}</b><CaretRight size={18} /></button>;
            })}
            {alertItems.length === 0 ? <div className="dashboard-alert dashboard-alert--success"><CheckCircle size={24} weight="fill" /><span><strong>ไม่มีรายการที่ต้องดำเนินการ</strong><small>งานวันนี้พร้อมดำเนินการต่อ</small></span></div> : null}
          </div>
        </section>
      </div>

      <section className="dashboard-panel dashboard-quick-panel">
        <PanelHeading title="เมนูด่วน" />
        <div className="dashboard-quick-grid">
          {QUICK_ACTIONS.map((action) => {
            const ActionIcon = action.icon;
            return <button className={`dashboard-quick-action dashboard-quick-action--${action.tone}`} key={action.label} onClick={() => onNavigate(action.view)} type="button"><ActionIcon size={29} weight="fill" /><span><strong>{action.label}</strong><small>{action.description}</small></span></button>;
          })}
        </div>
      </section>

      {showCancelModal ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cancel-modal-title">
          <div className="modal-content dashboard-cancel-modal">
            <h2 id="cancel-modal-title">ยกเลิกงานวันนี้</h2>
            <p>ยกเลิกได้หลังยกเลิกคำสั่งจากโรงงานที่ยังใช้งานอยู่แล้วเท่านั้น</p>
            {cancelError ? <p className="error-text">{cancelError}</p> : null}
            <label htmlFor="cancel-reason-input">เหตุผลในการยกเลิก <span>*</span>
              <textarea id="cancel-reason-input" onChange={(event) => setCancelReason(event.target.value)} placeholder="ระบุเหตุผลในการยกเลิกงาน..." rows={3} value={cancelReason} />
            </label>
            <div className="modal-actions">
              <button className="secondary-button" disabled={cancelSubmitting} onClick={() => { setShowCancelModal(false); setCancelReason(''); setCancelError(null); }} type="button">กลับ</button>
              <button className="primary-button destructive-button" disabled={cancelSubmitting || !cancelReason.trim()} onClick={handleCancelSession} type="button">{cancelSubmitting ? 'กำลังบันทึก...' : 'ยืนยันยกเลิกงาน'}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DashboardState({ title, detail, message }: { title: string; detail: string; message: string }) {
  return <div className="manager-dashboard"><DashboardHeading detail={detail} title={title} /><section className="dashboard-state" aria-busy="true"><Package size={28} weight="fill" /><p>{message}</p></section></div>;
}

function DashboardHeading({ title, detail, status, statusTone, children }: { title: string; detail: string; status?: string; statusTone?: string; children?: ReactNode }) {
  return <header className="dashboard-heading"><div><h1>{title}</h1><p>{detail}</p></div><div className="dashboard-heading__actions">{status ? <span className={`dashboard-session-status dashboard-session-status--${statusTone}`}><i />{status}</span> : null}{children}</div></header>;
}

function OverviewCard({ icon: IconComponent, label, value, unit, detail, tone }: { icon: Icon; label: string; value: string; unit?: string; detail: string; tone: 'blue' | 'green' | 'sky' | 'orange' }) {
  return <article className={`dashboard-overview-card dashboard-overview-card--${tone}`}><span className="dashboard-overview-card__icon"><IconComponent size={28} weight="fill" /></span><div><small>{label}</small><strong>{value}</strong>{unit ? <em>{unit}</em> : null}<p>{detail}</p><span className="dashboard-mini-bars" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /></span></div></article>;
}

function PanelHeading({ title, detail }: { title: string; detail?: string }) {
  return <div className="dashboard-panel__heading"><div><h2>{title}</h2>{detail ? <p>{detail}</p> : null}</div></div>;
}

function FlowStep({ icon: IconComponent, label, value, unit, state, muted = false }: { icon: Icon; label: string; value: string; unit?: string; state: string; muted?: boolean }) {
  return <article className={`dashboard-flow__step ${muted ? 'dashboard-flow__step--muted' : ''}`}><span className="dashboard-flow__node"><IconComponent size={27} weight="fill" /></span><strong>{label}</strong><b>{value}</b>{unit ? <small>{unit}</small> : null}<em><i />{state}</em></article>;
}
