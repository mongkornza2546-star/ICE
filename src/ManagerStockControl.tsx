import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './lib/supabase';
import type {
  DeliveryRound,
  StockControlSummary,
  StockLocationBalance,
  StockMovementKind,
} from './types/app';

const MOVEMENT_LABELS: Record<StockMovementKind, string> = {
  factory_order: 'รับจากโรงงาน',
  transfer: 'โอนระหว่างจุด',
  damage: 'เสียหาย / ละลาย',
  return_to_factory: 'ส่งคืนโรงงาน',
};

const LOCATION_LABELS: Record<StockLocationBalance['kind'], string> = {
  truck: 'รถบรรทุก',
  team: 'ทีมส่ง',
  small_vehicle: 'รถเล็ก',
  work_site: 'จุดปฏิบัติงาน',
  reserve_bin: 'ถังสำรอง',
  front_vehicle: 'จุดหน้ารถ',
};

type QuantityDraft = Record<string, number>;

export function ManagerStockControl({ round }: { round: DeliveryRound | null }) {
  const [summary, setSummary] = useState<StockControlSummary | null>(null);
  const [summaryRoundId, setSummaryRoundId] = useState<string | null>(null);
  const [kind, setKind] = useState<StockMovementKind>('factory_order');
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [quantities, setQuantities] = useState<QuantityDraft>({});
  const [note, setNote] = useState('');
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
      setSummaryRoundId(null);
      return;
    }
    void loadSummary(round.id);
  }, [round?.id]);

  const truckLocations = useMemo(
    () => summary?.locations.filter((location) => location.kind === 'truck') ?? [],
    [summary],
  );

  const iceTypes = summary?.locations[0]?.balances ?? [];

  useEffect(() => {
    if (!summary) return;
    setQuantities((current) =>
      Object.fromEntries(iceTypes.map((ice) => [ice.ice_type_id, current[ice.ice_type_id] ?? 0])),
    );
    setFromLocationId('');
    setToLocationId(truckLocations[0]?.id || '');
  }, [summary]);

  async function loadSummary(roundId: string) {
    if (!supabase) return;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    const { data, error: summaryError } = await supabase.rpc('get_stock_control_summary', {
      p_round_id: roundId,
    });
    if (currentRequest !== requestId.current) return;

    if (summaryError) {
      setError(summaryError.message);
      setSummary(null);
      setSummaryRoundId(null);
    } else {
      setSummary(data as StockControlSummary);
      setSummaryRoundId(roundId);
    }
    setLoading(false);
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !round || summaryRoundId !== round.id) {
      setError('ข้อมูลสต๊อกยังโหลดไม่ครบ กรุณารอสักครู่แล้วลองใหม่');
      return;
    }

    const items = iceTypes
      .map((ice) => ({ ice_type_id: ice.ice_type_id, quantity: quantities[ice.ice_type_id] ?? 0 }))
      .filter((item) => item.quantity > 0);

    if (items.length === 0) {
      setError('กรอกจำนวนน้ำแข็งอย่างน้อย 1 รายการ');
      return;
    }
    if (kind === 'transfer' && fromLocationId === toLocationId) {
      setError('ต้นทางและปลายทางต้องเป็นคนละจุด');
      return;
    }
    if (kind === 'damage' && !note.trim()) {
      setError('รายการเสียหายต้องมีหมายเหตุ');
      return;
    }

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    const signature = JSON.stringify({
      roundId: round.id,
      kind,
      fromLocationId: kind === 'factory_order' ? null : fromLocationId || null,
      toLocationId: kind === 'factory_order' || kind === 'transfer' ? toLocationId || null : null,
      items,
      note: note.trim() || null,
    });
    if (pendingRequest.current?.signature !== signature) {
      pendingRequest.current = { signature, key: crypto.randomUUID() };
    }
    const submittedRoundId = round.id;
    const submittedRequestKey = pendingRequest.current.key;

    const { data, error: movementError } = await supabase.rpc('record_stock_movement', {
      p_round_id: submittedRoundId,
      p_kind: kind,
      p_from_location_id: kind === 'factory_order' ? null : fromLocationId || null,
      p_to_location_id: kind === 'factory_order' || kind === 'transfer' ? toLocationId || null : null,
      p_items: items,
      p_note: note.trim() || null,
      p_idempotency_key: submittedRequestKey,
    });

    if (activeRoundId.current !== submittedRoundId) {
      if (pendingRequest.current?.key === submittedRequestKey) {
        pendingRequest.current = null;
      }
      setSubmitting(false);
      return;
    }

    if (movementError) {
      setError(movementError.message);
    } else {
      pendingRequest.current = null;
      setSummary(data as StockControlSummary);
      setQuantities(Object.fromEntries(iceTypes.map((ice) => [ice.ice_type_id, 0])));
      setNote('');
      setSuccess(`บันทึก “${MOVEMENT_LABELS[kind]}” แล้ว`);
    }
    setSubmitting(false);
  };

  const selectMovementKind = (nextKind: StockMovementKind) => {
    if (!summary) return;
    const truckId = truckLocations[0]?.id || '';
    const firstLocationId = summary.locations[0]?.id || '';

    setKind(nextKind);
    setSuccess(null);
    setError(null);
    pendingRequest.current = null;

    if (nextKind === 'factory_order') {
      setFromLocationId('');
      setToLocationId(truckId);
    } else if (nextKind === 'transfer') {
      const sourceId = truckId || firstLocationId;
      setFromLocationId(sourceId);
      setToLocationId(summary.locations.find((location) => location.id !== sourceId)?.id || '');
    } else {
      setFromLocationId(nextKind === 'return_to_factory' ? truckId : truckId || firstLocationId);
      setToLocationId('');
    }
  };

  if (!round) {
    return <p className="empty-text">เลือกรอบส่งเพื่อจัดการสต๊อกของวัน</p>;
  }
  if (loading) {
    return <p className="empty-text">กำลังรวมยอดสต๊อกทุกจุด...</p>;
  }
  if (!summary) {
    return <p className="error-text">{error ?? 'ไม่พบข้อมูลสต๊อก'}</p>;
  }

  return (
    <div className="stock-control">
      <div className="panel-header">
        <div>
          <p className="eyebrow">สต๊อกต่อเนื่องทั้งวัน · {summary.service_date}</p>
          <h3>น้ำแข็งอยู่ที่ไหนตอนนี้</h3>
        </div>
        <span className="status-badge status-badge--neutral">{summary.locations.length} จุด</span>
      </div>

      <div className="stock-location-grid">
        {summary.locations.map((location) => {
          const hasNegative = location.balances.some((balance) => balance.quantity < 0);
          return (
            <section className={`stock-location-card ${hasNegative ? 'stock-location-card--warning' : ''}`} key={location.id}>
              <div>
                <small>{LOCATION_LABELS[location.kind]} · {location.code}</small>
                <h3>{location.name}</h3>
              </div>
              <div className="stock-balance-list">
                {location.balances.map((balance) => (
                  <div className={balance.quantity < 0 ? 'stock-balance stock-balance--negative' : 'stock-balance'} key={balance.ice_type_id}>
                    <span>{balance.ice_type_name}</span>
                    <strong>{balance.quantity} <small>{balance.unit}</small></strong>
                  </div>
                ))}
              </div>
              {hasNegative ? <p className="error-text">ยอดติดลบ: ตรวจจุดต้นทางหรือรายการโอน</p> : null}
            </section>
          );
        })}
      </div>

      <form className="stock-movement-form" onSubmit={handleSubmit}>
        <div>
          <p className="eyebrow">บันทึกเหตุการณ์จริง</p>
          <h3>เคลื่อนย้ายสต๊อก</h3>
        </div>

        <div className="movement-kind-grid" role="radiogroup" aria-label="ประเภทรายการสต๊อก">
          {(Object.keys(MOVEMENT_LABELS) as StockMovementKind[]).map((movementKind) => (
            <button
              aria-pressed={kind === movementKind}
              className={kind === movementKind ? 'choice-chip choice-chip--selected' : 'choice-chip'}
              key={movementKind}
              onClick={() => selectMovementKind(movementKind)}
              type="button"
            >
              {MOVEMENT_LABELS[movementKind]}
            </button>
          ))}
        </div>

        {kind === 'factory_order' ? (
          <p className="muted">ยอดนี้ใช้จำนวนที่สั่งเป็นยอดตั้งต้นของรถ โดยสมมุติว่าโรงงานส่งครบ เพราะหัวหน้าไม่ได้ตรวจนับตอนขึ้นรถ</p>
        ) : null}

        <div className="field-grid">
          {kind !== 'factory_order' ? (
            <LocationSelect
              label="ต้นทาง"
              locations={kind === 'return_to_factory' ? truckLocations : summary.locations}
              onChange={setFromLocationId}
              value={fromLocationId}
            />
          ) : null}
          {kind === 'factory_order' || kind === 'transfer' ? (
            <LocationSelect
              label="ปลายทาง"
              locations={kind === 'factory_order' ? truckLocations : summary.locations.filter((location) => location.id !== fromLocationId)}
              onChange={setToLocationId}
              value={toLocationId}
            />
          ) : null}
        </div>

        <fieldset className="fieldset">
          <legend>ชนิดและจำนวน</legend>
          <div className="field-grid field-grid--three">
            {iceTypes.map((ice) => (
              <label key={ice.ice_type_id}>
                {ice.ice_type_name} ({ice.unit})
                <input
                  inputMode="numeric"
                  min={0}
                  onChange={(event) => setQuantities((current) => ({
                    ...current,
                    [ice.ice_type_id]: Math.max(0, Number(event.target.value) || 0),
                  }))}
                  type="number"
                  value={quantities[ice.ice_type_id] ?? 0}
                />
              </label>
            ))}
          </div>
        </fieldset>

        <label>
          หมายเหตุ {kind === 'damage' ? '(จำเป็น)' : '(ถ้ามี)'}
          <textarea
            onChange={(event) => setNote(event.target.value)}
            placeholder={kind === 'damage' ? 'เช่น ถุงแตกหรือละลายระหว่างรอส่ง' : 'รายละเอียดที่ช่วยตรวจย้อนหลัง'}
            rows={2}
            value={note}
          />
        </label>

        {error ? <p className="error-text">{error}</p> : null}
        {success ? <p className="success-text">{success}</p> : null}
        {round.status === 'closed' ? (
          <p className="muted">รอบส่งปิดแล้ว แต่ยังโอนของกลับ บันทึกเสียหาย และส่งคืนโรงงานเพื่อปิดสต๊อกของวันได้</p>
        ) : null}
        <button className="primary-button" disabled={submitting} type="submit">
          {submitting ? 'กำลังบันทึก...' : `ยืนยัน ${MOVEMENT_LABELS[kind]}`}
        </button>
      </form>

      <section className="stock-ledger">
        <div>
          <p className="eyebrow">ประวัติล่าสุดของวัน</p>
          <h3>รายการที่ตรวจนับได้</h3>
        </div>
        <div className="stock-ledger-list">
          {summary.recent_movements.map((movement) => (
            <article className="stock-ledger-item" key={movement.id}>
              <div className="panel-header">
                <strong>{MOVEMENT_LABELS[movement.kind]}</strong>
                <time>{formatStockTime(movement.recorded_at)}</time>
              </div>
              <p>
                {movement.from_location_name ?? 'โรงงาน'}
                {' → '}
                {movement.to_location_name ?? (movement.kind === 'damage' ? 'เสียหาย' : 'โรงงาน')}
              </p>
              <small>{movement.items.map((item) => `${item.ice_type_name} ${item.quantity} ${item.unit}`).join(' · ')}</small>
              <small>{movement.recorded_by}{movement.note ? ` · ${movement.note}` : ''}</small>
            </article>
          ))}
          {summary.recent_movements.length === 0 ? <p className="empty-text">ยังไม่มีรายการสต๊อกในวันนี้</p> : null}
        </div>
      </section>
    </div>
  );
}

function LocationSelect({
  label,
  locations,
  value,
  onChange,
}: {
  label: string;
  locations: StockLocationBalance[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select required value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">เลือกจุด</option>
        {locations.map((location) => (
          <option key={location.id} value={location.id}>{location.name}</option>
        ))}
      </select>
    </label>
  );
}

function formatStockTime(value: string) {
  return new Intl.DateTimeFormat('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
