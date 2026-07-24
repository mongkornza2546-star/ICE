import { useEffect, useRef, useState } from 'react';
import type { Icon } from '@phosphor-icons/react';
import {
  ArrowsLeftRight,
  Clock,
  CurrencyDollar,
  DotsThreeVertical,
  Factory,
  Gear,
  Package,
  Snowflake,
  Storefront,
  Truck,
  User,
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
  | 'location_management';

const QUICK_ACTIONS: Array<{
  view: ManagerDashboardView;
  label: string;
  icon: Icon;
}> = [
  { view: 'factory_order', label: 'สั่งจากโรงงาน', icon: Factory },
  { view: 'delivery', label: 'บันทึกส่งน้ำแข็ง', icon: Truck },
  { view: 'stock_operations', label: 'โอน / ตรวจ / ปิดสต๊อก', icon: ArrowsLeftRight },
  { view: 'location_management', label: 'สถานที่และจุดถือครอง', icon: Gear },
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

function formatTime(value?: string | null) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency: 'THB',
    maximumFractionDigits: 2,
  }).format(amount);
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

export function ManagerDashboard({
  isActive,
  profileRole,
  onNavigate,
}: {
  isActive: boolean;
  profileRole: 'round_lead' | 'admin';
  onNavigate: (view: ManagerDashboardView) => void;
}) {
  const [dashboard, setDashboard] = useState<DailyWorkDashboard | null>(null);
  const [stockSummary, setStockSummary] = useState<StockControlSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const requestId = useRef(0);

  // Cancellation modal state
  const [showCancelMenu, setShowCancelMenu] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    if (!isActive) return undefined;
    const currentRequest = ++requestId.current;

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

  const roleLabel = profileRole === 'admin' ? 'แอดมิน' : 'หัวหน้างาน';
  const serviceDate = dashboard?.session.service_date ?? todayIsoDate();

  if (loading) {
    return (
      <div className="manager-dashboard" aria-busy="true">
        <section className="manager-dashboard__intro">
          <h1>งานวันนี้</h1>
          <p>{roleLabel} · {formatServiceDate(serviceDate)}</p>
        </section>
        <section className="manager-dashboard__panel">
          <p className="empty-text" role="status">กำลังโหลดข้อมูลงานวันนี้...</p>
        </section>
      </div>
    );
  }

  if (error || !dashboard) {
    return (
      <div className="manager-dashboard">
        <section className="manager-dashboard__intro">
          <h1>งานวันนี้</h1>
          <p>{roleLabel} · {formatServiceDate(serviceDate)}</p>
        </section>
        <section className="manager-dashboard__panel error-panel" role="alert">
          <h2>โหลดข้อมูลไม่สำเร็จ</h2>
          <p className="error-text">{error ?? 'ไม่พบข้อมูลงานวันนี้'}</p>
          <div className="page-actions__buttons">
            <button className="secondary-button" onClick={() => setReloadKey((key) => key + 1)} type="button">
              ลองโหลดอีกครั้ง
            </button>
          </div>
        </section>
      </div>
    );
  }

  const { session, members, deliverySummary, salesSummary, readiness, cancellationState } = dashboard;
  const stockTotals = summarizeStock(stockSummary);
  const uncountedCount = readiness.filter((r) => r.status === 'uncounted').length;

  const sessionStatusConfig: Record<
    string,
    { label: string; tone: 'neutral' | 'warning' | 'success' | 'danger' }
  > = {
    not_started: { label: 'ยังไม่เริ่มงาน', tone: 'neutral' },
    in_progress: { label: 'กำลังทำงาน', tone: 'warning' },
    completed: { label: 'ปิดงานแล้ว', tone: 'success' },
    cancelled: { label: 'ยกเลิกแล้ว', tone: 'danger' },
  };

  const statusConfig = sessionStatusConfig[session.status] ?? {
    label: session.status,
    tone: 'neutral',
  };

  return (
    <div className="manager-dashboard">
      <section className="manager-dashboard__intro">
        <h1>งานวันนี้</h1>
        <p>{roleLabel} · {formatServiceDate(serviceDate)}</p>
      </section>

      {/* Daily Session Status Card */}
      <section className="manager-dashboard__panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">สถานะงานประจำวัน</p>
            <h2>วงจรงานวันนี้ ({formatServiceDate(serviceDate)})</h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className={`status-badge status-badge--${statusConfig.tone}`}>
              {statusConfig.label}
            </span>
            {profileRole === 'admin' && session.status === 'in_progress' && (
              <div style={{ position: 'relative' }}>
                <button
                  aria-label="ตัวเลือกเพิ่มเติม"
                  className="icon-button"
                  onClick={() => setShowCancelMenu((open) => !open)}
                  type="button"
                >
                  <DotsThreeVertical size={20} weight="bold" />
                </button>
                {showCancelMenu && (
                  <div
                    style={{
                      position: 'absolute',
                      right: 0,
                      top: '100%',
                      marginTop: '4px',
                      background: 'var(--surface-color, #ffffff)',
                      border: '1px solid var(--border-color, #e0e0e0)',
                      borderRadius: '8px',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                      zIndex: 20,
                      minWidth: '180px',
                      padding: '4px',
                    }}
                  >
                    <button
                      disabled={!cancellationState.can_cancel}
                      onClick={() => {
                        setShowCancelMenu(false);
                        setShowCancelModal(true);
                      }}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 12px',
                        border: 'none',
                        background: 'none',
                        color: cancellationState.can_cancel ? 'var(--danger-color, #d32f2f)' : '#9e9e9e',
                        cursor: cancellationState.can_cancel ? 'pointer' : 'not-allowed',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '14px',
                        borderRadius: '4px',
                      }}
                      title={cancellationState.blocker_reason ?? 'ยกเลิกงานวันนี้'}
                      type="button"
                    >
                      <XCircle size={18} />
                      <span>ยกเลิกงานวันนี้</span>
                    </button>
                    {!cancellationState.can_cancel && cancellationState.blocker_reason && (
                      <p style={{ margin: 0, padding: '4px 12px', fontSize: '11px', color: '#757575' }}>
                        {cancellationState.blocker_reason}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {session.status === 'not_started' && (
          <div className="info-note" style={{ background: '#f5f5f5', borderLeft: '4px solid #1976d2', padding: '12px 16px', borderRadius: '4px', marginBottom: '16px' }}>
            <p style={{ margin: 0, fontSize: '14px', color: '#333' }}>
              ℹ️ งานจะเริ่มอัตโนมัติเมื่อบันทึกคำสั่งจากโรงงานครั้งแรก
            </p>
          </div>
        )}

        {session.status === 'in_progress' && (
          <div className="info-note" style={{ background: '#fff8e1', borderLeft: '4px solid #ffa000', padding: '12px 16px', borderRadius: '4px', marginBottom: '16px' }}>
            <p style={{ margin: 0, fontSize: '14px', color: '#333' }}>
              ⚡ งานกำลังดำเนินอยู่ · เริ่มเมื่อเวลา {formatTime(session.opened_at)} {session.opened_by_name ? `โดย ${session.opened_by_name}` : ''}
            </p>
          </div>
        )}

        {session.status === 'completed' && (
          <div className="info-note" style={{ background: '#e8f5e9', borderLeft: '4px solid #388e3c', padding: '12px 16px', borderRadius: '4px', marginBottom: '16px' }}>
            <p style={{ margin: 0, fontSize: '14px', color: '#333' }}>
              ✅ ปิดงานและปิดสต๊อกสิ้นวันแล้วเมื่อเวลา {formatTime(session.closed_at)} {session.closed_by_name ? `โดย ${session.closed_by_name}` : ''}
            </p>
          </div>
        )}

        {session.status === 'cancelled' && (
          <div className="info-note" style={{ background: '#ffebee', borderLeft: '4px solid #d32f2f', padding: '12px 16px', borderRadius: '4px', marginBottom: '16px' }}>
            <p style={{ margin: 0, fontSize: '14px', color: '#333' }}>
              ❌ งานวันนี้ถูกยกเลิกแล้วเมื่อเวลา {formatTime(session.cancelled_at)} {session.cancelled_by_name ? `โดย ${session.cancelled_by_name}` : ''}
              {session.cancel_reason ? ` (สาเหตุ: ${session.cancel_reason})` : ''}
            </p>
          </div>
        )}

        {/* Operational Metrics */}
        <div className="metric-grid">
          <Metric icon={Truck} label="รายการส่งวันนี้" value={deliverySummary.activeDeliveryCount} />
          <Metric icon={Storefront} label="ร้านค้าที่มีการส่งจริง" value={deliverySummary.actualShopCount} tone="success" />
          <Metric icon={WarningCircle} label="ปัญหาที่ถูกบันทึกจริง" value={deliverySummary.problemCount} tone={deliverySummary.problemCount > 0 ? 'danger' : undefined} />
          <Metric icon={CurrencyDollar} label="มูลค่ายอดขายสุทธิ" value={salesSummary.netSalesValue} isCurrency />
        </div>
      </section>

      {/* Sales breakdown by ice type */}
      {salesSummary.iceTypeSales.length > 0 && (
        <section className="manager-dashboard__panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">สรุปยอดส่งจริงแยกตามสินค้า</p>
              <h2>จำนวนขายแยกชนิดน้ำแข็ง (สุทธิ)</h2>
            </div>
          </div>
          <div className="metric-grid">
            {salesSummary.iceTypeSales.map((item) => (
              <Metric
                icon={Snowflake}
                key={item.ice_type_id}
                label={item.ice_type_name}
                unit={item.unit}
                value={item.quantity}
              />
            ))}
          </div>
        </section>
      )}

      {/* Session Members Section */}
      <section className="manager-dashboard__panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">พนักงานปฏิบัติงานวันนี้</p>
            <h2>สมาชิกและกิจกรรมล่าสุด</h2>
          </div>
          <span className="status-badge status-badge--neutral">
            {members.length.toLocaleString('th-TH')} คน
          </span>
        </div>

        {members.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '12px' }}>
            {members.map((member) => (
              <article key={member.id} style={{ border: '1px solid var(--border-color, #e0e0e0)', borderRadius: '8px', padding: '12px 16px', background: '#fafafa' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <User size={20} weight="bold" />
                    <strong>{member.display_name}</strong>
                  </div>
                  <span className="status-badge status-badge--neutral" style={{ fontSize: '11px' }}>
                    {member.role_label}
                  </span>
                </div>
                {member.last_activity ? (
                  <p style={{ margin: 0, fontSize: '12px', color: '#555' }}>
                    <Clock size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                    {member.last_activity.description} ({formatTime(member.last_activity.timestamp)})
                  </p>
                ) : (
                  <p style={{ margin: 0, fontSize: '12px', color: '#9e9e9e' }}>
                    ยังไม่มีกิจกรรมในระบบวันนี้
                  </p>
                )}
              </article>
            ))}
          </div>
        ) : (
          <p className="empty-text">ยังไม่มีสมาชิกปฏิบัติงานวันนี้</p>
        )}
      </section>

      {/* Stock Balance Current State */}
      <section className="manager-dashboard__panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">ยอดสต๊อกคงเหลือ</p>
            <h2>สต๊อกคงเหลือปัจจุบันทุกจุด</h2>
          </div>
          <span className="status-badge status-badge--neutral">
            {stockSummary?.locations.length.toLocaleString('th-TH') ?? 0} จุด
          </span>
        </div>

        {stockTotals.length > 0 ? (
          <div className="metric-grid">
            {stockTotals.map((total) => (
              <Metric
                icon={Snowflake}
                key={total.iceTypeId}
                label={`รวม ${total.name}`}
                unit={total.unit}
                value={total.quantity}
                tone={total.quantity < 0 ? 'danger' : undefined}
              />
            ))}
          </div>
        ) : (
          <p className="empty-text">ยังไม่มีจุดถือครองที่ใช้งาน</p>
        )}
      </section>

      {/* Lower section: EOD readiness & quick actions */}
      <div className="manager-dashboard__lower">
        <section className="manager-dashboard__panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">ความพร้อมก่อนปิดวัน</p>
              <h2>ตรวจนับและปิดสต๊อกสิ้นวัน</h2>
            </div>
            <span className={`status-badge status-badge--${session.status === 'completed' ? 'success' : uncountedCount > 0 ? 'warning' : 'info'}`}>
              {session.status === 'completed'
                ? 'ปิดงานแล้ว'
                : uncountedCount > 0
                ? `ยังไมี่ได้นับ ${uncountedCount} จุด`
                : 'พร้อมปิดวัน'}
            </span>
          </div>

          <p className="info-note" style={{ marginBottom: '16px' }}>
            {session.status === 'completed'
              ? `ปิดสต๊อกและจบงานวันนี้เรียบร้อยแล้วเมื่อเวลา ${formatTime(session.closed_at)}`
              : 'การตรวจนับและจบงานทำได้ในหน้าโอน / ตรวจ / ปิดสต๊อก'}
          </p>

          <button className="primary-button" onClick={() => onNavigate('stock_operations')} type="button">
            <Package size={18} weight="bold" /> ไป โอน / ตรวจ / ปิดสต๊อก
          </button>
        </section>

        <aside className="manager-dashboard__aside">
          <section className="manager-aside-card">
            <p className="eyebrow">สำหรับ{roleLabel}</p>
            <h2>ทางลัดงานปฏิบัติการ</h2>
            <div className="stack">
              {QUICK_ACTIONS.map((action) => {
                const ActionIcon = action.icon;
                return (
                  <button className="secondary-button" key={action.view} onClick={() => onNavigate(action.view)} type="button">
                    <ActionIcon size={18} weight="bold" /> {action.label}
                  </button>
                );
              })}
            </div>
          </section>
        </aside>
      </div>

      {/* Cancellation Modal */}
      {showCancelModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cancel-modal-title">
          <div className="modal-content" style={{ maxWidth: '450px', padding: '24px' }}>
            <h2 id="cancel-modal-title" style={{ marginTop: 0, color: 'var(--danger-color, #d32f2f)' }}>
              ยกเลิกงานวันนี้
            </h2>
            <p style={{ fontSize: '14px', color: '#555' }}>
              ยกเลิกได้หลังยกเลิกคำสั่งจากโรงงานที่ยัง active แล้วเท่านั้น
            </p>
            {cancelError && <p className="error-text" style={{ marginBottom: '12px' }}>{cancelError}</p>}
            <div style={{ marginBottom: '16px' }}>
              <label htmlFor="cancel-reason-input" style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>
                เหตุผลในการยกเลิก <span style={{ color: 'red' }}>*</span>
              </label>
              <textarea
                id="cancel-reason-input"
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="ระบุเหตุผลในการยกเลิกงาน..."
                rows={3}
                style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
                value={cancelReason}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                className="secondary-button"
                disabled={cancelSubmitting}
                onClick={() => {
                  setShowCancelModal(false);
                  setCancelReason('');
                  setCancelError(null);
                }}
                type="button"
              >
                ยกเลิก
              </button>
              <button
                className="primary-button"
                disabled={cancelSubmitting || !cancelReason.trim()}
                onClick={handleCancelSession}
                style={{ background: 'var(--danger-color, #d32f2f)' }}
                type="button"
              >
                {cancelSubmitting ? 'กำลังบันทึก...' : 'ยืนยันยกเลิกงาน'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({
  icon: IconComponent,
  label,
  value,
  unit,
  tone,
  isCurrency = false,
}: {
  icon: Icon;
  label: string;
  value: number;
  unit?: string;
  tone?: 'success' | 'warning' | 'danger';
  isCurrency?: boolean;
}) {
  return (
    <article className={`metric-card ${tone ? `metric-card--${tone}` : ''}`}>
      <span className="metric-icon"><IconComponent aria-hidden="true" weight="fill" /></span>
      <div>
        <small>{label}</small>
        <strong>{isCurrency ? formatCurrency(value) : value.toLocaleString('th-TH')}</strong>
        {unit && !isCurrency ? <span>{unit}</span> : null}
      </div>
    </article>
  );
}
