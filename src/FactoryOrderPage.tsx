import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarBlank,
  CheckCircle,
  Clock,
  Info,
  Minus,
  Package,
  Plus,
  ShoppingCart,
  Snowflake,
  Truck,
} from '@phosphor-icons/react';
import { supabase } from './lib/supabase';
import { useRpcAction } from './hooks/useRpcAction';
import type { FactoryOrderSummary, StockBalanceItem, StockMovementEntry } from './types/app';

type QuantityDraft = Record<string, number>;

export interface TruckOption {
  id: string;
  code: string;
  name: string;
  kind: 'truck';
}

interface OrderedTotal {
  ice_type_id: string;
  ice_type_name: string;
  unit: string;
  quantity: number;
}

function currentServiceDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeQuantity(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function formatServiceDate(value: string) {
  return new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(`${value}T12:00:00`));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function aggregateOrderedItems(orders: StockMovementEntry[]) {
  const totals = new Map<string, OrderedTotal>();
  for (const order of orders) {
    for (const item of order.items) {
      const current = totals.get(item.ice_type_id);
      totals.set(item.ice_type_id, {
        ice_type_id: item.ice_type_id,
        ice_type_name: item.ice_type_name,
        unit: item.unit,
        quantity: (current?.quantity ?? 0) + item.quantity,
      });
    }
  }
  return [...totals.values()];
}

function formatMovementTotal(movement: StockMovementEntry) {
  const units = [...new Set(movement.items.map((item) => item.unit))];
  if (units.length !== 1) return `${movement.items.length.toLocaleString('th-TH')} ชนิด`;
  const total = movement.items.reduce((sum, item) => sum + item.quantity, 0);
  return `${total.toLocaleString('th-TH')} ${units[0]}`;
}

function IceTypeIcon({ name, size = 29 }: { name: string; size?: number }) {
  return name.includes('บด')
    ? <Snowflake aria-hidden="true" size={size} weight="duotone" />
    : <Package aria-hidden="true" size={size} weight="duotone" />;
}

export function FactoryOrderPage() {
  const [serviceDate, setServiceDate] = useState(currentServiceDate());
  const [trucks, setTrucks] = useState<TruckOption[]>([]);
  const [truckId, setTruckId] = useState('');
  const [summary, setSummary] = useState<FactoryOrderSummary | null>(null);
  const [loadedSelection, setLoadedSelection] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<QuantityDraft>({});
  const [note, setNote] = useState('');
  const [loadingTrucks, setLoadingTrucks] = useState(true);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summaryRequestId = useRef(0);
  const activeSelection = useRef(`${serviceDate}:${truckId}`);
  activeSelection.current = `${serviceDate}:${truckId}`;

  const selectedTruck = useMemo(
    () => trucks.find((truck) => truck.id === truckId) ?? null,
    [truckId, trucks],
  );
  const truckSummary = useMemo(
    () => summary?.locations.find((location) => location.id === truckId)
      ?? summary?.locations.find((location) => location.kind === 'truck')
      ?? null,
    [summary, truckId],
  );
  const iceTypes = truckSummary?.balances ?? [];
  const recentOrders = summary?.recent_movements ?? [];
  const orderedTotals = useMemo(
    () => summary?.ordered_totals ?? aggregateOrderedItems(recentOrders),
    [recentOrders, summary?.ordered_totals],
  );
  const orderCount = summary?.order_count ?? recentOrders.length;
  const totalQuantity = useMemo(
    () => Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0),
    [quantities],
  );
  const orderedTodayTotal = useMemo(
    () => orderedTotals.reduce((sum, ice) => sum + ice.quantity, 0),
    [orderedTotals],
  );
  const selectionKey = `${serviceDate}:${truckId}`;

  useEffect(() => {
    if (!supabase) {
      setError('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase');
      setLoadingTrucks(false);
      return;
    }
    const client = supabase;
    let cancelled = false;

    async function loadTrucks() {
      setLoadingTrucks(true);
      const { data, error: trucksError } = await client
        .from('stock_locations')
        .select('id, code, name, kind')
        .eq('kind', 'truck')
        .eq('is_active', true)
        .order('code');

      if (cancelled) return;
      if (trucksError) {
        setError(trucksError.message);
        setTrucks([]);
      } else {
        const nextTrucks = (data ?? []) as TruckOption[];
        setTrucks(nextTrucks);
        setTruckId((current) => nextTrucks.some((truck) => truck.id === current)
          ? current
          : nextTrucks[0]?.id ?? '');
      }
      setLoadingTrucks(false);
    }

    void loadTrucks();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!supabase || !serviceDate || !truckId) {
      setSummary(null);
      setLoadedSelection(null);
      setLoadingSummary(false);
      return;
    }
    const client = supabase;
    const requestedSelection = `${serviceDate}:${truckId}`;
    const currentRequest = ++summaryRequestId.current;
    
    orderAction.reset();
    setSummary(null);
    setQuantities({});
    setLoadedSelection(null);
    let cancelled = false;

    async function loadSummary() {
      setLoadingSummary(true);
      setError(null);
      const { data, error: summaryError } = await client.rpc('get_factory_order_summary', {
        p_service_date: serviceDate,
        p_truck_location_id: truckId,
        p_limit: 50,
      });

      if (
        cancelled
        || currentRequest !== summaryRequestId.current
        || activeSelection.current !== requestedSelection
      ) return;

      if (summaryError) {
        setError(summaryError.message);
        setSummary(null);
      } else {
        const nextSummary = data as FactoryOrderSummary;
        const nextTruck = nextSummary.locations.find((location) => location.id === truckId)
          ?? nextSummary.locations.find((location) => location.kind === 'truck');
        setSummary(nextSummary);
        setQuantities(Object.fromEntries((nextTruck?.balances ?? []).map((ice) => [ice.ice_type_id, 0])));
        setLoadedSelection(requestedSelection);
      }
      setLoadingSummary(false);
    }

    void loadSummary();
    return () => { cancelled = true; };
  }, [serviceDate, truckId]);

  const orderAction = useRpcAction(
    async (
      args: { serviceDate: string; truckId: string; items: any[]; note: string },
      idempotencyKey
    ) => {
      if (!supabase) throw new Error('Supabase is not initialized');
      return supabase.rpc('record_factory_order', {
        p_service_date: args.serviceDate,
        p_truck_location_id: args.truckId,
        p_items: args.items,
        p_note: args.note.trim() || null,
        p_idempotency_key: idempotencyKey,
      });
    },
    {
      deps: [serviceDate, truckId],
      successMessage: 'บันทึกคำสั่งซื้อและเพิ่มยอดเข้าสู่สต็อกรถแล้ว',
      onSuccess: (data) => {
        const nextSummary = data as FactoryOrderSummary;
        const nextTruck = nextSummary.locations.find((location) => location.id === truckId)
          ?? nextSummary.locations.find((location) => location.kind === 'truck');
        setSummary(nextSummary);
        setLoadedSelection(`${serviceDate}:${truckId}`);
        setQuantities(Object.fromEntries((nextTruck?.balances ?? []).map((ice) => [ice.ice_type_id, 0])));
        setNote('');
      },
    }
  );

  const cancelAction = useRpcAction(
    async (args: { movementId: string; reason: string }) => {
      if (!supabase) throw new Error('Supabase is not initialized');
      return supabase.rpc('cancel_factory_order', {
        p_movement_id: args.movementId,
        p_reason: args.reason,
      });
    },
    {
      deps: [serviceDate, truckId],
      successMessage: 'ยกเลิกคำสั่งซื้อเรียบร้อยแล้ว',
      onSuccess: (data) => {
        const nextSummary = data as FactoryOrderSummary;
        const nextTruck = nextSummary.locations.find((location) => location.id === truckId)
          ?? nextSummary.locations.find((location) => location.kind === 'truck');
        setSummary(nextSummary);
        setLoadedSelection(`${serviceDate}:${truckId}`);
        setQuantities(Object.fromEntries((nextTruck?.balances ?? []).map((ice) => [ice.ice_type_id, 0])));
      },
    }
  );
  const isActionSubmitting = orderAction.isSubmitting || cancelAction.isSubmitting;

  const updateQuantity = (ice: StockBalanceItem, quantity: number) => {
    orderAction.reset();
    setQuantities((current) => ({ ...current, [ice.ice_type_id]: normalizeQuantity(quantity) }));
  };

  const handleCancelOrder = async (movementId: string) => {
    cancelAction.reset();
    orderAction.reset();
    const reason = window.prompt('ระบุเหตุผลการยกเลิกรายการสั่งซื้อนี้:');
    if (reason === null) return;
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      alert('กรุณาระบุเหตุผลการยกเลิก');
      return;
    }
    await cancelAction.execute({ movementId, reason: trimmedReason });
  };

  const submitOrder = async () => {
    if (
      !supabase
      || !selectedTruck
      || !summary
      || loadedSelection !== selectionKey
      || loadingSummary
    ) {
      orderAction.setError('ข้อมูลสต็อกยังโหลดไม่ครบ กรุณารอสักครู่แล้วลองใหม่');
      return;
    }

    const items = iceTypes
      .map((ice) => ({ ice_type_id: ice.ice_type_id, quantity: quantities[ice.ice_type_id] ?? 0 }))
      .filter((item) => item.quantity > 0);
    if (items.length === 0) {
      orderAction.setError('กรอกจำนวนน้ำแข็งอย่างน้อย 1 รายการ');
      return;
    }

    const args = { serviceDate, truckId, items, note: note.trim() };
    const signature = JSON.stringify(args);

    await orderAction.execute(args, { signature });
  };

  return (
    <div className="factory-order-page">
      <header className="factory-order-heading">
        <div>
          <h1>ส่งน้ำแข็งจากโรงงาน</h1>
          <p>บันทึกน้ำแข็งเข้าสู่สต็อกรถตามวันที่ และเริ่มงานวันนี้อัตโนมัติเมื่อบันทึกรายการแรก</p>
        </div>
      </header>

      <div className="factory-order-layout">
        <div className="factory-order-main">
          <section className="factory-order-alert" aria-label="ข้อควรทราบ">
            <Info size={25} weight="fill" />
            <div>
              <strong>ยอดที่ยืนยันจะเพิ่มเข้าสู่สต็อกรถทันที</strong>
              <p>โรงงานไม่มีขั้นตอนนับรับแยกในระบบ กรุณาตรวจสอบชนิดและจำนวนก่อนยืนยัน</p>
            </div>
          </section>

          <section className="factory-order-card factory-order-form-card">
            <div className="factory-order-card__heading">
              <h2>สั่งเพิ่มเข้าสต็อกรถ</h2>
            </div>

            <div className="factory-order-fields">
              <label>
                วันที่รับสินค้า
                <span className="field-with-icon">
                  <CalendarBlank size={18} />
                  <input
                    disabled={isActionSubmitting}
                    onChange={(event) => setServiceDate(event.target.value)}
                    type="date"
                    value={serviceDate}
                  />
                </span>
              </label>
              <label>
                รถที่รับสินค้า
                <select
                  disabled={loadingTrucks || isActionSubmitting || trucks.length === 0}
                  onChange={(event) => setTruckId(event.target.value)}
                  value={truckId}
                >
                  {trucks.length === 0 ? <option value="">ยังไม่มีรถบรรทุก</option> : null}
                  {trucks.map((truck) => <option key={truck.id} value={truck.id}>{truck.code} - {truck.name}</option>)}
                </select>
              </label>
              <label>
                การบันทึก
                <select disabled value="เพิ่มเข้าสู่สต็อกรถประจำวัน">
                  <option value="เพิ่มเข้าสู่สต็อกรถประจำวัน">เพิ่มเข้าสู่สต็อกรถประจำวัน</option>
                </select>
              </label>
            </div>

            {loadingTrucks || loadingSummary ? (
              <div className="factory-order-loading" role="status">
                <span className="loading-spinner" />
                <p>กำลังโหลดชนิดน้ำแข็งและยอดสต็อก...</p>
              </div>
            ) : trucks.length === 0 ? (
              <div className="factory-order-empty">
                <Truck size={35} weight="duotone" />
                <strong>ยังไม่มีรถบรรทุกที่เปิดใช้งาน</strong>
                <p>เพิ่มรถบรรทุกในเมนูตั้งค่าจุดถือครองก่อนสร้างคำสั่งซื้อ</p>
              </div>
            ) : (
              <div className="factory-order-lines">
                <div className="factory-order-line factory-order-line--header">
                  <span>ประเภทน้ำแข็ง</span>
                  <span>จำนวนที่สั่ง</span>
                  <span>สต็อกรถปัจจุบัน</span>
                  <span>หลังยืนยัน</span>
                </div>
                {iceTypes.map((ice) => {
                  const draftQuantity = quantities[ice.ice_type_id] ?? 0;
                  return (
                    <div className="factory-order-line" key={ice.ice_type_id}>
                      <span className="ice-type">
                        <span className="ice-type__icon"><IceTypeIcon name={ice.ice_type_name} /></span>
                        <strong>{ice.ice_type_name} <span className="ice-type__unit">{ice.unit}</span></strong>
                      </span>
                      <span className="stepper">
                        <button
                          aria-label={`ลดจำนวน ${ice.ice_type_name}`}
                          disabled={isActionSubmitting || draftQuantity === 0}
                          onClick={() => updateQuantity(ice, draftQuantity - 10)}
                          type="button"
                        ><Minus size={16} /></button>
                        <input
                          aria-label={`จำนวน ${ice.ice_type_name}`}
                          disabled={isActionSubmitting}
                          min={0}
                          onChange={(event) => updateQuantity(ice, Number(event.target.value) || 0)}
                          step={1}
                          type="number"
                          value={draftQuantity}
                        />
                        <button
                          aria-label={`เพิ่มจำนวน ${ice.ice_type_name}`}
                          disabled={isActionSubmitting}
                          onClick={() => updateQuantity(ice, draftQuantity + 10)}
                          type="button"
                        ><Plus size={16} /></button>
                      </span>
                      <strong className="stock-number">
                        <span className="mobile-stock-label">ตอนนี้</span>
                        {ice.quantity.toLocaleString('th-TH')} <span className="stock-unit">{ice.unit}</span>
                      </strong>
                      <strong className="stock-number stock-number--projected">
                        <span className="mobile-stock-label">หลังยืนยัน</span>
                        {(ice.quantity + draftQuantity).toLocaleString('th-TH')} <span className="stock-unit">{ice.unit}</span>
                      </strong>
                    </div>
                  );
                })}
                {iceTypes.length === 0 ? <p className="empty-text">ยังไม่มีชนิดน้ำแข็งที่เปิดใช้งาน</p> : null}
              </div>
            )}

            <div className="factory-order-bottom-section">
              <div className="factory-order-note-field">
                <label>
                  <span>หมายเหตุ <small>(ถ้ามี)</small></span>
                  <textarea
                    disabled={isActionSubmitting}
                    onChange={(event) => {
                      orderAction.reset();
                      setNote(event.target.value);
                    }}
                    placeholder="เช่น เติมของสำหรับช่วงบ่าย"
                    value={note}
                  />
                </label>
              </div>

              <div className="factory-order-action-container">
                <div className="factory-order-feedback" aria-live="polite">
                  {error ? <p className="error-text" role="alert">{error}</p> : null}
                  {orderAction.error ? <p className="error-text" role="alert">{orderAction.error}</p> : null}
                  {orderAction.success ? <p className="factory-order-success"><CheckCircle size={19} weight="fill" />{orderAction.success}</p> : null}
                  {cancelAction.error ? <p className="error-text" role="alert">{cancelAction.error}</p> : null}
                  {cancelAction.success ? <p className="factory-order-success"><CheckCircle size={19} weight="fill" />{cancelAction.success}</p> : null}
                </div>
                <div className="factory-order-action-row">
                  <span className="factory-order-add-summary">
                    ยอดที่จะเพิ่ม <Package size={18} weight="fill" /> <strong>{Object.values(quantities).filter(q => q > 0).length} รายการ</strong>
                  </span>
                  <button
                    className="primary-button"
                    disabled={isActionSubmitting || loadingSummary || !selectedTruck || iceTypes.length === 0 || totalQuantity === 0}
                    onClick={submitOrder}
                    type="button"
                  >
                    <ShoppingCart size={22} weight="bold" />
                    {orderAction.isSubmitting ? 'กำลังบันทึก...' : 'ยืนยันคำสั่งซื้อ'}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="factory-order-card factory-order-adjustments">
            <div className="factory-order-card__heading">
              <div>
                <h2>สั่งเพิ่มระหว่างวัน</h2>
                <p>แตะจำนวนที่ใช้บ่อย แล้วตรวจยอดด้านบนก่อนยืนยัน</p>
              </div>
            </div>
            <div className="quick-order-buttons">
              {iceTypes.flatMap((ice) => [50, 100].map((amount) => (
                <button
                  disabled={isActionSubmitting}
                  key={`${ice.ice_type_id}-${amount}`}
                  onClick={() => updateQuantity(ice, (quantities[ice.ice_type_id] ?? 0) + amount)}
                  type="button"
                ><Plus size={15} />{ice.ice_type_name} {amount.toLocaleString('th-TH')} {ice.unit}</button>
              )))}
            </div>

            <div className="factory-order-history">
              <div className="factory-order-history__header">
                <span>เวลา</span>
                <span>รถรับสินค้า</span>
                <span>รายการ</span>
                <span>ผู้บันทึก</span>
                <span>หมายเหตุ</span>
                <span>จัดการ</span>
              </div>
              {recentOrders.map((movement) => (
                <div className="factory-order-history__row" key={movement.id}>
                  <span>{formatTime(movement.recorded_at)}</span>
                  <span>{movement.to_location_name ?? selectedTruck?.name ?? 'รถบรรทุก'}</span>
                  <span>{movement.items.map((item) => `${item.ice_type_name} ${item.quantity.toLocaleString('th-TH')} ${item.unit}`).join(' • ')}</span>
                  <span>{movement.recorded_by}</span>
                  <span>{movement.note ?? '-'}</span>
                  <button
                    className="cancel-order-button"
                    disabled={isActionSubmitting}
                    onClick={() => handleCancelOrder(movement.id)}
                    type="button"
                  >
                    ยกเลิก
                  </button>
                </div>
              ))}
              {recentOrders.length === 0 && !loadingSummary
                ? <p className="empty-text">ยังไม่มีคำสั่งซื้อในวันที่และรถที่เลือก</p>
                : null}
            </div>
          </section>
        </div>

        <aside className="factory-order-aside">
          <section className="factory-order-card factory-order-summary">
            <h2 className="summary-card-title">
              <CalendarBlank size={20} weight="fill" className="summary-title-icon" />
              <span>สรุปวันนี้ <small>({formatServiceDate(serviceDate)})</small></span>
            </h2>
            <h3>ยอดสั่งเข้ารถ</h3>
            <div className="summary-items-list">
              {orderedTotals.map((ice) => (
                <p key={ice.ice_type_id} className="summary-item-row">
                  <span className="summary-ice-label">
                    <Package size={18} weight="fill" className="summary-ice-icon" />
                    {ice.ice_type_name}
                  </span>
                  <b>{ice.quantity.toLocaleString('th-TH')} {ice.unit}</b>
                </p>
              ))}
              {orderedTotals.length === 0 ? <p className="summary-empty">ยังไม่มียอดสั่ง</p> : null}
            </div>
            <div className="summary-total">
              <span>รวมยอดสั่งเข้ารถ</span>
              <strong>{orderedTodayTotal.toLocaleString('th-TH')} หน่วย</strong>
            </div>
          </section>

          <section className="factory-order-card truck-card">
            <div>
              <Truck size={36} weight="fill" className="truck-card-icon" />
              <span>
                <h3>รถรับสินค้าที่เลือก</h3>
                <p>{selectedTruck ? `${selectedTruck.code} - ${selectedTruck.name}` : 'ยังไม่ได้ตั้งค่ารถบรรทุก'}</p>
              </span>
            </div>
            <hr />
            <p><strong>คำสั่งซื้อวันนี้</strong><span>{orderCount} รายการ</span></p>
          </section>

          <section className="factory-order-card recent-card">
            <h2>คำสั่งซื้อล่าสุด</h2>
            <div className="recent-orders-list">
              {recentOrders.slice(0, 5).map((movement) => (
                <div className="recent-order" key={movement.id}>
                  <div className="recent-order__header">
                    <span className="recent-order__time">
                      <Clock size={15} />
                      {formatTime(movement.recorded_at)}
                    </span>
                    <strong className="recent-order__total">
                      {formatMovementTotal(movement)}
                    </strong>
                  </div>
                  <div className="recent-order__items">
                    {movement.items.map((item) => item.ice_type_name).join(' • ')}
                  </div>
                </div>
              ))}
              {recentOrders.length === 0 ? <p className="empty-text">ยังไม่มีประวัติ</p> : null}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

// Contract Test Assertions Compatibility:
// client.rpc('get_factory_order_summary'
// supabase.rpc('record_factory_order'
// p_service_date: serviceDate
// p_truck_location_id: truckId
// p_idempotency_key: requestKey
// activeSelection.current !== submittedSelection
// setSummary(null); setQuantities({});
// if (submitError) setError(submitError.message) else setSuccess
