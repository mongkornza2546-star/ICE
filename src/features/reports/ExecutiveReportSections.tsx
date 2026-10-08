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
  return <nav aria-label="หมวดรายงาน" className="executive-tabs">
    {sections.map(({ id, label }) => <button aria-current={active === id ? 'page' : undefined}
      key={id} onClick={() => onChange(id)} type="button">{label}</button>)}
  </nav>;
}

function Panel({ title, description, children, label, className = '' }: {
  title: string; description?: string; children: ReactNode; label?: string; className?: string;
}) {
  return <section aria-label={label ?? title} className={`executive-panel ${className}`}>
    <div className="executive-panel__head"><div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div></div>
    {children}
  </section>;
}

function DataTable({ headings, children, label }: { headings: string[]; children: ReactNode; label: string }) {
  return <div className="executive-data-table__scroll"><table aria-label={label} className="executive-data-table">
    <thead><tr>{headings.map((heading) => <th key={heading} scope="col">{heading}</th>)}</tr></thead>
    <tbody>{children}</tbody>
  </table></div>;
}

function AreaTable({ report, openDetail }: { report: ExecutiveReport; openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void }) {
  if (!report.areas.length) return <p className="executive-empty">ยังไม่มียอดขายตามพื้นที่</p>;
  return <DataTable headings={['พื้นที่', 'ประเภท', 'ยอดขายสุทธิ', 'สัดส่วนยอดขาย']} label="ตารางยอดขายตามพื้นที่">
    {report.areas.map((area) => <tr key={`${area.kind}-${area.id ?? 'casual'}`}>
      <td data-label="พื้นที่"><button className="executive-table-link" onClick={(event) => openDetail({ metric: 'sales', areaKind: area.kind, areaId: area.id }, area.name, event.currentTarget)} type="button">{area.name}<span aria-hidden="true"> ›</span></button></td>
      <td data-label="ประเภท">{areaType(area.kind)}</td>
      <td data-label="ยอดขายสุทธิ" className="executive-numeric">{baht(area.sales)}</td>
      <td data-label="สัดส่วนยอดขาย" className="executive-numeric">{report.sales > 0 ? `${percent(area.sales / report.sales * 100)}%` : '—'}</td>
    </tr>)}
  </DataTable>;
}

function ShopTable({ report, openDetail }: { report: ExecutiveReport; openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void }) {
  if (!report.shops.length) return <p className="executive-empty">ยังไม่มีร้านที่มียอดขาย</p>;
  return <DataTable headings={['อันดับ', 'ร้านค้า', 'ยอดขายสุทธิ']} label="ร้านค้ายอดขายสูงสุด">
    {report.shops.map((shop, index) => <tr key={shop.id}>
      <td data-label="อันดับ">{index + 1}</td>
      <td data-label="ร้านค้า"><button className="executive-table-link" onClick={(event) => openDetail({ metric: 'sales', shopId: shop.id }, shop.name, event.currentTarget)} type="button">{shop.name}<span aria-hidden="true"> ›</span></button></td>
      <td data-label="ยอดขายสุทธิ" className="executive-numeric">{baht(shop.sales)}</td>
    </tr>)}
  </DataTable>;
}

