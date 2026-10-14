import { translateUi, uiDateTimeFormat } from '../../i18n';
import { Panel, DataTable } from './ReportPrimitives';
import { formatReportDate } from './reportDates';
import { comparisonTimeline, timelineProducts, type TimelineMetric, type TimelinePoint } from './comparisonData';
import type { DetailQuery, ExecutiveReport } from './types';

const number = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 }).format(value);
const dateTick = (date: string | null) => date ? uiDateTimeFormat({ day: 'numeric', month: 'numeric', weekday: 'short' })
  .format(new Date(`${date}T12:00:00+07:00`)) : '—';

export type TrendSelection = { kind: 'sales' | 'volume'; productKey: string; table: boolean };

export function ComparisonTrend({ current, previous, openDetail, selection, onSelectionChange }: {
  current: ExecutiveReport; previous: ExecutiveReport;
  selection: TrendSelection; onSelectionChange: (selection: TrendSelection) => void;
  openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
}) {
  const { kind, productKey, table } = selection;
  const products = timelineProducts(current, previous);
  const key = (product: { id: string; unit: string }) => JSON.stringify([product.id, product.unit]);
  const product = products.find((item) => key(item) === productKey) ?? products[0];
  const metric: TimelineMetric = kind === 'sales' ? { kind } : { kind, productId: product?.id ?? '', unit: product?.unit ?? '' };
  const unit = kind === 'sales' ? 'บาท' : product?.unit ?? '';
  const points = comparisonTimeline(current, previous, metric);
  const values = points.flatMap((point) => [point.current, point.previous]).filter((value): value is number => value !== null);
  const hasData = values.length > 0 && (kind === 'sales' || Boolean(product));
  const low = Math.min(0, ...values), high = Math.max(1, ...values);
  const x = (index: number) => 64 + index / Math.max(1, points.length - 1) * 630;
  const y = (value: number) => 22 + (high - value) / (high - low) * 190;
  const path = (side: 'current' | 'previous') => {
    let connected = false;
    return points.map((point, index) => {
      const value = point[side];
      if (value === null) { connected = false; return ''; }
      const command = connected ? 'L' : 'M'; connected = true;
      return `${command}${x(index)},${y(value)}`;
    }).join(' ');
  };
  const ticks = [...new Set(Array.from({ length: Math.min(6, points.length) }, (_, index) =>
    Math.round(index * (points.length - 1) / Math.max(1, Math.min(6, points.length) - 1))))];
  const valueText = (value: number | null) => value === null ? '—' : `${number(value)} ${translateUi(unit)}`;
  const dateOf = (point: TimelinePoint, side: 'current' | 'previous') => side === 'current' ? point.currentDate : point.previousDate;
  return <Panel title={translateUi('แนวโน้มรายวัน · เปรียบเทียบสองช่วง')}
    description={translateUi('วันที่ 1 ของ A เทียบวันที่ 1 ของ B · ปุ่มสัปดาห์นี้จับคู่วันจันทร์กับวันจันทร์')}>
    <div className="report-comparison__controls">
      <label>{translateUi('ข้อมูลแนวโน้ม')}<select value={kind} onChange={(event) => onSelectionChange({ ...selection, kind: event.target.value as typeof kind })}>
        <option value="sales">{translateUi('ยอดขาย')}</option><option value="volume">{translateUi('ปริมาณน้ำแข็ง')}</option>
      </select></label>
      {kind === 'volume' ? <label>{translateUi('ชนิดน้ำแข็งในแนวโน้ม')}<select value={product ? key(product) : ''}
        onChange={(event) => onSelectionChange({ ...selection, productKey: event.target.value })}>
        {products.map((item) => <option key={key(item)} value={key(item)}>{item.name} ({translateUi(item.unit)})</option>)}
      </select></label> : null}
    </div>
    <p className="report-comparison__legend"><span>A · {formatReportDate(current.from)} – {formatReportDate(current.to)}</span>
      <span>B · {formatReportDate(previous.from)} – {formatReportDate(previous.to)}</span></p>
    {hasData ? <div className="report-comparison__timeline-scroll"><svg className="report-comparison__timeline" viewBox="0 0 750 290" role="img"
      aria-label={translateUi(kind === 'sales' ? 'กราฟแนวโน้มยอดขายรายวัน A และ B' : 'กราฟแนวโน้มปริมาณน้ำแข็งรายวัน A และ B')}>
      <title>{translateUi(kind === 'sales' ? 'ยอดขายรายวัน' : 'ปริมาณน้ำแข็งรายวัน')} · {kind === 'volume' ? product?.name : ''} ({translateUi(unit)})</title>
      {Array.from({ length: 5 }, (_, index) => low + (high - low) * index / 4).map((value, index) => <g key={index}>
        <line x1="64" x2="694" y1={y(value)} y2={y(value)} stroke="#e0e7f0" />
        <text x="56" y={y(value) + 4} textAnchor="end">{number(value)}</text>
      </g>)}
      <line x1="64" x2="694" y1={y(0)} y2={y(0)} stroke="#8393a8" />
      {(['current', 'previous'] as const).map((side) => <g key={side}>
        <path d={path(side)} fill="none" stroke={side === 'current' ? '#1769e8' : '#a26405'} strokeWidth="2.5"
          strokeDasharray={side === 'previous' ? '7 5' : undefined} />
        {points.map((point, index) => point[side] === null ? null : <circle key={point.day} cx={x(index)} cy={y(point[side]!)}
          r={points.length > 60 ? 2 : 3.5} fill={side === 'current' ? '#1769e8' : '#fff'} stroke={side === 'current' ? '#1769e8' : '#a26405'}>
          <title>{side === 'current' ? 'A' : 'B'} · {formatReportDate(dateOf(point, side)!)} · {valueText(point[side])}</title>
        </circle>)}
      </g>)}
      {ticks.map((index) => <g key={index}>
        <text x={x(index)} y="237" textAnchor="middle">{translateUi('วัน')} {index + 1}</text>
        <text x={x(index)} y="256" textAnchor="middle" fill="#075ed8">A: {dateTick(points[index].currentDate)}</text>
        <text x={x(index)} y="275" textAnchor="middle" fill="#9b5a04">B: {dateTick(points[index].previousDate)}</text>
      </g>)}
    </svg></div> : <p className="executive-empty">{translateUi(kind === 'volume' && !products.length
      ? 'ไม่มีชนิดน้ำแข็งในทั้งสองช่วง' : 'ข้อมูลแนวโน้มรายวันยังไม่พร้อมใช้งาน')}</p>}
    {points.some((point) => (point.currentDate && point.current === null) || (point.previousDate && point.previous === null)) ?
      <p className="executive-panel-note">{translateUi('ข้อมูลรายวันบางช่วงยังไม่พร้อม · ไม่แทนข้อมูลที่ขาดด้วยศูนย์')}</p> : null}
    <p className="executive-panel-note">{translateUi('0 = ไม่มีรายการในวันนั้น · — = อยู่นอกช่วงหรือข้อมูลยังไม่พร้อม · ดูตารางเพื่ออ่านค่าทุกวัน')}</p>
    <button type="button" className="executive-text-button" aria-expanded={table} onClick={() => onSelectionChange({ ...selection, table: !table })}>{translateUi(table ? 'ซ่อนตารางรายวัน' : 'ดูตารางรายวัน')}</button>
    {table ? <ComparisonDailyTable points={points} unit={unit} sales={kind === 'sales'} openDetail={openDetail} /> : null}
  </Panel>;
}

