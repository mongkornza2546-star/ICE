import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle, Cube, Warning } from '@phosphor-icons/react';
import { supabase } from '../../../lib/supabase';
import { publishDataChange } from '../../../lib/dataChange';

interface AggregateItem {
  ice_type_id: string;
  code: string;
  name: string;
  unit: string;
  ordered_quantity?: number;
  sold_quantity?: number;
  damaged_quantity?: number;
  returned_quantity?: number;
  available_quantity: number;
  actual_quantity?: number | null;
  variance_quantity?: number | null;
}

interface AggregateSummary {
  service_date: string;
  status: 'open' | 'closed';
  items: AggregateItem[];
}

interface DailyCloseEmployee {
  employee_id: string;
  employee_name: string;
  is_active: boolean;
  expected_cash_amount: number;
  actual_cash_amount?: number | null;
  cash_variance_amount?: number | null;
  cash_reason?: string | null;
  payment_ids: string[];
  recorded_at?: string | null;
}

interface DailyCloseReconciliation {
  service_date: string;
  status: 'open' | 'closed';
  feature_enabled: boolean;
  enabled_from_service_date?: string | null;
  stock: AggregateSummary;
  employees: DailyCloseEmployee[];
}

interface LegacyRefillHistoryItem {
  id: string;
  status: 'active' | 'cancelled';
  note: string | null;
  recorded_at: string;
  recorded_by: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  items: Array<{
    ice_type_id: string;
    ice_type_name: string;
    unit: string;
    quantity: number;
  }>;
}