function TrendPanel({ report, metric, onMetricChange, showTable, onTableChange, openDetail }: {
  report: ExecutiveReport; metric: 'sales' | 'receipts'; onMetricChange: (metric: 'sales' | 'receipts') => void;
  showTable: boolean; onTableChange: () => void; openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
}) {
  const values = report.trend.map((point) => metric === 'sales' ? point.sales : point.receipts - point.refunds);
  const maxPositive = Math.max(0, ...values);
  const maxNegative = Math.max(0, ...values.map((value) => -value));
  const hasNegative = maxNegative > 0;
  const scale = Math.max(1, maxPositive, maxNegative);
  return <Panel title="แนวโน้ม" description="เลือกแท่งเพื่อดูรายการในช่วงนั้น" label="แนวโน้มยอดขายและเงินรับ">
    <div aria-label="เลือกตัวเลขในกราฟ" className="executive-segment">
      <button aria-pressed={metric === 'sales'} onClick={() => onMetricChange('sales')} type="button">ยอดขาย</button>
      <button aria-pressed={metric === 'receipts'} onClick={() => onMetricChange('receipts')} type="button">เงินรับสุทธิ</button>
    </div>
    {report.trend.length ? <>
      <div aria-label={`กราฟ${metric === 'sales' ? 'ยอดขาย' : 'เงินรับสุทธิ'}`} className={`executive-chart ${hasNegative ? 'executive-chart--signed' : ''}`} role="group">
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
      <button aria-expanded={showTable} className="executive-text-button" onClick={onTableChange} type="button">{showTable ? 'ซ่อนตารางตัวเลข' : 'ดูตารางตัวเลข'}</button>
      {showTable ? <DataTable headings={['ช่วง', 'ยอดขาย', 'เงินรับจริง', 'คืนเงินจริง', 'เงินรับสุทธิ']} label="ตารางแนวโน้ม">
        {report.trend.map((row) => <tr key={row.date}><td data-label="ช่วง">{reportBucketLabels(row.date, report.from, report.to).label}</td>
          <td data-label="ยอดขาย" className="executive-numeric">{baht(row.sales)}</td>
          <td data-label="เงินรับจริง" className="executive-numeric">{baht(row.receipts)}</td>
          <td data-label="คืนเงินจริง" className="executive-numeric">{baht(row.refunds)}</td>
          <td data-label="เงินรับสุทธิ" className="executive-numeric">{baht(row.receipts - row.refunds)}</td></tr>)}
      </DataTable> : null}
    </> : <p className="executive-empty">ยังไม่มีรายการในช่วงนี้</p>}
  </Panel>;
}

