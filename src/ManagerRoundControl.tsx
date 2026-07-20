import { FormEvent, useEffect, useRef, useState } from 'react';
import { supabase } from './lib/supabase';
import { useRpcAction } from './hooks/useRpcAction';
import type { DeliveryRound, RoundControlSummary } from './types/app';

type CancellationBlocker = 'delivery_events' | 'stock_movements' | 'non_pending_stops' | 'round_ice_counts';

interface RoundCancellationState {
  can_cancel: boolean;
  blockers: CancellationBlocker[];
  status: 'open' | 'closed' | 'cancelled';
}

export function ManagerRoundControl({
  round,
  onClosed,
  onCancelled,
}: {
  round: DeliveryRound | null;
  onClosed: () => Promise<void>;
  onCancelled: () => Promise<void>;
}) {
  const [summary, setSummary] = useState<RoundControlSummary | null>(null);
  const [cancellationState, setCancellationState] = useState<RoundCancellationState | null>(null);
  const [summaryRoundId, setSummaryRoundId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('เปิดผิดวันที่หรือเวลา');
  const [cancelDetail, setCancelDetail] = useState('');
  const summaryRequestId = useRef(0);

  useEffect(() => {
    setCancelDialogOpen(false);
    setCancelReason('เปิดผิดวันที่หรือเวลา');
    setCancelDetail('');
    if (!round) {
      summaryRequestId.current += 1;
      setSummary(null);
      setCancellationState(null);
      setSummaryRoundId(null);
      return;
    }
    void loadSummary(round.id);
  }, [round?.id]);

  async function loadSummary(roundId: string) {
    if (!supabase) return;
    const requestId = ++summaryRequestId.current;
    setLoading(true);
    setSummaryRoundId(null);
    setError(null);
    const [summaryResponse, cancellationResponse] = await Promise.all([
      supabase.rpc('get_round_control_summary', { p_round_id: roundId }),
      supabase.rpc('get_delivery_round_cancellation_state', { p_round_id: roundId }),
    ]);
    if (requestId !== summaryRequestId.current) return;
    const summaryError = summaryResponse.error ?? cancellationResponse.error;
    if (summaryError) {
      setError(summaryError.message);
      setSummary(null);
      setCancellationState(null);
      setSummaryRoundId(null);
    } else {
      const nextSummary = summaryResponse.data as RoundControlSummary;
      setSummary(nextSummary);
      setCancellationState(cancellationResponse.data as RoundCancellationState);
      setSummaryRoundId(roundId);
    }
    setLoading(false);
  }

  const closeRoundAction = useRpcAction(
    async (payload: any[]) => {
      if (!supabase) throw new Error('Supabase is not initialized');
      return supabase.rpc('close_delivery_round', {
        p_round_id: round!.id,
        p_ice_counts: payload,
      });
    },
    {
      deps: [round?.id],
      onSuccess: async () => {
        await onClosed();
        await loadSummary(round!.id);
      },
    }
  );

  const cancelRoundAction = useRpcAction(
    async (reason: string) => {
      if (!supabase) throw new Error('Supabase is not initialized');
      return supabase.rpc('cancel_delivery_round', {
        p_round_id: round!.id,
        p_reason: reason,
      });
    },
    {
      deps: [round?.id],
      successMessage: 'ยกเลิกการเปิดรอบเรียบร้อยแล้ว',
      onSuccess: async () => {
        setCancelDialogOpen(false);
        await onCancelled();
      },
    }
  );

  useEffect(() => {
    if (!cancelDialogOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !cancelRoundAction.isSubmitting) {
        setCancelDialogOpen(false);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [cancelDialogOpen, cancelRoundAction.isSubmitting]);

  const handleClose = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !round || !summary || summaryRoundId !== round.id) {
      closeRoundAction.setError('ข้อมูลสรุปรอบยังโหลดไม่ครบ กรุณารอสักครู่แล้วลองใหม่');
      return;
    }
    
    const payload = summary.ice_counts.map((item) => ({
      ice_type_id: item.ice_type_id,
      replenished_quantity: item.replenished_quantity,
      remaining_quantity: item.remaining_quantity,
      damaged_quantity: item.damaged_quantity,
    }));
    
    await closeRoundAction.execute(payload);
  };

  const handleCancelRound = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!round || round.status !== 'open' || !cancellationState?.can_cancel) return;
    const detail = cancelDetail.trim();
    const reason = cancelReason === 'อื่น ๆ'
      ? detail
      : detail ? `${cancelReason}: ${detail}` : cancelReason;
    if (!reason) {
      cancelRoundAction.setError('กรุณาระบุเหตุผลการยกเลิกรอบ');
      return;
    }
    await cancelRoundAction.execute(reason);
  };

  if (!round) {
    return <p className="empty-text">เลือกรอบส่งเพื่อดูภาพรวมของหัวหน้า</p>;
  }
  if (loading) {
    return <p className="empty-text">กำลังคำนวณยอดรอบ...</p>;
  }
  if (!summary) {
    return <p className="error-text">{error ?? 'ไม่พบข้อมูลรอบ'}</p>;
  }

  const canCancel = cancellationState?.can_cancel === true;

  return (
    <>
      <div className="round-control-actions">
        <span className={`status-badge status-badge--${round.cancelled_at ? 'danger' : round.status === 'open' ? 'warning' : 'success'}`}>
          {round.cancelled_at ? 'ยกเลิกแล้ว' : round.status === 'open' ? 'เปิดอยู่' : 'ปิดแล้ว'}
        </span>
        {round.status === 'open' ? (
          <button
            className="ghost-button danger-button"
            onClick={() => {
              cancelRoundAction.reset();
              setCancelDialogOpen(true);
            }}
            type="button"
          >
            ยกเลิกการเปิดรอบ
          </button>
        ) : null}
      </div>

      <form className="manager-control" onSubmit={handleClose}>
        <div className="metric-grid">
          <Metric label="ร้านทั้งหมด" value={summary.stop_counts.total} />
          <Metric label="มีรายการส่ง" value={summary.stop_counts.delivered} tone="success" />
          <Metric label="ยังไม่มีรายการ" value={summary.stop_counts.pending} />
          <Metric label="มีปัญหา" value={summary.stop_counts.problem} tone="danger" />
        </div>

        <div className="reconciliation-list">
          {summary.ice_counts.map((item) => (
            <section className="reconciliation-card" key={item.ice_type_id}>
              <div className="panel-header">
                <div><p className="eyebrow">ยอดขายในรอบ · {item.unit}</p><h3>{item.ice_type_name}</h3></div>
                <strong>{item.delivered_quantity}</strong>
              </div>
            </section>
          ))}
        </div>

        {closeRoundAction.error ? <p className="error-text" role="alert">{closeRoundAction.error}</p> : null}
        {closeRoundAction.success ? <p className="success-text" aria-live="polite">{closeRoundAction.success}</p> : null}

        <button
          className="primary-button"
          disabled={closeRoundAction.isSubmitting || round.status === 'closed' || summaryRoundId !== round.id}
          type="submit"
        >
          {round.cancelled_at ? 'รอบนี้ยกเลิกแล้ว' : round.status === 'closed' ? 'รอบนี้ปิดแล้ว' : closeRoundAction.isSubmitting ? 'กำลังปิดรอบ...' : 'ปิดรอบรายการขาย'}
        </button>
        <p className="muted">ปิดรอบได้แม้มีร้านที่ไม่มีรายการ เพราะรอบเป็นกลุ่มรายการขาย ไม่ใช่สต๊อก การนับจริงและปิดสต๊อกทำครั้งเดียวหลังจบทุกรอบของวัน</p>
      </form>

      {cancelDialogOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form
            aria-labelledby="cancel-round-title"
            aria-modal="true"
            className="modal-card cancel-round-dialog"
            onSubmit={handleCancelRound}
            role="dialog"
          >
            <div>
              <p className="eyebrow">การจัดการรอบส่ง</p>
              <h2 id="cancel-round-title">ยกเลิกการเปิดรอบนี้?</h2>
              <p className="muted">รอบ {round.name} · {formatServiceDate(round.service_date)}</p>
            </div>

            <div className="cancel-round-impact" aria-label="สรุปรายการในรอบ">
              <span>รายการส่ง <strong>{summary.stop_counts.delivered}</strong></span>
              <span>รายการมีปัญหา <strong>{summary.stop_counts.problem}</strong></span>
              <span>ยอดน้ำแข็งที่ส่ง <strong>{summary.ice_counts.reduce((total, item) => total + item.delivered_quantity, 0)}</strong></span>
            </div>

            {!canCancel ? (
              <p className="error-text" role="alert">
                รอบนี้มีการทำรายการแล้ว ({cancellationBlockerLabel(cancellationState?.blockers ?? [])}) จึงไม่สามารถยกเลิกการเปิดรอบได้
              </p>
            ) : (
              <>
                <p className="info-note">เมื่อยืนยัน รอบนี้จะเปลี่ยนเป็น “ยกเลิกแล้ว” และไม่สามารถใช้บันทึกรายการใหม่ได้</p>
                <label>
                  เหตุผลการยกเลิก
                  <select value={cancelReason} onChange={(event) => setCancelReason(event.target.value)}>
                    <option>เปิดผิดวันที่หรือเวลา</option>
                    <option>เลือกรอบผิด</option>
                    <option>เปิดรอบซ้ำ</option>
                    <option>อื่น ๆ</option>
                  </select>
                </label>
                <label>
                  รายละเอียด{cancelReason === 'อื่น ๆ' ? ' (จำเป็น)' : ' (ถ้ามี)'}
                  <textarea
                    autoFocus
                    onChange={(event) => setCancelDetail(event.target.value)}
                    required={cancelReason === 'อื่น ๆ'}
                    rows={3}
                    value={cancelDetail}
                  />
                </label>
              </>
            )}

            {cancelRoundAction.error ? <p className="error-text" role="alert">{cancelRoundAction.error}</p> : null}
            <div className="modal-actions">
              <button
                className="secondary-button"
                disabled={cancelRoundAction.isSubmitting}
                onClick={() => setCancelDialogOpen(false)}
                type="button"
              >
                กลับไปตรวจสอบ
              </button>
              {canCancel ? (
                <button className="primary-button destructive-button" disabled={cancelRoundAction.isSubmitting} type="submit">
                  {cancelRoundAction.isSubmitting ? 'กำลังยกเลิก...' : 'ยืนยันยกเลิกรอบ'}
                </button>
              ) : null}
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function cancellationBlockerLabel(blockers: CancellationBlocker[]) {
  const labels: Record<CancellationBlocker, string> = {
    delivery_events: 'มีรายการส่ง',
    stock_movements: 'มีรายการสต๊อก',
    non_pending_stops: 'มีสถานะร้านที่เปลี่ยนแล้ว',
    round_ice_counts: 'มียอดน้ำแข็งในรอบ',
  };
  return blockers.map((blocker) => labels[blocker]).join(', ') || 'ไม่สามารถยกเลิกได้';
}

function formatServiceDate(value: string) {
  return new Intl.DateTimeFormat('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${value}T00:00:00`));
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'danger' }) {
  return (
    <div className={`metric-card ${tone ? `metric-card--${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
