import { useEffect, useRef, useState } from 'react';
import type { Icon } from '@phosphor-icons/react';
import {
  ArrowsLeftRight,
  CheckCircle,
  ClipboardText,
  Clock,
  Factory,
  Gear,
  Package,
  Snowflake,
  Storefront,
  Truck,
  WarningCircle,
} from '@phosphor-icons/react';
import { supabase } from './lib/supabase';
import type {
  DailyStockCloseState,
  DeliveryRound,
  RoundControlSummary,
  StockControlSummary,
  StockLocationBalance,
} from './types/app';

export type ManagerDashboardView =
  | 'factory_order'
  | 'manager'
  | 'delivery'
  | 'stock_operations'
  | 'stock_locations';

interface RoundOverview {
  round: DeliveryRound;
  summary: RoundControlSummary;
}

interface DashboardData {
  rounds: RoundOverview[];
  stock: StockControlSummary | null;
  closeState: DailyStockCloseState | null;
}

interface StockTotal {
  iceTypeId: string;
  name: string;
  unit: string;
  quantity: number;
}

const LOCATION_LABELS: Record<StockLocationBalance['kind'], string> = {
  truck: 'รถบรรทุก',
  team: 'ทีมส่ง',
  small_vehicle: 'รถเล็ก',
  work_site: 'จุดปฏิบัติงาน',
  reserve_bin: 'ถังสำรอง',
  front_vehicle: 'จุดหน้ารถ',
};

