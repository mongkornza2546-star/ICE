import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle, Cube, Warning } from '@phosphor-icons/react';
import { supabase } from '../../../lib/supabase';

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
  const [legacyRefills, setLegacyRefills] = useState<LegacyRefillHistoryItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRequest = useRef<{ signature: string; key: string } | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    const [summaryResponse, legacyRefillsResponse] = await Promise.all([
      supabase.rpc('get_daily_aggregate_stock_summary', { p_service_date: serviceDate }),
      supabase.rpc('get_daily_stock_refill_history', { p_service_date: serviceDate }),
    ]);
    const loadError = summaryResponse.error ?? legacyRefillsResponse.error;
    if (loadError) setError(loadError.message);
    if (summaryResponse.data) {
      const next = summaryResponse.data as AggregateSummary;
      setSummary(next);
      setCounts(Object.fromEntries(
        next.items.map((item) => [item.ice_type_id, Number(item.available_quantity)]),
      ));
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

  const close = async () => {
    if (!supabase || !summary || submitting) return;
    if (hasVariance && !note.trim()) {
      setError('กรอกหมายเหตุเมื่อยอดนับจริงต่างจากยอดตามระบบ');
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
      note: note.trim() || null,
    });
    if (pendingRequest.current?.signature !== signature) {
      pendingRequest.current = { signature, key: crypto.randomUUID() };
    }
    try {
      const { error: closeError } = await supabase.rpc('close_daily_aggregate_stock', {
        p_service_date: serviceDate,
        p_counts: closeItems,
        p_note: note.trim() || null,
        p_idempotency_key: pendingRequest.current.key,
      });
      if (closeError) {
        setError(closeError.message);
      } else {
        pendingRequest.current = null;
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
      else await load();
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
        disabled={submitting || (hasVariance && !note.trim())}
        onClick={() => void close()}
        style={{ marginTop: 16 }}
        type="button"
      >
        {submitting ? 'กำลังปิดสต๊อก...' : 'ปิดสต๊อกและจบงานวันนี้'}
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
