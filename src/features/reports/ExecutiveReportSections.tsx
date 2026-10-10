import { translateUi, useLanguage } from '../../i18n';
import type { ReactNode } from 'react';
import { reportBucketLabels } from './reportDates';
import type { DetailQuery, ExecutiveReport } from './types';

const baht = (value: number) => new Intl.NumberFormat('th-TH', {
  style: 'currency', currency: 'THB', maximumFractionDigits: 0,
}).format(value);
const number = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value);
const percent = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value);
const areaType = (kind: string) => kind === 'event' ? 'อีเวนต์' : kind === 'casual' ? 'ขายหน้ารถ' : 'อาคาร';

export type ReportSection = 'overview' | 'sales' | 'finance' | 'volume';

const sections: Array<{ id: ReportSection; label: string }> = [
  { id: 'overview', label: 'ภาพรวม' },
  { id: 'sales', label: 'ยอดขาย' },
  { id: 'finance', label: 'เงินรับและลูกหนี้' },
  { id: 'volume', label: 'ปริมาณส่ง' },
];

export function ReportTabs({ active, onChange }: { active: ReportSection; onChange: (section: ReportSection) => void }) {
  useLanguage();
  return <nav aria-label={translateUi('หมวดรายงาน')} className="executive-tabs">
    {sections.map(({ id, label }) => <button aria-current={active === id ? 'page' : undefined}
      key={id} onClick={() => onChange(id)} type="button">{translateUi(label)}</button>)}
  </nav>;
}

function Panel({ title, description, children, label, className = '' }: {
  title: string; description?: string; children: ReactNode; label?: string; className?: string;
}) {
  useLanguage();
  return <section aria-label={label ?? title} className={`executive-panel ${className}`}>
    <div className="executive-panel__head"><div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div></div>
    {children}
  </section>;
}

function DataTable({ headings, children, label }: { headings: string[]; children: ReactNode; label: string }) {
  useLanguage();
  return <div className="executive-data-table__scroll"><table aria-label={label} className="executive-data-table">
    <thead><tr>{headings.map((heading) => <th key={heading} scope="col">{translateUi(heading)}</th>)}</tr></thead>
    <tbody>{children}</tbody>
  </table></div>;
}

function AreaTable({ report, openDetail }: { report: ExecutiveReport; openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void }) {
  useLanguage();
  if (!report.areas.length) return <p className="executive-empty">{translateUi('ยังไม่มียอดขายตามพื้นที่')}</p>;
  return <DataTable headings={['พื้นที่', 'ประเภท', 'ยอดขายสุทธิ', 'สัดส่วนยอดขาย']} label={translateUi('ตารางยอดขายตามพื้นที่')}>
    {report.areas.map((area) => <tr key={`${area.kind}-${area.id ?? 'casual'}`}>
      <td data-label={translateUi('พื้นที่')}><button className="executive-table-link" onClick={(event) => openDetail({ metric: 'sales', areaKind: area.kind, areaId: area.id }, area.name, event.currentTarget)} type="button">{area.name}<span aria-hidden="true"> ›</span></button></td>
      <td data-label={translateUi('ประเภท')}>{translateUi(areaType(area.kind))}</td>
      <td data-label={translateUi('ยอดขายสุทธิ')} className="executive-numeric">{baht(area.sales)}</td>
      <td data-label={translateUi('สัดส่วนยอดขาย')} className="executive-numeric">{report.sales > 0 ? `${percent(area.sales / report.sales * 100)}%` : '—'}</td>
    </tr>)}
  </DataTable>;
}

function ShopTable({ report, openDetail }: { report: ExecutiveReport; openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void }) {
  useLanguage();
  if (!report.shops.length) return <p className="executive-empty">{translateUi('ยังไม่มีร้านที่มียอดขาย')}</p>;
  return <DataTable headings={['อันดับ', 'ร้านค้า', 'ยอดขายสุทธิ']} label={translateUi('ร้านค้ายอดขายสูงสุด')}>
    {report.shops.map((shop, index) => <tr key={shop.id}>
      <td data-label={translateUi('อันดับ')}>{index + 1}</td>
      <td data-label={translateUi('ร้านค้า')}><button className="executive-table-link" onClick={(event) => openDetail({ metric: 'sales', shopId: shop.id }, shop.name, event.currentTarget)} type="button">{shop.name}<span aria-hidden="true"> ›</span></button></td>
      <td data-label={translateUi('ยอดขายสุทธิ')} className="executive-numeric">{baht(shop.sales)}</td>
    </tr>)}
  </DataTable>;
}

