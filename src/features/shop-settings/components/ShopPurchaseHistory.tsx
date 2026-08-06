import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowClockwise,
  CalendarBlank,
  CheckCircle,
  ClockCounterClockwise,
  Package,
  Receipt,
  WarningCircle,
} from '@phosphor-icons/react';
import { supabase } from '../../../lib/supabase';
import { env } from '../../../lib/env';
import { getErrorMessage } from '../../../lib/errorMessage';
import { formatServiceDate, money, paymentMethodLabel } from '../../financial-operations/utils';
import type { FinancialPaymentStatus, PaymentMethod, PaymentTerm } from '../../../types/app';

type PurchaseHistoryItem = {
  ice_type_id: string;
  name: string;
  unit: string;
  quantity: number;
  unit_price: number | null;
  line_total: number | null;
};

type PurchaseHistoryPayment = {
  payment_id: string;
  payment_method: PaymentMethod;
  amount: number;
  recorded_at: string;
};

export type PurchaseHistoryEntry = {
  delivery_event_id: string;
  charge_id: string | null;
  charge_number: string | null;
  service_date: string;
  recorded_at: string;
  recorded_by_name: string;
  total_amount: number | null;
  payment_term: PaymentTerm | null;
  allocated_amount: number;
  outstanding_amount: number;
  payment_status: FinancialPaymentStatus | null;
  delivery_status?: 'active' | 'replaced' | 'cancelled';
  charge_status?: 'active' | 'voided' | null;
  base_amount?: number | null;
  round_status?: 'open' | 'closed';
  day_closed?: boolean;
  adjustments?: Array<{ id: string; amount_delta: number; reason: string }>;
  items: PurchaseHistoryItem[];
  payments: PurchaseHistoryPayment[];
};

type HistoryPeriod = 'all' | '30' | '90';
type HistoryPaymentFilter = 'all' | 'paid' | 'outstanding';

const DEMO_HISTORY: PurchaseHistoryEntry[] = [
  {
    delivery_event_id: 'demo-delivery-1',
    charge_id: 'demo-charge-1',
    charge_number: 'C690803-000021',
    service_date: '2026-08-03',
    recorded_at: '2026-08-03T09:18:00+07:00',
    recorded_by_name: 'พนักงานส่งน้ำแข็ง 01',
    total_amount: 240,
    payment_term: 'immediate',
    allocated_amount: 240,
    outstanding_amount: 0,
    payment_status: 'paid',
    items: [
      { ice_type_id: 'demo-ice-1', name: 'น้ำแข็งก้อน', unit: 'ถุง', quantity: 8, unit_price: 30, line_total: 240 },
    ],
    payments: [
      { payment_id: 'demo-payment-1', payment_method: 'cash', amount: 240, recorded_at: '2026-08-03T09:19:00+07:00' },
    ],
  },
  {
    delivery_event_id: 'demo-delivery-2',
    charge_id: 'demo-charge-2',
    charge_number: 'C690802-000018',
    service_date: '2026-08-02',
    recorded_at: '2026-08-02T10:05:00+07:00',
    recorded_by_name: 'พนักงานส่งน้ำแข็ง 02',
    total_amount: 360,
    payment_term: 'end_of_day',
    allocated_amount: 200,
    outstanding_amount: 160,
    payment_status: 'partial',
    items: [
      { ice_type_id: 'demo-ice-1', name: 'น้ำแข็งก้อน', unit: 'ถุง', quantity: 12, unit_price: 30, line_total: 360 },
    ],
    payments: [
      { payment_id: 'demo-payment-2', payment_method: 'bank_transfer', amount: 200, recorded_at: '2026-08-02T17:12:00+07:00' },
    ],
  },
  {
    delivery_event_id: 'demo-delivery-3',
    charge_id: 'demo-charge-3',
    charge_number: 'C690801-000011',
    service_date: '2026-08-01',
    recorded_at: '2026-08-01T08:42:00+07:00',
    recorded_by_name: 'พนักงานส่งน้ำแข็ง 01',
    total_amount: 180,
    payment_term: 'credit',
    allocated_amount: 0,
    outstanding_amount: 180,
    payment_status: 'unpaid',
    items: [
      { ice_type_id: 'demo-ice-1', name: 'น้ำแข็งก้อน', unit: 'ถุง', quantity: 6, unit_price: 30, line_total: 180 },
    ],
    payments: [],
  },
];

