import { FormEvent, useEffect, useRef, useState } from 'react';
import { supabase } from './lib/supabase';
import type { DeliveryRound, RoundControlIceCount, RoundControlSummary } from './types/app';

type CountDraft = Record<
  string,
  { replenished_quantity: number; remaining_quantity: number; damaged_quantity: number }
>;

export function ManagerRoundControl({
  round,
  onClosed,
}: {
  round: DeliveryRound | null;
  onClosed: () => Promise<void>;
}) {
  const [summary, setSummary] = useState<RoundControlSummary | null>(null);
  const [summaryRoundId, setSummaryRoundId] = useState<string | null>(null);
  const [counts, setCounts] = useState<CountDraft>({});
  const [loading, setLoading] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summaryRequestId = useRef(0);

  useEffect(() => {
    if (!round) {
      summaryRequestId.current += 1;
      setSummary(null);
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
    const { data, error: summaryError } = await supabase.rpc('get_round_control_summary', {
      p_round_id: roundId,
    });
    if (requestId !== summaryRequestId.current) return;
    if (summaryError) {
      setError(summaryError.message);
      setSummary(null);
      setSummaryRoundId(null);
    } else {
      const nextSummary = data as RoundControlSummary;
      setSummary(nextSummary);
      setSummaryRoundId(roundId);
      setCounts(
        Object.fromEntries(
          nextSummary.ice_counts.map((item) => [
            item.ice_type_id,
            {
              replenished_quantity: item.replenished_quantity,
              remaining_quantity: item.remaining_quantity,
              damaged_quantity: item.damaged_quantity,
            },
          ]),
        ),
      );
    }
    setLoading(false);
  }

  const updateCount = (
    iceTypeId: string,
    field: keyof CountDraft[string],
    value: number,
  ) => {
    setCounts((current) => ({
      ...current,
      [iceTypeId]: { ...current[iceTypeId], [field]: Math.max(0, value || 0) },
    }));
  };

  const preview = (item: RoundControlIceCount) => {
    const draft = counts[item.ice_type_id];
    const expected =
      item.loaded_quantity +
      (draft?.replenished_quantity ?? 0) -
      (draft?.remaining_quantity ?? 0) -
      (draft?.damaged_quantity ?? 0);
    return { expected, variance: expected - item.delivered_quantity };
  };

  const handleClose = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !round || !summary || summaryRoundId !== round.id) {
      setError('ข้อมูลสรุปรอบยังโหลดไม่ครบ กรุณารอสักครู่แล้วลองใหม่');
      return;
    }
    setClosing(true);
    setError(null);
    const payload = summary.ice_counts.map((item) => ({
      ice_type_id: item.ice_type_id,
      ...counts[item.ice_type_id],
    }));
    const { error: closeError } = await supabase.rpc('close_delivery_round', {
      p_round_id: round.id,
      p_ice_counts: payload,
    });
    if (closeError) {
      setError(closeError.message);
    } else {
      await onClosed();
      await loadSummary(round.id);
    }
    setClosing(false);
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

  return (
    <form className="manager-control" onSubmit={handleClose}>
      <div className="metric-grid">
        <Metric label="ร้านทั้งหมด" value={summary.stop_counts.total} />
        <Metric label="มีรายการส่ง" value={summary.stop_counts.delivered} tone="success" />
        <Metric label="ยังไม่มีรายการ" value={summary.stop_counts.pending} />
        <Metric label="มีปัญหา" value={summary.stop_counts.problem} tone="danger" />
      </div>

      <div className="reconciliation-list">
        {summary.ice_counts.map((item) => {
          const result = preview(item);
          return (
            <section className="reconciliation-card" key={item.ice_type_id}>
              <div className="panel-header">
                <div>
                  <p className="eyebrow">{item.unit}</p>
                  <h3>{item.ice_type_name}</h3>
                </div>
                <span className={`variance ${result.variance === 0 ? 'variance--ok' : 'variance--warning'}`}>
                  {result.variance === 0 ? 'ยอดตรง' : `ต่าง ${result.variance}`}
                </span>
              </div>
              <p className="formula-line">
                ยกออก {item.loaded_quantity} + เติม {counts[item.ice_type_id]?.replenished_quantity ?? 0}
                {' − '}เหลือ {counts[item.ice_type_id]?.remaining_quantity ?? 0}
                {' − '}เสีย {counts[item.ice_type_id]?.damaged_quantity ?? 0}
                {' = '}ควรส่ง {result.expected} · ส่งจริง {item.delivered_quantity}
              </p>
              <div className="field-grid field-grid--three">
                <NumberField
                  disabled={round.status === 'closed'}
                  label="เติมเพิ่ม"
                  onChange={(value) => updateCount(item.ice_type_id, 'replenished_quantity', value)}
                  value={counts[item.ice_type_id]?.replenished_quantity ?? 0}
                />
                <NumberField
                  disabled={round.status === 'closed'}
                  label="เหลือ"
                  onChange={(value) => updateCount(item.ice_type_id, 'remaining_quantity', value)}
                  value={counts[item.ice_type_id]?.remaining_quantity ?? 0}
                />
                <NumberField
                  disabled={round.status === 'closed'}
                  label="เสียหาย"
                  onChange={(value) => updateCount(item.ice_type_id, 'damaged_quantity', value)}
                  value={counts[item.ice_type_id]?.damaged_quantity ?? 0}
                />
              </div>
            </section>
          );
        })}
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      <button
        className="primary-button"
        disabled={closing || round.status === 'closed' || summaryRoundId !== round.id}
        type="submit"
      >
        {round.status === 'closed' ? 'รอบนี้ปิดแล้ว' : closing ? 'กำลังปิดรอบ...' : 'ยืนยันยอดและปิดรอบ'}
      </button>
      <p className="muted">ปิดรอบได้แม้มีร้านค้างหรือยอดต่าง ระบบจะเก็บ snapshot ไว้ตรวจย้อนหลัง</p>
    </form>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'danger' }) {
  return (
    <div className={`metric-card ${tone ? `metric-card--${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function NumberField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      {label}
      <input
        disabled={disabled}
        inputMode="numeric"
        min={0}
        onChange={(event) => onChange(Number(event.target.value))}
        type="number"
        value={value}
      />
    </label>
  );
}
