import { ChartBar, CreditCard } from '@phosphor-icons/react';
import { FinancialAnalysis } from './FinancialOverview';
import { money as baht } from './financialReport';
import { toBangkokDateString } from '../../lib/serviceDate';
import { ReportOverview } from './ReportOverview';
import { translateUi, useLanguage } from '../../i18n';
import { formatReportDate, reportBucketLabels } from './reportDates';
import { agingLabels, damageFlags, damageRate, receiptMethodLabels, attentionItems } from './reportInsights';
import { DataTable, Panel, StackBar } from './ReportPrimitives';
import type { DetailQuery, ExecutiveReport } from './types';

const number = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value);
const percent = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value);
const areaType = (kind: string) => kind === 'event' ? 'อีเวนต์' : kind === 'casual' ? 'ขายหน้ารถ' : 'อาคาร';

export type ReportSection = 'overview' | 'sales' | 'finance' | 'volume';

const sections: Array<{ id: ReportSection; label: string }> = [
  { id: 'overview', label: 'ภาพรวม' },
  { id: 'finance', label: 'การเงิน' },
];

export function ReportTabs({ active, onChange }: { active: ReportSection; onChange: (section: ReportSection) => void }) {
  useLanguage();
  return <nav aria-label={translateUi('หมวดรายงาน')} className="executive-tabs">
    {sections.map(({ id, label }) => <button aria-current={(active === id || (id === 'overview' && active !== 'finance')) ? 'page' : undefined}
      key={id} onClick={() => onChange(id)} type="button">{id === 'overview' ? <ChartBar size={19} aria-hidden="true" /> : <CreditCard size={19} aria-hidden="true" />}{translateUi(label)}</button>)}
  </nav>;
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

function VolumeTable({ products, label }: { products: ExecutiveReport['products']; label: string }) {
  useLanguage();
  return <DataTable headings={['ชนิดน้ำแข็ง', 'หน่วย', 'จำนวนส่ง', 'เสียหาย', 'อัตราของเสีย']} label={label}>
    {products.map((product) => {
      const rate = damageRate(product.delivered, product.damaged);
      return <tr key={product.id}>
        <td data-label={translateUi('ชนิดน้ำแข็ง')}>{product.name}</td>
        <td data-label={translateUi('หน่วย')}>{product.unit}</td>
        <td data-label={translateUi('จำนวนส่ง')} className="executive-numeric">{number(product.delivered)}</td>
        <td data-label={translateUi('เสียหาย')} className="executive-numeric">{number(product.damaged)}</td>
        <td data-label={translateUi('อัตราของเสีย')} className="executive-numeric">{rate !== null ? `${percent(rate)}%` : '—'}</td>
      </tr>;
    })}
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

function QuietShopsPanel({ report, openDetail }: {
  report: ExecutiveReport;
  openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
}) {
  useLanguage();
  const quiet = report.quietShops;
  if (!quiet || quiet.total === 0) return null;
  return <Panel
    className="executive-panel--warning"
    description={translateUi('ร้านค้าที่เคยสั่งสม่ำเสมอแต่เงียบไปนานผิดปกติ')}
    id="executive-quiet-shops"
    title={translateUi('ร้านที่หยุดสั่งซื้อ / สัญญาณเตือน')}
  >
    <DataTable
      headings={['ร้านค้า', 'เงียบมาแล้ว', 'รอบปกติ', 'ยอดซื้อเฉลี่ย / เดือน', 'สั่งล่าสุด']}
      label={translateUi('ตารางร้านที่หยุดสั่งซื้อ')}
    >
      {quiet.rows.map((shop) => <tr key={shop.id}>
        <td data-label={translateUi('ร้านค้า')}>
          <button
            className="executive-table-link"
            onClick={(event) => openDetail({ metric: 'sales', shopId: shop.id }, shop.name, event.currentTarget)}
            type="button"
          >
            <strong>{shop.name}</strong>
            {shop.building ? <small className="executive-cell-sub"> · {shop.building}</small> : null}
            <span aria-hidden="true"> ›</span>
          </button>
        </td>
        <td className="executive-numeric executive-numeric--alert" data-label={translateUi('เงียบมาแล้ว')}>
          {translateUi('{0} วัน', { 0: number(shop.daysSince) })}
        </td>
        <td className="executive-numeric" data-label={translateUi('รอบปกติ')}>
          {translateUi('ทุก {0} วัน', { 0: number(shop.usualGap) })}
        </td>
        <td className="executive-numeric" data-label={translateUi('ยอดซื้อเฉลี่ย / เดือน')}>
          {baht(shop.monthlySales)}
        </td>
        <td data-label={translateUi('สั่งล่าสุด')}>
          {formatReportDate(shop.lastOrder)}
        </td>
      </tr>)}
    </DataTable>
    <p className="executive-panel-note">
      {translateUi('ร้านค้าที่สั่งซื้ออย่างน้อย 4 วันในรอบ 90 วัน แต่เงียบไปนานกว่า 2 เท่าของรอบสั่งปกติ')}
    </p>
  </Panel>;
}

function DebtAgingPanel({ report, openDetail }: {
  report: ExecutiveReport;
  openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
}) {
  useLanguage();
  const aging = report.debtAging;
  if (!aging || aging.length === 0) return <Panel title={translateUi('อายุหนี้')}><p>{translateUi('ยังคำนวณไม่ได้ · ขาดข้อมูลวันครบกำหนดและยอดค้างรายบิล')}</p></Panel>;
  const total = report.outstanding;
  const segments = aging.map((b) => ({
    key: b.bucket,
    value: b.amount,
    tone: b.bucket === 'notDue' ? 'blue' : b.bucket === 'days1to7' ? 'amber' : b.bucket === 'days8to30' ? 'orange' : 'red',
  }));

  return <Panel
    description={`${translateUi('ยอด ณ')} ${formatReportDate(toBangkokDateString(new Date(report.asOf)))} · ${translateUi('ไม่ขึ้นกับช่วงวันที่เลือก')}`}
    id="executive-aging"
    title={translateUi('ตารางวิเคราะห์อายุหนี้')}
  >
    <StackBar label={translateUi('อายุหนี้ปัจจุบัน')} segments={segments} />
    <DataTable headings={['อายุหนี้ปัจจุบัน', 'จำนวนเงิน', 'สัดส่วน', 'ลูกหนี้']} label={translateUi('ตารางวิเคราะห์อายุหนี้')}>
      {aging.map((row) => {
        const isOverdue = row.bucket !== 'notDue';
        return <tr key={row.bucket}>
          <td data-label={translateUi('อายุหนี้ปัจจุบัน')}>
            <span className={`executive-aging-tag executive-aging-tag--${row.bucket}`}>
              {translateUi(agingLabels[row.bucket])}
            </span>
          </td>
          <td className="executive-numeric" data-label={translateUi('จำนวนเงิน')}>
            {row.amount > 0 && report.financialVersion === 1 ? (
              <button
                className="executive-table-link"
                onClick={(event) => openDetail({ metric: isOverdue ? 'overdue' : 'debt', agingBucket: row.bucket }, agingLabels[row.bucket], event.currentTarget)}
                type="button"
              >
                {baht(row.amount)}<span aria-hidden="true"> ›</span>
              </button>
            ) : baht(row.amount)}
          </td>
          <td className="executive-numeric" data-label={translateUi('สัดส่วน')}>
            {total > 0 ? `${percent(row.amount / total * 100)}%` : '—'}
          </td>
          <td className="executive-numeric" data-label={translateUi('ลูกหนี้')}>
            {number(row.shops)} {translateUi('ร้าน')}
          </td>
        </tr>;
      })}
    </DataTable>
  </Panel>;
}

function ReceiptMethodsPanel({ report }: { report: ExecutiveReport }) {
  useLanguage();
  const methods = report.receiptMethods;
  if (!methods || methods.length === 0) return null;
  const total = report.receipts;
  return <Panel
    title={translateUi('สัดส่วนช่องทางรับเงิน')}
  >
    <div className="executive-methods-grid">
      {methods.map((item) => {
        const label = receiptMethodLabels[item.method] ?? item.method;
        const share = total > 0 ? (item.amount / total) * 100 : 0;
        return <div className="executive-method-card" key={item.method}>
          <div className="executive-method-card__head">
            <span>{translateUi(label)}</span>
            <small>{percent(share)}%</small>
          </div>
          <strong>{baht(item.amount)}</strong>
          <div className="executive-progress">
            <i style={{ width: `${Math.min(100, Math.max(0, share))}%` }} />
          </div>
        </div>;
      })}
    </div>
  </Panel>;
}

function TrendPanel({ report, metric, onMetricChange, showTable, onTableChange, openDetail }: {
  report: ExecutiveReport; metric: 'sales' | 'receipts'; onMetricChange: (metric: 'sales' | 'receipts') => void;
  showTable: boolean; onTableChange: () => void; openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
}) {
  useLanguage();
  const values = report.trend.map((point) => metric === 'sales' ? point.sales : point.receipts);
  const maxPositive = Math.max(0, ...values);
  const maxNegative = Math.max(0, ...values.map((value) => -value));
  const hasNegative = maxNegative > 0;
  const scale = Math.max(1, maxPositive, maxNegative);
  return <Panel description={translateUi('เลือกแท่งเพื่อดูรายการในช่วงนั้น')} label={translateUi('แนวโน้มยอดขายและเงินรับ')} title={translateUi('แนวโน้ม')}>
    <div aria-label={translateUi('เลือกตัวเลขในกราฟ')} className="executive-segment">
      <button aria-pressed={metric === 'sales'} onClick={() => onMetricChange('sales')} type="button">{translateUi('ยอดขาย')}</button>
      <button aria-pressed={metric === 'receipts'} onClick={() => onMetricChange('receipts')} type="button">{translateUi('เงินรับจริง')}</button>
    </div>
    <p className="executive-panel-note">{translateUi('แนวโน้มกำไร: ยังคำนวณไม่ได้ · ขาดต้นทุนและค่าใช้จ่ายในแต่ละช่วง')}</p>
    {report.trend.length ? <>
      <div aria-label={translateUi('กราฟ{0}', { 0: metric === 'sales' ? translateUi('ยอดขาย') : translateUi('เงินรับจริง') })} className={`executive-chart ${hasNegative ? 'executive-chart--signed' : ''}`} role="group">
        {report.trend.map((point) => {
          const value = metric === 'sales' ? point.sales : point.receipts;
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
          <td className="executive-numeric" data-label={translateUi('ยอดขาย')}>{baht(row.sales)}</td>
          <td className="executive-numeric" data-label={translateUi('เงินรับจริง')}>{baht(row.receipts)}</td>
          <td className="executive-numeric" data-label={translateUi('คืนเงินจริง')}>{baht(row.refunds)}</td>
          <td className="executive-numeric" data-label={translateUi('เงินรับสุทธิ')}>{baht(row.receipts - row.refunds)}</td></tr>)}
      </DataTable> : null}
    </> : <p className="executive-empty">{translateUi('ยังไม่มีรายการในช่วงนี้')}</p>}
  </Panel>;
}

function AttentionBanner({
  report,
  onNavigate,
}: {
  report: ExecutiveReport;
  onNavigate?: (section: ReportSection, targetId?: string) => void;
}) {
  useLanguage();
  const items = attentionItems(report);
  if (!items.length) return null;

  return <section aria-label={translateUi('สัญญาณเตือนและสิ่งที่ต้องติดตาม')} className="executive-attention">
    <div className="executive-attention__head">
      <h2>{translateUi('สิ่งที่ต้องติดตาม / ดำเนินการ')}</h2>
    </div>
    <div className="executive-attention__list">
      {items.map((item) => <div className={`executive-attention__item executive-attention__item--${item.tone}`} key={item.id}>
        <div className="executive-attention__body">
          <strong>{translateUi(item.title, item.titleValues)}</strong>
          <small>{translateUi(item.detail, item.detailValues)}</small>
        </div>
        <div className="executive-attention__right">
          <span className="executive-attention__value">{item.value}</span>
          {onNavigate ? <button
            className="executive-attention__btn"
            onClick={() => onNavigate(item.section, item.target)}
            type="button"
          >
            {translateUi('ดูข้อมูล ›')}
          </button> : null}
        </div>
      </div>)}
    </div>
  </section>;
}

export function ReportSections({
  section, report, trendMetric, setTrendMetric, showTrendTable, toggleTrendTable, openDetail, onNavigateSection,
}: {
  section: ReportSection; report: ExecutiveReport; trendMetric: 'sales' | 'receipts';
  setTrendMetric: (metric: 'sales' | 'receipts') => void; showTrendTable: boolean; toggleTrendTable: () => void;
  openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
  onNavigateSection?: (section: ReportSection, targetId?: string) => void;
}) {
  useLanguage();
  if (section === 'overview') {
    return <div className="executive-report__stack">
      <AttentionBanner report={report} onNavigate={onNavigateSection} />
      <div className="executive-analysis-links">
        <button type="button" onClick={() => onNavigateSection?.('finance')}>{translateUi('วิเคราะห์กำไร เงินสด และลูกหนี้ ›')}</button>
        <button type="button" onClick={() => onNavigateSection?.('sales')}>{translateUi('ดูยอดขาย')}</button>
        {!report.scopeShopId ? <button type="button" onClick={() => onNavigateSection?.('volume')}>{translateUi('รายการส่ง')} {number(report.deliveryCount)} · {translateUi('จำนวนครั้งที่บันทึกส่ง')}</button> : null}
      </div>
      <TrendPanel metric={trendMetric} onMetricChange={setTrendMetric} onTableChange={toggleTrendTable} openDetail={openDetail} report={report} showTable={showTrendTable} />
      <Panel title={translateUi('ขายมาก กับ ทำกำไรมาก')} description={translateUi('ยอดขายสูงไม่ได้แปลว่ากำไรสูง')}>
        <div className="executive-cash-grid">
          <div><span>{translateUi('ลูกค้ายอดขายสูงสุด')}</span>{report.shops.length ? <button type="button" className="executive-table-link" onClick={(event) => openDetail({ metric: 'sales', shopId: report.shops[0].id }, report.shops[0].name, event.currentTarget)}>{report.shops[0].name} · {baht(report.shops[0].sales)} ›</button> : <p>{translateUi('ไม่มีรายการขายลูกค้าในช่วงนี้')}</p>}</div>
          <div><span>{translateUi('พื้นที่ยอดขายสูงสุด')}</span>{report.areas.length ? <button type="button" className="executive-table-link" onClick={(event) => openDetail({ metric: 'sales', areaKind: report.areas[0].kind, areaId: report.areas[0].id }, report.areas[0].name, event.currentTarget)}>{report.areas[0].name} · {baht(report.areas[0].sales)} ›</button> : <p>{translateUi('ไม่มีรายการขายในช่วงนี้')}</p>}</div>
          <div><span>{translateUi('สินค้า / ลูกค้า / เส้นทางที่ทำกำไรสูงสุด')}</span><strong>{translateUi('ยังคำนวณไม่ได้')}</strong><small>{translateUi('ขาดต้นทุนที่เชื่อมกับสินค้า ลูกค้า และเส้นทาง ไม่ใช้ยอดขายแทนกำไร')}</small></div>
        </div>
      </Panel>
    </div>;
  }

  if (section === 'sales') {
    return <div className="executive-report__stack">
      {!report.scopeShopId ? <details className="executive-panel executive-methodology"><summary>{translateUi('ปริมาณสินค้าและพื้นที่จัดส่ง')}</summary><ReportOverview report={report} openDetail={openDetail} onNavigate={onNavigateSection} /></details> : null}
      <TrendPanel metric={trendMetric} onMetricChange={setTrendMetric} onTableChange={toggleTrendTable} openDetail={openDetail} report={report} showTable={showTrendTable} />
      <QuietShopsPanel openDetail={openDetail} report={report} />
      <Panel description={translateUi('อาคาร อีเวนต์ และขายหน้ารถ · เลือกชื่อพื้นที่เพื่อดูรายการ')} label={translateUi('ยอดขายตามพื้นที่')} title={translateUi('ยอดขายตามพื้นที่')}>
        <AreaTable openDetail={openDetail} report={report} />
      </Panel>
      <Panel description={translateUi('10 อันดับในช่วงที่เลือก · เลือกร้านเพื่อดูบิล')} title={translateUi('ร้านค้ายอดขายสูงสุด')}>
        <ShopTable openDetail={openDetail} report={report} />
      </Panel>
    </div>;
  }

  if (section === 'finance') {
    return <div className="executive-report__stack">
      <FinancialAnalysis report={report} openDetail={openDetail} />
      <AttentionBanner onNavigate={onNavigateSection} report={report} />
      <Panel description={translateUi('เงินรับหลังหักเงินคืน ยังไม่หักเงินจ่ายประเภทอื่น จึงไม่ใช่กระแสเงินสดสุทธิ')} title={translateUi('เงินรับช่วงนี้')}>
        <div className="executive-finance-flow">
          <button onClick={(event) => openDetail({ metric: 'receipts' }, undefined, event.currentTarget)} type="button"><span>{translateUi('เงินรับจริง')}</span><strong>{baht(report.receipts)}</strong><small>{translateUi('ดูรายการรับเงิน ›')}</small></button>
          <span aria-hidden="true">−</span>
          <button onClick={(event) => openDetail({ metric: 'refunds' }, undefined, event.currentTarget)} type="button"><span>{translateUi('เงินคืนจริง')}</span><strong>{baht(report.refunds)}</strong><small>{translateUi('ดูรายการคืนเงิน ›')}</small></button>
          <span aria-hidden="true">=</span>
          <div><span>{translateUi('เงินรับสุทธิ')}</span><strong>{baht(report.netReceipts)}</strong></div>
        </div>
      </Panel>
      <ReceiptMethodsPanel report={report} />
      <DebtAgingPanel openDetail={openDetail} report={report} />
      <Panel description={`${translateUi('ยอด ณ')} ${formatReportDate(toBangkokDateString(new Date(report.asOf)))} · ${translateUi('ไม่ขึ้นกับช่วงวันที่เลือก')}`} title={translateUi('ลูกหนี้ปัจจุบัน')}>
        <div className="executive-debt-grid">
          <button onClick={(event) => openDetail({ metric: 'debt' }, undefined, event.currentTarget)} type="button"><span>{translateUi('หนี้ค้างทั้งหมด · ')}{number(report.debtors)}{translateUi(' ร้าน')}</span><strong>{baht(report.outstanding)}</strong><small>{translateUi('ดูร้านค้าและบิลค้าง ›')}</small></button>
          <button onClick={(event) => openDetail({ metric: 'overdue' }, undefined, event.currentTarget)} type="button"><span>{translateUi('เกินกำหนด')}</span><strong>{baht(report.overdue)}</strong><small>{translateUi('ดูร้านค้าและบิลเกินกำหนด ›')}</small></button>
        </div>
      </Panel>
    </div>;
  }

  if (report.scopeShopId) return <Panel title={translateUi('ปริมาณส่งรายร้าน')}><p>{translateUi('ยังไม่รองรับการแยกของเสียและปริมาณตามร้าน กรุณาเลือกขอบเขตทั้งกิจการ')}</p></Panel>;

  const buildings = report.volumeAreas?.filter((area) => area.kind === 'building') ?? [];
  const otherAreas = report.volumeAreas?.filter((area) => area.kind !== 'building') ?? [];
  const flags = damageFlags(report);

  return <div className="executive-report__stack">
    {flags.length > 0 ? <div className="executive-alert-card executive-alert-card--warning">
      <strong>{translateUi('พบจุดส่งที่มีของเสียสูงกว่าปกติ')}</strong>
      <p>{flags.slice(0, 3).map((f) => `${f.areaName}: ${f.productName} (${percent(f.rate)}% · ${translateUi('ของเสียเฉลี่ยรวม {0}', { 0: `${percent(f.average)}%` })})`).join(' · ')}</p>
    </div> : null}
    <Panel description={translateUi('จำนวนส่งและเสียหาย แยกตามชนิดและหน่วย')} title={translateUi('ปริมาณงานและน้ำแข็ง · รวมทั้งหมด')}>
      <p className="executive-feature-number">{number(report.deliveryCount)} <small>{translateUi('รายการส่งร้าน')}</small></p>
      {report.products.length ? <VolumeTable label={translateUi('ปริมาณงานและน้ำแข็ง')} products={report.products} />
        : <p className="executive-empty">{translateUi('ยังไม่มีปริมาณน้ำแข็งในช่วงนี้')}</p>}
    </Panel>
    <section aria-label={translateUi('แยกตามตึก')} className="executive-report__stack" id="executive-volume-areas">
      <div><h2>{translateUi('แยกตามตึก')}</h2>
        <p className="executive-panel-note">{translateUi('จำนวนส่งตามตึกปลายทาง · เสียหายตามจุดสต็อกของตึก')}</p></div>
      {buildings.map((area) => <Panel id={`executive-volume-${area.kind}-${area.id}`} key={area.id} title={area.name}>
        <VolumeTable label={`${translateUi('ปริมาณน้ำแข็ง')} · ${area.name}`} products={area.products} />
      </Panel>)}
      {!buildings.length ? <p className="executive-empty">{translateUi(report.volumeAreas
        ? 'ยังไม่มีปริมาณน้ำแข็งแยกตึกในช่วงนี้' : 'ข้อมูลแยกตึกยังไม่พร้อมใช้งาน')}</p> : null}
    </section>
    {otherAreas.length ? <section aria-label={translateUi('รายการอื่นในยอดรวม')} className="executive-report__stack">
      <h2>{translateUi('รายการอื่นในยอดรวม')}</h2>
      {otherAreas.map((area) => <Panel id={`executive-volume-${area.kind}-${area.id ?? 'none'}`} description={area.kind === 'event' ? translateUi('อีเวนต์') : undefined} key={`${area.kind}-${area.id ?? 'none'}`} title={area.name}>
        <VolumeTable label={`${translateUi('ปริมาณน้ำแข็ง')} · ${area.name}`} products={area.products} />
      </Panel>)}
    </section> : null}
  </div>;
}
