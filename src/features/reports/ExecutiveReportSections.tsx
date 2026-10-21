import { useState } from 'react';
import { ChartBar, ChartLine, CreditCard, Cube } from '@phosphor-icons/react';
import { ReportOverview } from './ReportOverview';
import { translateUi, useLanguage } from '../../i18n';
import { formatReportDate, reportBucketLabels } from './reportDates';
import { agingLabels, damageFlags, damageRate, receiptMethodLabels, attentionItems } from './reportInsights';
import { DataTable, Panel, StackBar } from './ReportPrimitives';
import type { DetailQuery, ExecutiveReport } from './types';
import { shiftServiceDate, toBangkokDateString } from '../../lib/serviceDate';

const baht = (value: number) => new Intl.NumberFormat('th-TH', {
  style: 'currency', currency: 'THB', minimumFractionDigits: 0, maximumFractionDigits: 2,
}).format(value);
const number = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value);
const percent = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value);
const areaType = (kind: string) => kind === 'event' ? 'อีเวนต์' : kind === 'casual' ? 'ขายหน้ารถ' : 'อาคาร';

export type ReportSection = 'overview' | 'sales' | 'finance' | 'volume';

const sections: Array<{ id: ReportSection; label: string }> = [
  { id: 'overview', label: 'ภาพรวม' },
  { id: 'sales', label: 'ยอดขาย' },
  { id: 'finance', label: 'เงินรับและลูกหนี้' },
  { id: 'volume', label: 'ปริมาณ' },
];

export function ReportTabs({ active, onChange }: { active: ReportSection; onChange: (section: ReportSection) => void }) {
  useLanguage();
  return <nav aria-label={translateUi('หมวดรายงาน')} className="executive-tabs">
    {sections.map(({ id, label }) => <button aria-current={active === id ? 'page' : undefined}
      key={id} onClick={() => onChange(id)} type="button">{id === 'overview' ? <ChartBar size={19} aria-hidden="true" /> : id === 'sales' ? <ChartLine size={19} aria-hidden="true" /> : id === 'volume' ? <Cube size={19} aria-hidden="true" /> : <CreditCard size={19} aria-hidden="true" />}{translateUi(label)}</button>)}
  </nav>;
}

function AreaTable({ report, openDetail }: { report: ExecutiveReport; openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void }) {
  useLanguage();
  if (!report.areas.length) return <p className="executive-empty">{translateUi('ยังไม่มียอดขายตามพื้นที่')}</p>;
  return <DataTable headings={['พื้นที่', 'ประเภท', 'ยอดขายสุทธิ', 'สัดส่วนยอดขาย']} numericColumns={[2, 3]} label={translateUi('ตารางยอดขายตามพื้นที่')}>
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
  return <DataTable headings={['ชนิดน้ำแข็ง', 'หน่วย', 'จำนวนส่ง', 'เสียหาย', 'อัตราของเสีย']} numericColumns={[2, 3, 4]} label={label}>
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
  return <DataTable headings={['อันดับ', 'ร้านค้า', 'ยอดขายสุทธิ']} numericColumns={[2]} label={translateUi('ร้านค้ายอดขายสูงสุด')}>
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
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil((quiet?.rows.length ?? 0) / 10));
  const currentPage = Math.min(page, pageCount - 1);
  const offset = currentPage * 10;
  const asOf = toBangkokDateString(new Date(report.asOf));
  const dateRange = { from: shiftServiceDate(asOf, -89), to: asOf };
  if (!quiet || quiet.total === 0) return null;
  return <Panel
    className="executive-panel--warning"
    description={`${translateUi('สถานะปัจจุบัน ณ')} ${formatReportDate(asOf)} · ${translateUi('ไม่ขึ้นกับช่วงวันที่เลือก')}`}
    id="executive-quiet-shops"
    title={translateUi('ร้านที่หยุดสั่งซื้อ / สัญญาณเตือน')}
  >
    <DataTable
      headings={['ร้านค้า', 'เงียบมาแล้ว', 'รอบปกติ', 'ยอดซื้อเฉลี่ย / เดือน', 'สั่งล่าสุด']}
      numericColumns={[1, 2, 3]}
      label={translateUi('ตารางร้านที่หยุดสั่งซื้อ')}
    >
      {quiet.rows.slice(offset, offset + 10).map((shop) => <tr key={shop.id}>
        <td data-label={translateUi('ร้านค้า')}>
          <button
            className="executive-table-link"
            onClick={(event) => openDetail({ metric: 'sales', shopId: shop.id, dateRange }, shop.name, event.currentTarget)}
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
    <nav aria-label={translateUi('หน้าร้านที่หยุดสั่งซื้อ')} className="executive-quiet-pagination">
      <span aria-live="polite">{translateUi('แสดง {0}–{1} จาก {2} ร้าน', {
        0: number(quiet.rows.length ? offset + 1 : 0),
        1: number(Math.min(offset + 10, quiet.rows.length)), 2: number(quiet.total),
      })}</span>
      <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} type="button">{translateUi('ก่อนหน้า')}</button>
      <button disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)} type="button">{translateUi('ถัดไป')}</button>
    </nav>
    {quiet.total > quiet.rows.length ? <p className="executive-panel-note">{translateUi('แสดงรายชื่อได้บางส่วน กรุณาลองรีเฟรช')}</p> : null}
    <p className="executive-panel-note">
      {translateUi('ร้านค้าที่สั่งซื้ออย่างน้อย 4 วันในรอบ 90 วัน แต่เงียบไปนานกว่า 2 เท่าของรอบสั่งปกติ')}
      {' · '}{translateUi('เลือกร้านเพื่อดูประวัติขายย้อนหลัง 90 วัน')}
    </p>
  </Panel>;
}