export function DailyAggregateStockClose({
  serviceDate,
  onClosed,
  imagePathByIceTypeId = {},
  imageUrls = {},
  failedImagePaths = new Set<string>(),
  onImageError,
  onPreviewImage,
}: {
  serviceDate: string;
  onClosed?: () => void;
  imagePathByIceTypeId?: Record<string, string | null | undefined>;
  imageUrls?: Record<string, string>;
  failedImagePaths?: Set<string>;
  onImageError?: (path: string) => void;
  onPreviewImage?: (image: { name: string; url: string }) => void;
}) {
  const [summary, setSummary] = useState<AggregateSummary | null>(null);
  const [employees, setEmployees] = useState<DailyCloseEmployee[]>([]);
  const [featureEnabled, setFeatureEnabled] = useState(false);
  const [legacyRefills, setLegacyRefills] = useState<LegacyRefillHistoryItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [cashCounts, setCashCounts] = useState<Record<string, number>>({});
  const [cashReasons, setCashReasons] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRequest = useRef<{ signature: string; key: string } | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    const [reconciliationResponse, legacyRefillsResponse] = await Promise.all([
      supabase.rpc('get_daily_close_reconciliation', { p_service_date: serviceDate }),
      supabase.rpc('get_daily_stock_refill_history', { p_service_date: serviceDate }),
    ]);
    const loadError = reconciliationResponse.error ?? legacyRefillsResponse.error;
    if (loadError) setError(loadError.message);
    if (reconciliationResponse.data) {
      const next = reconciliationResponse.data as DailyCloseReconciliation;
      setSummary(next.stock);
      setEmployees(next.employees);
      setFeatureEnabled(next.feature_enabled);
      setCounts(Object.fromEntries(
        next.stock.items.map((item) => [
          item.ice_type_id,
          Number(item.actual_quantity ?? item.available_quantity),
        ]),
      ));
      setCashCounts(Object.fromEntries(next.employees.map((employee) => [
        employee.employee_id,
        Number(employee.actual_cash_amount ?? employee.expected_cash_amount),
      ])));
      setCashReasons(Object.fromEntries(next.employees.map((employee) => [
        employee.employee_id,
        employee.cash_reason ?? '',
      ])));
    } else if (!loadError) setError('ไม่พบยอดสต๊อกรวมสำหรับวันที่เลือก');
    setLegacyRefills((legacyRefillsResponse.data ?? []) as LegacyRefillHistoryItem[]);
    setLoading(false);
  }, [serviceDate]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasVariance = useMemo(() => summary?.items.some(
    (item) => (counts[item.ice_type_id] ?? 0) !== Number(item.available_quantity),
  ) ?? false, [counts, summary]);

  const hasMissingCashReason = useMemo(() => employees.some((employee) => (
    (cashCounts[employee.employee_id] ?? 0) !== Number(employee.expected_cash_amount)
      && !cashReasons[employee.employee_id]?.trim()
  )), [cashCounts, cashReasons, employees]);

  const close = async () => {
    if (!supabase || !summary || submitting) return;
    if (hasVariance && !note.trim()) {
      setError('กรอกหมายเหตุเมื่อยอดนับจริงต่างจากยอดตามระบบ');
      return;
    }
    if (featureEnabled && hasMissingCashReason) {
      setError('กรอกเหตุผลของพนักงานทุกคนที่ยอดเงินสดไม่ตรง');
      return;
    }
    setSubmitting(true);
    setError(null);
    const closeItems = summary.items.map((item) => ({
        ice_type_id: item.ice_type_id,
        actual_quantity: counts[item.ice_type_id] ?? 0,
        note: hasVariance ? note.trim() || 'ส่วนต่างยังไม่ทราบสาเหตุ' : null,
      }));
    const signature = JSON.stringify({
      serviceDate,
      items: closeItems,
      cash: employees.map((employee) => ({
        employee_id: employee.employee_id,
        actual_cash_amount: cashCounts[employee.employee_id] ?? 0,
        reason: cashReasons[employee.employee_id]?.trim() || null,
      })),
      note: note.trim() || null,
    });
    if (pendingRequest.current?.signature !== signature) {
      pendingRequest.current = { signature, key: crypto.randomUUID() };
    }
    try {
      const { error: closeError } = featureEnabled
        ? await supabase.rpc('close_daily_reconciliation_v2', {
          p_service_date: serviceDate,
          p_stock_counts: closeItems,
          p_cash_counts: employees.map((employee) => ({
            employee_id: employee.employee_id,
            actual_cash_amount: cashCounts[employee.employee_id] ?? 0,
            reason: cashReasons[employee.employee_id]?.trim() || null,
          })),
          p_stock_note: note.trim() || null,
          p_idempotency_key: pendingRequest.current.key,
        })
        : await supabase.rpc('close_daily_aggregate_stock', {
          p_service_date: serviceDate,
          p_counts: closeItems,
          p_note: note.trim() || null,
          p_idempotency_key: pendingRequest.current.key,
        });
      if (closeError) {
        setError(closeError.message);
      } else {
        pendingRequest.current = null;
        publishDataChange(['accounting', 'payment', 'stock']);
        await load();
        onClosed?.();
      }
    } catch (closeError) {
      setError(closeError instanceof Error ? closeError.message : 'ปิดสต๊อกรวมไม่สำเร็จ');
    } finally {
      setSubmitting(false);
    }
  };

  const cancelLegacyRefill = async (refill: LegacyRefillHistoryItem) => {
    if (!supabase || submitting || refill.status !== 'active') return;
    const reason = window.prompt('เหตุผลที่ยกเลิกรายการเติมน้ำแข็งเดิม')?.trim();
    if (!reason) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error: cancelError } = await supabase.rpc('cancel_daily_stock_refill', {
        p_use_id: refill.id,
        p_reason: reason,
      });
      if (cancelError) setError(cancelError.message);
      else {
        publishDataChange(['accounting', 'stock']);
        await load();
      }
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'ยกเลิกรายการเดิมไม่สำเร็จ');
    } finally {
      setSubmitting(false);
    }
  };

  const legacyRefillHistory = legacyRefills.length > 0 ? (
    <section aria-labelledby="legacy-refill-history-title" style={{ marginTop: 20 }}>
      <div className="panel-header">
        <div>
          <p className="eyebrow">สำหรับตรวจสอบข้อมูลก่อนยกเลิกฟีเจอร์เท่านั้น</p>
          <h3 id="legacy-refill-history-title">รายการเติมน้ำแข็งเดิม</h3>
        </div>
      </div>
      <div className="financial-ops__list">
        {legacyRefills.map((refill) => (
          <div key={refill.id}>
            <span>
              <strong>
                {refill.items.map((item) => (
                  `${item.ice_type_name} ${item.quantity} ${item.unit}`
                )).join(' · ')}
              </strong>
              <small>
                ผู้บันทึก {refill.recorded_by}
                {' · '}{new Intl.DateTimeFormat('th-TH', {
                  dateStyle: 'short',
                  timeStyle: 'short',
                }).format(new Date(refill.recorded_at))}
                {refill.note ? ` · ${refill.note}` : ''}
              </small>
              {refill.status === 'cancelled' ? (
                <small>
                  ยกเลิกโดย {refill.cancelled_by ?? '—'} · {refill.cancellation_reason ?? '—'}
                </small>
              ) : null}
            </span>
            {summary?.status === 'open' && refill.status === 'active' ? (
              <button
                disabled={submitting}
                onClick={() => void cancelLegacyRefill(refill)}
                type="button"
              >
                ยกเลิกรายการเดิม
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  ) : null;

  if (loading) return <p className="muted">กำลังโหลดยอดสต๊อกรวม...</p>;
  if (!summary) return <p className="error-text">{error ?? 'โหลดยอดสต๊อกรวมไม่สำเร็จ'}</p>;
  if (summary.status === 'closed') {
    return (
      <section aria-labelledby="aggregate-closed-title">
        <div className="employee-success" role="status">
          <CheckCircle size={22} weight="fill" />
          <span id="aggregate-closed-title">
            ปิดสต๊อกรวมวันที่ {serviceDate} แล้ว ยอดพร้อมใช้เป็นศูนย์
          </span>
        </div>
        <div className="daily-stock-closed-list">
          {summary.items.map((item) => (
            <div className="daily-stock-closed-item" key={item.ice_type_id}>
              <IceTypeImage
                itemName={item.name}
                imagePath={imagePathByIceTypeId[item.ice_type_id]}
                imageUrls={imageUrls}
                failedImagePaths={failedImagePaths}
                onImageError={onImageError}
                onPreviewImage={onPreviewImage}
              />
              <p className="muted">
                {item.name}: นับจริง {item.actual_quantity ?? 0} {item.unit}
                {' · '}ส่วนต่าง {Number(item.variance_quantity ?? 0) > 0 ? '+' : ''}
                {item.variance_quantity ?? 0}
              </p>
            </div>
          ))}
        </div>
        {featureEnabled ? (
          <section aria-labelledby="daily-cash-closed-title" className="daily-close-cash" style={{ marginTop: 18 }}>
            <div className="panel-header">
              <div>
                <p className="eyebrow">Snapshot เงินสดสิ้นวัน</p>
                <h3 id="daily-cash-closed-title">เงินสดรายพนักงาน</h3>
              </div>
            </div>
            <div className="daily-close-cash__grid">
              {employees.map((employee) => {
                const variance = Number(employee.cash_variance_amount ?? 0);
                return (
                  <article className="daily-close-cash__card" key={employee.employee_id}>
                    <div>
                      <strong>{employee.employee_name}</strong>
                      {!employee.is_active ? <small>พนักงานที่ยกเลิกแล้ว</small> : null}
                    </div>
                    <dl>
                      <div><dt>ควรส่ง</dt><dd>{formatBaht(employee.expected_cash_amount)}</dd></div>
                      <div><dt>นับจริง</dt><dd>{formatBaht(employee.actual_cash_amount ?? 0)}</dd></div>
                      <div><dt>ส่วนต่าง</dt><dd className={variance ? 'daily-close-cash__variance' : ''}>{formatSignedBaht(variance)}</dd></div>
                    </dl>
                    {employee.cash_reason ? <p>เหตุผล: {employee.cash_reason}</p> : null}
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}
        {legacyRefillHistory}
      </section>
    );
  }

  return (
    <section aria-labelledby="aggregate-close-title">
      <div className="panel-header">
        <div>
          <p className="eyebrow">ยอดรวมจากทุกจุด</p>
          <h3 id="aggregate-close-title">ตรวจนับและปิดสต๊อกสิ้นวัน</h3>
        </div>
        <span className="status-badge status-badge--neutral">พร้อมนับรวม</span>
      </div>
      <p className="muted">
        นับน้ำแข็งที่เหลือรวมจากรถและทุกจุด แล้วกรอกยอดจริงแยกตามชนิด
      </p>
      <div className="daily-stock-count-grid" style={{ marginTop: 16 }}>
        {summary.items.map((item) => {
          const actual = counts[item.ice_type_id] ?? 0;
          const variance = actual - Number(item.available_quantity);
          return (
            <article className="daily-stock-count-card" key={item.ice_type_id}>
              <div className="daily-stock-count-card__identity">
                <IceTypeImage
                  itemName={item.name}
                  imagePath={imagePathByIceTypeId[item.ice_type_id]}
                  imageUrls={imageUrls}
                  failedImagePaths={failedImagePaths}
                  onImageError={onImageError}
                  onPreviewImage={onPreviewImage}
                />
                <div>
                  <strong>{item.name}</strong>
                  <small>
                    ตามระบบ {item.available_quantity} {item.unit}
                    {variance ? ` · ต่าง ${variance > 0 ? '+' : ''}${variance}` : ' · ตรง'}
                  </small>
                  <small>
                    สั่ง {item.ordered_quantity ?? 0}
                    {' · '}ขาย {item.sold_quantity ?? 0}
                    {' · '}เสีย {item.damaged_quantity ?? 0}
                    {' · '}คืน {item.returned_quantity ?? 0}
                  </small>
                </div>
              </div>
              <label className="daily-stock-count-card__input">
                <span>นับจริง</span>
                <div className="input-wrapper">
                  <input
                    inputMode="decimal"
                    min={0}
                    onChange={(event) => setCounts((current) => ({
                      ...current,
                      [item.ice_type_id]: Math.max(0, Number(event.target.value) || 0),
                    }))}
                    step={0.5}
                    type="number"
                    value={actual}
                  />
                  <small>{item.unit}</small>
                </div>
              </label>
            </article>
          );
        })}
      </div>
      <section aria-labelledby="daily-cash-count-title" className="daily-close-cash" style={{ marginTop: 22 }}>
        <div className="panel-header">
          <div>
            <p className="eyebrow">ตรวจเงินพร้อมปิดยอด</p>
            <h3 id="daily-cash-count-title">เงินสดรายพนักงาน</h3>
          </div>
          <span className={`status-badge ${featureEnabled ? 'status-badge--success' : 'status-badge--neutral'}`}>
            {featureEnabled ? 'ใช้งานจริง' : 'Dark launch'}
          </span>
        </div>
        <p className="muted">
          ยอดที่ควรส่งนับเฉพาะเงินสดที่พนักงานรับจริง ไม่รวมเงินทอน โอน QR รายการ void หรือเงินที่หัวหน้ารับเอง
        </p>
        {!featureEnabled ? (
          <p className="daily-close-cash__rollout" role="status">
            กำลังเปรียบเทียบยอดกับรายงานเดิม ช่องเงินสดยังไม่ถูกบันทึกจนกว่าจะเปิดใช้ reconciliation
          </p>
        ) : null}
        <div className="daily-close-cash__grid">
          {employees.map((employee) => {
            const expected = Number(employee.expected_cash_amount);
            const actual = cashCounts[employee.employee_id] ?? 0;
            const variance = actual - expected;
            return (
              <article className="daily-close-cash__card" key={employee.employee_id}>
                <div className="daily-close-cash__identity">
                  <span>
                    <strong>{employee.employee_name}</strong>
                    <small>{employee.payment_ids.length} รายการเงินสด{!employee.is_active ? ' · พนักงานที่ยกเลิกแล้ว' : ''}</small>
                  </span>
                  <b className={variance ? 'daily-close-cash__variance' : ''}>{formatSignedBaht(variance)}</b>
                </div>
                <div className="daily-close-cash__expected">ควรส่ง <strong>{formatBaht(expected)}</strong></div>
                <label>
                  <span>หัวหน้านับจริง</span>
                  <div className="input-wrapper">
                    <input
                      disabled={!featureEnabled}
                      inputMode="decimal"
                      min={0}
                      onChange={(event) => setCashCounts((current) => ({
                        ...current,
                        [employee.employee_id]: Math.max(0, Number(event.target.value) || 0),
                      }))}
                      step={0.01}
                      type="number"
                      value={actual}
                    />
                    <small>บาท</small>
                  </div>
                </label>
                {variance !== 0 ? (
                  <label>
                    <span>เหตุผลส่วนต่าง *</span>
                    <input
                      disabled={!featureEnabled}
                      onChange={(event) => setCashReasons((current) => ({
                        ...current,
                        [employee.employee_id]: event.target.value,
                      }))}
                      placeholder="เช่น ลูกค้ายังค้างเงินสด"
                      type="text"
                      value={cashReasons[employee.employee_id] ?? ''}
                    />
                  </label>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
      <label style={{ display: 'grid', gap: 6, marginTop: 16 }}>
        หมายเหตุ{hasVariance ? ' *' : ' (ถ้ามี)'}
        <textarea
          onChange={(event) => setNote(event.target.value)}
          placeholder={hasVariance ? 'เช่น ส่วนต่างยังไม่ทราบสาเหตุ' : ''}
          rows={2}
          value={note}
        />
      </label>
      {error ? <p className="error-text" role="alert"><Warning size={18} />{error}</p> : null}
      <button
        className="primary-button"
        disabled={submitting || (hasVariance && !note.trim()) || (featureEnabled && hasMissingCashReason)}
        onClick={() => void close()}
        style={{ marginTop: 16 }}
        type="button"
      >
        {submitting ? 'กำลังปิดยอด...' : featureEnabled ? 'ปิดยอดสต๊อกและเงินสดวันนี้' : 'ปิดสต๊อกและจบงานวันนี้'}
      </button>
      {legacyRefillHistory}
    </section>
  );
}

function IceTypeImage({
  itemName,
  imagePath,
  imageUrls,
  failedImagePaths,
  onImageError,
  onPreviewImage,
}: {
  itemName: string;
  imagePath?: string | null;
  imageUrls: Record<string, string>;
  failedImagePaths: Set<string>;
  onImageError?: (path: string) => void;
  onPreviewImage?: (image: { name: string; url: string }) => void;
}) {
  const imageUrl = imagePath && imageUrls[imagePath] && !failedImagePaths.has(imagePath)
    ? imageUrls[imagePath]
    : null;

  if (!imageUrl) {
    const placeholderLabel = !imagePath
      ? 'ไม่มีรูป'
      : failedImagePaths.has(imagePath)
        ? 'โหลดไม่ได้'
        : 'กำลังโหลด';
    return (
      <span className="daily-stock-count-card__image daily-stock-count-card__image--placeholder">
        <Cube aria-hidden="true" size={25} weight="duotone" />
        <small>{placeholderLabel}</small>
      </span>
    );
  }

  const image = (
    <img
      alt={itemName}
      onError={() => onImageError?.(imagePath!)}
      src={imageUrl}
    />
  );

  return onPreviewImage ? (
    <button
      aria-label={`ดูรูป ${itemName} ขนาดใหญ่`}
      className="daily-stock-count-card__image daily-stock-count-card__image-button"
      onClick={() => onPreviewImage({ name: itemName, url: imageUrl })}
      type="button"
    >
      {image}
    </button>
  ) : (
    <span className="daily-stock-count-card__image">{image}</span>
  );
}

function formatBaht(value: number) {
  return `${Number(value).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} บาท`;
}

function formatSignedBaht(value: number) {
  if (value === 0) return 'ตรงยอด';
  return `${value > 0 ? '+' : ''}${formatBaht(value)}`;
}