function TrendPanel({ report, metric, onMetricChange, showTable, onTableChange, openDetail }: {
  report: ExecutiveReport; metric: 'sales' | 'receipts'; onMetricChange: (metric: 'sales' | 'receipts') => void;
  showTable: boolean; onTableChange: () => void; openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
}) {
  useLanguage();
  const values = report.trend.map((point) => metric === 'sales' ? point.sales : point.receipts - point.refunds);
  const maxPositive = Math.max(0, ...values);
  const maxNegative = Math.max(0, ...values.map((value) => -value));
  const hasNegative = maxNegative > 0;
  const scale = Math.max(1, maxPositive, maxNegative);
  return <Panel title={translateUi('แนวโน้ม')} description={translateUi('เลือกแท่งเพื่อดูรายการในช่วงนั้น')} label={translateUi('แนวโน้มยอดขายและเงินรับ')}>
    <div aria-label={translateUi('เลือกตัวเลขในกราฟ')} className="executive-segment">
      <button aria-pressed={metric === 'sales'} onClick={() => onMetricChange('sales')} type="button">{translateUi('ยอดขาย')}</button>
      <button aria-pressed={metric === 'receipts'} onClick={() => onMetricChange('receipts')} type="button">{translateUi('เงินรับสุทธิ')}</button>
    </div>
    {report.trend.length ? <>
      <div aria-label={translateUi('กราฟ{0}', { 0: metric === 'sales' ? translateUi('ยอดขาย') : translateUi('เงินรับสุทธิ') })} className={`executive-chart ${hasNegative ? 'executive-chart--signed' : ''}`} role="group">
        {report.trend.map((point) => {
          const value = metric === 'sales' ? point.sales : point.receipts - point.refunds;
          const { label, axisLabel } = reportBucketLabels(point.date, report.from, report.to);
          const height = value === 0 ? 0 : Math.max(3, Math.abs(value) / scale * 100);
          return <button aria-label={`${label} ${baht(value)}`} className="executive-chart__item" key={point.date}
            onClick={(event) => openDetail({ metric, bucket: point.date }, label, event.currentTarget)} type="button">
            <span className="executive-chart__plot"><span className="executive-chart__positive">{value > 0 ? <i style={{ height: `${height}%` }} /> : null}</span>
              <span className="executive-chart__negative">{value < 0 ? <i style={{ height: `${height}%` }} /> : null}</span></span>
            <small>{axisLabel}</small>
          </button>;
        })}
      </div>
      <button aria-expanded={showTable} className="executive-text-button" onClick={onTableChange} type="button">{showTable ? translateUi('ซ่อนตารางตัวเลข') : translateUi('ดูตารางตัวเลข')}</button>
      {showTable ? <DataTable headings={['ช่วง', 'ยอดขาย', 'เงินรับจริง', 'คืนเงินจริง', 'เงินรับสุทธิ']} label={translateUi('ตารางแนวโน้ม')}>
        {report.trend.map((row) => <tr key={row.date}><td data-label={translateUi('ช่วง')}>{reportBucketLabels(row.date, report.from, report.to).label}</td>
          <td data-label={translateUi('ยอดขาย')} className="executive-numeric">{baht(row.sales)}</td>
          <td data-label={translateUi('เงินรับจริง')} className="executive-numeric">{baht(row.receipts)}</td>
          <td data-label={translateUi('คืนเงินจริง')} className="executive-numeric">{baht(row.refunds)}</td>
          <td data-label={translateUi('เงินรับสุทธิ')} className="executive-numeric">{baht(row.receipts - row.refunds)}</td></tr>)}
      </DataTable> : null}
    </> : <p className="executive-empty">{translateUi('ยังไม่มีรายการในช่วงนี้')}</p>}
  </Panel>;
}