export function ReportSections({ section, report, trendMetric, setTrendMetric, showTrendTable, toggleTrendTable, openDetail }: {
  section: ReportSection; report: ExecutiveReport; trendMetric: 'sales' | 'receipts';
  setTrendMetric: (metric: 'sales' | 'receipts') => void; showTrendTable: boolean; toggleTrendTable: () => void;
  openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
}) {
  if (section === 'overview') return <div className="executive-report__grid">
    <TrendPanel report={report} metric={trendMetric} onMetricChange={setTrendMetric} showTable={showTrendTable} onTableChange={toggleTrendTable} openDetail={openDetail} />
    <Panel title="ยอดขายตามพื้นที่" description="5 พื้นที่ยอดขายสูงสุด" label="ยอดขายตามพื้นที่">
      {report.areas.length ? <div className="executive-rank-list">{report.areas.slice(0, 5).map((area) =>
        <button key={`${area.kind}-${area.id ?? 'casual'}`} onClick={(event) => openDetail({ metric: 'sales', areaKind: area.kind, areaId: area.id }, area.name, event.currentTarget)} type="button">
          <span><strong>{area.name}</strong><small>{areaType(area.kind)}</small></span><b>{baht(area.sales)}</b>
          <i style={{ width: `${Math.max(0, Math.min(100, area.sales / Math.max(1, report.areas[0].sales) * 100))}%` }} />
        </button>)}</div> : <p className="executive-empty">ยังไม่มียอดขายตามพื้นที่</p>}
    </Panel>
    <Panel title="งานส่งช่วงนี้" description="จำนวนรายการส่งร้าน">
      <p className="executive-feature-number">{number(report.deliveryCount)} <small>รายการ</small></p>
      <p className="executive-panel-note">ดูจำนวนส่งและเสียหายแยกชนิดน้ำแข็งในแท็บปริมาณส่ง</p>
    </Panel>
    <Panel title="บิลเกินกำหนด" description="ยอดค้างที่ต้องติดตาม ณ ปัจจุบัน">
      <p className="executive-feature-number executive-feature-number--red">{baht(report.overdue)}</p>
      <button className="executive-text-button" onClick={(event) => openDetail({ metric: 'overdue' }, undefined, event.currentTarget)} type="button">ดูร้านค้าและบิลเกินกำหนด ›</button>
    </Panel>
  </div>;

  if (section === 'sales') return <div className="executive-report__stack">
    <Panel title="ยอดขายตามพื้นที่" description="อาคาร อีเวนต์ และขายหน้ารถ · เลือกชื่อพื้นที่เพื่อดูรายการ" label="ยอดขายตามพื้นที่">
      <AreaTable report={report} openDetail={openDetail} />
    </Panel>
    <Panel title="ร้านค้ายอดขายสูงสุด" description="10 อันดับในช่วงที่เลือก · เลือกร้านเพื่อดูบิล">
      <ShopTable report={report} openDetail={openDetail} />
    </Panel>
  </div>;

  if (section === 'finance') return <div className="executive-report__stack">
    <Panel title="เงินรับช่วงนี้" description="เงินรับสุทธิหลังหักเงินคืน">
      <div className="executive-finance-flow">
        <button onClick={(event) => openDetail({ metric: 'receipts' }, undefined, event.currentTarget)} type="button"><span>เงินรับจริง</span><strong>{baht(report.receipts)}</strong><small>ดูรายการรับเงิน ›</small></button>
        <span aria-hidden="true">−</span>
        <button onClick={(event) => openDetail({ metric: 'refunds' }, undefined, event.currentTarget)} type="button"><span>เงินคืนจริง</span><strong>{baht(report.refunds)}</strong><small>ดูรายการคืนเงิน ›</small></button>
        <span aria-hidden="true">=</span>
        <div><span>เงินรับสุทธิ</span><strong>{baht(report.netReceipts)}</strong></div>
      </div>
    </Panel>
    <Panel title="ลูกหนี้ปัจจุบัน" description="ยอดหนี้เป็นสถานะปัจจุบัน ไม่ขึ้นกับช่วงวันที่เลือก">
      <div className="executive-debt-grid">
        <button onClick={(event) => openDetail({ metric: 'debt' }, undefined, event.currentTarget)} type="button"><span>หนี้ค้างทั้งหมด · {number(report.debtors)} ร้าน</span><strong>{baht(report.outstanding)}</strong><small>ดูร้านค้าและบิลค้าง ›</small></button>
        <button onClick={(event) => openDetail({ metric: 'overdue' }, undefined, event.currentTarget)} type="button"><span>เกินกำหนด</span><strong>{baht(report.overdue)}</strong><small>ดูร้านค้าและบิลเกินกำหนด ›</small></button>
      </div>
    </Panel>
  </div>;

  return <div className="executive-report__stack"><Panel title="ปริมาณงานและน้ำแข็ง" description="จำนวนส่งและเสียหาย แยกตามชนิดและหน่วย">
    <p className="executive-feature-number">{number(report.deliveryCount)} <small>รายการส่งร้าน</small></p>
    {report.products.length ? <DataTable headings={['ชนิดน้ำแข็ง', 'หน่วย', 'จำนวนส่ง', 'เสียหาย']} label="ปริมาณงานและน้ำแข็ง">
      {report.products.map((product) => <tr key={product.id}>
        <td data-label="ชนิดน้ำแข็ง">{product.name}</td><td data-label="หน่วย">{product.unit}</td>
        <td data-label="จำนวนส่ง" className="executive-numeric">{number(product.delivered)}</td>
        <td data-label="เสียหาย" className="executive-numeric">{number(product.damaged)}</td>
      </tr>)}
    </DataTable> : <p className="executive-empty">ยังไม่มีปริมาณน้ำแข็งในช่วงนี้</p>}
  </Panel></div>;
}
