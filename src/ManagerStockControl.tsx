import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCircle,
  Cube,
  Info,
  Minus,
  Plus,
  Snowflake,
  Trash,
  Truck,
  UserCircle,
  Warning,
} from '@phosphor-icons/react';
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
  StockCountVarianceReview,
} from './types/app';

import { StockCountPanel } from './features/stock-control/components/StockCountPanel';
import { StockVarianceReviewModal } from './features/stock-control/components/StockVarianceReviewModal';
import { StockCloseSummaryPanel } from './features/stock-control/components/StockCloseSummaryPanel';

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
  demoSummary,
}: {
  operationRound: DeliveryRound | null;
  round: DeliveryRound | null;
  serviceDate: string;
  demoSummary?: StockControlSummary;
}) {
  const isRoundSnapshot = round?.status === 'closed';
  const actionRound = operationRound ?? round;
  const [summary, setSummary] = useState<StockControlSummary | null>(demoSummary ?? null);
  const [summaryRoundId, setSummaryRoundId] = useState<string | null>(demoSummary ? round?.id ?? null : null);
  const [activeTab, setActiveTab] = useState<TabKind>('transfer');
  const [kind, setKind] = useState<StockOperationKind>('transfer');
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [quantities, setQuantities] = useState<QuantityDraft>({});
  const [note, setNote] = useState('');
  const [countLocationId, setCountLocationId] = useState('');
  const [countHistory, setCountHistory] = useState<StockCountSnapshot[]>([]);
  const [countReadiness, setCountReadiness] = useState<StockCountReadiness[]>([]);
  const [closeState, setCloseState] = useState<DailyStockCloseState | null>(null);
  const [closeNote, setCloseNote] = useState('');
  const [confirmSkipUncounted, setConfirmSkipUncounted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  const [varianceReviews, setVarianceReviews] = useState<StockCountVarianceReview[]>([]);
  const [isVarianceModalOpen, setIsVarianceModalOpen] = useState(false);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

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
    return summary.locations.filter((location) => (
      location.holds_inventory === true
      && location.requires_daily_count === true
      && !latestCounts.has(location.id)
    ));
  }, [summary, latestCounts]);

  const requestId = useRef(0);

  useEffect(() => {
    if (demoSummary) return;
    void loadSummary(serviceDate, round?.id ?? null);
  }, [demoSummary, round?.id, serviceDate]);

  useEffect(() => {
    setConfirmSkipUncounted(false);
  }, [serviceDate]);

  const truckLocations = useMemo(
    () => summary?.locations.filter((location) => (
      location.kind === 'truck' && location.holds_inventory === true
    )) ?? [],
    [summary],
  );

  const stockHolderLocations = useMemo(
    () => summary?.locations.filter((location) => location.holds_inventory === true) ?? [],
    [summary],
  );

  const transferSourceLocations = useMemo(
    () => stockHolderLocations.filter((source) => (
      stockHolderLocations.some((destination) => isAllowedTransferDestination(source, destination))
    )),
    [stockHolderLocations],
  );

  const iceTypes = summary?.locations[0]?.balances ?? [];

  useEffect(() => {
    if (!summary) return;
    setQuantities((current) =>
      Object.fromEntries(iceTypes.map((ice) => [ice.ice_type_id, current[ice.ice_type_id] ?? 0])),
    );
    const truckId = truckLocations.find((location) => location.is_courier_source === true)?.id
      || truckLocations[0]?.id
      || '';
    const transferSourceId = transferSourceLocations.find((location) => (
      location.kind === 'truck' && location.is_courier_source === true
    ))?.id || transferSourceLocations[0]?.id || '';
    const firstLocationId = stockHolderLocations[0]?.id || '';
    if (kind === 'transfer') {
      setFromLocationId((current) => (
        transferSourceLocations.some((location) => location.id === current)
          ? current
          : transferSourceId
      ));
      setToLocationId((current) => (
        stockHolderLocations.some((location) => location.id === current) ? current : ''
      ));
    } else {
      setFromLocationId(kind === 'return_to_factory' ? truckId : truckId || firstLocationId);
      setToLocationId('');
    }
  }, [summary]);

  useEffect(() => {
    if (!summary) return;
    const selectedLocation = stockHolderLocations.find((location) => location.id === countLocationId)
      ?? stockHolderLocations.find((location) => location.kind !== 'truck')
      ?? stockHolderLocations[0];
    setCountLocationId(selectedLocation?.id ?? '');
  }, [summary, countLocationId, closeState?.is_closed]);

  async function loadSummary(requestedServiceDate: string, roundId: string | null) {
    if (!supabase) return;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    const [summaryResponse, countResponse, readinessResponse, closeResponse, reviewsResponse] = await Promise.all([
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
      supabase.rpc('get_stock_count_variance_reviews', {
        p_service_date: requestedServiceDate,
      }),
    ]);
    if (currentRequest !== requestId.current) return;

    const firstError = summaryResponse.error
      ?? countResponse.error
      ?? readinessResponse.error
      ?? closeResponse.error
      ?? reviewsResponse.error;
    if (firstError) {
      setError(firstError.message);
      setSummary(null);
      setSummaryRoundId(null);
    } else {
      setSummary(summaryResponse.data as StockControlSummary);
      setCountHistory((countResponse.data ?? []) as StockCountSnapshot[]);
      setCountReadiness((readinessResponse.data ?? []) as StockCountReadiness[]);
      setCloseState(closeResponse.data as DailyStockCloseState);
      setVarianceReviews((reviewsResponse.data ?? []) as StockCountVarianceReview[]);
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
      if (demoSummary) return { data: { preview: true }, error: null };
      if (!supabase) throw new Error('Supabase is not initialized');

      return supabase.rpc('record_stock_transfer_v2', {
        p_service_date: serviceDate,
        p_purpose: args.kind === 'transfer' ? 'auto' : args.kind,
        p_from_location_id: args.fromLocationId || null,
        p_to_location_id: args.kind === 'transfer' ? args.toLocationId || null : null,
        p_items: args.items,
        p_note: args.note.trim() || null,
        p_idempotency_key: idempotencyKey,
      });
    },
    {
      deps: [actionRound?.id, demoSummary, round?.id, serviceDate],
      successMessage: (_, args) => `บันทึก “${MOVEMENT_LABELS[args.kind]}” แล้ว`,
      onSuccess: async () => {
        if (!demoSummary) {
          await loadSummary(serviceDate, round?.id ?? null);
        }
        setQuantities({});
        setToLocationId('');
        setNote('');
      },
    }
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isRoundSnapshot) {
      stockMovementAction.setError('งานวันนี้ปิดแล้วและเป็นประวัติอ่านอย่างเดียว');
      return;
    }
    if (!actionRound) {
      stockMovementAction.setError('ต้องเริ่มงานวันนี้ก่อนบันทึกรายการสต๊อก');
      return;
    }
    if (!demoSummary && (!supabase || summaryRoundId !== (round?.id ?? null))) {
      stockMovementAction.setError('ข้อมูลสต๊อกยังโหลดไม่ครบ กรุณารอสักครู่แล้วลองใหม่');
      return;
    }
    if (closeState?.is_closed) {
      stockMovementAction.setError('สต๊อกของวันนี้ปิดแล้ว ไม่สามารถเพิ่มรายการเคลื่อนไหวได้');
      return;
    }

    const movementBalances = summary?.locations.find((location) => location.id === fromLocationId)?.balances
      ?? iceTypes;
    const items = movementBalances
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
    if (kind === 'transfer' && !transferSourceLocations.some((location) => location.id === fromLocationId)) {
      stockMovementAction.setError('จุดต้นทางนี้ไม่รองรับปลายทางที่เลือก กรุณาเลือกต้นทางใหม่');
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
    async (args: { counts: any[]; note: string }, idempotencyKey) => {
      if (!supabase) throw new Error('Supabase is not initialized');
      return supabase.rpc('record_location_count_v2', {
        p_service_date: serviceDate,
        p_location_id: countLocationId,
        p_counts: args.counts,
        p_note: args.note.trim() || null,
        p_idempotency_key: idempotencyKey,
      });
    },
    {
      deps: [actionRound?.id, round?.id, serviceDate],
      successMessage: () => {
        const selectedLocation = summary?.locations.find((location) => location.id === countLocationId);
        return `บันทึกยอดนับจริงของ “${selectedLocation?.name ?? ''}” แล้ว`;
      },
      onSuccess: async () => {
        await loadSummary(serviceDate, round?.id ?? null);
      },
    }
  );

  const handleReviewSubmit = async (reviewId: string, status: 'approved' | 'rejected', reviewNote: string) => {
    if (!supabase) return;
    setReviewSubmitting(true);
    setReviewError(null);
    const { error: reviewError } = await supabase.rpc('approve_stock_count_variance', {
      p_review_id: reviewId,
      p_status: status,
      p_note: reviewNote.trim() || null,
    });
    if (reviewError) {
      setReviewError(reviewError.message);
    } else {
      const { data: reviewsData, error: reloadError } = await supabase.rpc(
        'get_stock_count_variance_reviews',
        { p_service_date: serviceDate },
      );
      if (reloadError) {
        setReviewError(reloadError.message);
      } else {
        setVarianceReviews((reviewsData ?? []) as StockCountVarianceReview[]);
        if (status === 'rejected') {
          const rejectedReview = varianceReviews.find((review) => review.id === reviewId);
          setReviewError('ปฏิเสธยอดแล้ว กรุณาตรวจนับจุดนั้นใหม่ก่อนปิดสต๊อก');
          if (rejectedReview) setCountLocationId(rejectedReview.location_id);
        }
      }
    }
    setReviewSubmitting(false);
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
      closeDayAction.setError('ต้องจัดการรายการค้างเดิมทั้งหมดก่อนปิดสต๊อกสิ้นวัน');
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

    const truckId = truckLocations.find((location) => location.is_courier_source === true)?.id
      || truckLocations[0]?.id
      || '';
    const transferSourceId = transferSourceLocations.find((location) => (
      location.kind === 'truck' && location.is_courier_source === true
    ))?.id || transferSourceLocations[0]?.id || '';
    const firstLocationId = stockHolderLocations[0]?.id || '';

    if (nextKind === 'transfer') {
      setFromLocationId(transferSourceId);
      setToLocationId('');
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
  const countedLocation = stockHolderLocations.find((location) => location.id === countLocationId)
    ?? stockHolderLocations[0];
  const requiresSource = true;
  const requiresDestination = kind === 'transfer';
  const sourceLocations = kind === 'return_to_factory'
    ? truckLocations
    : kind === 'transfer'
      ? transferSourceLocations
      : stockHolderLocations;
  const selectedSource = sourceLocations.find((location) => location.id === fromLocationId);
  const destinationLocations = kind === 'transfer'
    ? stockHolderLocations.filter((location) => isAllowedTransferDestination(selectedSource, location))
    : [];
  const stockTimestamp = isRoundSnapshot ? summary.snapshot_at : loadedAt;
  const selectedRecipient = destinationLocations.find((location) => location.id === toLocationId) ?? null;
  const recipientLocations = destinationLocations;
  const movementIceTypes = selectedSource?.balances ?? iceTypes;
  const cartItems = movementIceTypes.filter((ice) => (quantities[ice.ice_type_id] ?? 0) > 0);
  const cartTotal = cartItems.reduce((total, ice) => total + (quantities[ice.ice_type_id] ?? 0), 0);

  const updateQuantity = (iceTypeId: string, value: number, available: number) => {
    const nextValue = Math.min(available, Math.max(0, Math.round(value * 2) / 2));
    setQuantities((current) => ({ ...current, [iceTypeId]: nextValue }));
    stockMovementAction.reset();
  };

  const pendingReviewsCount = varianceReviews.filter((r) => r.status === 'pending').length;

  return (
    <div className="stock-control">
      {/* V2 Stock Variance Review Alert */}
      {pendingReviewsCount > 0 && !isRoundSnapshot && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 flex justify-between items-center shadow-sm" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Warning size={20} color="#d97706" weight="fill" />
            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#92400e' }}>
              คุณมียอดเบี่ยงเบนรอตรวจสอบ {pendingReviewsCount} รายการ
            </span>
          </div>
          <button
            type="button"
            onClick={() => setIsVarianceModalOpen(true)}
            style={{ padding: '6px 12px', backgroundColor: '#d97706', border: 'none', color: '#fff', borderRadius: 6, fontSize: '0.75rem', fontWeight: 'bold', cursor: 'pointer' }}
          >
            เปิดตรวจสอบ
          </button>
        </div>
      )}

      {/* V2 Stock Variance Review Modal */}
      <StockVarianceReviewModal
        isOpen={isVarianceModalOpen}
        onClose={() => setIsVarianceModalOpen(false)}
        reviews={varianceReviews}
        onReviewSubmit={handleReviewSubmit}
        loading={reviewSubmitting}
        error={reviewError}
      />

      {activeTab !== 'transfer' ? <div className="stock-layout-panel">
        <div className="stock-layout-header">
          <h3 className="stock-layout-title">
            {isRoundSnapshot ? 'สต๊อกทั้งวัน ณ เวลาปิดงาน' : 'สต๊อกปัจจุบันของวัน'}
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
          <p className="muted" style={{ marginBottom: 16 }}>ยอดนี้หยุดที่ {summary.snapshot_at ? formatStockDateTime(summary.snapshot_at) : 'เวลาปิดงาน'} และจะไม่เปลี่ยนตามรายการปัจจุบัน</p>
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
                  {formatHolderName(location)}
                </div>
                {!isRoundSnapshot && location.kind === 'work_site' && (location.assigned_employees?.length ?? 0) > 0 ? (
                  <p className="stock-location-responsibility">ผู้ดูแล: {location.assigned_employees?.map(formatEmployeeName).join(', ')}</p>
                ) : null}
                {!isRoundSnapshot && location.assigned_employee ? (
                  <p className="stock-location-responsibility">ผู้รับผิดชอบ: {formatLocationResponsibility(location)}</p>
                ) : null}
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
      </div> : null}

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

          {activeTab === 'transfer' ? (
            <form className="holder-pos" onSubmit={handleSubmit}>
              <div className="holder-pos__main">
                <section className="holder-pos__section" aria-labelledby="holder-step-title">
                  <div className="holder-pos__section-heading">
                    <span>1.</span>
                    <h3 id="holder-step-title">เลือกต้นทางและจุดรับสต๊อก</h3>
                  </div>
                  <div className="holder-pos__source-control">
                    <Truck aria-hidden="true" size={18} weight="fill" />
                    <LocationSelect
                      label="ต้นทาง (จาก)"
                      locations={sourceLocations}
                      onChange={(nextSourceId) => {
                        setFromLocationId(nextSourceId);
                        setToLocationId((current) => current === nextSourceId ? '' : current);
                        setQuantities({});
                        stockMovementAction.reset();
                      }}
                      value={fromLocationId}
                    />
                  </div>

                  <div className="holder-card-grid">
                    {recipientLocations.map((location) => {
                      const isSelected = location.id === toLocationId;
                      const totalBalance = location.balances.reduce((total, balance) => total + balance.quantity, 0);
                      return (
                        <button
                          aria-pressed={isSelected}
                          className={`holder-card ${isSelected ? 'holder-card--selected' : ''}`}
                          key={location.id}
                          onClick={() => {
                            setToLocationId(location.id);
                            stockMovementAction.reset();
                          }}
                          type="button"
                        >
                          {isSelected ? <CheckCircle className="holder-card__check" size={21} weight="fill" /> : null}
                          <span className="holder-card__avatar" aria-hidden="true">
                            <UserCircle size={48} weight="duotone" />
                          </span>
                          <span className="holder-card__identity">
                            <strong>{formatHolderName(location)}</strong>
                            {location.assigned_employee ? <small>ผู้รับผิดชอบ: {formatEmployeeName(location.assigned_employee)}</small> : null}
                            {(location.assigned_work_sites?.length ?? 0) > 0 ? <small>{location.assigned_work_sites?.map((site) => site.name).join(', ')}</small> : null}
                          </span>
                          <span className={`holder-card__balance ${totalBalance === 0 ? 'holder-card__balance--empty' : ''}`}>
                            คงเหลือที่จุดรับ <strong>{formatStockQuantity(totalBalance)}</strong> หน่วย
                          </span>
                        </button>
                      );
                    })}
                    {recipientLocations.length === 0 ? (
                      <p className="holder-pos__empty">ยังไม่มีจุดรับสต๊อกที่พร้อมรับสินค้า</p>
                    ) : null}
                  </div>

                  <div className="holder-pos__return-action">
                    <button
                      className="holder-pos__return-btn"
                      type="button"
                      onClick={() => selectMovementKind('return_to_factory')}
                    >
                      <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14l-5-5 5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/></svg>
                      คืนของ
                    </button>
                  </div>
                </section>

                <section className="holder-pos__section" aria-labelledby="product-step-title">
                  <div className="holder-pos__section-heading">
                    <span>2.</span>
                    <h3 id="product-step-title">เลือกชนิดและจำนวน</h3>
                  </div>
                  <div className="product-card-grid">
                    {movementIceTypes.map((ice, index) => {
                      const quantity = quantities[ice.ice_type_id] ?? 0;
                      const selected = quantity > 0;
                      const ProductIcon = index % 2 === 0 ? Cube : Snowflake;
                      return (
                        <article className={`product-quantity-card ${selected ? 'product-quantity-card--selected' : ''}`} key={ice.ice_type_id}>
                          {selected ? <CheckCircle className="product-quantity-card__check" size={21} weight="fill" /> : null}
                          <div className="product-quantity-card__header">
                            <span className="product-quantity-card__icon" aria-hidden="true"><ProductIcon size={37} weight="duotone" /></span>
                            <span>
                              <strong>{ice.ice_type_name}</strong>
                              <small>บนรถ {formatStockQuantity(ice.quantity)} {ice.unit}</small>
                            </span>
                          </div>
                          <div className="quantity-stepper">
                            <button
                              aria-label={`ลด ${ice.ice_type_name}`}
                              disabled={quantity <= 0 || closeState?.is_closed}
                              onClick={() => updateQuantity(ice.ice_type_id, quantity - 0.5, ice.quantity)}
                              type="button"
                            >
                              <Minus size={18} weight="bold" />
                            </button>
                            <input
                              aria-label={`จำนวน ${ice.ice_type_name}`}
                              disabled={closeState?.is_closed}
                              inputMode="decimal"
                              max={ice.quantity}
                              min={0}
                              onChange={(event) => updateQuantity(ice.ice_type_id, Number(event.target.value) || 0, ice.quantity)}
                              placeholder="0"
                              step={0.5}
                              type="number"
                              value={quantity || ''}
                            />
                            <button
                              aria-label={`เพิ่ม ${ice.ice_type_name}`}
                              disabled={quantity >= ice.quantity || closeState?.is_closed}
                              onClick={() => updateQuantity(ice.ice_type_id, quantity + 0.5, ice.quantity)}
                              type="button"
                            >
                              <Plus size={18} weight="bold" />
                            </button>
                          </div>
                          <div className="quantity-quick-actions" aria-label={`ปุ่มลัด ${ice.ice_type_name}`}>
                            {[1, 5, 10].map((amount) => (
                              <button
                                disabled={quantity >= ice.quantity || closeState?.is_closed}
                                key={amount}
                                onClick={() => updateQuantity(ice.ice_type_id, quantity + amount, ice.quantity)}
                                type="button"
                              >
                                +{amount}
                              </button>
                            ))}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>

                <label className="holder-pos__note">
                  <span>หมายเหตุเพิ่มเติม (ถ้ามี)</span>
                  <textarea
                    disabled={closeState?.is_closed}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="ระบุหมายเหตุเพิ่มเติม..."
                    rows={3}
                    value={note}
                  />
                </label>
              </div>

              <aside className="holder-cart" aria-labelledby="cart-title">
                <h3 id="cart-title">3. สรุปรายการเบิก</h3>
                {selectedRecipient ? (
                  <div className="holder-cart__recipient">
                    <UserCircle aria-hidden="true" size={50} weight="duotone" />
                    <span>
                      <small>กำลังโอนไปยัง:</small>
                      <strong>{formatHolderName(selectedRecipient)}</strong>
                      {selectedRecipient.assigned_employee ? <small>ผู้รับผิดชอบ: {formatEmployeeName(selectedRecipient.assigned_employee)}</small> : null}
                      {(selectedRecipient.assigned_work_sites?.length ?? 0) > 0 ? <small>{selectedRecipient.assigned_work_sites?.map((site) => site.name).join(', ')}</small> : null}
                    </span>
                  </div>
                ) : (
                  <div className="holder-cart__placeholder">เลือกจุดรับสต๊อกเพื่อเริ่มรายการ</div>
                )}

                <div className="holder-cart__items" aria-live="polite">
                  {cartItems.map((ice, index) => {
                    const ProductIcon = index % 2 === 0 ? Cube : Snowflake;
                    return (
                      <div className="holder-cart__item" key={ice.ice_type_id}>
                        <ProductIcon aria-hidden="true" size={31} weight="duotone" />
                        <span>{ice.ice_type_name}</span>
                        <strong>{formatStockQuantity(quantities[ice.ice_type_id] ?? 0)} <small>{ice.unit}</small></strong>
                      </div>
                    );
                  })}
                  {cartItems.length === 0 ? <p>ยังไม่ได้เลือกสินค้า</p> : null}
                </div>

                <div className="holder-cart__totals">
                  <span>รวมรายการ <strong>{cartItems.length} ชนิด</strong></span>
                  <span>รวมจำนวน <strong>{formatStockQuantity(cartTotal)} หน่วย</strong></span>
                </div>

                <div className="holder-cart__notice">
                  <Info aria-hidden="true" size={21} weight="fill" />
                  <span>หลังยืนยัน ระบบจะตัดจาก {selectedSource?.name ?? 'รถหลัก'} และเพิ่มเข้าสู่สต๊อกของ {selectedRecipient ? formatHolderName(selectedRecipient) : 'ผู้รับ'} ทันที</span>
                </div>

                {stockMovementAction.error ? <p className="holder-cart__feedback error-text" role="alert">{stockMovementAction.error}</p> : null}
                {stockMovementAction.success ? <p className="holder-cart__feedback success-text" role="status">{stockMovementAction.success}</p> : null}

                <button
                  aria-label="ยืนยัน โอนระหว่างจุด"
                  className="primary-button holder-cart__confirm"
                  disabled={!actionRound || !selectedRecipient || cartItems.length === 0 || stockMovementAction.isSubmitting || closeState?.is_closed}
                  type="submit"
                >
                  <Check size={19} weight="bold" />
                  {closeState?.is_closed
                    ? 'ปิดสต๊อกวันนี้แล้ว'
                    : stockMovementAction.isSubmitting
                      ? 'กำลังบันทึก...'
                      : `ยืนยันโอนไป${selectedRecipient ? formatHolderName(selectedRecipient) : 'จุดรับ'}`}
                </button>
                <button
                  className="holder-cart__clear"
                  disabled={cartItems.length === 0 && !selectedRecipient}
                  onClick={() => {
                    setQuantities(Object.fromEntries(movementIceTypes.map((ice) => [ice.ice_type_id, 0])));
                    setToLocationId('');
                    setNote('');
                    stockMovementAction.reset();
                  }}
                  type="button"
                >
                  <Trash size={18} />
                  ล้างรายการ
                </button>
              </aside>
            </form>
          ) : activeTab !== 'count' ? (
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
            <div>
              <div style={{ marginBottom: 24 }}>
                <LocationSelect
                  label="จุดที่ต้องการตรวจนับ"
                  locations={stockHolderLocations}
                  onChange={setCountLocationId}
                  value={countLocationId}
                />
              </div>
              {countedLocation ? (
                <StockCountPanel
                  location={countedLocation}
                  onSaveCount={async (counts, countNote) => {
                    const args = { counts, note: countNote };
                    const signature = JSON.stringify({
                      serviceDate,
                      locationId: countLocationId,
                      ...args,
                    });
                    await locationCountAction.execute(args, { signature });
                  }}
                  loading={locationCountAction.isSubmitting}
                  error={locationCountAction.error}
                  successMessage={locationCountAction.success}
                />
              ) : <p className="empty-text">ยังไม่มีจุดถือครองสต๊อกที่ใช้งานได้</p>}
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
            </div>
          )}
        </div>
      ) : null}

      {!isRoundSnapshot ? (
        <section className="daily-close-section" style={{ marginTop: 24 }}>
          {closeState ? (
            closeState.is_closed ? (
              <StockCloseSummaryPanel closeState={closeState} />
            ) : (
              <form className="stock-movement-form" onSubmit={handleCloseDay}>
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">เมื่อสิ้นสุดการทำงานของวัน</p>
                    <h3>ตรวจนับและปิดสต๊อกสิ้นวัน</h3>
                  </div>
                  <span className={`status-badge status-badge--neutral`}>
                    {closeState.open_round_count > 0 ? 'มีรายการค้างที่ต้องปิดก่อน' : 'พร้อมปิดงาน'}
                  </span>
                </div>
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
                      {summary.locations.filter((location) => (
                        location.holds_inventory === true && location.requires_daily_count === true
                      )).map((location) => {
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
                            <td style={{ padding: '12px 16px', fontWeight: 500 }}>
                              {formatHolderName(location)}
                              {location.assigned_employee ? <small style={{ display: 'block', marginTop: 3, color: '#64748b' }}>{formatLocationResponsibility(location)}</small> : null}
                            </td>
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
                {closeState.open_round_count > 0 ? <p className="error-text">ต้องปิดรายการค้างเดิมก่อนปิดสต๊อก</p> : null}

                {closeDayAction.error ? <p className="error-text">{closeDayAction.error}</p> : null}
                {closeDayAction.success ? <p className="success-text">{closeDayAction.success}</p> : null}

                <button
                  className="primary-button"
                  disabled={closeDayAction.isSubmitting || closeState.open_round_count > 0 || (uncountedLocations.length > 0 && !confirmSkipUncounted)}
                  type="submit"
                >
                  {closeDayAction.isSubmitting ? 'กำลังปิดสต๊อกและจบงานวันนี้...' : 'ปิดสต๊อกและจบงานวันนี้'}
                </button>

              </form>
            )
          ) : null}
        </section>
      ) : null}

      <section className="stock-ledger" style={{ marginTop: 24 }}>
        <div>
          <p className="eyebrow">{isRoundSnapshot ? 'ประวัติจนถึงเวลาปิดงาน' : 'ประวัติล่าสุดของวัน'}</p>
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
          <option key={location.id} value={location.id}>{formatLocationOption(location)}</option>
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

function formatStockQuantity(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatEmployeeName(employee: NonNullable<StockLocationBalance['assigned_employee']>) {
  return employee.nickname ? `${employee.display_name} (${employee.nickname})` : employee.display_name;
}

function formatHolderName(location: StockLocationBalance) {
  return location.assigned_employee?.nickname || location.assigned_employee?.display_name || location.name;
}

function formatLocationResponsibility(location: StockLocationBalance) {
  if (!location.assigned_employee) return '';
  const workSites = location.assigned_work_sites?.map((site) => site.name).join(', ');
  return workSites
    ? `${formatEmployeeName(location.assigned_employee)} · ${workSites}`
    : formatEmployeeName(location.assigned_employee);
}

function formatLocationOption(location: StockLocationBalance) {
  const responsibility = formatLocationResponsibility(location);
  const name = formatHolderName(location);
  return responsibility ? `${name} — ${responsibility}` : name;
}

function isAllowedTransferDestination(
  source: StockLocationBalance | undefined,
  destination: StockLocationBalance,
) {
  if (!source || source.id === destination.id || destination.holds_inventory !== true) return false;

  if (source.kind === 'truck' && source.is_courier_source) {
    return isActiveAssignedEmployeeHolder(destination);
  }

  if (source.kind === 'team' || source.kind === 'small_vehicle') {
    return isActiveAssignedEmployeeHolder(destination)
      || (destination.kind === 'truck' && destination.is_courier_source === true);
  }

  if (source.kind === 'reserve_bin' || source.kind === 'front_vehicle') {
    return destination.kind === 'truck' && destination.is_courier_source === true;
  }

  return false;
}

function isActiveAssignedEmployeeHolder(location: StockLocationBalance) {
  return (location.kind === 'team' || location.kind === 'small_vehicle')
    && !!location.assigned_employee
    && (location.assigned_work_sites?.length ?? 0) > 0;
}