const QUICK_ACTIONS: Array<{
  view: ManagerDashboardView;
  label: string;
  icon: Icon;
}> = [
  { view: 'manager', label: 'ควบคุมรอบส่ง', icon: ClipboardText },
  { view: 'factory_order', label: 'สั่งจากโรงงาน', icon: Factory },
  { view: 'delivery', label: 'บันทึกส่งน้ำแข็ง', icon: Truck },
  { view: 'stock_operations', label: 'โอน / ตรวจ / ปิดสต๊อก', icon: ArrowsLeftRight },
  { view: 'stock_locations', label: 'ตั้งค่าจุดถือครอง', icon: Gear },
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

function formatTime(value: string) {
  return new Intl.DateTimeFormat('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
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
  profileRole,
  onNavigate,
}: {
  profileRole: 'round_lead' | 'admin';
  onNavigate: (view: ManagerDashboardView) => void;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    const currentRequest = ++requestId.current;

    if (!supabase) {
      setData(null);
      setError('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase');
      setLoading(false);
      return;
    }
    const client = supabase;

    async function loadDashboard() {
      setLoading(true);
      setError(null);

      try {
        const serviceDate = todayIsoDate();
        const roundsResponse = await client
          .from('delivery_rounds')
          .select('id, service_date, name, status, opened_at')
          .eq('service_date', serviceDate)
          .order('opened_at', { ascending: false });

        if (currentRequest !== requestId.current) return;
        if (roundsResponse.error) throw new Error(roundsResponse.error.message);

        const rounds = (roundsResponse.data ?? []) as DeliveryRound[];
        const [roundResponses, stockResponse, closeResponse] = await Promise.all([
          Promise.all(rounds.map((round) => client.rpc('get_round_control_summary', {
            p_round_id: round.id,
          }))),
          client.rpc('get_stock_control_summary', { p_service_date: serviceDate }),
          client.rpc('get_daily_stock_close_state', { p_service_date: serviceDate }),
        ]);

        if (currentRequest !== requestId.current) return;

        const firstError = roundResponses.find((response) => response.error)?.error
          ?? stockResponse.error
          ?? closeResponse.error;
        if (firstError) throw new Error(firstError.message);

        setData({
          rounds: rounds.map((round, index) => ({
            round,
            summary: roundResponses[index].data as RoundControlSummary,
          })),
          stock: stockResponse.data as StockControlSummary,
          closeState: closeResponse.data as DailyStockCloseState,
        });
        setLoading(false);
      } catch (loadError) {
        if (currentRequest !== requestId.current) return;
        setData(null);
        setError(loadError instanceof Error ? loadError.message : 'โหลดภาพรวมงานวันนี้ไม่สำเร็จ');
        setLoading(false);
      }
    }

    void loadDashboard();
    return () => {
      requestId.current += 1;
    };
  }, [reloadKey]);

  const roleLabel = profileRole === 'admin' ? 'แอดมิน' : 'หัวหน้ารอบ';
  const serviceDate = data?.stock?.service_date ?? todayIsoDate();

  if (loading) {
    return (
      <div className="manager-dashboard" aria-busy="true">
        <section className="manager-dashboard__intro">
          <h1>ภาพรวมงานวันนี้</h1>
          <p>{roleLabel} · {formatServiceDate(serviceDate)}</p>
        </section>
        <section className="manager-dashboard__panel">
          <p className="empty-text" role="status">กำลังรวมข้อมูลรอบส่งและสต๊อกวันนี้...</p>
        </section>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="manager-dashboard">
        <section className="manager-dashboard__intro">
          <h1>ภาพรวมงานวันนี้</h1>
          <p>{roleLabel} · {formatServiceDate(serviceDate)}</p>
        </section>
        <section className="manager-dashboard__panel error-panel" role="alert">
          <h2>โหลดภาพรวมไม่สำเร็จ</h2>
          <p className="error-text">{error ?? 'ไม่พบข้อมูลภาพรวม'}</p>
          <div className="page-actions__buttons">
            <button className="secondary-button" onClick={() => setReloadKey((key) => key + 1)} type="button">
              ลองโหลดอีกครั้ง
            </button>
          </div>
        </section>
      </div>
    );
  }

  const openRoundCount = data.rounds.filter(({ round }) => round.status === 'open').length;
  const closedRoundCount = data.rounds.length - openRoundCount;
  const stopTotals = data.rounds.reduce(
    (totals, { summary }) => ({
      total: totals.total + summary.stop_counts.total,
      delivered: totals.delivered + summary.stop_counts.delivered,
      pending: totals.pending + summary.stop_counts.pending,
      problem: totals.problem + summary.stop_counts.problem,
    }),
    { total: 0, delivered: 0, pending: 0, problem: 0 },
  );
  const stockTotals = summarizeStock(data.stock);
  const closeState = data.closeState;

  return (
    <div className="manager-dashboard">
      <section className="manager-dashboard__intro">
        <h1>ภาพรวมงานวันนี้</h1>
        <p>{roleLabel} · {formatServiceDate(serviceDate)} · ข้อมูลจากรอบส่งและ stock ledger</p>
      </section>

      <section className="manager-dashboard__panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">สถานะการส่งวันนี้</p>
            <h2>รอบส่งและร้านค้า</h2>
          </div>
          <span className="status-badge status-badge--info">{data.rounds.length.toLocaleString('th-TH')} รอบ</span>
        </div>

        <div className="metric-grid">
          <Metric icon={Clock} label="รอบเปิดอยู่" value={openRoundCount} tone="warning" />
          <Metric icon={CheckCircle} label="รอบปิดแล้ว" value={closedRoundCount} tone="success" />
          <Metric icon={Storefront} label="บัตรร้านรวมทุกรอบ" value={stopTotals.total} />
          <Metric icon={CheckCircle} label="ส่งแล้ว" value={stopTotals.delivered} tone="success" />
          <Metric icon={Clock} label="ยังไม่ส่ง" value={stopTotals.pending} tone="warning" />
          <Metric icon={WarningCircle} label="มีปัญหา" value={stopTotals.problem} tone="danger" />
        </div>

        <div className="round-overview-grid">
          {data.rounds.map(({ round, summary }) => {
            const progress = summary.stop_counts.total > 0
              ? Math.round((summary.stop_counts.delivered / summary.stop_counts.total) * 100)
              : 0;
            return (
              <button className="round-overview-card" key={round.id} onClick={() => onNavigate('manager')} type="button">
                <span className="round-overview-card__top">
                  <strong>{round.name}</strong>
                  <span className={`status-badge status-badge--${round.status === 'open' ? 'warning' : 'success'}`}>
                    {round.status === 'open' ? 'เปิดอยู่' : 'ปิดแล้ว'}
                  </span>
                </span>
                <small>เปิดเวลา {formatTime(round.opened_at)}</small>
                <p><strong>{summary.stop_counts.delivered}</strong> <span>/ {summary.stop_counts.total} ร้าน</span></p>
                <span className="progress-track" aria-label={`ส่งสำเร็จ ${progress}%`}><i style={{ width: `${progress}%` }} /></span>
                <b>ค้าง {summary.stop_counts.pending} · ปัญหา {summary.stop_counts.problem}</b>
              </button>
            );
          })}
        </div>
        {data.rounds.length === 0 ? (
          <div className="empty-text">
            <p>ยังไม่มีรอบส่งวันนี้ แต่ยอดสั่งโรงงานและสต๊อกประจำวันแสดงต่อด้านล่างได้ตามปกติ</p>
            <button className="secondary-button" onClick={() => onNavigate('manager')} type="button">
              <ClipboardText size={18} weight="bold" /> ไปเปิดรอบส่ง
            </button>
          </div>
        ) : null}
      </section>

      <section className="manager-dashboard__panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">ยอดจริงทุกจุดถือครอง</p>
            <h2>สต๊อกคงเหลือปัจจุบัน</h2>
          </div>
          <span className="status-badge status-badge--neutral">
            {data.stock?.locations.length.toLocaleString('th-TH') ?? 0} จุด
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
        ) : null}

        {data.stock && data.stock.locations.length > 0 ? (
          <div className="stock-location-grid">
            {data.stock.locations.map((location) => {
              const hasNegative = location.balances.some((balance) => balance.quantity < 0);
              return (
                <article className={`stock-location-card ${hasNegative ? 'stock-location-card--warning' : ''}`} key={location.id}>
                  <div>
                    <small>{LOCATION_LABELS[location.kind]} · {location.code}</small>
                    <h3>{location.name}</h3>
                  </div>
                  <div className="stock-balance-list">
                    {location.balances.map((balance) => (
                      <div className={`stock-balance ${balance.quantity < 0 ? 'stock-balance--negative' : ''}`} key={balance.ice_type_id}>
                        <span>{balance.ice_type_name}</span>
                        <strong>{balance.quantity.toLocaleString('th-TH')} <small>{balance.unit}</small></strong>
                      </div>
                    ))}
                  </div>
                  {hasNegative ? <p className="error-text">มียอดติดลบ กรุณาตรวจรายการสต๊อก</p> : null}
                </article>
              );
            })}
          </div>
        ) : <p className="empty-text">ยังไม่มีจุดถือครองที่ใช้งาน</p>}
      </section>

      <div className="manager-dashboard__lower">
        <section className="manager-dashboard__panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">ตรวจนับและปิดสต๊อก</p>
              <h2>สถานะปิดวัน</h2>
            </div>
            <CloseStateBadge closeState={closeState} />
          </div>
          <DailyCloseMessage closeState={closeState} />
          <button className="primary-button" onClick={() => onNavigate('stock_operations')} type="button">
            <Package size={18} weight="bold" /> ไปตรวจสต๊อก
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
    </div>
  );
}

