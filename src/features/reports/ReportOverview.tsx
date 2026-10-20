import { useState } from 'react';
import { Buildings, CaretRight } from '@phosphor-icons/react';
import { translateUi, useLanguage } from '../../i18n';
import type { ReportSection } from './ExecutiveReportSections';
import type { DetailQuery, ExecutiveReport } from './types';

const number = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value);
const baht = (value: number) => new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
const isSalesDestination = (area: { kind: string }) => ['building', 'event', 'casual'].includes(area.kind);

export function ReportOverview({ report, openDetail, onNavigate }: {
  report: ExecutiveReport;
  openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
  onNavigate?: (section: ReportSection, targetId?: string) => void;
}) {
  useLanguage();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const areaKey = (area: { kind: string; id: string | null }) => `${area.kind}-${area.id ?? 'none'}`;
  const areas = report.areas.filter(isSalesDestination).map((area) => ({ ...area,
    products: report.volumeAreas?.find((volume) => areaKey(volume) === areaKey(area))?.products ?? [],
  }));
  areas.sort((a, b) => b.sales - a.sales);
  const selected = areas.find((area) => areaKey(area) === selectedKey) ?? areas[0];
  const maxSales = Math.max(1, ...areas.map((area) => area.sales));
  const scaleStep = 10 ** Math.floor(Math.log10(maxSales));
  const axisMax = Math.ceil(maxSales / scaleStep) * scaleStep;
  const axisMin = Math.floor(Math.min(0, ...areas.map((area) => area.sales)) / scaleStep) * scaleStep;
  const axisRange = axisMax - axisMin;
  const zeroPosition = axisMax / axisRange * 100;
  return <div className="executive-overview executive-overview--summary">
    <section className="executive-area-chart" aria-label={translateUi('ยอดขายตามพื้นที่')}>
      <div className="executive-overview__heading executive-overview__heading--action">
        <div><h2>{translateUi('ยอดขายตามพื้นที่')}</h2>
          <p>{translateUi('อาคาร อีเวนต์ และขายหน้ารถ · เลือกพื้นที่เพื่อดูรายละเอียด')}</p></div>
        {onNavigate ? <button onClick={() => onNavigate('sales')} type="button">{translateUi('ดูยอดขาย')}<CaretRight size={16} /></button> : null}
      </div>
      {areas.length ? <>
        <p className="executive-area-chart__unit">{translateUi('ยอดขายสุทธิ (บาท)')}</p>
        <div className="executive-area-chart__frame">
          <div className="executive-area-chart__axis" aria-hidden="true">{[0, 1, 2, 3, 4].map((tick) =>
            <span key={tick} style={{ top: `${tick * 25}%` }}>{number(axisMax - axisRange * tick / 4)}</span>)}</div>
          <div className="executive-area-chart__scroll" tabIndex={0} role="group" aria-label={translateUi('กราฟแท่งยอดขายตามพื้นที่')}>
            <div className="executive-area-chart__columns" style={{ minWidth: `${areas.length * 120}px` }}>
              <div className="executive-area-chart__grid" aria-hidden="true">{[0, 1, 2, 3, 4].map((tick) =>
                <i key={tick} style={{ top: `${tick * 25}%` }} />)}<i className="executive-area-chart__zero" style={{ top: `${zeroPosition}%` }} /></div>
              {areas.map((area) => <button key={areaKey(area)} type="button"
                aria-pressed={areaKey(area) === areaKey(selected)} aria-controls="executive-selected-area"
                className="executive-area-chart__column" onClick={() => setSelectedKey(areaKey(area))}>
                <strong>{baht(area.sales)}</strong>
                <span className="executive-area-chart__plot" aria-hidden="true"><i className={area.sales < 0 ? 'executive-area-chart__bar--negative' : undefined}
                  style={{ top: `${area.sales >= 0 ? (axisMax - area.sales) / axisRange * 100 : zeroPosition}%`, height: `${Math.abs(area.sales) / axisRange * 100}%` }} /></span>
                <span className="executive-area-chart__label">{area.name}</span>
              </button>)}
            </div>
          </div>
        </div>
        <div className="executive-area-selection" id="executive-selected-area" role="region" aria-label={translateUi('พื้นที่ที่เลือก')} aria-live="polite">
          <div className="executive-area-selection__heading">
            <span className="executive-overview-icon"><Buildings size={24} aria-hidden="true" /></span>
            <div><h3>{selected.name}</h3><p>{translateUi('ยอดขายสุทธิ')} {baht(selected.sales)}</p></div>
            <div className="executive-area-selection__actions">
              <button type="button" onClick={(event) => openDetail({ metric: 'sales', areaKind: selected.kind, areaId: selected.id }, selected.name, event.currentTarget)}>{translateUi('ดูรายการขายพื้นที่นี้')}<CaretRight size={14} /></button>
              {selected.products.length && onNavigate ? <button type="button" onClick={() => onNavigate('volume', `executive-volume-${areaKey(selected)}`)}>{translateUi('ดูปริมาณส่ง')}<CaretRight size={14} /></button> : null}
            </div>
          </div>
        </div>
      </> : <p className="executive-empty">{translateUi('ยังไม่มีข้อมูลพื้นที่ในช่วงที่เลือก')}</p>}
    </section>
  </div>;
}
