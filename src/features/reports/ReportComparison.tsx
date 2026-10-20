import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { toBangkokDateString } from '../../lib/serviceDate';
import { translateUi, useLanguage } from '../../i18n';
import { Panel, DataTable } from './ReportPrimitives';
import { formatReportDate, reportRangeError, type Preset } from './reportDates';
import { comparisonRange, comparisonRows, changePercent, rangeDays,
  type ComparePreset, type ComparisonRow, type DateRange, type ComparisonSelection } from './comparisonData';
import { exportReportComparison } from './exportExecutiveReport';
import { ComparisonTrend, type TrendSelection } from './ComparisonTrend';
import { demoComparisonReport } from './demoComparisonReport';
import type { DetailQuery, ExecutiveReport } from './types';
import './reportComparison.css';

const number = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 }).format(value);
const amount = (value: number | null, unit: string) => value === null ? '—' : `${number(value)} ${translateUi(unit)}`;
const dateLabel = (range: DateRange) => `${formatReportDate(range.from)} – ${formatReportDate(range.to)}`;
const presets: Array<[ComparePreset, string]> = [
  ['previous', 'ช่วงก่อนหน้าเท่ากัน'], ['week', 'เลื่อนกลับ 1 สัปดาห์'], ['month', 'ช่วงเดียวกันเดือนก่อน'],
  ['year', 'ช่วงเดียวกันปีก่อน'], ['custom', 'กำหนดเอง'],
];
function Delta({ row }: { row: ComparisonRow }) {
  if (row.current === null || row.previous === null) return <span>{translateUi('ข้อมูลไม่พร้อม')}</span>;
  const delta = row.current - row.previous;
  const percent = changePercent(row.current, row.previous);
  return <span className={`report-comparison__delta ${delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : ''}`}>
    {delta > 0 ? '+' : ''}{amount(delta, row.unit)}
    <small>{percent === null ? translateUi('ฐานเป็น 0 · ไม่คิด %') : `${percent > 0 ? '+' : ''}${number(percent)}%`}</small>
  </span>;
}
function ComparisonTable({ rows, label, current, previous, openDetail, sales = false }: {
  rows: ComparisonRow[]; label: string; current: DateRange; previous: DateRange; sales?: boolean;
  openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
}) {
  const unequal = rangeDays(current) !== rangeDays(previous);
  const headings = ['รายการ', 'ช่วง A', 'ช่วง B', 'ส่วนต่าง A − B', ...(unequal ? ['เฉลี่ย/วัน A', 'เฉลี่ย/วัน B'] : [])];
  return rows.length ? <DataTable label={label} headings={headings} numericColumns={[1, 2, 3, 4, 5]}>
    {rows.map((row) => <tr key={row.key}>
      <td data-label={translateUi('รายการ')}>{row.name}</td>
      {(['current', 'previous'] as const).map((side, index) => <td key={side} className="executive-numeric" data-label={translateUi(headings[index + 1])}>
        {sales && row[side] !== null ? <button className="executive-table-link" type="button"
          aria-label={`${row.name} · ${index === 0 ? 'A' : 'B'} · ${amount(row[side], row.unit)}`}
          onClick={(event) => openDetail({ metric: 'sales', areaKind: row.area?.kind, areaId: row.area?.id,
            dateRange: side === 'current' ? current : previous }, row.name, event.currentTarget)}>{amount(row[side], row.unit)}</button> : amount(row[side], row.unit)}
      </td>)}
      <td className="executive-numeric" data-label={translateUi(headings[3])}><Delta row={row} /></td>
      {unequal ? <>
        <td className="executive-numeric" data-label={translateUi(headings[4])}>{amount(row.current === null ? null : row.current / rangeDays(current), row.unit)}</td>
        <td className="executive-numeric" data-label={translateUi(headings[5])}>{amount(row.previous === null ? null : row.previous / rangeDays(previous), row.unit)}</td>
      </> : null}
    </tr>)}
  </DataTable> : <p className="executive-empty">{translateUi('ไม่มีรายการในทั้งสองช่วง')}</p>;
}

