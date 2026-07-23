import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, Package, Scales } from '@phosphor-icons/react';
import { supabase } from './lib/supabase';
import type { StockCountSnapshot, StockMovementEntry } from './types/app';

const PAGE_SIZE = 20;

const MOVEMENT_LABELS: Record<string, string> = {
  factory_order: 'รับจากโรงงาน',
  transfer: 'โอนระหว่างจุด',
  damage: 'เสียหาย / ละลาย',
  return_to_factory: 'ส่งคืนโรงงาน',
};

function todayIsoDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function formatStockTime(value: string) {
  return new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

interface StockAuditMovement extends StockMovementEntry {
  cancelled_by?: string | null;
}

interface MovementHistoryResponse {
  movements: StockAuditMovement[];
  total_count: number;
}

interface CountHistoryResponse {
  snapshots: StockCountSnapshot[];
  total_count: number;
}

/** Read-only record of stock movements and count snapshots. */
export function ManagerStockAudit() {
  const [serviceDate, setServiceDate] = useState(todayIsoDate);
  const [movements, setMovements] = useState<StockAuditMovement[]>([]);
  const [movementTotal, setMovementTotal] = useState(0);
  const [movementOffset, setMovementOffset] = useState(0);
  const [countHistory, setCountHistory] = useState<StockCountSnapshot[]>([]);
  const [countTotal, setCountTotal] = useState(0);
  const [countOffset, setCountOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const requestId = useRef(0);

  const loadAudit = useCallback(async () => {
    const currentRequest = ++requestId.current;
    if (!serviceDate) {
      setError('กรุณาเลือกวันที่ทำรายการ');
      setMovements([]);
      setMovementTotal(0);
      setCountHistory([]);
      setCountTotal(0);
      setLoadedAt(null);
      setLoading(false);
      return;
    }
    if (!supabase) {
      setError('Supabase ยังไม่ได้ตั้งค่า');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const [movementResponse, countResponse] = await Promise.all([
      supabase.rpc('get_stock_movement_history_v2', {
        p_service_date: serviceDate,
        p_limit: PAGE_SIZE,
        p_offset: movementOffset,
      }),
      supabase.rpc('get_location_count_history_v2', {
        p_service_date: serviceDate,
        p_limit: PAGE_SIZE,
        p_offset: countOffset,
      }),
    ]);
    if (currentRequest !== requestId.current) return;

    const firstError = movementResponse.error ?? countResponse.error;
    if (firstError) {
      setError(firstError.message);
      setMovements([]);
      setMovementTotal(0);
      setCountHistory([]);
      setCountTotal(0);
      setLoadedAt(null);
    } else {
      const movementData = movementResponse.data as MovementHistoryResponse;
      const countData = countResponse.data as CountHistoryResponse;
      setMovements(movementData.movements ?? []);
      setMovementTotal(movementData.total_count ?? 0);
      setCountHistory(countData.snapshots ?? []);
      setCountTotal(countData.total_count ?? 0);
      setLoadedAt(new Date().toISOString());
    }
    setLoading(false);
  }, [countOffset, movementOffset, serviceDate]);

  useEffect(() => {
    void loadAudit();
    return () => { requestId.current += 1; };
  }, [loadAudit]);

  const changeServiceDate = (value: string) => {
    setServiceDate(value);
    setMovementOffset(0);
    setCountOffset(0);
    setMovements([]);
    setMovementTotal(0);
    setCountHistory([]);
    setCountTotal(0);
    setLoadedAt(null);
  };

  return (
    <div className="stack stack--wide stock-audit">
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Audit log</p>
            <h1>ประวัติการจัดการสต็อก</h1>
            <p className="muted">ดูรายการย้อนหลังแบบอ่านอย่างเดียว แยกจากหน้าทำรายการสต็อก</p>
          </div>
          <button className="secondary-button" disabled={loading} onClick={() => void loadAudit()} type="button">
            <ArrowClockwise size={18} /> {loading ? 'กำลังโหลด...' : 'รีเฟรช'}
          </button>
        </div>
        <div className="audit-toolbar">
          <label>
            วันที่ทำรายการ
            <input max={todayIsoDate()} onChange={(event) => changeServiceDate(event.target.value)} required type="date" value={serviceDate} />
          </label>
          {loadedAt ? <small className="muted">อัปเดต {formatStockTime(loadedAt)} น.</small> : null}
        </div>
      </section>

      {error ? <section className="panel error-panel"><p className="eyebrow">โหลด Audit ไม่สำเร็จ</p><h2>{error}</h2></section> : null}
      {!error && loading && !loadedAt ? <section className="panel center-panel"><p className="eyebrow">กำลังโหลด</p><h2>กำลังดึงประวัติการทำรายการ</h2></section> : null}

      {!error && loadedAt ? (
        <>
          <section className="stock-ledger audit-section">
            <div className="panel-header">
              <div><p className="eyebrow">Stock movements</p><h2><Package size={22} /> รายการเคลื่อนไหว</h2></div>
              <span className="status-badge status-badge--neutral">{movementTotal} รายการ</span>
            </div>
            <div className="stock-ledger-list">
              {movements.map((movement) => (
                <article className="stock-ledger-item" key={movement.id}>
                  <div className="panel-header">
                    <div className="audit-movement-title">
                      <strong>{MOVEMENT_LABELS[movement.kind] ?? movement.kind}</strong>
                      {movement.status === 'cancelled' ? <span className="status-badge status-badge--danger">ยกเลิกแล้ว</span> : null}
                    </div>
                    <time>{formatStockTime(movement.recorded_at)} น.</time>
                  </div>
                  <p>{movement.from_location_name ?? 'โรงงาน'} {' → '} {movement.to_location_name ?? (movement.kind === 'damage' ? 'เสียหาย' : 'โรงงาน')}</p>
                  <small>{movement.items.map((item) => `${item.ice_type_name} ${item.quantity} ${item.unit}`).join(' · ')}</small>
                  <small>{movement.recorded_by}{movement.note ? ` · ${movement.note}` : ''}</small>
                  {movement.status === 'cancelled' ? (
                    <small className="audit-cancellation">
                      ยกเลิกโดย {movement.cancelled_by ?? '-'}
                      {movement.cancelled_at ? ` เมื่อ ${formatStockTime(movement.cancelled_at)} น.` : ''}
                      {movement.cancellation_reason ? ` · ${movement.cancellation_reason}` : ''}
                    </small>
                  ) : null}
                  {movement.original_movement_id ? <small>แก้ไขจากรายการ {movement.original_movement_id}</small> : null}
                  {movement.replacement_movement_id ? <small>รายการทดแทน {movement.replacement_movement_id}</small> : null}
                </article>
              ))}
              {movements.length === 0 ? <p className="empty-text">ยังไม่มีรายการสต็อกในวันที่เลือก</p> : null}
            </div>
            {movementTotal > PAGE_SIZE ? (
              <AuditPagination
                count={movements.length}
                itemLabel="รายการ"
                loading={loading}
                offset={movementOffset}
                onOffsetChange={setMovementOffset}
                sectionLabel="รายการเคลื่อนไหว"
                total={movementTotal}
              />
            ) : null}
          </section>

          <section className="stock-ledger audit-section">
            <div className="panel-header">
              <div><p className="eyebrow">Count snapshots</p><h2><Scales size={22} /> ประวัติการตรวจนับ</h2></div>
              <span className="status-badge status-badge--neutral">{countTotal} ครั้ง</span>
            </div>
            <div className="stock-ledger-list">
              {countHistory.map((snapshot) => (
                <article className="stock-ledger-item" key={snapshot.id}>
                  <div className="panel-header"><strong>{snapshot.location_name}</strong><time>{formatStockTime(snapshot.counted_at)} น.</time></div>
                  <small>{snapshot.items.map((item) => `${item.ice_type_name}: ระบบ ${item.system_quantity} / นับ ${item.actual_quantity} / ต่าง ${item.variance_quantity}`).join(' · ')}</small>
                  <small>{snapshot.counted_by}{snapshot.note ? ` · ${snapshot.note}` : ''}</small>
                </article>
              ))}
              {countHistory.length === 0 ? <p className="empty-text">ยังไม่มีประวัติการตรวจนับในวันที่เลือก</p> : null}
            </div>
            {countTotal > PAGE_SIZE ? (
              <AuditPagination
                count={countHistory.length}
                itemLabel="ครั้ง"
                loading={loading}
                offset={countOffset}
                onOffsetChange={setCountOffset}
                sectionLabel="ประวัติการตรวจนับ"
                total={countTotal}
              />
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}

function AuditPagination({
  count,
  itemLabel,
  loading,
  offset,
  onOffsetChange,
  sectionLabel,
  total,
}: {
  count: number;
  itemLabel: string;
  loading: boolean;
  offset: number;
  onOffsetChange: (offset: number) => void;
  sectionLabel: string;
  total: number;
}) {
  return (
    <div className="audit-pagination">
      <small className="muted">แสดง {offset + 1}-{offset + count} จาก {total} {itemLabel}</small>
      <div>
        <button
          aria-label={`หน้าก่อนหน้าของ${sectionLabel}`}
          className="secondary-button"
          disabled={loading || offset === 0}
          onClick={() => onOffsetChange(Math.max(0, offset - PAGE_SIZE))}
          type="button"
        >
          ‹ ก่อนหน้า
        </button>
        <button
          aria-label={`หน้าถัดไปของ${sectionLabel}`}
          className="secondary-button"
          disabled={loading || offset + count >= total}
          onClick={() => onOffsetChange(offset + PAGE_SIZE)}
          type="button"
        >
          ถัดไป ›
        </button>
      </div>
    </div>
  );
}
