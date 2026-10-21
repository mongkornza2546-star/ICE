import { useEffect, useState } from 'react';
import { translateUi, useLanguage } from '../../i18n';
import { shiftServiceDate, toBangkokDateString } from '../../lib/serviceDate';
import { supabase } from '../../lib/supabase';
import { demoComparisonReport } from './demoComparisonReport';
import { formatReportDate } from './reportDates';
import { Panel } from './ReportPrimitives';
import { exportDailyQuantities } from './exportExecutiveReport';
import type { ExecutiveReport } from './types';

const number = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 }).format(value);

/** One column per product: bags and rows must never be added together. */
export function ReportDailyQuantities({ report, demo = false, selectedDate, onDateChange, reportLoading = false, reportError }: {
  report: ExecutiveReport; demo?: boolean; selectedDate: string; onDateChange: (date: string) => void;
  reportLoading?: boolean; reportError?: string | null;
}) {
  useLanguage();
  const today = toBangkokDateString();
  const month = selectedDate.slice(0, 7);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<ExecutiveReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const first = `${month}-01`;
  const [year, monthNumber] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  const end = last < today ? last : today;
  const previousDate = shiftServiceDate(selectedDate, -1);
  const start = previousDate < first ? previousDate : first;
  const covers = (value: ExecutiveReport | null) => value && value.from <= start && value.to >= end;
  const reuseReport = covers(report);
  const source = reuseReport ? report : covers(loaded) ? loaded : null;

  useEffect(() => {
    setLoaded(null);
    setError(null);
    if (reuseReport) return;
    if (demo) {
      setLoaded(demoComparisonReport(report, { from: start, to: end }));
      return;
    }
    let cancelled = false;
    if (!supabase) { setError('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase'); return; }
    void supabase.rpc('get_executive_report', { p_from: start, p_to: end }).then(({ data, error: rpcError }) => {
      if (cancelled) return;
      if (rpcError) setError(rpcError.message);
      else setLoaded(data as ExecutiveReport);
    }, (cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'โหลดจำนวนขายรายวันไม่สำเร็จ');
    });
    return () => { cancelled = true; };
  }, [report, reuseReport, start, end, demo, retry]);

  const days = Array.from({ length: Number(last.slice(-2)) }, (_, index) => shiftServiceDate(first, index));
  const daily = new Map(source?.dailyTrend?.map((day) => [day.date, day]));
  const products = new Map<string, { id: string; name: string; unit: string }>();
  source?.products.forEach((product) => products.set(product.id, product));
  source?.dailyTrend?.filter((day) => day.date >= start && day.date <= end)
    .forEach((day) => day.products.forEach((product) => products.set(product.id, product)));
  const columns = [...products.values()];
  const quantity = (date: string, id: string) => {
    const day = daily.get(date);
    return day ? day.products.find((product) => product.id === id)?.delivered ?? 0 : null;
  };
  const total = (id: string) => {
    const values = days.filter((date) => date <= end).map((date) => quantity(date, id));
    return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  };
  const display = (value: number | null) => value === null ? '—' : number(value);
  const canExport = Boolean(source?.dailyTrend && columns.length && !error
    && !(reuseReport && (reportLoading || reportError)));
  const handleExport = async () => {
    if (!source || !canExport || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      await exportDailyQuantities({
        month, selectedDate, previousDate, end, asOf: source.asOf, days, demo,
        products: columns.map((product) => ({
          name: product.name, unit: product.unit,
          current: quantity(selectedDate, product.id), previous: quantity(previousDate, product.id),
          total: total(product.id),
          daily: days.map((date) => date > end ? null : quantity(date, product.id)),
        })),
      });
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : 'ส่งออกจำนวนขายรายวันไม่สำเร็จ');
    } finally {
      setExporting(false);
    }
  };

  return <Panel title={translateUi('จำนวนขายน้ำแข็งรายวัน')}
    description={translateUi('แยกชนิดและหน่วย · ตารางนี้ใช้เดือนที่เลือกในกล่อง แยกจากช่วงวันที่หลัก')}
    className="executive-daily-quantities"
    action={<div className="executive-quantity-actions"><label className="executive-quantity-month">{translateUi('เดือนที่ต้องการดู')}
      <input type="month" value={month} max={today.slice(0, 7)} onChange={(event) => {
        const value = event.target.value;
        if (!/^\d{4}-\d{2}$/.test(value) || value > today.slice(0, 7)) return;
        const [y, m] = value.split('-').map(Number);
        onDateChange(value === today.slice(0, 7) ? today : new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10));
      }} />
    </label><button type="button" disabled={!canExport || exporting} onClick={() => void handleExport()}>
      {translateUi(exporting ? 'กำลังสร้างไฟล์จำนวนขาย…' : 'ส่งออกจำนวนขายรายวัน (Excel)')}
    </button></div>}>
    {demo ? <p className="executive-panel-note">{translateUi('ข้อมูลจำลอง · ไม่ใช่ข้อมูลจริงตามวันที่')}</p> : null}
    {exportError ? <p className="executive-error" role="alert">{translateUi(exportError)}</p> : null}
    {error ? <p className="executive-error" role="alert">{translateUi(error)} <button type="button" onClick={() => setRetry((value) => value + 1)}>{translateUi('ลองใหม่')}</button></p>
      : !source ? <p role="status">{translateUi('กำลังโหลดจำนวนขายรายวัน…')}</p>
      : !source.dailyTrend ? <p role="status">{translateUi('ข้อมูลจำนวนขายรายวันยังไม่พร้อมใช้งาน กรุณาอัปเดตระบบรายงาน')}</p>
      : !columns.length ? <p className="executive-empty">{translateUi('ยังไม่มีรายการขายน้ำแข็งในเดือนนี้')}</p>
      : <>
        <div className="executive-quantity-controls">
          <h3>{translateUi(selectedDate === today ? 'วันนี้เทียบกับเมื่อวาน' : 'วันที่เลือกเทียบกับวันก่อนหน้า')}</h3>
          <label>{translateUi('วันที่เปรียบเทียบ')}<input type="date" min={first} max={end} value={selectedDate}
            onChange={(event) => {
              const value = event.target.value;
              if (value >= first && value <= end) onDateChange(value);
            }} /></label>
        </div>
        <div className="executive-quantity-scroll" role="region" aria-label={translateUi('ตารางเปรียบเทียบจำนวนขาย')} tabIndex={0}>
          <table className="executive-quantity-table">
            <thead><tr><th scope="col">{translateUi('ชนิดน้ำแข็ง')}</th><th scope="col">{formatReportDate(selectedDate)}</th>
              <th scope="col">{formatReportDate(previousDate)}</th><th scope="col">{translateUi('เพิ่ม / ลด')}</th></tr></thead>
            <tbody>{columns.map((product) => {
              const current = quantity(selectedDate, product.id);
              const previous = quantity(previousDate, product.id);
              const difference = current === null || previous === null ? null : current - previous;
              return <tr key={product.id}><th scope="row">{product.name}<small>{product.unit}</small></th>
                <td>{display(current)}</td><td>{display(previous)}</td>
                <td className={difference === null || difference === 0 ? '' : difference > 0 ? 'executive-quantity-up' : 'executive-quantity-down'}>
                  {difference === null ? '—' : difference === 0 ? translateUi('เท่าเดิม') : `${difference > 0 ? '+' : ''}${number(difference)} ${product.unit}`}
                </td></tr>;
            })}</tbody>
          </table>
        </div>
        <h3 className="executive-quantity-month-heading">{translateUi('จำนวนขายแต่ละวันทั้งเดือน')}</h3>
        <p className="executive-panel-note">{translateUi('0 = ไม่มีจำนวนขาย · — = ยังไม่มีข้อมูลหรือยังไม่ถึงวันนั้น · วันนี้เป็นยอดที่บันทึกแล้ว ยังไม่ครบวัน')}</p>
        <div className="executive-quantity-scroll executive-quantity-scroll--month" role="region" aria-label={translateUi('ตารางจำนวนขายรายวันทั้งเดือน')} tabIndex={0}>
          <table className="executive-quantity-table">
            <thead><tr><th scope="col">{translateUi('วันที่')}</th>{columns.map((product) =>
              <th scope="col" key={product.id}>{product.name}<small>{product.unit}</small></th>)}</tr></thead>
            <tbody>{days.map((date) => <tr key={date} className={date === selectedDate ? 'executive-quantity-selected' : undefined}>
              <th scope="row">{date <= end ? <button type="button" aria-pressed={date === selectedDate}
                onClick={() => onDateChange(date)}>{formatReportDate(date)}{date === today ? ` · ${translateUi('วันนี้')}` : ''}</button>
                : formatReportDate(date)}</th>
              {columns.map((product) => <td key={product.id}>{date > end ? '—' : display(quantity(date, product.id))}</td>)}
            </tr>)}</tbody>
            <tfoot><tr><th scope="row">{translateUi('รวมเดือนถึงวันที่')} {formatReportDate(end)}</th>
              {columns.map((product) => <td key={product.id}>{display(total(product.id))}</td>)}</tr></tfoot>
          </table>
        </div>
        <p className="executive-panel-note">{translateUi('รวมจำนวนส่งร้านและขายหน้ารถตามวันที่ขาย หลังปรับแก้รายการ ไม่รวมของเสีย')}</p>
      </>}
  </Panel>;
}