function ComparisonDailyTable({ points, unit, sales, openDetail }: {
  points: TimelinePoint[]; unit: string; sales: boolean;
  openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
}) {
  return <DataTable label={translateUi('ตารางเปรียบเทียบรายวัน')} headings={['ลำดับวัน', 'วันที่ A', 'ยอด A', 'วันที่ B', 'ยอด B']} numericColumns={[2, 4]}>
    {points.map((point) => <tr key={point.day}><td data-label={translateUi('ลำดับวัน')}>{point.day}</td>
      {(['current', 'previous'] as const).map((side) => {
        const date = side === 'current' ? point.currentDate : point.previousDate;
        const letter = side === 'current' ? 'A' : 'B';
        const value = point[side];
        return <DailyCells key={side} date={date} letter={letter} value={value} unit={unit} sales={sales} openDetail={openDetail} />;
      })}
    </tr>)}
  </DataTable>;
}
function DailyCells({ date, letter, value, unit, sales, openDetail }: {
  date: string | null; letter: string; value: number | null; unit: string; sales: boolean;
  openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
}) {
  const valueText = value === null ? '—' : `${number(value)} ${translateUi(unit)}`;
  return <><td data-label={`${translateUi('วันที่')} ${letter}`}>{date ? formatReportDate(date) : '—'}</td>
    <td className="executive-numeric" data-label={`${translateUi('ยอด')} ${letter}`}>
      {sales && date && value !== null ? <button type="button" className="executive-table-link" aria-label={`${letter} · ${date} · ${valueText}`}
        onClick={(event) => openDetail({ metric: 'sales', dateRange: { from: date, to: date } }, `${letter} · ${formatReportDate(date)}`, event.currentTarget)}>{valueText}</button> : valueText}
    </td></>;
}
