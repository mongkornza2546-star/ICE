import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './lib/supabase';
import { useRpcAction } from './hooks/useRpcAction';
import type {
  DailyStockCloseState,
  DeliveryRound,
  StockCountSnapshot,
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

const STOCK_OPERATION_KINDS = ['transfer', 'damage', 'return_to_factory'] as const;
type StockOperationKind = typeof STOCK_OPERATION_KINDS[number];

const LOCATION_LABELS: Record<StockLocationBalance['kind'], string> = {
  truck: 'รถบรรทุก',
  team: 'ทีมส่ง',
  small_vehicle: 'รถเล็ก',
  work_site: 'จุดปฏิบัติงาน',
  reserve_bin: 'ถังสำรอง',
  front_vehicle: 'จุดหน้ารถ',
};

type QuantityDraft = Record<string, number>;

export function ManagerStockControl({
  operationRound,
  round,
  serviceDate,
}: {
  operationRound: DeliveryRound | null;
  round: DeliveryRound | null;
  serviceDate: string;
}) {
  const isRoundSnapshot = round?.status === 'closed';
  const actionRound = operationRound ?? round;
  const [summary, setSummary] = useState<StockControlSummary | null>(null);
  const [summaryRoundId, setSummaryRoundId] = useState<string | null>(null);
  const [kind, setKind] = useState<StockOperationKind>('transfer');
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [quantities, setQuantities] = useState<QuantityDraft>({});
  const [note, setNote] = useState('');
  const [countLocationId, setCountLocationId] = useState('');
  const [actualCounts, setActualCounts] = useState<QuantityDraft>({});
  const [countNote, setCountNote] = useState('');
  const [countHistory, setCountHistory] = useState<StockCountSnapshot[]>([]);
  const [closeState, setCloseState] = useState<DailyStockCloseState | null>(null);
  const [closeCounts, setCloseCounts] = useState<Record<string, number>>({});
  const [closeNote, setCloseNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const requestId = useRef(0);

  useEffect(() => {
    void loadSummary(serviceDate, round?.id ?? null);
  }, [round?.id, serviceDate]);

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
    const sourceId = truckLocations[0]?.id || summary.locations[0]?.id || '';
    setFromLocationId(sourceId);
    setToLocationId(summary.locations.find((location) => location.id !== sourceId)?.id || '');
  }, [summary]);

  useEffect(() => {
    if (!summary) return;
    const selectedLocation = summary.locations.find((location) => location.id === countLocationId)
      ?? summary.locations.find((location) => location.kind !== 'truck')
      ?? summary.locations[0];
    setCountLocationId(selectedLocation?.id ?? '');
    setActualCounts(Object.fromEntries(
      (selectedLocation?.balances ?? []).map((balance) => [balance.ice_type_id, Math.max(0, balance.quantity)]),
    ));
    if (!closeState?.is_closed) {
      setCloseCounts(Object.fromEntries(
        summary.locations.flatMap((location) => location.balances.map((balance) => [
          closeCountKey(location.id, balance.ice_type_id),
          Math.max(0, balance.quantity),
        ])),
      ));
    }
  }, [summary, countLocationId, closeState?.is_closed]);

  async function loadSummary(requestedServiceDate: string, roundId: string | null) {
    if (!supabase) return;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    const [summaryResponse, countResponse, closeResponse] = await Promise.all([
      supabase.rpc('get_stock_control_summary', {
        p_round_id: roundId,
        p_service_date: requestedServiceDate,
      }),
      supabase.rpc('get_location_count_history', {
        p_round_id: roundId,
        p_service_date: requestedServiceDate,
      }),
      supabase.rpc('get_daily_stock_close_state', {
        p_round_id: roundId,
        p_service_date: requestedServiceDate,
      }),
    ]);
    if (currentRequest !== requestId.current) return;

    const firstError = summaryResponse.error ?? countResponse.error ?? closeResponse.error;
    if (firstError) {
      setError(firstError.message);
      setSummary(null);
      setSummaryRoundId(null);
    } else {
      setSummary(summaryResponse.data as StockControlSummary);
      setCountHistory((countResponse.data ?? []) as StockCountSnapshot[]);
      setCloseState(closeResponse.data as DailyStockCloseState);
      setSummaryRoundId(roundId);
    }
    setLoading(false);
  }

  const stockMovementAction = useRpcAction(
    async (
      args: { kind: StockOperationKind; fromLocationId: string; toLocationId: string; items: any[]; note: string },
      idempotencyKey
    ) => {
      if (!supabase) throw new Error('Supabase is not initialized');
      return supabase.rpc('record_stock_movement', {
        p_round_id: actionRound!.id,
        p_kind: args.kind,
        p_from_location_id: args.fromLocationId || null,
        p_to_location_id: args.kind === 'transfer' ? args.toLocationId || null : null,
        p_items: args.items,
        p_note: args.note.trim() || null,
        p_idempotency_key: idempotencyKey,
      });
    },
    {
      deps: [actionRound?.id, round?.id, serviceDate],
      successMessage: (_, args) => `บันทึก “${MOVEMENT_LABELS[args.kind]}” แล้ว`,
      onSuccess: async () => {
        await loadSummary(serviceDate, round?.id ?? null);
        setQuantities(Object.fromEntries(iceTypes.map((ice) => [ice.ice_type_id, 0])));
        setNote('');
      },
    }
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isRoundSnapshot) {
      stockMovementAction.setError('รอบปิดแล้วเป็นประวัติอ่านอย่างเดียว');
      return;
    }
    if (!actionRound) {
      stockMovementAction.setError('ต้องมีรอบส่งของวันที่เลือกก่อนบันทึกการโอน ของเสีย หรือส่งคืนระหว่างวัน');
      return;
    }
    if (!supabase || summaryRoundId !== (round?.id ?? null)) {
      stockMovementAction.setError('ข้อมูลสต๊อกยังโหลดไม่ครบ กรุณารอสักครู่แล้วลองใหม่');
      return;
    }
    if (closeState?.is_closed) {
      stockMovementAction.setError('สต๊อกของวันนี้ปิดแล้ว ไม่สามารถเพิ่มรายการเคลื่อนไหวได้');
      return;
    }

    const items = iceTypes
      .map((ice) => ({ ice_type_id: ice.ice_type_id, quantity: quantities[ice.ice_type_id] ?? 0 }))
      .filter((item) => item.quantity > 0);

    if (items.length === 0) {
      stockMovementAction.setError('กรอกจำนวนน้ำแข็งอย่างน้อย 1 รายการ');
      return;
    }
    if (!fromLocationId) {
      stockMovementAction.setError('เลือกจุดต้นทางก่อนบันทึกรายการ');
      return;
    }
    if (kind === 'transfer' && !toLocationId) {
      stockMovementAction.setError('เลือกจุดปลายทางก่อนบันทึกรายการโอน');
      return;
    }
    if (kind === 'transfer' && fromLocationId === toLocationId) {
      stockMovementAction.setError('ต้นทางและปลายทางต้องเป็นคนละจุด');
      return;
    }
    if (kind === 'damage' && !note.trim()) {
      stockMovementAction.setError('รายการเสียหายต้องมีหมายเหตุ');
      return;
    }

    const args = { kind, fromLocationId, toLocationId, items, note: note.trim() };
    const signature = JSON.stringify({ roundId: actionRound.id, ...args });

    await stockMovementAction.execute(args, { signature });
  };

  const locationCountAction = useRpcAction(
    async (args: { counts: any[]; note: string }) => {
      if (!supabase) throw new Error('Supabase is not initialized');
      const { error } = await supabase.rpc('record_location_count', {
        p_round_id: actionRound?.id ?? null,
        p_service_date: serviceDate,
        p_location_id: countLocationId,
        p_counts: args.counts,
        p_note: args.note.trim() || null,
      });
      if (error) return { data: null, error };

      const { data, error: historyError } = await supabase.rpc('get_location_count_history', {
        p_round_id: actionRound?.id ?? null,
        p_service_date: serviceDate,
      });
      return { data, error: historyError };
    },
    {
      deps: [actionRound?.id, round?.id, serviceDate],
      successMessage: () => {
        const selectedLocation = summary?.locations.find((location) => location.id === countLocationId);
        return `บันทึกยอดนับจริงของ “${selectedLocation?.name ?? ''}” แล้ว`;
      },
      onSuccess: (data) => {
        setCountHistory((data ?? []) as StockCountSnapshot[]);
        setCountNote('');
      },
    }
  );

  const handleLocationCount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !summary || !countLocationId || isRoundSnapshot || closeState?.is_closed) return;
    const selectedLocation = summary.locations.find((location) => location.id === countLocationId);
    if (!selectedLocation) return;

    const counts = selectedLocation.balances.map((balance) => ({
      ice_type_id: balance.ice_type_id,
      actual_quantity: actualCounts[balance.ice_type_id] ?? 0,
    }));

    await locationCountAction.execute({ counts, note: countNote });
  };

  const closeDayAction = useRpcAction(
    async (args: { counts: any[]; note: string }, idempotencyKey) => {
      if (!supabase) throw new Error('Supabase is not initialized');
      return supabase.rpc('close_daily_stock', {
        p_round_id: actionRound?.id ?? null,
        p_service_date: serviceDate,
        p_counts: args.counts,
        p_note: args.note.trim() || null,
        p_idempotency_key: idempotencyKey,
      });
    },
    {
      deps: [actionRound?.id, round?.id, serviceDate],
      successMessage: 'ปิดสต๊อกสิ้นวันและบันทึกส่งยอดคงเหลือกลับโรงงานแล้ว',
      onSuccess: async (data) => {
        setCloseState(data as DailyStockCloseState);
        await loadSummary(serviceDate, round?.id ?? null);
      },
    }
  );

  const handleCloseDay = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !summary || !closeState || isRoundSnapshot || closeState.is_closed) return;
    if (closeState.open_round_count > 0) {
      closeDayAction.setError('ต้องปิดรอบส่งทุกช่วงของวันนี้ก่อนปิดสต๊อกสิ้นวัน');
      return;
    }

    const counts = summary.locations.flatMap((location) => location.balances.map((balance) => ({
      location_id: location.id,
      ice_type_id: balance.ice_type_id,
      actual_quantity: closeCounts[closeCountKey(location.id, balance.ice_type_id)] ?? 0,
      note: null,
    })));
    const noteValue = closeNote.trim();

    const signature = JSON.stringify({ serviceDate, roundId: actionRound?.id ?? null, counts, note: noteValue });
    await closeDayAction.execute({ counts, note: noteValue }, { signature });
  };

  const selectMovementKind = (nextKind: StockOperationKind) => {
    if (!summary) return;
    const truckId = truckLocations[0]?.id || '';
    const firstLocationId = summary.locations[0]?.id || '';

    setKind(nextKind);
    stockMovementAction.reset();

    if (nextKind === 'transfer') {
      const sourceId = truckId || firstLocationId;
      setFromLocationId(sourceId);
      setToLocationId(summary.locations.find((location) => location.id !== sourceId)?.id || '');
    } else {
      setFromLocationId(nextKind === 'return_to_factory' ? truckId : truckId || firstLocationId);
      setToLocationId('');
    }
  };

  if (loading) {
    return <p className="empty-text">กำลังรวมยอดสต๊อกทุกจุด...</p>;
  }
  if (!summary) {
    return <p className="error-text">{error ?? 'ไม่พบข้อมูลสต๊อก'}</p>;
  }
  const countedLocation = summary.locations.find((location) => location.id === countLocationId)
    ?? summary.locations[0];

  return (
    <div className="stock-control">
      <div className="panel-header">
        <div>
          <p className="eyebrow">{isRoundSnapshot ? 'Snapshot รอบปิด' : 'สต๊อกต่อเนื่องทั้งวัน'} · {summary.service_date}</p>
          <h3>{isRoundSnapshot ? 'สต๊อกทั้งวัน ณ เวลาปิดรอบ' : 'น้ำแข็งอยู่ที่ไหนตอนนี้'}</h3>
        </div>
        <span className={`status-badge ${isRoundSnapshot ? 'status-badge--success' : 'status-badge--neutral'}`}>
          {isRoundSnapshot ? 'ประวัติ · ดูอย่างเดียว' : `${summary.locations.length} จุด`}
        </span>
      </div>
      {isRoundSnapshot ? (
        <p className="muted">ยอดนี้หยุดที่ {summary.snapshot_at ? formatStockDateTime(summary.snapshot_at) : 'เวลาปิดรอบ'} และจะไม่เปลี่ยนตามรายการของรอบปัจจุบัน</p>
      ) : null}

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

      {!isRoundSnapshot ? (<>
      <form className="stock-movement-form" onSubmit={handleSubmit}>
        <div>
          <p className="eyebrow">บันทึกเหตุการณ์จริง</p>
          <h3>เคลื่อนย้ายสต๊อก</h3>
        </div>
        {!actionRound ? <p className="muted">วันที่นี้ยังไม่มีรอบส่ง จึงดูยอด ตรวจนับ และปิดวันได้ แต่ยังบันทึกการเคลื่อนย้ายระหว่างวันไม่ได้</p> : null}

        <div className="movement-kind-grid" role="radiogroup" aria-label="ประเภทรายการสต๊อก">
          {STOCK_OPERATION_KINDS.map((movementKind) => (
            <button
              aria-pressed={kind === movementKind}
              className={kind === movementKind ? 'choice-chip choice-chip--selected' : 'choice-chip'}
              key={movementKind}
              disabled={closeState?.is_closed}
              onClick={() => selectMovementKind(movementKind)}
              type="button"
            >
              {MOVEMENT_LABELS[movementKind]}
            </button>
          ))}
        </div>

        <div className="field-grid">
          <LocationSelect
            label="ต้นทาง"
            locations={kind === 'return_to_factory' ? truckLocations : summary.locations}
            onChange={setFromLocationId}
            value={fromLocationId}
          />
          {kind === 'transfer' ? (
            <LocationSelect
              label="ปลายทาง"
              locations={summary.locations.filter((location) => location.id !== fromLocationId)}
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
                  inputMode="decimal"
                  disabled={closeState?.is_closed}
                  min={0}
                  step={0.5}
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
            disabled={closeState?.is_closed}
            onChange={(event) => setNote(event.target.value)}
            placeholder={kind === 'damage' ? 'เช่น ถุงแตกหรือละลายระหว่างรอส่ง' : 'รายละเอียดที่ช่วยตรวจย้อนหลัง'}
            rows={2}
            value={note}
          />
        </label>

        {stockMovementAction.error ? <p className="error-text">{stockMovementAction.error}</p> : null}
        {stockMovementAction.success ? <p className="success-text">{stockMovementAction.success}</p> : null}
        {closeState?.is_closed ? <p className="muted">สต๊อกของวันนี้ปิดแล้ว รายการทั้งหมดเป็นประวัติอ่านอย่างเดียว</p> : null}
        <button className="primary-button" disabled={!actionRound || stockMovementAction.isSubmitting || closeState?.is_closed} type="submit">
          {closeState?.is_closed ? 'ปิดสต๊อกวันนี้แล้ว' : stockMovementAction.isSubmitting ? 'กำลังบันทึก...' : `ยืนยัน ${MOVEMENT_LABELS[kind]}`}
        </button>
      </form>

      <section className="stock-count-section">
        <div className="panel-header">
          <div>
            <p className="eyebrow">เมื่อพนักงานหรือรถเล็กกลับมา</p>
            <h3>นับยอดจริงและเทียบกับระบบ</h3>
          </div>
          <span className="status-badge status-badge--neutral">ไม่ปรับยอดอัตโนมัติ</span>
        </div>
        <p className="muted">ยอดนับนี้เป็นหลักฐานเปรียบเทียบเท่านั้น หากต้องคืนรถ โอนเข้าถัง หรือบันทึกเสียหาย ให้สร้างรายการเคลื่อนไหวจริงด้านบนต่อ</p>
        <form className="stock-movement-form" onSubmit={handleLocationCount}>
          <label>
            ผู้รับ / จุดที่กลับมารายงาน
            <select
              disabled={closeState?.is_closed}
              required
              value={countLocationId}
              onChange={(event) => setCountLocationId(event.target.value)}
            >
              {summary.locations.map((location) => (
                <option key={location.id} value={location.id}>{LOCATION_LABELS[location.kind]} · {location.name}</option>
              ))}
            </select>
          </label>
          <div className="field-grid field-grid--three">
            {countedLocation?.balances.map((balance) => {
              const actual = actualCounts[balance.ice_type_id] ?? 0;
              const variance = actual - balance.quantity;
              return (
                <label key={balance.ice_type_id}>
                  {balance.ice_type_name} · ระบบ {balance.quantity} {balance.unit}
                  <input
                    disabled={closeState?.is_closed}
                    min={0}
                    step={0.5}
                    type="number"
                    value={actual}
                    onChange={(event) => setActualCounts((current) => ({
                      ...current,
                      [balance.ice_type_id]: Math.max(0, Number(event.target.value) || 0),
                    }))}
                  />
                  <small className={variance === 0 ? 'success-text' : 'error-text'}>
                    {variance === 0 ? 'ยอดตรง' : `ส่วนต่าง ${variance > 0 ? '+' : ''}${variance}`}
                  </small>
                </label>
              );
            })}
          </div>
          <label>หมายเหตุส่วนต่าง (ถ้ามี)<textarea disabled={closeState?.is_closed} rows={2} value={countNote} onChange={(event) => setCountNote(event.target.value)} /></label>
          
          {locationCountAction.error ? <p className="error-text">{locationCountAction.error}</p> : null}
          {locationCountAction.success ? <p className="success-text">{locationCountAction.success}</p> : null}
          
          <button className="primary-button" disabled={locationCountAction.isSubmitting || closeState?.is_closed} type="submit">
            {locationCountAction.isSubmitting ? 'กำลังบันทึก...' : 'เก็บ snapshot ยอดนับจริง'}
          </button>
        </form>
        <div className="stock-ledger-list">
          {countHistory.slice(0, 6).map((snapshot) => (
            <article className="stock-ledger-item" key={snapshot.id}>
              <div className="panel-header"><strong>{snapshot.location_name}</strong><time>{formatStockTime(snapshot.counted_at)}</time></div>
              <small>{snapshot.items.map((item) => `${item.ice_type_name}: ระบบ ${item.system_quantity} / นับ ${item.actual_quantity} / ต่าง ${item.variance_quantity}`).join(' · ')}</small>
              <small>{snapshot.counted_by}{snapshot.note ? ` · ${snapshot.note}` : ''}</small>
            </article>
          ))}
          {countHistory.length === 0 ? <p className="empty-text">ยังไม่มี snapshot ยอดนับกลับของวันนี้</p> : null}
        </div>
      </section>

      <section className="daily-close-section">
        <div className="panel-header">
          <div>
            <p className="eyebrow">หลังจบทุกรอบของวัน</p>
            <h3>ตรวจนับและปิดสต๊อกสิ้นวัน</h3>
          </div>
          <span className={`status-badge ${closeState?.is_closed ? 'status-badge--success' : 'status-badge--neutral'}`}>
            {closeState?.is_closed ? 'ปิดแล้ว' : `เหลือ ${closeState?.open_round_count ?? 0} รอบเปิด`}
          </span>
        </div>

        {closeState?.is_closed ? (
          <div className="stack">
            <p className="success-text">ปิดโดย {closeState.closed_by ?? '-'} · {closeState.closed_at ? formatStockDateTime(closeState.closed_at) : '-'}</p>
            <p className="muted">ระบบเก็บยอดตามระบบ ยอดนับจริง และส่วนต่างไว้แล้ว พร้อมบันทึกการรวบรวมของทุกจุดและส่งยอดคงเหลือกลับโรงงานจนยอดทุกจุดเป็นศูนย์</p>
            <div className="stock-ledger-list">
              {closeState.counts.map((item) => (
                <article className="stock-ledger-item" key={closeCountKey(item.location_id, item.ice_type_id)}>
                  <strong>{item.location_name} · {item.ice_type_name}</strong>
                  <small>ระบบ {item.system_quantity} · นับจริง {item.actual_quantity} · ต่าง {item.variance_quantity > 0 ? '+' : ''}{item.variance_quantity} {item.unit}</small>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <form className="stock-movement-form" onSubmit={handleCloseDay}>
            <p className="muted">กรอกยอดนับจริงทุกจุด ระบบจะ snapshot ส่วนต่างโดยไม่เดาสาเหตุ จากนั้นรวบรวมยอดคงเหลือและบันทึกส่งคืนโรงงานใน transaction เดียว</p>
            <div className="daily-close-grid">
              {summary.locations.map((location) => (
                <section className="stock-location-card" key={location.id}>
                  <div><small>{LOCATION_LABELS[location.kind]} · {location.code}</small><h3>{location.name}</h3></div>
                  {location.balances.map((balance) => {
                    const key = closeCountKey(location.id, balance.ice_type_id);
                    const actual = closeCounts[key] ?? 0;
                    const variance = actual - balance.quantity;
                    return (
                      <label key={balance.ice_type_id}>
                        {balance.ice_type_name} · ระบบ {balance.quantity}
                        <input min={0} step={0.5} type="number" value={actual} onChange={(event) => setCloseCounts((current) => ({ ...current, [key]: Math.max(0, Number(event.target.value) || 0) }))} />
                        <small className={variance === 0 ? 'success-text' : 'error-text'}>{variance === 0 ? 'ยอดตรง' : `ต่าง ${variance > 0 ? '+' : ''}${variance}`}</small>
                      </label>
                    );
                  })}
                </section>
              ))}
            </div>
            <label>หมายเหตุปิดวัน (ถ้ามี)<textarea rows={2} value={closeNote} onChange={(event) => setCloseNote(event.target.value)} /></label>
            {closeState && closeState.open_round_count > 0 ? <p className="error-text">ต้องปิดรอบส่งที่เหลือ {closeState.open_round_count} รอบก่อน</p> : null}
            
            {closeDayAction.error ? <p className="error-text">{closeDayAction.error}</p> : null}
            {closeDayAction.success ? <p className="success-text">{closeDayAction.success}</p> : null}
            
            <button className="primary-button" disabled={closeDayAction.isSubmitting || !closeState || closeState.open_round_count > 0} type="submit">
              {closeDayAction.isSubmitting ? 'กำลังปิดสต๊อก...' : 'ยืนยันยอดจริง ส่งคืนโรงงาน และปิดวัน'}
            </button>
          </form>
        )}
      </section>
      </>) : null}

      <section className="stock-ledger">
        <div>
          <p className="eyebrow">{isRoundSnapshot ? 'ประวัติจนถึงเวลาปิดรอบ' : 'ประวัติล่าสุดของวัน'}</p>
          <h3>{isRoundSnapshot ? 'รายการก่อน Snapshot' : 'รายการที่ตรวจนับได้'}</h3>
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

function formatStockDateTime(value: string) {
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function closeCountKey(locationId: string, iceTypeId: string) {
  return `${locationId}:${iceTypeId}`;
}
