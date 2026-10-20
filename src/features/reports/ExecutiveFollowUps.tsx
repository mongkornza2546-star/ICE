import { useEffect, useState } from 'react';
import { translateUi, useLanguage } from '../../i18n';
import { toBangkokDateString } from '../../lib/serviceDate';
import { supabase } from '../../lib/supabase';
import { formatReportDate } from './reportDates';
import type { ExecutiveReport, ReportRow } from './types';
import './ExecutiveFollowUps.css';

const baht = (value: number) => new Intl.NumberFormat('th-TH', {
  style: 'currency', currency: 'THB', minimumFractionDigits: 0, maximumFractionDigits: 2,
}).format(value);
const number = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value);

function topShops(rows: ReportRow[]) {
  return [...rows].sort((a, b) => b.amount - a.amount || a.day.localeCompare(b.day) || a.id.localeCompare(b.id)).slice(0, 5);
}

function overdueDays(dueDate: string | null | undefined, asOfDate: string) {
  if (!dueDate) return null;
  const days = (Date.parse(`${asOfDate}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86400000;
  return Number.isFinite(days) ? Math.max(0, Math.floor(days)) : null;
}

type FollowUpResult = {
  report: ExecutiveReport;
  demoRows?: ReportRow[];
  rows: ReportRow[];
  error: string | null;
};

export function ExecutiveFollowUps({ report, isActive, demoRows, onOpenShop, onOpenAll }: {
  report: ExecutiveReport;
  isActive: boolean;
  demoRows?: ReportRow[];
  onOpenShop: (row: ReportRow, trigger: HTMLElement) => void;
  onOpenAll: (trigger: HTMLElement) => void;
}) {
  useLanguage();
  const [result, setResult] = useState<FollowUpResult | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    if (!isActive || report.overdue <= 0) return;
    if (demoRows !== undefined) {
      setResult({ report, demoRows, rows: topShops(demoRows), error: null });
      return;
    }
    void (async () => {
      try {
        if (!supabase) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase');
        const { data, error } = await supabase.rpc('get_executive_report_details', {
          p_from: report.from, p_to: report.to, p_metric: 'overdue', p_limit: 5, p_offset: 0,
          p_bucket: null, p_area_kind: null, p_area_id: null, p_shop_id: null,
        });
        if (error) throw new Error(error.message);
        if (!data || !Array.isArray(data.rows)) throw new Error('โหลดรายการไม่สำเร็จ');
        if (!cancelled) setResult({ report, rows: topShops(data.rows as ReportRow[]), error: null });
      } catch (cause: unknown) {
        if (!cancelled) setResult({ report, rows: [],
          error: cause instanceof Error ? cause.message : 'โหลดรายการไม่สำเร็จ' });
      }
    })();
    return () => { cancelled = true; };
  }, [report, isActive, demoRows, retry]);

  if (!isActive) return null;
  const shown = result?.report === report && result.demoRows === demoRows ? result : null;
  const asOfDate = toBangkokDateString(new Date(report.asOf));
  const hasOverdue = report.overdue > 0;
  const loading = hasOverdue && !shown;

  return <section aria-label={translateUi('ต้องติดตาม')} className="executive-panel executive-follow-ups">
    <div className="executive-panel__head executive-follow-ups__head">
      <div>
        <h2>{translateUi('ต้องติดตาม')}</h2>
        <p>{translateUi('ยอดหนี้ ณ {0} · ไม่ขึ้นกับช่วงวันที่เลือก', { 0: formatReportDate(asOfDate) })}</p>
      </div>
      {hasOverdue ? <button className="executive-text-button" onClick={(event) => onOpenAll(event.currentTarget)} type="button">
        {translateUi('ดูร้านเกินกำหนดทั้งหมด ›')}
      </button> : null}
    </div>
    <div className="executive-follow-ups__summary">
      <span>{translateUi('หนี้เกินกำหนดปัจจุบัน')}</span>
      <strong>{baht(report.overdue)}</strong>
      {report.outstanding > 0 ? <span>{translateUi('{0}% ของหนี้ค้างปัจจุบัน', {
        0: number(report.overdue / report.outstanding * 100),
      })}</span> : null}
    </div>
    {!hasOverdue ? <p className="executive-empty">{translateUi('ไม่มีหนี้เกินกำหนดที่ต้องติดตาม')}</p>
      : loading ? <p className="executive-status" role="status">{translateUi('กำลังโหลดร้านที่ต้องติดตาม…')}</p>
        : shown?.error ? <div className="executive-error" role="alert">
          {translateUi('โหลดร้านที่ต้องติดตามไม่สำเร็จ')}: {translateUi(shown.error)}
          <button onClick={() => { setResult(null); setRetry((value) => value + 1); }} type="button">{translateUi('ลองใหม่')}</button>
        </div> : shown?.rows.length ? <>
          <p className="executive-follow-ups__caption">{translateUi('5 ร้านที่มียอดเกินกำหนดสูงสุด · เลือกร้านเพื่อดูบิล')}</p>
          <ol aria-label={translateUi('ร้านที่ต้องติดตาม')} className="executive-follow-ups__list">
            {shown.rows.map((row) => {
              const days = overdueDays(row.dueDate, asOfDate);
              return <li key={row.id}>
                <button data-follow-up-shop={row.shopId} onClick={(event) => onOpenShop(row, event.currentTarget)} type="button">
                  <span className="executive-follow-ups__shop"><strong>{row.label}</strong>
                    <small>{days === null ? translateUi('ไม่ระบุวันครบกำหนด') : translateUi('เกินกำหนดนานสุด {0} วัน', { 0: number(days) })}</small>
                  </span>
                  <span className="executive-follow-ups__amount"><b>{baht(row.amount)}</b><span aria-hidden="true"> ›</span></span>
                </button>
              </li>;
            })}
          </ol>
        </> : <p className="executive-empty" role="status">{translateUi('ไม่พบรายการร้านค้า กรุณารีเฟรชรายงาน')}</p>}
  </section>;
}