export function ReportSections({ section, report, trendMetric, setTrendMetric, showTrendTable, toggleTrendTable, openDetail }: {
  section: ReportSection; report: ExecutiveReport; trendMetric: 'sales' | 'receipts';
  setTrendMetric: (metric: 'sales' | 'receipts') => void; showTrendTable: boolean; toggleTrendTable: () => void;
  openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
}) {
  useLanguage();
  if (section === 'overview') return <div className="executive-report__grid">
    <TrendPanel report={report} metric={trendMetric} onMetricChange={setTrendMetric} showTable={showTrendTable} onTableChange={toggleTrendTable} openDetail={openDetail} />
    <Panel title={translateUi('ยอดขายตามพื้นที่')} description={translateUi('5 พื้นที่ยอดขายสูงสุด')} label={translateUi('ยอดขายตามพื้นที่')}>
      {report.areas.length ? <div className="executive-rank-list">{report.areas.slice(0, 5).map((area) =>
        <button key={`${area.kind}-${area.id ?? 'casual'}`} onClick={(event) => openDetail({ metric: 'sales', areaKind: area.kind, areaId: area.id }, area.name, event.currentTarget)} type="button">
          <span><strong>{area.name}</strong><small>{translateUi(areaType(area.kind))}</small></span><b>{baht(area.sales)}</b>
          <i style={{ width: `${Math.max(0, Math.min(100, area.sales / Math.max(1, report.areas[0].sales) * 100))}%` }} />
        </button>)}</div> : <p className="executive-empty">{translateUi('ยังไม่มียอดขายตามพื้นที่')}</p>}
    </Panel>
    <Panel title={translateUi('งานส่งช่วงนี้')} description={translateUi('จำนวนรายการส่งร้าน')}>
      <p className="executive-feature-number">{number(report.deliveryCount)} <small>{translateUi('รายการ')}</small></p>
      <p className="executive-panel-note">{translateUi('ดูจำนวนส่งและเสียหายแยกชนิดน้ำแข็งในแท็บปริมาณส่ง')}</p>
    </Panel>
    <Panel title={translateUi('บิลเกินกำหนด')} description={translateUi('ยอดค้างที่ต้องติดตาม ณ ปัจจุบัน')}>
      <p className="executive-feature-number executive-feature-number--red">{baht(report.overdue)}</p>
      <button className="executive-text-button" onClick={(event) => openDetail({ metric: 'overdue' }, undefined, event.currentTarget)} type="button">{translateUi('ดูร้านค้าและบิลเกินกำหนด ›')}</button>
    </Panel>
  </div>;

  if (section === 'sales') return <div className="executive-report__stack">
    <Panel title={translateUi('ยอดขายตามพื้นที่')} description={translateUi('อาคาร อีเวนต์ และขายหน้ารถ · เลือกชื่อพื้นที่เพื่อดูรายการ')} label={translateUi('ยอดขายตามพื้นที่')}>
      <AreaTable report={report} openDetail={openDetail} />
    </Panel>
    <Panel title={translateUi('ร้านค้ายอดขายสูงสุด')} description={translateUi('10 อันดับในช่วงที่เลือก · เลือกร้านเพื่อดูบิล')}>
      <ShopTable report={report} openDetail={openDetail} />
    </Panel>
  </div>;

  if (section === 'finance') return <div className="executive-report__stack">
    <Panel title={translateUi('เงินรับช่วงนี้')} description={translateUi('เงินรับสุทธิหลังหักเงินคืน')}>
      <div className="executive-finance-flow">
        <button onClick={(event) => openDetail({ metric: 'receipts' }, undefined, event.currentTarget)} type="button"><span>{translateUi('เงินรับจริง')}</span><strong>{baht(report.receipts)}</strong><small>{translateUi('ดูรายการรับเงิน ›')}</small></button>
        <span aria-hidden="true">−</span>
        <button onClick={(event) => openDetail({ metric: 'refunds' }, undefined, event.currentTarget)} type="button"><span>{translateUi('เงินคืนจริง')}</span><strong>{baht(report.refunds)}</strong><small>{translateUi('ดูรายการคืนเงิน ›')}</small></button>
        <span aria-hidden="true">=</span>
        <div><span>{translateUi('เงินรับสุทธิ')}</span><strong>{baht(report.netReceipts)}</strong></div>
      </div>
    </Panel>
    <Panel title={translateUi('ลูกหนี้ปัจจุบัน')} description={translateUi('ยอดหนี้เป็นสถานะปัจจุบัน ไม่ขึ้นกับช่วงวันที่เลือก')}>
      <div className="executive-debt-grid">
        <button onClick={(event) => openDetail({ metric: 'debt' }, undefined, event.currentTarget)} type="button"><span>{translateUi('หนี้ค้างทั้งหมด · ')}{number(report.debtors)}{translateUi(' ร้าน')}</span><strong>{baht(report.outstanding)}</strong><small>{translateUi('ดูร้านค้าและบิลค้าง ›')}</small></button>
        <button onClick={(event) => openDetail({ metric: 'overdue' }, undefined, event.currentTarget)} type="button"><span>{translateUi('เกินกำหนด')}</span><strong>{baht(report.overdue)}</strong><small>{translateUi('ดูร้านค้าและบิลเกินกำหนด ›')}</small></button>
      </div>
    </Panel>
  </div>;

  return <div className="executive-report__stack"><Panel title={translateUi('ปริมาณงานและน้ำแข็ง')} description={translateUi('จำนวนส่งและเสียหาย แยกตามชนิดและหน่วย')}>
    <p className="executive-feature-number">{number(report.deliveryCount)} <small>{translateUi('รายการส่งร้าน')}</small></p>
    {report.products.length ? <DataTable headings={['ชนิดน้ำแข็ง', 'หน่วย', 'จำนวนส่ง', 'เสียหาย']} label={translateUi('ปริมาณงานและน้ำแข็ง')}>
      {report.products.map((product) => <tr key={product.id}>
        <td data-label={translateUi('ชนิดน้ำแข็ง')}>{product.name}</td><td data-label={translateUi('หน่วย')}>{product.unit}</td>
        <td data-label={translateUi('จำนวนส่ง')} className="executive-numeric">{number(product.delivered)}</td>
        <td data-label={translateUi('เสียหาย')} className="executive-numeric">{number(product.damaged)}</td>
      </tr>)}
    </DataTable> : <p className="executive-empty">{translateUi('ยังไม่มีปริมาณน้ำแข็งในช่วงนี้')}</p>}
  </Panel></div>;
}