const paymentTermLabel: Record<PaymentTerm, string> = {
  immediate: 'ชำระทันที',
  end_of_day: 'ชำระสิ้นวัน',
  credit: 'เครดิต',
};

function paymentStatusLabel(status: FinancialPaymentStatus | null) {
  if (status === 'paid') return 'ชำระแล้ว';
  if (status === 'partial') return 'ชำระบางส่วน';
  if (status === 'unpaid') return 'ค้างชำระ';
  return 'ข้อมูลเดิม';
}

function entryPaymentMethods(entry: PurchaseHistoryEntry) {
  return [...new Set(entry.payments.map((payment) => payment.payment_method))]
    .map(paymentMethodLabel)
    .join(' + ');
}

export function ShopPurchaseHistory({ isActive, shopId }: { isActive: boolean; shopId: string }) {
  const [entries, setEntries] = useState<PurchaseHistoryEntry[]>([]);
  const [period, setPeriod] = useState<HistoryPeriod>('90');
  const [paymentFilter, setPaymentFilter] = useState<HistoryPaymentFilter>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    if (!shopId) return;
    setLoading(true);
    setError(null);
    try {
      if (env.isDemoMode) {
        setEntries(DEMO_HISTORY);
        return;
      }
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase สำหรับประวัติการซื้อ');
      const { data, error: loadError } = await supabase.rpc('get_shop_purchase_history', {
        p_limit: 100,
        p_offset: 0,
        p_shop_id: shopId,
      });
      if (loadError) throw loadError;
      setEntries((data ?? []) as PurchaseHistoryEntry[]);
    } catch (loadError) {
      setEntries([]);
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [shopId]);

  useEffect(() => {
    setEntries([]);
    setError(null);
  }, [shopId]);

  useEffect(() => {
    if (!isActive) return;
    void loadHistory();
  }, [isActive, loadHistory]);

  const filteredEntries = useMemo(() => {
    const cutoff = period === 'all' ? null : new Date();
    if (cutoff) cutoff.setDate(cutoff.getDate() - Number(period));
    return entries.filter((entry) => {
      const inPeriod = !cutoff || new Date(`${entry.service_date}T23:59:59`).getTime() >= cutoff.getTime();
      const matchesPayment = paymentFilter === 'all'
        || (paymentFilter === 'paid' ? entry.payment_status === 'paid' : entry.payment_status === 'partial' || entry.payment_status === 'unpaid');
      return inPeriod && matchesPayment;
    });
  }, [entries, paymentFilter, period]);

  const totals = useMemo(() => filteredEntries.reduce((summary, entry) => ({
    amount: summary.amount + (entry.total_amount ?? 0),
    quantity: summary.quantity + entry.items.reduce((total, item) => total + Number(item.quantity), 0),
    outstanding: summary.outstanding + Number(entry.outstanding_amount),
  }), { amount: 0, quantity: 0, outstanding: 0 }), [filteredEntries]);

  if (!shopId) return <p className="muted">บันทึกข้อมูลร้านก่อน แล้วจึงดูประวัติการซื้อ</p>;

  return (
    <section aria-label="ประวัติการซื้อของร้าน" className="shop-purchase-history">
      <header className="shop-purchase-history__heading">
        <div>
          <p className="eyebrow">รายการส่งและการชำระเงิน</p>
          <h3>ประวัติการซื้อ</h3>
          <p>แสดงรายการล่าสุดสูงสุด 100 รายการของร้านนี้</p>
        </div>
        <button aria-label="โหลดประวัติการซื้อใหม่" className="secondary-button" disabled={loading} onClick={() => void loadHistory()} type="button">
          <ArrowClockwise className={loading ? 'is-spinning' : ''} size={17} />
          โหลดใหม่
        </button>
      </header>

      <div className="shop-purchase-history__filters">
        <label>
          ช่วงเวลา
          <select value={period} onChange={(event) => setPeriod(event.target.value as HistoryPeriod)}>
            <option value="30">30 วันล่าสุด</option>
            <option value="90">90 วันล่าสุด</option>
            <option value="all">ทั้งหมด</option>
          </select>
        </label>
        <label>
          สถานะชำระเงิน
          <select value={paymentFilter} onChange={(event) => setPaymentFilter(event.target.value as HistoryPaymentFilter)}>
            <option value="all">ทุกสถานะ</option>
            <option value="paid">ชำระแล้ว</option>
            <option value="outstanding">ยังมียอดค้าง</option>
          </select>
        </label>
      </div>

      {!loading && !error ? (
        <div className="shop-purchase-history__summary" aria-label="สรุปประวัติการซื้อที่แสดง">
          <span><Receipt size={20} /><small>จำนวนรายการ</small><strong>{filteredEntries.length.toLocaleString('th-TH')}</strong></span>
          <span><Package size={20} /><small>จำนวนรวม</small><strong>{totals.quantity.toLocaleString('th-TH')} หน่วย</strong></span>
          <span><CheckCircle size={20} /><small>ยอดซื้อรวม</small><strong>{money.format(totals.amount)}</strong></span>
          <span className={totals.outstanding > 0 ? 'has-outstanding' : ''}><WarningCircle size={20} /><small>ยอดค้าง</small><strong>{money.format(totals.outstanding)}</strong></span>
        </div>
      ) : null}

      {loading ? (
        <div className="shop-purchase-history__state" role="status"><span className="loading-spinner" /><strong>กำลังโหลดประวัติการซื้อ</strong><small>โปรดรอสักครู่</small></div>
      ) : error ? (
        <div className="shop-purchase-history__state shop-purchase-history__state--error" role="alert"><WarningCircle size={30} /><strong>โหลดประวัติไม่สำเร็จ</strong><small>{error}</small><button className="secondary-button" onClick={() => void loadHistory()} type="button">ลองอีกครั้ง</button></div>
      ) : filteredEntries.length === 0 ? (
        <div className="shop-purchase-history__state"><ClockCounterClockwise size={34} /><strong>ไม่พบประวัติการซื้อ</strong><small>ลองเปลี่ยนช่วงเวลาหรือสถานะการชำระเงิน</small></div>
      ) : (
        <div className="shop-purchase-history__list">
          {filteredEntries.map((entry) => {
            const paymentMethods = entryPaymentMethods(entry);
            return (
              <article className="shop-purchase-card" key={entry.delivery_event_id}>
                <div className="shop-purchase-card__date">
                  <CalendarBlank size={21} />
                  <span><strong>{formatServiceDate(entry.service_date)}</strong><small>{new Date(entry.recorded_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} น.</small></span>
                </div>
                <div className="shop-purchase-card__body">
                  <div className="shop-purchase-card__title">
                    <span>
                      <strong>{entry.charge_number ?? 'รายการเดิมก่อนใช้ระบบบิล'}</strong>
                      <small>บันทึกโดย {entry.recorded_by_name || '—'}</small>
                    </span>
                    <span className={`shop-purchase-status shop-purchase-status--${entry.payment_status ?? 'legacy'}`}>{paymentStatusLabel(entry.payment_status)}</span>
                  </div>
                  {entry.delivery_status === 'replaced' ? <p className="muted">บิลนี้ถูกแทนที่ด้วยบิลแก้ไขแล้ว</p>
                    : entry.delivery_status === 'cancelled' || entry.charge_status === 'voided' ? <p className="muted">บิลนี้ถูกยกเลิกแล้ว</p> : null}
                  <div className="shop-purchase-card__items">
                    {entry.items.map((item) => (
                      <span key={item.ice_type_id}>
                        <b>{item.name}</b>
                        <small>{Number(item.quantity).toLocaleString('th-TH')} {item.unit}{item.line_total == null ? '' : ` · ${money.format(Number(item.line_total))}`}</small>
                      </span>
                    ))}
                  </div>
                  <div className="shop-purchase-card__meta">
                    <span><small>เงื่อนไข</small><strong>{entry.payment_term ? paymentTermLabel[entry.payment_term] : 'ข้อมูลเดิม'}</strong></span>
                    <span><small>วิธีชำระ</small><strong>{paymentMethods || (entry.payment_status === 'unpaid' ? 'ยังไม่ชำระ' : '—')}</strong></span>
                    <span><small>ยอดรวม</small><strong>{entry.total_amount == null ? 'ไม่ระบุยอด' : money.format(Number(entry.total_amount))}</strong></span>
                    <span><small>ยอดค้าง</small><strong className={entry.outstanding_amount > 0 ? 'is-outstanding' : ''}>{entry.total_amount == null ? '—' : money.format(Number(entry.outstanding_amount))}</strong></span>
                  </div>
                  {entry.adjustments?.map((adjustment) => <p className="muted" key={adjustment.id}>{adjustment.reason} · {adjustment.amount_delta >= 0 ? '+' : ''}{money.format(Number(adjustment.amount_delta))}</p>)}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