export function ReportComparison({ from, to, report, refreshKey, isActive, demoReport, reportError, selection, onSelectionChange, rangePreset, onChoosePreset, openDetail }: {
  from: string; to: string; report: ExecutiveReport | null; refreshKey: number; isActive: boolean;
  demoReport?: ExecutiveReport; reportError?: string | null;
  selection: ComparisonSelection; onSelectionChange: (selection: ComparisonSelection) => void;
  rangePreset: Preset; onChoosePreset: (preset: Exclude<Preset, 'custom'>) => void;
  openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
}) {
  useLanguage();
  const { preset, custom } = selection;
  const [result, setResult] = useState<ExecutiveReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [view, setView] = useState<'areas' | 'products' | 'volumeAreas'>('areas');
  const [unit, setUnit] = useState('');
  const [sort, setSort] = useState<'name' | 'up' | 'down'>('name');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [trendSelection, setTrendSelection] = useState<TrendSelection>({ kind: 'sales', productKey: '', table: false });
  const range = { from, to };
  const baseError = reportRangeError(from, to);
  const compared = preset === 'custom' || baseError ? custom : comparisonRange(range, preset);
  const rangeError = reportRangeError(compared.from, compared.to);
  const today = toBangkokDateString();

  useEffect(() => {
    if (!isActive || rangeError || baseError) return;
    let cancelled = false;
    setLoading(true); setError(null); setResult(null); setExportError(null);
    async function fetchComparison() {
      try {
        if (demoReport) {
          // Demo data is explicitly labeled and never used after a live request fails.
          if (!cancelled) setResult(demoComparisonReport(demoReport, compared));
          return;
        }
        if (!supabase) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase');
        const { data, error: rpcError } = await supabase.rpc('get_executive_report', { p_from: compared.from, p_to: compared.to });
        if (rpcError) throw new Error(rpcError.message);
        if (!data || data.from !== compared.from || data.to !== compared.to) throw new Error('ช่วงวันที่ของข้อมูลไม่ตรงกัน กรุณาลองใหม่');
        if (!cancelled) setResult(data as ExecutiveReport);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'โหลดข้อมูลเปรียบเทียบไม่สำเร็จ');
      } finally { if (!cancelled) setLoading(false); }
    }
    void fetchComparison();
    return () => { cancelled = true; };
  }, [compared.from, compared.to, rangeError, baseError, refreshKey, retry, isActive, demoReport]);

  const previous = !loading && !error && !rangeError && !baseError && result?.from === compared.from && result.to === compared.to ? result : null;
  const current = !baseError && report?.from === from && report.to === to ? report : null;
  const basisMismatch = Boolean(current && previous && current.salesBasis !== previous.salesBasis);
  const rows = current && previous && !basisMismatch ? comparisonRows(current, previous) : null;
  const sorted = (items: ComparisonRow[]) => [...items].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'th')
    : a.unit.localeCompare(b.unit, 'th') || ((a.current ?? 0) - (a.previous ?? 0) - ((b.current ?? 0) - (b.previous ?? 0))) * (sort === 'up' ? -1 : 1));
  const units = [...new Set((rows?.[view] ?? []).map((row) => row.unit))];
  const selectedUnit = units.includes(unit) ? unit : units[0] ?? '';
  const chartRows = sorted(rows?.[view] ?? []).filter((row) => row.unit === selectedUnit);
  const max = Math.max(1, ...chartRows.flatMap((row) => [Math.abs(row.current ?? 0), Math.abs(row.previous ?? 0)]));
  const unequal = !baseError && !rangeError && rangeDays(range) !== rangeDays(compared);
  const summary: ComparisonRow[] = current && previous ? [
    { key: 'sales', name: 'ยอดขายสุทธิ', unit: 'บาท', current: current.sales, previous: previous.sales },
    { key: 'deliveries', name: 'รายการส่ง', unit: 'รายการ', current: current.deliveryCount, previous: previous.deliveryCount },
    ...(rows?.products ?? []),
  ] : [];
  const viewNames = { areas: 'ยอดขายตามพื้นที่', products: 'ปริมาณตามชนิดน้ำแข็ง', volumeAreas: 'ปริมาณตามพื้นที่และชนิด' };

  async function exportComparison() {
    if (!current || !previous || !rows) return;
    setExporting(true); setExportError(null);
    try { await exportReportComparison(current, previous, { areas: sorted(rows.areas), products: sorted(rows.products), volumeAreas: sorted(rows.volumeAreas) }, Boolean(demoReport)); }
    catch (cause) { setExportError(cause instanceof Error ? cause.message : 'ส่งออก Excel ไม่สำเร็จ'); }
    finally { setExporting(false); }
  }

  return <section className="report-comparison executive-report__stack" aria-label={translateUi('เปรียบเทียบยอดขายและน้ำแข็ง')}>
    <Panel title={translateUi('เปรียบเทียบยอดขายและน้ำแข็ง')} description={translateUi('ช่วง A ใช้วันที่ด้านบน · เลือกช่วง B ที่ต้องการเทียบ')}
      action={<div className="executive-report__actions"><button type="button" disabled={!rows || exporting} onClick={() => void exportComparison()}>{translateUi(exporting ? 'กำลังสร้าง Excel…' : 'ส่งออก Excel เปรียบเทียบ')}</button></div>}>
      <div className="executive-presets report-comparison__quick">
        <button type="button" aria-pressed={rangePreset === 'calendarWeek' && preset === 'week'} onClick={() => { onChoosePreset('calendarWeek'); onSelectionChange({ ...selection, preset: 'week' }); }}>{translateUi('สัปดาห์นี้เทียบสัปดาห์ก่อน')}</button>
        <button type="button" aria-pressed={rangePreset === 'week' && preset === 'previous'} onClick={() => { onChoosePreset('week'); onSelectionChange({ ...selection, preset: 'previous' }); }}>{translateUi('7 วันล่าสุดเทียบ 7 วันก่อน')}</button>
        <button type="button" aria-pressed={rangePreset === 'month' && preset === 'month'} onClick={() => { onChoosePreset('month'); onSelectionChange({ ...selection, preset: 'month' }); }}>{translateUi('เดือนนี้เทียบเดือนก่อน')}</button>
      </div>
      <div className="report-comparison__controls">
        <label>{translateUi('เปรียบเทียบกับ')}<select value={preset} onChange={(event) => {
          onSelectionChange({ preset: event.target.value as ComparePreset, custom: event.target.value === 'custom' ? compared : custom });
        }}>{presets.map(([value, label]) => <option key={value} value={value}>{translateUi(label)}</option>)}</select></label>
        <label>{translateUi('ช่วง B จาก')}<input type="date" max={today} value={compared.from} onChange={(event) => {
          onSelectionChange({ custom: { ...compared, from: event.target.value }, preset: 'custom' });
        }} /></label>
        <label>{translateUi('ช่วง B ถึง')}<input type="date" max={today} value={compared.to} onChange={(event) => {
          onSelectionChange({ custom: { ...compared, to: event.target.value }, preset: 'custom' });
        }} /></label>
      </div>
      {rangeError ? <p role="alert" className="executive-error">{translateUi('ช่วง B: ')}{translateUi(rangeError)}</p> : null}
      {!baseError && !rangeError ? <div className="report-comparison__periods">
        <p><b>A</b> {dateLabel(range)} · {rangeDays(range)} {translateUi('วัน')}</p>
        <p><b>B</b> {dateLabel(compared)} · {rangeDays(compared)} {translateUi('วัน')}</p>
      </div> : null}
      {unequal ? <p className="executive-panel-note">{translateUi('ช่วงเวลายาวไม่เท่ากัน · แสดงยอดเฉลี่ยต่อวันควบคู่ยอดรวม')}</p> : null}
      {to === today || compared.to === today ? <p className="executive-panel-note">{translateUi('วันนี้ยังไม่จบวัน · ยอดอาจเปลี่ยนระหว่างวัน')}</p> : null}
      {demoReport ? <p className="executive-panel-note">{translateUi('ข้อมูลจำลอง · ใช้ชุดตัวอย่างเดียวกันในทั้งสองช่วง ไม่ใช่ข้อมูลจริงตามวันที่')}</p> : null}
    </Panel>
    {error ? <p role="alert" className="executive-error">{translateUi('โหลดช่วง B ไม่สำเร็จ: ')}{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>{translateUi('ลองใหม่')}</button></p> : null}
    {basisMismatch ? <p role="alert" className="executive-error">{translateUi('ฐาน VAT ของสองช่วงไม่ตรงกัน กรุณารีเฟรชรายงานก่อนเปรียบเทียบ')}</p> : null}
    {exportError ? <p role="alert" className="executive-error">{exportError}</p> : null}
    {!baseError && !rangeError && !error && !reportError && (!current || !previous) ? <p role="status" className="executive-status">{translateUi('กำลังโหลดข้อมูลสองช่วง…')}</p> : null}
    {current && previous && rows ? <>
      <div className="report-comparison__cards">{summary.map((row) => <article className="report-comparison__card" key={row.key}>
        <h3>{translateUi(row.name)}</h3><strong>{amount(row.current, row.unit)}</strong>
        <p>B: {amount(row.previous, row.unit)}</p><Delta row={row} />
        {unequal ? <small>{translateUi('เฉลี่ย/วัน')} A: {amount(row.current! / rangeDays(range), row.unit)} · B: {amount(row.previous! / rangeDays(compared), row.unit)}</small> : null}
      </article>)}</div>
      <ComparisonTrend current={current} previous={previous} openDetail={openDetail} selection={trendSelection} onSelectionChange={setTrendSelection} />
      <Panel title={translateUi('กราฟเปรียบเทียบสองช่วง')} description={translateUi('ยอดรวมตามพื้นที่หรือชนิดน้ำแข็ง · แยกกราฟตามหน่วย')}>
        <div className="report-comparison__controls">
          <label>{translateUi('ข้อมูลบนกราฟ')}<select value={view} onChange={(event) => setView(event.target.value as typeof view)}>
            {Object.entries(viewNames).map(([value, label]) => <option key={value} value={value}>{translateUi(label)}</option>)}
          </select></label>
          {view !== 'areas' ? <label>{translateUi('หน่วยบนกราฟ')}<select value={selectedUnit} onChange={(event) => setUnit(event.target.value)}>{units.map((value) => <option key={value} value={value}>{translateUi(value)}</option>)}</select></label> : null}
          <label>{translateUi('เรียงรายการ')}<select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
            <option value="name">{translateUi('ชื่อ')}</option><option value="up">{translateUi('เพิ่มมากที่สุด')}</option><option value="down">{translateUi('ลดมากที่สุด')}</option>
          </select></label>
        </div>
        <p className="report-comparison__legend"><span>A · {translateUi('ช่วงที่เลือก')}</span><span>B · {translateUi('ช่วงเปรียบเทียบ')}</span></p>
        <div className="report-comparison__chart" role="group" aria-label={translateUi(`กราฟ${viewNames[view]}`)}>
          {chartRows.map((row) => <div key={row.key} className="report-comparison__chart-row"><strong>{row.name}</strong>
            {(['current', 'previous'] as const).map((side, index) => <div key={side} className={`report-comparison__bar-row is-${side}`}>
              <span>{index === 0 ? 'A' : 'B'}</span><div className="report-comparison__track"><i style={{ width: `${Math.abs(row[side] ?? 0) / max * 100}%` }} /></div><span>{amount(row[side], row.unit)}</span>
            </div>)}
          </div>)}
          {!chartRows.length ? <p className="executive-empty">{translateUi(view === 'volumeAreas' && (!current.volumeAreas || !previous.volumeAreas) ? 'ข้อมูลแยกพื้นที่ไม่พร้อมใช้งาน' : 'ไม่มีรายการในทั้งสองช่วง')}</p> : null}
        </div>
        {chartRows.some((row) => (row.current ?? 0) < 0 || (row.previous ?? 0) < 0) ? <p className="executive-panel-note">{translateUi('ความยาวแท่งแสดงขนาดของยอด · ดูเครื่องหมายลบที่ตัวเลขสำหรับยอดติดลบ')}</p> : null}
      </Panel>
      <Panel title={translateUi('ยอดขายแยกพื้นที่')} description={translateUi('กดยอด A หรือ B เพื่อดูรายการขายของช่วงนั้น')}>
        <ComparisonTable rows={sorted(rows.areas)} label="เปรียบเทียบยอดขายแยกพื้นที่" current={range} previous={compared} openDetail={openDetail} sales />
      </Panel>
      <Panel title={translateUi('ปริมาณน้ำแข็งแยกชนิด')} description={translateUi('ปริมาณส่งตามชนิดและหน่วย · ไม่ใช่จำนวนรายการส่ง')}>
        <ComparisonTable rows={sorted(rows.products)} label="เปรียบเทียบน้ำแข็งแยกชนิด" current={range} previous={compared} openDetail={openDetail} />
      </Panel>
      <Panel title={translateUi('ปริมาณน้ำแข็งแยกพื้นที่และชนิด')}>
        {!current.volumeAreas || !previous.volumeAreas ? <p className="executive-panel-note">{translateUi('ข้อมูลแยกพื้นที่ไม่ครบทั้งสองช่วง · ไม่แสดงข้อมูลที่ขาดเป็นศูนย์')}</p> : null}
        {rows.volumeAreas.length || (current.volumeAreas && previous.volumeAreas) ? <ComparisonTable rows={sorted(rows.volumeAreas)} label="เปรียบเทียบน้ำแข็งแยกพื้นที่" current={range} previous={compared} openDetail={openDetail} /> : null}
      </Panel>
    </> : null}
  </section>;
}
