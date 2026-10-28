import { useEffect, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Cube, DownloadSimple, Truck } from '@phosphor-icons/react';
import { translateUi, useLanguage } from '../../i18n';
import { shiftServiceDate, toBangkokDateString } from '../../lib/serviceDate';
import { supabase } from '../../lib/supabase';
import { demoComparisonReport } from './demoComparisonReport';
import { formatReportDate } from './reportDates';
import { Panel } from './ReportPrimitives';
import { QuantityTrendChart } from './QuantityTrendChart';
import { exportDailyQuantities } from './exportExecutiveReport';
import type { ExecutiveReport } from './types';

const number = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 }).format(value);

/** One column per product: bags and rows must never be added together. */
export function ReportDailyQuantities({ report, from, to, demo = false, selectedDate, onDateChange, reportLoading = false, reportError }: {
  report: ExecutiveReport | null; from: string; to: string; demo?: boolean; selectedDate: string; onDateChange: (date: string) => void;
  reportLoading?: boolean; reportError?: string | null;
}) {
  useLanguage();
  const today = toBangkokDateString();
  const [exporting, setExporting] = useState(false);
  const [productId, setProductId] = useState('');
  const [showAllDays, setShowAllDays] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<ExecutiveReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const first = from;
  const end = to;
  const previousDate = shiftServiceDate(selectedDate, -1);
  const coversPrevious = (value: ExecutiveReport | null) => value && value.from <= previousDate && value.to >= previousDate;
  const reuseReport = coversPrevious(report);
  const source = report && (reuseReport || coversPrevious(loaded)) ? report : null;

  useEffect(() => {
    setLoaded(null);
    setError(null);
    if (!report || reuseReport) return;
    if (demo) {
      setLoaded(demoComparisonReport(report, { from: previousDate, to: previousDate }));
      return;
    }
    let cancelled = false;
    if (!supabase) { setError('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase'); return; }
    void supabase.rpc('get_executive_report', { p_from: previousDate, p_to: previousDate }).then(({ data, error: rpcError }) => {
      if (cancelled) return;
      if (rpcError) setError(rpcError.message);
      else setLoaded(data as ExecutiveReport);
    }, (cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'โหลดจำนวนขายรายวันไม่สำเร็จ');
    });
    return () => { cancelled = true; };
  }, [report, reuseReport, previousDate, demo, retry]);

  const days = Array.from({ length: (Date.parse(end) - Date.parse(first)) / 86400000 + 1 }, (_, index) => shiftServiceDate(first, index));
  const daily = new Map([...(source && !reuseReport ? loaded?.dailyTrend ?? [] : []), ...(source?.dailyTrend ?? [])]
    .map((day) => [day.date, day]));
  const products = new Map<string, { id: string; name: string; unit: string }>();
  source?.products.forEach((product) => products.set(product.id, product));
  if (source && !reuseReport) loaded?.dailyTrend?.forEach((day) => day.products.forEach((product) => products.set(product.id, product)));
  source?.dailyTrend?.filter((day) => day.date >= first && day.date <= end)
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
  const selectedProduct = columns.find((product) => product.id === productId) ?? columns.find((product) => product.unit === 'ถุง') ?? columns[0];
  const visibleDays = showAllDays ? days : days.filter((date) => date <= selectedDate).slice(-5).reverse();
  const display = (value: number | null) => value === null ? '—' : number(value);
  const canExport = Boolean(source?.dailyTrend && columns.length && !error
    && !reportLoading && !reportError);
  const handleExport = async () => {
    if (!source || !canExport || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      await exportDailyQuantities({
        from, to, selectedDate, previousDate, asOf: source.asOf, days, demo,
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

  // The parent supplies totals for the selected range, excluding the prior comparison day.
  const deliverySummary = report ? <div className="quantity-deliveries" role="region" aria-label={translateUi('จำนวนรายการส่ง')}>
    <Truck size={25} aria-hidden="true" /><div><span>{translateUi('รายการส่งช่วงที่เลือก')}</span><strong>{number(report.deliveryCount)} <small>{translateUi('ครั้ง')}</small></strong>
      <small>{formatReportDate(report.from)} – {formatReportDate(report.to)}</small>
      <small>{translateUi('จำนวนครั้งที่บันทึกส่ง ไม่ใช่จำนวนถุง')}</small></div>
  </div> : null;

  return <Panel title={translateUi('จำนวนขายน้ำแข็งรายวัน')}
    className="executive-daily-quantities"
    action={<div className="executive-quantity-actions"><button aria-label={translateUi(exporting ? 'กำลังสร้างไฟล์จำนวนขาย…' : 'ส่งออกจำนวนขายรายวัน (Excel)')} type="button" disabled={!canExport || exporting} onClick={() => void handleExport()}>
      <DownloadSimple size={18} aria-hidden="true" /> {translateUi(exporting ? 'กำลังสร้างไฟล์จำนวนขาย…' : 'ส่งออก Excel')}
    </button></div>}>
    {demo ? <p className="executive-panel-note quantity-demo-note">{translateUi('ข้อมูลจำลอง · ไม่ใช่ข้อมูลจริงตามวันที่')}</p> : null}
    {exportError ? <p className="executive-error" role="alert">{translateUi(exportError)}</p> : null}
    {reportError && !report ? null : error ? <p className="executive-error" role="alert">{translateUi(error)} <button type="button" onClick={() => setRetry((value) => value + 1)}>{translateUi('ลองใหม่')}</button></p>
      : !source ? <p role="status">{translateUi('กำลังโหลดจำนวนขายรายวัน…')}</p>
      : !source.dailyTrend ? <p role="status">{translateUi('ข้อมูลจำนวนขายรายวันยังไม่พร้อมใช้งาน กรุณาอัปเดตระบบรายงาน')}</p>
      : !columns.length ? <p className="executive-empty">{translateUi('ยังไม่มีรายการขายน้ำแข็งในช่วงนี้')}</p>
      : <>
        <div className="quantity-analysis">
          <section className="quantity-analysis__chart" aria-label={translateUi('แนวโน้มจำนวนขาย')}>
            <div className="quantity-analysis__heading"><h3>{translateUi('แนวโน้มจำนวนขาย')}</h3>
              <select aria-label={translateUi('ชนิดน้ำแข็งในกราฟ')} value={selectedProduct.id} onChange={(event) => setProductId(event.target.value)}>
                {columns.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.unit}</option>)}
              </select>
            </div>
            <QuantityTrendChart name={selectedProduct.name} unit={selectedProduct.unit} selectedDate={selectedDate} onDateChange={onDateChange}
              points={days.filter((date) => date <= end).map((date) => ({ date, value: quantity(date, selectedProduct.id) }))} />
          </section>
          <aside className="quantity-comparison" aria-label={translateUi('เปรียบเทียบจำนวนขาย')}>
            <div className="executive-quantity-controls">
              <h3>{translateUi(selectedDate === today ? 'วันนี้เทียบกับเมื่อวาน' : 'วันที่เลือกเทียบกับวันก่อนหน้า')}</h3>
            </div>
            <ul className="quantity-comparison__list" tabIndex={0} aria-label={translateUi('ยอดเปรียบเทียบแยกชนิดน้ำแข็ง')}>
              {columns.map((product) => {
                const current = quantity(selectedDate, product.id);
                const previous = quantity(previousDate, product.id);
                const difference = current === null || previous === null ? null : current - previous;
                return <li key={product.id} aria-label={product.name}>
                  <span className="quantity-comparison__icon"><Cube size={25} aria-hidden="true" /></span>
                  <div className="quantity-comparison__product"><span>{product.name}</span><strong>{display(current)} <small>{product.unit}</small></strong>
                    <small>{translateUi('วันก่อน')} {display(previous)} {product.unit}</small></div>
                  <div className={`quantity-comparison__delta ${difference === null || difference === 0 ? '' : difference > 0 ? 'executive-quantity-up' : 'executive-quantity-down'}`}>
                    <strong>{difference !== null && difference !== 0 ? difference > 0 ? <ArrowUp size={14} aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" /> : null}
                      {difference === null ? '—' : difference === 0 ? translateUi('เท่าเดิม') : `${difference > 0 ? '+' : ''}${number(difference)} ${product.unit}`}</strong>
                    <small>{translateUi('เทียบ')} {formatReportDate(previousDate)}</small>
                  </div>
                </li>;
              })}
            </ul>
            {deliverySummary}
          </aside>
        </div>
        <div className="quantity-table-heading"><h3>{translateUi(showAllDays ? 'จำนวนขายแต่ละวันในช่วงที่เลือก' : 'รายละเอียดรายวัน')}</h3>
          <span>{formatReportDate(first)} – {formatReportDate(end)}</span></div>
        <div className={`executive-quantity-scroll executive-quantity-scroll--month${showAllDays ? ' is-expanded' : ''}`} role="region" aria-label={translateUi('ตารางจำนวนขายรายวันตามช่วงวันที่')} tabIndex={0}>
          <table className="executive-quantity-table">
            <thead><tr><th scope="col">{translateUi('วันที่')}</th>{columns.map((product) =>
              <th scope="col" key={product.id}>{product.name}<small>{product.unit}</small></th>)}</tr></thead>
            <tbody>{visibleDays.map((date) => <tr key={date} className={date === selectedDate ? 'executive-quantity-selected' : undefined}>
              <th scope="row">{date <= end ? <button type="button" aria-pressed={date === selectedDate}
                onClick={() => onDateChange(date)}>{formatReportDate(date)}{date === today ? ` · ${translateUi('วันนี้')}` : ''}</button>
                : formatReportDate(date)}</th>
              {columns.map((product) => <td key={product.id}>{date > end ? '—' : display(quantity(date, product.id))}</td>)}
            </tr>)}</tbody>
            {showAllDays ? <tfoot><tr><th scope="row">{translateUi('รวมช่วงถึงวันที่')} {formatReportDate(end)}</th>
              {columns.map((product) => <td key={product.id}>{display(total(product.id))}</td>)}</tr></tfoot> : null}
          </table>
        </div>
        <div className="quantity-table-footer"><p className="executive-panel-note">{translateUi('0 = ไม่มีจำนวนขาย · — = ยังไม่มีข้อมูลหรือยังไม่ถึงวันนั้น · วันนี้เป็นยอดที่บันทึกแล้ว ยังไม่ครบวัน')}</p>
          <button type="button" aria-expanded={showAllDays} onClick={() => setShowAllDays((value) => !value)}>{translateUi(showAllDays ? 'แสดง 5 วัน' : 'ดูทุกวันในช่วง')}<ArrowRight size={17} aria-hidden="true" /></button></div>
        <p className="executive-panel-note quantity-source-note">{translateUi('รวมจำนวนส่งร้านและขายหน้ารถตามวันที่ขาย หลังปรับแก้รายการ ไม่รวมของเสีย')}</p>
        <a className="quantity-building-link" href="#executive-volume-areas">{translateUi('ดูปริมาณแยกตามตึก')}<ArrowRight size={19} aria-hidden="true" /></a>
      </>}
    {error || !source?.dailyTrend || !columns.length ? deliverySummary : null}
  </Panel>;
}
