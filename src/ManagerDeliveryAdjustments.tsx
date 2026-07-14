import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './lib/supabase';
import type {
  DeliveryRound,
  ManagerDeliveryEvent,
  ManagerDeliveryEventSummary,
  ShopRoundStatus,
} from './types/app';

const STATUS_OPTIONS: Array<{ value: Exclude<ShopRoundStatus, 'pending'>; label: string }> = [
  { value: 'delivered', label: 'ส่งแล้ว' },
  { value: 'full_bin', label: 'ถังเต็ม' },
  { value: 'closed_shop', label: 'ปิดร้าน' },
  { value: 'no_access', label: 'เข้าไม่ได้' },
  { value: 'issue', label: 'มีปัญหา' },
];

export function ManagerDeliveryAdjustments({ round }: { round: DeliveryRound | null }) {
  const [summary, setSummary] = useState<ManagerDeliveryEventSummary | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [status, setStatus] = useState<Exclude<ShopRoundStatus, 'pending'>>('delivered');
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const requestId = useRef(0);
  const pendingRequest = useRef<{ signature: string; key: string } | null>(null);
  const activeRoundId = useRef<string | null>(round?.id ?? null);
  activeRoundId.current = round?.id ?? null;

  useEffect(() => {
    pendingRequest.current = null;
    setSuccess(null);
    if (!round) {
      requestId.current += 1;
      setSummary(null);
      setSelectedId('');
      return;
    }
    void loadEvents(round.id);
  }, [round?.id]);

  const selectedEvent = useMemo(
    () => summary?.events.find((event) => event.id === selectedId) ?? null,
    [summary, selectedId],
  );

  useEffect(() => {
    if (!selectedEvent || !summary) return;
    const nextStatus = selectedEvent.stop_status === 'pending' ? 'delivered' : selectedEvent.stop_status;
    setStatus(nextStatus);
    setNote(selectedEvent.note ?? '');
    setReason('');
    setQuantities(Object.fromEntries(
      summary.ice_types.map((ice) => [
        ice.id,
        selectedEvent.items.find((item) => item.ice_type_id === ice.id)?.quantity ?? 0,
      ]),
    ));
    pendingRequest.current = null;
  }, [selectedEvent?.id, summary?.ice_types]);

  async function loadEvents(roundId: string) {
    if (!supabase) return;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    const { data, error: loadError } = await supabase.rpc('get_manager_delivery_events', {
      p_round_id: roundId,
    });
    if (currentRequest !== requestId.current) return;
    if (loadError) {
      setError(loadError.message);
      setSummary(null);
    } else {
      const nextSummary = data as ManagerDeliveryEventSummary;
      setSummary(nextSummary);
      setSelectedId((current) => (
        nextSummary.events.some((event) => event.id === current)
          ? current
          : nextSummary.events[0]?.id ?? ''
      ));
    }
    setLoading(false);
  }

  async function submitRevision(
    event: FormEvent<HTMLFormElement> | null,
    action: 'correct' | 'cancel',
  ) {
    event?.preventDefault();
    if (!supabase || !round || !selectedEvent || !summary) return;
    if (!reason.trim()) {
      setError('ต้องระบุเหตุผลที่แก้ไขหรือยกเลิก');
      return;
    }

    const items = action === 'correct' && status === 'delivered'
      ? summary.ice_types
        .map((ice) => ({ ice_type_id: ice.id, quantity: quantities[ice.id] ?? 0 }))
        .filter((item) => item.quantity > 0)
      : [];

    if (action === 'correct' && status === 'delivered' && items.length === 0) {
      setError('รายการส่งแล้วต้องมีน้ำแข็งอย่างน้อย 1 ชนิด');
      return;
    }
    if (action === 'correct' && status !== 'delivered' && !note.trim()) {
      setError('สถานะที่ไม่ได้ส่งต้องมีหมายเหตุ');
      return;
    }

    const signature = JSON.stringify({
      eventId: selectedEvent.id,
      action,
      items,
      status,
      note: note.trim(),
      reason: reason.trim(),
    });
    if (pendingRequest.current?.signature !== signature) {
      pendingRequest.current = { signature, key: crypto.randomUUID() };
    }

    setSubmitting(true);
    setError(null);
    setSuccess(null);
    const requestKey = pendingRequest.current.key;
    const submittedRoundId = round.id;
    const { data, error: revisionError } = await supabase.rpc('revise_delivery_event', {
      p_event_id: selectedEvent.id,
      p_action: action,
      p_items: items,
      p_stop_status: status,
      p_note: note.trim() || null,
      p_reason: reason.trim(),
      p_idempotency_key: requestKey,
    });

    if (activeRoundId.current !== submittedRoundId) {
      setSubmitting(false);
      return;
    }

    if (revisionError) {
      setError(revisionError.message);
    } else {
      pendingRequest.current = null;
      const nextSummary = data as ManagerDeliveryEventSummary;
      setSummary(nextSummary);
      setSelectedId(nextSummary.events[0]?.id ?? '');
      setSuccess(action === 'correct' ? 'แก้ไขรายการและเก็บประวัติแล้ว' : 'ยกเลิกรายการและคืนสต๊อกแล้ว');
    }
    setSubmitting(false);
  }

  if (!round) return <p className="empty-text">เลือกรอบเพื่อตรวจรายการส่ง</p>;
  if (loading) return <p className="empty-text">กำลังโหลดรายการส่ง...</p>;
  if (!summary) return <p className="error-text">{error ?? 'โหลดรายการไม่สำเร็จ'}</p>;

  return (
    <section className="manager-delivery-adjustments">
      <div className="panel-header">
        <div>
          <p className="eyebrow">ตรวจและแก้ไข</p>
          <h3>รายการส่งของทุกคน</h3>
        </div>
        <span className="status-badge status-badge--neutral">{summary.events.length} รายการ</span>
      </div>

      {summary.events.length === 0 ? <p className="empty-text">ยังไม่มีรายการส่งในรอบนี้</p> : (
        <div className="manager-adjustment-grid">
          <div className="stock-ledger-list manager-event-list">
            {summary.events.map((deliveryEvent) => (
              <button
                className={`round-item ${deliveryEvent.id === selectedId ? 'round-item--selected' : ''}`}
                key={deliveryEvent.id}
                onClick={() => setSelectedId(deliveryEvent.id)}
                type="button"
              >
                <span>{deliveryEvent.shop_code} · {deliveryEvent.shop_name}</span>
                <small>{formatTime(deliveryEvent.recorded_at)} · {deliveryEvent.recorded_by} · {eventItemsLabel(deliveryEvent, summary)}</small>
              </button>
            ))}
          </div>

          {selectedEvent ? (
            <form className="settings-form" onSubmit={(event) => void submitRevision(event, 'correct')}>
              <div className="field-grid">
                <label>
                  สถานะ
                  <select disabled={round.status === 'closed'} value={status} onChange={(event) => setStatus(event.target.value as Exclude<ShopRoundStatus, 'pending'>)}>
                    {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label>
                  เหตุผลที่แก้/ยกเลิก
                  <input disabled={round.status === 'closed'} required value={reason} onChange={(event) => setReason(event.target.value)} />
                </label>
              </div>
              {status === 'delivered' ? (
                <div className="field-grid field-grid--three">
                  {summary.ice_types.map((ice) => (
                    <label key={ice.id}>
                      {ice.name} ({ice.unit})
                      <input
                        disabled={round.status === 'closed'}
                        min={0}
                        type="number"
                        value={quantities[ice.id] ?? 0}
                        onChange={(event) => setQuantities((current) => ({ ...current, [ice.id]: Math.max(0, Number(event.target.value) || 0) }))}
                      />
                    </label>
                  ))}
                </div>
              ) : null}
              <label>หมายเหตุ<textarea disabled={round.status === 'closed'} rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></label>
              {error ? <p className="error-text">{error}</p> : null}
              {success ? <p className="success-text">{success}</p> : null}
              <div className="manager-action-row">
                <button className="primary-button" disabled={submitting || round.status === 'closed'} type="submit">{submitting ? 'กำลังบันทึก...' : 'บันทึกการแก้ไข'}</button>
                <button className="ghost-button danger-button" disabled={submitting || round.status === 'closed'} onClick={() => void submitRevision(null, 'cancel')} type="button">ยกเลิกรายการ</button>
              </div>
              {round.status === 'closed' ? <p className="muted">รอบปิดแล้ว รายการแก้ไขได้เฉพาะก่อนปิดรอบเพื่อไม่ให้ snapshot เปลี่ยนย้อนหลัง</p> : null}
            </form>
          ) : null}
        </div>
      )}
    </section>
  );
}

function eventItemsLabel(event: ManagerDeliveryEvent, summary: ManagerDeliveryEventSummary) {
  if (event.items.length === 0) {
    return STATUS_OPTIONS.find((option) => option.value === event.stop_status)?.label ?? 'ไม่มียอด';
  }
  return event.items.map((item) => {
    const ice = summary.ice_types.find((option) => option.id === item.ice_type_id);
    return `${ice?.name ?? 'น้ำแข็ง'} ${item.quantity}`;
  }).join(' · ');
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