function Metric({
  icon: IconComponent,
  label,
  value,
  unit,
  tone,
}: {
  icon: Icon;
  label: string;
  value: number;
  unit?: string;
  tone?: 'success' | 'warning' | 'danger';
}) {
  return (
    <article className={`metric-card ${tone ? `metric-card--${tone}` : ''}`}>
      <span className="metric-icon"><IconComponent aria-hidden="true" weight="fill" /></span>
      <div>
        <small>{label}</small>
        <strong>{value.toLocaleString('th-TH')}</strong>
        {unit ? <span>{unit}</span> : null}
      </div>
    </article>
  );
}

function CloseStateBadge({ closeState }: { closeState: DailyStockCloseState | null }) {
  if (!closeState) return <span className="status-badge status-badge--neutral">ไม่มีข้อมูล</span>;
  if (closeState.is_closed) return <span className="status-badge status-badge--success">ปิดวันแล้ว</span>;
  if (closeState.open_round_count > 0) {
    return <span className="status-badge status-badge--warning">เหลือ {closeState.open_round_count} รอบเปิด</span>;
  }
  return <span className="status-badge status-badge--info">พร้อมปิดวัน</span>;
}

function DailyCloseMessage({ closeState }: { closeState: DailyStockCloseState | null }) {
  if (!closeState) return <p className="empty-text">ไม่พบสถานะปิดสต๊อกของวันนี้</p>;
  if (closeState.is_closed) {
    return (
      <p className="info-note">
        ปิดสต๊อกแล้วเวลา {closeState.closed_at ? formatTime(closeState.closed_at) : '-'}
        {' '}· ตรวจนับ {closeState.counts.length} รายการ
      </p>
    );
  }
  if (closeState.open_round_count > 0) {
    return <p className="info-note">ต้องปิดรอบส่งที่เหลืออีก {closeState.open_round_count} รอบ ก่อนตรวจนับและปิดสต๊อกประจำวัน</p>;
  }
  return <p className="info-note">รอบส่งปิดครบแล้ว พร้อมตรวจนับยอดจริงและปิดสต๊อกประจำวัน</p>;
}