function DebtAgingPanel({ report, openDetail }: {
  report: ExecutiveReport;
  openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
}) {
  useLanguage();
  const aging = report.debtAging;
  if (!aging || aging.length === 0) return null;
  const total = report.outstanding;
  const segments = aging.map((b) => ({
    key: b.bucket,
    value: b.amount,
    tone: b.bucket === 'notDue' ? 'blue' : b.bucket === 'days1to7' ? 'amber' : b.bucket === 'days8to30' ? 'orange' : 'red',
  }));

  return <Panel
    description={translateUi('ยอดหนี้เป็นสถานะปัจจุบัน ไม่ขึ้นกับช่วงวันที่เลือก')}
    id="executive-aging"
    title={translateUi('ตารางวิเคราะห์อายุหนี้')}
  >
    <StackBar label={translateUi('อายุหนี้ปัจจุบัน')} segments={segments} />
    <DataTable headings={['อายุหนี้ปัจจุบัน', 'จำนวนเงิน', 'สัดส่วน', 'ลูกหนี้']} numericColumns={[1, 2, 3]} label={translateUi('ตารางวิเคราะห์อายุหนี้')}>
      {aging.map((row) => {
        return <tr key={row.bucket}>
          <td data-label={translateUi('อายุหนี้ปัจจุบัน')}>
            <span className={`executive-aging-tag executive-aging-tag--${row.bucket}`}>
              {translateUi(agingLabels[row.bucket])}
            </span>
          </td>
          <td className="executive-numeric" data-label={translateUi('จำนวนเงิน')}>
            {row.amount > 0 && report.agingDetailsVersion === 1 ? (
              <button
                className="executive-table-link"
                onClick={(event) => openDetail({
                  metric: row.bucket === 'notDue' ? 'debt' : 'overdue', agingBucket: row.bucket,
                }, translateUi(agingLabels[row.bucket]), event.currentTarget)}
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
    {report.agingDetailsVersion !== 1 ? <p className="executive-panel-note">
      {translateUi('ยังเปิดรายการแยกอายุหนี้ไม่ได้ กรุณารีเฟรช หากยังไม่ได้ ระบบข้อมูลยังไม่รองรับตัวกรองนี้')}
    </p> : null}
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

function TrendPanel({ report, showTable, onTableChange, openDetail }: {
  report: ExecutiveReport;
  showTable: boolean; onTableChange: () => void; openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
}) {
  useLanguage();
  const values = report.trend.flatMap((point) => [point.sales, point.receipts - point.refunds]);
  const maxPositive = Math.max(0, ...values);
  const maxNegative = Math.max(0, ...values.map((value) => -value));
  const hasNegative = maxNegative > 0;
  const maximum = Math.max(1, maxPositive, maxNegative);
  const step = 10 ** Math.floor(Math.log10(maximum));
  const scale = Math.ceil(maximum / step) * step;
  const ticks = hasNegative ? [scale, scale / 2, 0, -scale / 2, -scale] : [scale, scale * .75, scale / 2, scale * .25, 0];
  return <Panel description={translateUi('เลือกแท่งเพื่อดูรายการในช่วงนั้น')} label={translateUi('แนวโน้มยอดขายและเงินรับ')} title={translateUi('แนวโน้มยอดขายและเงินรับ')}>
    <div aria-label={translateUi('คำอธิบายกราฟ')} className="executive-trend-legend">
      <span><i className="executive-trend-legend__sales" />{translateUi('ยอดขาย')}</span>
      <span><i className="executive-trend-legend__receipts" />{translateUi('เงินรับสุทธิ')}</span>
    </div>
    {report.trend.length ? <>
      <p className="executive-trend-unit">{translateUi('หน่วย: บาท')}</p>
      <div className="executive-trend-frame">
        <div aria-hidden="true" className="executive-trend-axis">
          {ticks.map((value, index) => <span key={index} style={{ top: `${index * 25}%` }}>{number(value)}</span>)}
        </div>
        <div aria-label={translateUi('กราฟยอดขายและเงินรับสุทธิ')} className={`executive-chart executive-chart--grouped ${hasNegative ? 'executive-chart--signed' : ''}`} role="group">
        {report.trend.map((point) => {
          const { label, axisLabel } = reportBucketLabels(point.date, report.from, report.to);
          return <div className="executive-chart__bucket" key={point.date}>
            <div className="executive-chart__pair">
              {(['sales', 'receipts'] as const).map((metric) => {
                const value = metric === 'sales' ? point.sales : point.receipts - point.refunds;
                const metricLabel = translateUi(metric === 'sales' ? 'ยอดขาย' : 'เงินรับสุทธิ');
                const height = Math.abs(value) / scale * 100;
                const description = `${metricLabel} ${label} ${baht(value)}`;
                return <button aria-label={description} title={description} className={`executive-chart__item executive-chart__item--${metric}`} key={metric}
                  onClick={(event) => openDetail({ metric, bucket: point.date }, label, event.currentTarget)} type="button">
                  <span className="executive-chart__plot"><span className="executive-chart__positive">{value > 0 ? <i style={{ height: `${height}%` }} /> : null}</span>
                    <span className="executive-chart__negative">{value < 0 ? <i style={{ height: `${height}%` }} /> : null}</span></span>
                </button>;
              })}
            </div>
            <small>{axisLabel}</small>
          </div>;
        })}
        </div>
      </div>
      <button aria-expanded={showTable} className="executive-text-button" onClick={onTableChange} type="button">{showTable ? translateUi('ซ่อนตารางตัวเลข') : translateUi('ดูตารางตัวเลข')}</button>
      {showTable ? <DataTable headings={['ช่วง', 'ยอดขาย', 'เงินรับจริง', 'คืนเงินจริง', 'เงินรับสุทธิ']} numericColumns={[1, 2, 3, 4]} label={translateUi('ตารางแนวโน้ม')}>
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
  const items = attentionItems(report).slice(0, 5);
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
  section, report, showTrendTable, toggleTrendTable, openDetail, onNavigateSection,
}: {
  section: ReportSection; report: ExecutiveReport; showTrendTable: boolean; toggleTrendTable: () => void;
  openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
  onNavigateSection?: (section: ReportSection, targetId?: string) => void;
}) {
  useLanguage();
  if (section === 'overview') {
    return <div className="executive-report__stack">
      <TrendPanel onTableChange={toggleTrendTable} openDetail={openDetail} report={report} showTable={showTrendTable} />
      <AttentionBanner onNavigate={onNavigateSection} report={report} />
      <ReportOverview report={report} openDetail={openDetail} onNavigate={onNavigateSection} />
    </div>;
  }

  if (section === 'sales') {
    return <div className="executive-report__stack">
      <TrendPanel onTableChange={toggleTrendTable} openDetail={openDetail} report={report} showTable={showTrendTable} />
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
      <Panel description={translateUi('เงินรับสุทธิหลังหักเงินคืน')} title={translateUi('เงินรับช่วงนี้')}>
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
      <Panel description={translateUi('ยอดหนี้เป็นสถานะปัจจุบัน ไม่ขึ้นกับช่วงวันที่เลือก')} title={translateUi('ลูกหนี้ปัจจุบัน')}>
        <div className="executive-debt-grid">
          <button onClick={(event) => openDetail({ metric: 'debt' }, undefined, event.currentTarget)} type="button"><span>{translateUi('หนี้ค้างทั้งหมด · ')}{number(report.debtors)}{translateUi(' ร้าน')}</span><strong>{baht(report.outstanding)}</strong><small>{translateUi('ดูร้านค้าและบิลค้าง ›')}</small></button>
          <button onClick={(event) => openDetail({ metric: 'overdue' }, undefined, event.currentTarget)} type="button"><span>{translateUi('เกินกำหนด')}</span><strong>{baht(report.overdue)}</strong><small>{translateUi('ดูร้านค้าและบิลเกินกำหนด ›')}</small></button>
        </div>
      </Panel>
    </div>;
  }

  const buildings = report.volumeAreas?.filter((area) => area.kind === 'building') ?? [];
  const otherAreas = report.volumeAreas?.filter((area) => area.kind !== 'building') ?? [];
  const flags = damageFlags(report);

  return <div className="executive-report__stack">
    {flags.length > 0 ? <div className="executive-alert-card executive-alert-card--warning">
      <strong>{translateUi('พบจุดส่งที่มีของเสียสูงกว่าปกติ')}</strong>
      <p>{flags.slice(0, 3).map((f) => `${f.areaName}: ${f.productName} (${percent(f.rate)}% · ${translateUi('ของเสียเฉลี่ยรวม {0}', { 0: `${percent(f.average)}%` })})`).join(' · ')}</p>
    </div> : null}
    <Panel description={translateUi('จำนวนส่งและเสียหาย แยกตามชนิดและหน่วย')} title={translateUi('ปริมาณขายแยกชนิด')}>
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
