import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './lib/supabase';
import { useRpcAction } from './hooks/useRpcAction';
import type {
  DailyStockCloseState,
  DeliveryRound,
  StockControlSummary,
  StockLocationBalance,
} from './types/app';
import { StockCountPanel } from './features/stock-control/components/StockCountPanel';

interface ManagerStockControlProps {
  isActive?: boolean;
  round: DeliveryRound | null;
  serviceDate: string;
  demoSummary?: StockControlSummary;
}

export function ManagerStockControl({
  isActive = true,
  round,
  serviceDate,
  demoSummary,
}: ManagerStockControlProps) {
  const [summary, setSummary] = useState<StockControlSummary | null>(demoSummary ?? null);
  const [closeState, setCloseState] = useState<DailyStockCloseState | null>(null);
  const [closeStateError, setCloseStateError] = useState<string | null>(null);
  const [countLocationId, setCountLocationId] = useState('');
  const [loading, setLoading] = useState(!demoSummary);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const isDemo = Boolean(demoSummary);

  useEffect(() => {
    if (demoSummary) {
      setSummary(demoSummary);
      setCloseState(null);
      setCloseStateError(null);
      setError(null);
      setLoading(false);
      return;
    }

    if (!isActive) return;
    void loadWorkspace(serviceDate, round?.id ?? null);
  }, [demoSummary, isActive, round?.id, round?.status, serviceDate]);

  const stockHolderLocations = useMemo(
    () => summary?.locations.filter((location) => location.holds_inventory === true) ?? [],
    [summary],
  );

  useEffect(() => {
    if (!summary) return;

    const selectedLocation = stockHolderLocations.find((location) => location.id === countLocationId)
      ?? stockHolderLocations.find((location) => location.kind !== 'truck')
      ?? stockHolderLocations[0];
    setCountLocationId(selectedLocation?.id ?? '');
  }, [countLocationId, stockHolderLocations, summary]);

  async function loadWorkspace(requestedServiceDate: string, roundId: string | null) {
    if (!supabase) {
      setSummary(null);
      setError('Supabase is not initialized');
      setLoading(false);
      return;
    }

    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    setCloseStateError(null);

    const [summaryResponse, closeResponse] = await Promise.all([
      supabase.rpc('get_stock_control_summary', {
        p_round_id: roundId,
        p_service_date: requestedServiceDate,
      }),
      supabase.rpc('get_daily_stock_close_state', {
        p_round_id: roundId,
        p_service_date: requestedServiceDate,
      }),
    ]);

    if (currentRequest !== requestId.current) return;

    if (summaryResponse.error) {
      setSummary(null);
      setError(summaryResponse.error.message);
    } else {
      setSummary(summaryResponse.data as StockControlSummary);
    }

    if (closeResponse.error) {
      setCloseState(null);
      setCloseStateError(closeResponse.error.message);
    } else {
      setCloseState(closeResponse.data as DailyStockCloseState);
    }

    setLoading(false);
  }

  const isClosed = round?.status === 'closed' || closeState?.is_closed === true;
  const countDisabled = !isDemo && (loading || isClosed || closeState === null);
  const disabledMessage = !isDemo && loading
    ? 'กำลังตรวจสอบสถานะสต๊อกล่าสุด'
    : isClosed
      ? 'สต๊อกของวันนี้ปิดแล้ว ข้อมูลนี้ดูได้อย่างเดียว'
      : closeStateError
        ? `ตรวจสอบสถานะการปิดสต๊อกไม่ได้: ${closeStateError}`
        : null;

  const locationCountAction = useRpcAction(
    async (args: { counts: { ice_type_id: string; actual_quantity: number }[]; note: string }, idempotencyKey) => {
      if (isDemo) return { data: { preview: true }, error: null };
      if (!supabase) throw new Error('Supabase is not initialized');
      if (loading || round?.status === 'closed' || !closeState || closeState.is_closed) {
        throw new Error('สต๊อกของวันนี้ปิดแล้วหรือยังตรวจสอบสถานะไม่ได้');
      }

      return supabase.rpc('record_location_count_v2', {
        p_service_date: serviceDate,
        p_location_id: countLocationId,
        p_counts: args.counts,
        p_note: args.note.trim() || null,
        p_idempotency_key: idempotencyKey,
      });
    },
    {
      deps: [countLocationId, isDemo, round?.id, round?.status, serviceDate],
      successMessage: () => {
        const selectedLocation = summary?.locations.find((location) => location.id === countLocationId);
        return isDemo
          ? 'บันทึกยอดนับจริงในโหมดตัวอย่างแล้ว'
          : `บันทึกยอดนับจริงของ “${selectedLocation?.name ?? ''}” แล้ว`;
      },
      onSuccess: async () => {
        if (!isDemo) await loadWorkspace(serviceDate, round?.id ?? null);
      },
    },
  );

  if (loading && !summary) {
    return <p className="empty-text">กำลังโหลดข้อมูลสำหรับตรวจนับ...</p>;
  }

  if (!summary) {
    return <p className="error-text">{error ?? 'ไม่พบข้อมูลสต๊อก'}</p>;
  }

  const countedLocation = stockHolderLocations.find((location) => location.id === countLocationId)
    ?? stockHolderLocations[0];

  return (
    <div className="stock-control">
      <section
        aria-labelledby="actual-stock-count-title"
        className="stock-layout-panel stock-action-panel"
      >
        <div style={{ marginBottom: 24 }}>
          <h2 id="actual-stock-count-title" className="employee-visually-hidden">ตรวจนับจริง</h2>
          <LocationSelect
            label="จุดที่ต้องการตรวจนับ"
            locations={stockHolderLocations}
            onChange={(locationId) => {
              setCountLocationId(locationId);
              locationCountAction.reset();
            }}
            value={countLocationId}
          />
        </div>

        {countedLocation ? (
          <>
            <StockCountPanel
              disabled={countDisabled}
              disabledMessage={disabledMessage}
              error={locationCountAction.error}
              loading={locationCountAction.isSubmitting}
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
              successMessage={locationCountAction.success}
            />
            {closeStateError && !loading ? (
              <button
                className="secondary-button"
                onClick={() => void loadWorkspace(serviceDate, round?.id ?? null)}
                type="button"
              >
                ลองตรวจสอบสถานะอีกครั้ง
              </button>
            ) : null}
          </>
        ) : (
          <p className="empty-text">ยังไม่มีจุดถือครองสต๊อกที่ใช้งานได้</p>
        )}
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

function formatLocationOption(location: StockLocationBalance) {
  const name = location.assigned_employee?.nickname
    || location.assigned_employee?.display_name
    || location.name;
  if (!location.assigned_employee) return name;

  const employeeName = location.assigned_employee.nickname
    ? `${location.assigned_employee.display_name} (${location.assigned_employee.nickname})`
    : location.assigned_employee.display_name;
  const workSites = location.assigned_work_sites?.map((site) => site.name).join(', ');
  const responsibility = workSites ? `${employeeName} · ${workSites}` : employeeName;
  return `${name} — ${responsibility}`;
}
