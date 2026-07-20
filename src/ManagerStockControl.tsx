import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './lib/supabase';
import { useRpcAction } from './hooks/useRpcAction';
import type {
  DailyStockCloseState,
  DeliveryRound,
  StockCountReadiness,
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
type TabKind = StockOperationKind | 'count';

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
  const [activeTab, setActiveTab] = useState<TabKind>('transfer');
  const [kind, setKind] = useState<StockOperationKind>('transfer');
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [quantities, setQuantities] = useState<QuantityDraft>({});
  const [note, setNote] = useState('');
  const [countLocationId, setCountLocationId] = useState('');
  const [actualCounts, setActualCounts] = useState<QuantityDraft>({});
  const [countNote, setCountNote] = useState('');
  const [countHistory, setCountHistory] = useState<StockCountSnapshot[]>([]);
  const [countReadiness, setCountReadiness] = useState<StockCountReadiness[]>([]);
  const [closeState, setCloseState] = useState<DailyStockCloseState | null>(null);
  const [closeNote, setCloseNote] = useState('');
  const [confirmSkipUncounted, setConfirmSkipUncounted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  const latestCounts = useMemo(() => {
    const map = new Map<string, StockCountSnapshot>();
    for (const readiness of countReadiness) {
      if (readiness.status === 'current' && readiness.snapshot) {
        map.set(readiness.location_id, readiness.snapshot);
      }
    }
    return map;
  }, [countReadiness]);

  const readinessByLocation = useMemo(
    () => new Map(countReadiness.map((readiness) => [readiness.location_id, readiness])),
    [countReadiness],
  );

  const uncountedLocations = useMemo(() => {
    if (!summary) return [];
    return summary.locations.filter((location) => !latestCounts.has(location.id));
  }, [summary, latestCounts]);

  const requestId = useRef(0);

  useEffect(() => {
    void loadSummary(serviceDate, round?.id ?? null);
  }, [round?.id, serviceDate]);

  useEffect(() => {
    setConfirmSkipUncounted(false);
  }, [serviceDate]);

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
    const truckId = truckLocations[0]?.id || '';
    const firstLocationId = summary.locations[0]?.id || '';
    if (kind === 'transfer') {
      const sourceId = truckId || firstLocationId;
      setFromLocationId(sourceId);
      setToLocationId(summary.locations.find((location) => location.id !== sourceId)?.id || '');
    } else {
      setFromLocationId(kind === 'return_to_factory' ? truckId : truckId || firstLocationId);
      setToLocationId('');
    }
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
  }, [summary, countLocationId, closeState?.is_closed]);

  async function loadSummary(requestedServiceDate: string, roundId: string | null) {
    if (!supabase) return;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    const [summaryResponse, countResponse, readinessResponse, closeResponse] = await Promise.all([
      supabase.rpc('get_stock_control_summary', {
        p_round_id: roundId,
        p_service_date: requestedServiceDate,
      }),
      supabase.rpc('get_location_count_history', {
        p_round_id: roundId,
        p_service_date: requestedServiceDate,
      }),
      supabase.rpc('get_daily_stock_count_readiness', {
        p_round_id: roundId,
        p_service_date: requestedServiceDate,
      }),
      supabase.rpc('get_daily_stock_close_state', {
        p_round_id: roundId,
        p_service_date: requestedServiceDate,
      }),
    ]);
    if (currentRequest !== requestId.current) return;

    const firstError = summaryResponse.error ?? countResponse.error ?? readinessResponse.error ?? closeResponse.error;
    if (firstError) {
      setError(firstError.message);
      setSummary(null);
      setSummaryRoundId(null);
    } else {
      setSummary(summaryResponse.data as StockControlSummary);
      setCountHistory((countResponse.data ?? []) as StockCountSnapshot[]);
      setCountReadiness((readinessResponse.data ?? []) as StockCountReadiness[]);
      setCloseState(closeResponse.data as DailyStockCloseState);
      setSummaryRoundId(roundId);
      setLoadedAt(new Date().toISOString());
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
      stockMovementAction.setError('ต้องมีรอบส่งของวันที่เลือกก่อนบันทึกรายการสต๊อก');
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
      return supabase.rpc('record_location_count', {
        p_round_id: actionRound?.id ?? null,
        p_service_date: serviceDate,
        p_location_id: countLocationId,
        p_counts: args.counts,
        p_note: args.note.trim() || null,
      });
    },
    {
      deps: [actionRound?.id, round?.id, serviceDate],
      successMessage: () => {
        const selectedLocation = summary?.locations.find((location) => location.id === countLocationId);
        return `บันทึกยอดนับจริงของ “${selectedLocation?.name ?? ''}” แล้ว`;
      },
      onSuccess: async () => {
        setCountNote('');
        await loadSummary(serviceDate, round?.id ?? null);
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
    async (args: { note: string; useSystemForUncounted: boolean }, idempotencyKey) => {
      if (!supabase) throw new Error('Supabase is not initialized');
      return supabase.rpc('close_daily_stock_from_latest_counts', {
        p_round_id: actionRound?.id ?? null,
        p_service_date: serviceDate,
        p_note: args.note.trim() || null,
        p_idempotency_key: idempotencyKey,
        p_use_system_for_uncounted: args.useSystemForUncounted,
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

    if (uncountedLocations.length > 0 && !confirmSkipUncounted) {
      closeDayAction.setError('กรุณายืนยันการปิดสต๊อกหากยังมีจุดที่ไม่ได้ตรวจนับ หรือทำการตรวจให้ครบก่อน');
      return;
    }

    const noteValue = closeNote.trim();
    const args = { note: noteValue, useSystemForUncounted: confirmSkipUncounted };

    const signature = JSON.stringify({ serviceDate, roundId: actionRound?.id ?? null, ...args });
    await closeDayAction.execute(args, { signature });
  };

  const selectMovementKind = (nextTab: TabKind) => {
    if (!summary) return;
    setActiveTab(nextTab);

    if (nextTab === 'count') {
      return;
    }

    const nextKind = nextTab as StockOperationKind;
    setKind(nextKind);
    stockMovementAction.reset();

    const truckId = truckLocations[0]?.id || '';
    const firstLocationId = summary.locations[0]?.id || '';

    if (nextKind === 'transfer') {
      const sourceId = truckId || firstLocationId;
      setFromLocationId(sourceId);
      setToLocationId(summary.locations.find((location) => location.id !== sourceId)?.id || '');
    } else {
      setFromLocationId(nextKind === 'return_to_factory' ? truckId : truckId || firstLocationId);
      setToLocationId('');
    }
  };

  if (loading && !summary) {
    return <p className="empty-text">กำลังรวมยอดสต๊อกทุกจุด...</p>;
  }
  if (!summary) {
    return <p className="error-text">{error ?? 'ไม่พบข้อมูลสต๊อก'}</p>;
  }
  const countedLocation = summary.locations.find((location) => location.id === countLocationId)
    ?? summary.locations[0];
  const requiresSource = true;
  const requiresDestination = kind === 'transfer';
  const sourceLocations = kind === 'return_to_factory' ? truckLocations : summary.locations;
  const destinationLocations = summary.locations.filter((location) => location.id !== fromLocationId);
  const stockTimestamp = isRoundSnapshot ? summary.snapshot_at : loadedAt;

  return (
    <div className="stock-control">
      <div className="stock-layout-panel">
        <div className="stock-layout-header">
          <h3 className="stock-layout-title">
            {isRoundSnapshot ? 'สต๊อกทั้งวัน ณ เวลาปิดรอบ' : 'สต๊อกปัจจุบันของวัน'}
          </h3>
          <div className="stock-layout-subtitle">
            <span>{isRoundSnapshot ? 'ข้อมูล ณ' : 'โหลดล่าสุด'} {stockTimestamp ? formatStockTime(stockTimestamp) : '-'} น.</span>
            <button
              aria-label="รีเฟรชข้อมูลสต๊อก"
              className="stock-refresh-button"
              disabled={loading}
              onClick={() => void loadSummary(serviceDate, round?.id ?? null)}
              type="button"
            >
              <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
            </button>
          </div>
        </div>

        {isRoundSnapshot ? (
          <p className="muted" style={{ marginBottom: 16 }}>ยอดนี้หยุดที่ {summary.snapshot_at ? formatStockDateTime(summary.snapshot_at) : 'เวลาปิดรอบ'} และจะไม่เปลี่ยนตามรายการของรอบปัจจุบัน</p>
        ) : null}

        <div className="stock-location-grid-custom">
          {summary.locations.map((location) => {
            const hasNegative = location.balances.some((balance) => balance.quantity < 0);
            return (
              <section className={`stock-location-card-custom ${hasNegative ? 'stock-location-card--warning' : ''}`} key={location.id}>
                <div className="stock-location-card-custom-header">
                  <div className="icon-circle">
                    {location.kind === 'truck' ? <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12v6a2 2 0 002 2h10a2 2 0 002-2v-6M9 16h6"/></svg> : location.name.charAt(0)}
                  </div>
                  {location.name}
                </div>
                <div className="stock-location-card-custom-body">
                  {location.balances.map((balance) => (
                    <div className="stock-balance-row" key={balance.ice_type_id}>
                      <span>{balance.ice_type_name}</span>
                      <strong className={`qty ${balance.quantity === 0 ? 'zero' : ''}`}>{balance.quantity}</strong>
                    </div>
                  ))}
                </div>
                {hasNegative ? <p className="error-text" style={{ marginTop: 8 }}>ยอดติดลบ</p> : null}
              </section>
            );
          })}
        </div>
      </div>

      {!isRoundSnapshot ? (
        <div className="stock-layout-panel">
          <div className="action-tabs">
            <button
              className={`action-tab ${activeTab === 'transfer' ? 'active' : ''}`}
              onClick={() => selectMovementKind('transfer')}
              type="button"
            >
              <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/></svg>
              โอนระหว่างจุด
            </button>

            <button
              className={`action-tab ${activeTab === 'damage' ? 'active' : ''}`}
              onClick={() => selectMovementKind('damage')}
              type="button"
            >
              <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 2.69l5.66 5.66a8 8 0 11-11.31 0z"/></svg>
              เสียหาย / ละลาย
            </button>
            <button
              className={`action-tab ${activeTab === 'count' ? 'active' : ''}`}
              onClick={() => selectMovementKind('count')}
              type="button"
            >
              <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/></svg>
              ตรวจนับจริง
            </button>
            <button
              className={`action-tab ${activeTab === 'return_to_factory' ? 'active' : ''}`}
              onClick={() => selectMovementKind('return_to_factory')}
              type="button"
            >
              <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M4 12h16m-6-6 6 6-6 6"/></svg>
              ส่งคืนโรงงาน
            </button>
          </div>

          {activeTab !== 'count' ? (
            <form onSubmit={handleSubmit}>
              <div className={`action-form-grid ${requiresSource && requiresDestination ? '' : 'action-form-grid--single'}`}>
                {requiresSource ? <div>
                  <LocationSelect
                    label="ต้นทาง (จาก)"
                    locations={sourceLocations}
                    onChange={setFromLocationId}
                    value={fromLocationId}
                  />
                </div> : null}
                {requiresSource && requiresDestination ? <div className="swap-icon-container">
                  <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/></svg>
                </div> : null}
                {requiresDestination ? <div>
                  <LocationSelect
                    label="ปลายทาง (ไปยัง)"
                    locations={destinationLocations}
                    onChange={setToLocationId}
                    value={toLocationId}
                  />
                </div> : null}
              </div>

              <div style={{ marginTop: 24 }}>
                <p className="eyebrow" style={{ color: '#1a2332', fontWeight: 600, fontSize: '0.95rem', marginBottom: 12 }}>ชนิดและจำนวน</p>
                <div className="inputs-2col">
                  {iceTypes.map((ice) => (
                    <div className="input-row" key={ice.ice_type_id}>
                      <span>{ice.ice_type_name}</span>
                      <div className="input-wrapper">
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
                          value={quantities[ice.ice_type_id] || ''}
                          placeholder="0"
                        />
                        <small>{ice.unit}</small>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 24 }}>
                <p className="eyebrow" style={{ color: '#1a2332', fontWeight: 600, fontSize: '0.95rem', marginBottom: 12 }}>หมายเหตุ (ถ้ามี)</p>
                <textarea
                  disabled={closeState?.is_closed}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={kind === 'damage' ? 'เช่น ถุงแตกหรือละลายระหว่างรอส่ง' : 'ระบุรายละเอียดเพิ่มเติม (ถ้ามี)'}
                  required={kind === 'damage'}
                  rows={2}
                  value={note}
                  style={{ width: '100%' }}
                />
              </div>

              {stockMovementAction.error ? <p className="error-text" style={{ marginTop: 16 }}>{stockMovementAction.error}</p> : null}
              {stockMovementAction.success ? <p className="success-text" style={{ marginTop: 16 }}>{stockMovementAction.success}</p> : null}

              <div className="submit-btn-container">
                <button className="primary-button" disabled={!actionRound || stockMovementAction.isSubmitting || closeState?.is_closed} type="submit">
                  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
                  {closeState?.is_closed ? 'ปิดสต๊อกวันนี้แล้ว' : stockMovementAction.isSubmitting ? 'กำลังบันทึก...' : `ยืนยัน ${MOVEMENT_LABELS[kind]}`}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleLocationCount}>
              <div style={{ marginBottom: 24 }}>
                <LocationSelect
                  label="จุดที่ต้องการตรวจนับ"
                  locations={summary.locations}
                  onChange={setCountLocationId}
                  value={countLocationId}
                />
              </div>
              <p className="eyebrow" style={{ color: '#1a2332', fontWeight: 600, fontSize: '0.95rem', marginBottom: 12 }}>ตรวจนับและเปรียบเทียบ</p>
              <div className="inputs-2col">
                {countedLocation?.balances.map((balance) => {
                  const actual = actualCounts[balance.ice_type_id] ?? 0;
                  const variance = actual - balance.quantity;
                  return (
                    <div className="input-row" key={balance.ice_type_id}>
                      <span>{balance.ice_type_name} (ระบบ {balance.quantity})</span>
                      <div className="input-wrapper" style={{ flexDirection: 'column', alignItems: 'flex-end', width: 'auto' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input
                            disabled={closeState?.is_closed}
                            min={0}
                            step={0.5}
                            type="number"
                            value={actual || ''}
                            placeholder="0"
                            onChange={(event) => setActualCounts((current) => ({
                              ...current,
                              [balance.ice_type_id]: Math.max(0, Number(event.target.value) || 0),
                            }))}
                            style={{ width: 100 }}
                          />
                          <small>{balance.unit}</small>
                        </div>
                        <small className={variance === 0 ? 'success-text' : 'error-text'} style={{ width: 'auto', textAlign: 'right' }}>
                          {variance === 0 ? 'ยอดตรง' : `ต่าง ${variance > 0 ? '+' : ''}${variance}`}
                        </small>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 24 }}>
                <p className="eyebrow" style={{ color: '#1a2332', fontWeight: 600, fontSize: '0.95rem', marginBottom: 12 }}>หมายเหตุ (ถ้ามี)</p>
                <textarea disabled={closeState?.is_closed} rows={2} value={countNote} onChange={(event) => setCountNote(event.target.value)} style={{ width: '100%' }} />
              </div>

              {locationCountAction.error ? <p className="error-text" style={{ marginTop: 16 }}>{locationCountAction.error}</p> : null}
              {locationCountAction.success ? <p className="success-text" style={{ marginTop: 16 }}>{locationCountAction.success}</p> : null}

              <div className="submit-btn-container">
                <button className="primary-button" disabled={locationCountAction.isSubmitting || closeState?.is_closed} type="submit">
                  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/></svg>
                  {locationCountAction.isSubmitting ? 'กำลังบันทึก...' : 'บันทึกยอดนับจริง'}
                </button>
              </div>

              <div className="stock-ledger-list" style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid #e1e7ef' }}>
                <p className="eyebrow" style={{ color: '#1a2332', fontWeight: 600, fontSize: '0.95rem', marginBottom: 16 }}>ประวัติการตรวจนับวันนี้</p>
                {countHistory.slice(0, 6).map((snapshot) => (
                  <article className="stock-ledger-item" key={snapshot.id}>
                    <div className="panel-header"><strong>{snapshot.location_name}</strong><time>{formatStockTime(snapshot.counted_at)}</time></div>
                    <small>{snapshot.items.map((item) => `${item.ice_type_name}: ระบบ ${item.system_quantity} / นับ ${item.actual_quantity} / ต่าง ${item.variance_quantity}`).join(' · ')}</small>
                    <small>{snapshot.counted_by}{snapshot.note ? ` · ${snapshot.note}` : ''}</small>
                  </article>
                ))}
                {countHistory.length === 0 ? <p className="empty-text">ยังไม่มี snapshot ยอดนับกลับของวันนี้</p> : null}
              </div>
            </form>
          )}
        </div>
      ) : null}

      {!isRoundSnapshot ? (
        <section className="daily-close-section" style={{ marginTop: 24 }}>
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
              <p className="muted">ตรวจสอบผลการตรวจนับล่าสุดของแต่ละจุด ระบบจะรวมยอดเพื่อปิดสต๊อกและส่งคืนโรงงานตามยอดนี้</p>

              <div className="table-responsive" style={{ margin: '16px 0', border: '1px solid #e1e7ef', borderRadius: 8, overflow: 'hidden' }}>
                <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem' }}>
                  <thead style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e1e7ef' }}>
                    <tr>
                      <th style={{ padding: '12px 16px', color: '#64748b', fontWeight: 600 }}>จุด</th>
                      <th style={{ padding: '12px 16px', color: '#64748b', fontWeight: 600 }}>สถานะ</th>
                      <th style={{ padding: '12px 16px', color: '#64748b', fontWeight: 600 }}>ผลตรวจ</th>
                    </tr>
                  </thead>
                  <tbody style={{ backgroundColor: '#fff' }}>
                    {summary.locations.map((location) => {
                      const readiness = readinessByLocation.get(location.id);
                      const latest = readiness?.snapshot;
                      let statusStr = 'ยังไม่ตรวจ';
                      let statusColor = '#64748b';
                      let resultStr = '—';
                      let resultColor = '#64748b';

                      if (readiness?.status === 'stale' && latest) {
                        statusStr = `ต้องตรวจใหม่ · ตรวจล่าสุด ${formatStockTime(latest.counted_at)} น.`;
                        statusColor = '#c2410c';
                        resultStr = 'มีรายการสต๊อกหลังการตรวจ';
                        resultColor = '#c2410c';
                      } else if (readiness?.status === 'current' && latest) {
                        statusStr = `ตรวจแล้ว ${formatStockTime(latest.counted_at)} น.`;
                        statusColor = '#0f172a';

                        let totalVariance = 0;
                        const variances: string[] = [];
                        latest.items.forEach(item => {
                          totalVariance += item.variance_quantity;
                          if (item.variance_quantity !== 0) {
                            variances.push(`${item.ice_type_name} ${item.variance_quantity > 0 ? '+' : ''}${item.variance_quantity}`);
                          }
                        });

                        if (totalVariance === 0 && variances.length === 0) {
                          resultStr = 'ตรง';
                          resultColor = '#10b981';
                        } else {
                          resultStr = variances.join(', ');
                          resultColor = '#ef4444';
                        }
                      }

                      return (
                        <tr key={location.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '12px 16px', fontWeight: 500 }}>{location.name}</td>
                          <td style={{ padding: '12px 16px', color: statusColor }}>{statusStr}</td>
                          <td style={{ padding: '12px 16px', color: resultColor, fontWeight: 500 }}>{resultStr}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
                {uncountedLocations.length > 0 && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setActiveTab('count');
                      setCountLocationId(uncountedLocations[0].id);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                  >
                    <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" style={{ marginRight: 6, verticalAlign: 'text-bottom' }}><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/></svg>
                    ตรวจจุดที่ยังไม่ครบหรือข้อมูลเก่า ({uncountedLocations.length})
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    const ledger = document.querySelector('.stock-ledger');
                    if (ledger) ledger.scrollIntoView({ behavior: 'smooth' });
                  }}
                >
                  <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" style={{ marginRight: 6, verticalAlign: 'text-bottom' }}><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                  ดูประวัติการทำรายการ
                </button>
              </div>

              {uncountedLocations.length > 0 && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px', backgroundColor: '#fff7ed', border: '1px solid #fdba74', borderRadius: 8, marginBottom: 16 }}>
                  <input
                    type="checkbox"
                    checked={confirmSkipUncounted}
                    onChange={(event) => setConfirmSkipUncounted(event.target.checked)}
                  />
                  <span style={{ color: '#c2410c', fontSize: '0.9rem', fontWeight: 500 }}>
                    หัวหน้างานยืนยัน: ปิดวันโดยใช้ยอดตามระบบสำหรับจุดที่ยังไม่มีผลตรวจปัจจุบัน ({uncountedLocations.length} จุด)
                  </span>
                </label>
              )}

              <label>เหตุผลหรือหมายเหตุปิดวัน (ถ้ามี)<textarea rows={2} value={closeNote} onChange={(event) => setCloseNote(event.target.value)} /></label>
              {closeState && closeState.open_round_count > 0 ? <p className="error-text">ต้องปิดรอบส่งที่เหลือ {closeState.open_round_count} รอบก่อน</p> : null}

              {closeDayAction.error ? <p className="error-text">{closeDayAction.error}</p> : null}
              {closeDayAction.success ? <p className="success-text">{closeDayAction.success}</p> : null}

              <button
                className="primary-button"
                disabled={closeDayAction.isSubmitting || !closeState || closeState.open_round_count > 0 || (uncountedLocations.length > 0 && !confirmSkipUncounted)}
                type="submit"
              >
                {closeDayAction.isSubmitting ? 'กำลังปิดสต๊อก...' : 'ปิดสต๊อกวันนี้'}
              </button>
            </form>
          )}
        </section>
      ) : null}

      <section className="stock-ledger" style={{ marginTop: 24 }}>
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
