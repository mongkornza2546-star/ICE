import { Buildings, CaretRight, Cube } from '@phosphor-icons/react';
import { translateUi, useLanguage } from '../../i18n';
import type { ReportSection } from './ExecutiveReportSections';
import type { DetailQuery, ExecutiveReport } from './types';

const number = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value);
const baht = (value: number) => new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: 0 }).format(value);

export function ReportOverview({ report, openDetail, onNavigate }: {
  report: ExecutiveReport;
  openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
  onNavigate?: (section: ReportSection, targetId?: string) => void;
}) {
  useLanguage();
  const areas = [...report.areas].sort((a, b) => b.sales - a.sales).slice(0, 5);
  const maxSales = Math.max(1, ...areas.map((area) => area.sales));
  // Include destinations with sales but no volume row without treating missing data as zero.
  const locations = [...(report.volumeAreas ?? [])];
  for (const area of report.areas) {
    if (!locations.some((location) => location.kind === area.kind && location.id === area.id)) {
      locations.push({ ...area, products: [] });
    }
  }
  const period = translateUi(report.from === report.to ? 'จำนวนที่ขายได้ในวันที่เลือก' : 'จำนวนที่ขายได้ในช่วงวันที่เลือก');

  return <div className="executive-overview">
    <section className="executive-ice-sales" aria-label={translateUi('ยอดขายแยกตามประเภทน้ำแข็ง')}>
      <div className="executive-overview__heading"><h2>{translateUi('ยอดขายแยกตามประเภทน้ำแข็ง')}</h2><p>{period}</p></div>
      <div className="executive-ice-grid">
        {report.products.map((product) => <div className="executive-ice-card" key={product.id}>
          <span className="executive-overview-icon"><Cube size={29} weight="duotone" aria-hidden="true" /></span>
          <div><h3>{product.name}</h3><p><strong>{number(product.delivered)}</strong><span>{product.unit}</span></p></div>
        </div>)}
      </div>
      {!report.products.length ? <p className="executive-empty">{translateUi('ยังไม่มีปริมาณน้ำแข็งในช่วงนี้')}</p> : null}
    </section>

    <div className="executive-overview__columns">
      <section className="executive-area-sales" aria-label={translateUi('ยอดขายตามพื้นที่')}>
        <div className="executive-overview__heading executive-overview__heading--action">
          <div><h2>{translateUi('ยอดขายตามพื้นที่')}</h2><p>{translateUi('5 พื้นที่ยอดขายสูงสุดในช่วงที่เลือก')}</p></div>
          <button onClick={() => onNavigate?.('sales')} type="button">{translateUi('ดูยอดขาย')}<CaretRight size={16} /></button>
        </div>
        <div className="executive-area-bars">{areas.map((area) => <button key={`${area.kind}-${area.id}`}
          onClick={(event) => openDetail({ metric: 'sales', areaKind: area.kind, areaId: area.id }, area.name, event.currentTarget)} type="button">
          <span>{area.name}</span><strong>{baht(area.sales)}</strong><span className="executive-area-bars__track" aria-hidden="true"><i style={{ width: `${Math.max(0, area.sales / maxSales * 100)}%` }} /></span>
        </button>)}</div>
        {!areas.length ? <p className="executive-empty">{translateUi('ยังไม่มียอดขายตามพื้นที่')}</p> : null}
      </section>

      <section className="executive-location-summary" aria-label={translateUi('สรุปยอดน้ำแข็งแต่ละจุด')}>
        <div className="executive-overview__heading"><h2>{translateUi('สรุปยอดน้ำแข็งแต่ละจุด')}</h2><p>{translateUi('จำนวนส่งแยกตามตึกและอีเวนต์ในช่วงที่เลือก')}</p></div>
        <div className="executive-location-list">{locations.map((area) => <button className="executive-location-card" key={`${area.kind}-${area.id}`}
          onClick={() => onNavigate?.('volume', area.products.length ? `executive-volume-${area.kind}-${area.id ?? 'none'}` : 'executive-volume-areas')} type="button">
          <span className="executive-overview-icon"><Buildings size={24} aria-hidden="true" /></span>
          <span className="executive-location-card__name"><strong>{area.name}</strong><small>{translateUi(area.kind === 'building' ? 'ตึก' : area.kind === 'event' ? 'อีเวนต์' : area.kind === 'casual' ? 'ขายหน้ารถ' : 'จุดสต็อก')}</small></span>
          <CaretRight className="executive-location-card__arrow" size={17} aria-hidden="true" />
          <span className="executive-location-card__quantities">{area.products.length
            ? area.products.map((product) => <span key={product.id}>{product.name} <b>{number(product.delivered)}</b> {product.unit}</span>)
            : translateUi(report.volumeAreas ? 'ยังไม่มีรายการส่งน้ำแข็ง' : 'ข้อมูลแยกตึกยังไม่พร้อมใช้งาน')}</span>
        </button>)}</div>
        {!locations.length ? <p className="executive-empty">{translateUi(report.volumeAreas ? 'ยังไม่มีรายการส่งน้ำแข็ง' : 'ข้อมูลแยกตึกยังไม่พร้อมใช้งาน')}</p> : null}
      </section>
    </div>
  </div>;
}
