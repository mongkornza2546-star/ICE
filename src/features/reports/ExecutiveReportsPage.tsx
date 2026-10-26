import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, CaretLeft, CaretRight, ChartBar, CreditCard, DownloadSimple, Receipt, Warning, X, type Icon } from '@phosphor-icons/react';
import { supabase } from '../../lib/supabase';
import { subscribeToDataChange } from '../../lib/dataChange';
import { toBangkokDateString } from '../../lib/serviceDate';
import { translateUi, uiDateTimeString, useLanguage } from '../../i18n';
import { exportExecutiveReport } from './exportExecutiveReport';
import { ReportSections, ReportTabs, type ReportSection } from './ExecutiveReportSections';
import { ExecutiveFollowUps } from './ExecutiveFollowUps';
import { ReportShopProfile } from './ReportShopProfile';
import { ReportComparison } from './ReportComparison';
import { ReportDailyQuantities } from './ReportDailyQuantities';
import { changePercent, comparisonRange, type ComparisonSelection } from './comparisonData';
import { demoComparisonReport } from './demoComparisonReport';
import { agingLabels } from './reportInsights';
import { formatReportDate, presetDates, quantityMonthDates, reportRangeError, type Preset } from './reportDates';
import type { DetailQuery, ExecutiveReport, ReportInvoice, ReportMetric, ReportRow } from './types';
import './executiveReports.css';

const baht = (value: number) => new Intl.NumberFormat('th-TH', {
  style: 'currency', currency: 'THB', minimumFractionDigits: 0, maximumFractionDigits: 2,
}).format(value);
const number = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value);
const metricNames: Record<ReportMetric, string> = {
  sales: 'ยอดขายสุทธิ', receipts: 'เงินรับจริง', refunds: 'เงินคืนจริง',
  debt: 'หนี้ค้างปัจจุบัน', overdue: 'เกินกำหนดปัจจุบัน',
};
const paymentMethod = (method?: string | null) => method === 'cash' ? 'เงินสด'
  : method === 'bank_transfer' ? 'โอนเงิน' : method === 'qr' ? 'QR' : null;
const presetNames: Record<Exclude<Preset, 'custom' | 'calendarWeek'>, string> = {
  today: 'วันนี้', week: '7 วัน', month: 'เดือนนี้', year: 'ปีนี้',
};

async function fetchDetails(from: string, to: string, query: DetailQuery, offset: number) {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase');
  const { data, error } = query.agingBucket ? await supabase.rpc('get_executive_report_aging_details', {
    p_bucket: query.agingBucket, p_shop_id: query.shopId ?? null, p_limit: 50, p_offset: offset,
  }) : await supabase.rpc('get_executive_report_details', {
    p_from: from, p_to: to, p_metric: query.metric,
    p_limit: 50, p_offset: offset, p_bucket: query.bucket ?? null,
    p_area_kind: query.areaKind ?? null, p_area_id: query.areaId ?? null,
    p_shop_id: query.shopId ?? null,
  });
  if (error) throw new Error(error.message);
  return data as { total: number; rows: ReportRow[] };
}

function MetricCard({ title, value, previous, note, description, onClick, tone = 'blue', icon: Icon, count = false }: {
  title: string; value: number; note?: string; description?: string; icon: Icon; count?: boolean;
  previous?: number;
  onClick: (trigger: HTMLButtonElement) => void; tone?: string;
}) {
  return <button className={`executive-metric executive-metric--${tone}${count ? ' executive-metric--count' : ''}`}
    onClick={(event) => onClick(event.currentTarget)} type="button">
    <span className="executive-metric__heading"><span className="executive-metric__icon"><Icon size={23} aria-hidden="true" /></span>{title}</span>
    <strong>{count ? number(value) : baht(value)}</strong>
    {previous !== undefined ? <small className="executive-metric__change"
      data-direction={value > previous ? 'increase' : value < previous ? 'decrease' : 'flat'}>
      {translateUi(value > previous ? 'เพิ่มขึ้น' : value < previous ? 'ลดลง' : 'เท่าเดิม')}
      {value !== previous ? ` ${baht(Math.abs(value - previous))}` : ''}
      {' · '}{changePercent(value, previous) === null
        ? translateUi('ฐานเดิมเป็น 0 · ไม่คิด %')
        : `${number(changePercent(value, previous)!)}%`}
    </small> : null}
    {description ? <small>{description}</small> : null}
    {note ? <small className="executive-metric__note">{note}</small> : null}
  </button>;
}

export function ExecutiveReportsPage({ isActive, demoReport, demoRows }: {
  isActive: boolean; demoReport?: ExecutiveReport;
  demoRows?: Partial<Record<ReportMetric, ReportRow[]>>;
}) {
  useLanguage();
  const initial = presetDates('month');
  const [preset, setPreset] = useState<Preset>('month');
  const [rangeFrom, setFrom] = useState(initial.from);
  const [rangeTo, setTo] = useState(initial.to);
  const [report, setReport] = useState<ExecutiveReport | null>(demoReport ?? null);
  const [loading, setLoading] = useState(!demoReport);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showTrendTable, setShowTrendTable] = useState(false);
  const [section, setSection] = useState<ReportSection>('overview');
  const [hasViewedVolume, setHasViewedVolume] = useState(false);
  const [quantitySelection, setQuantitySelection] = useState<string | null>(null);
  const quantityDate = quantitySelection ?? toBangkokDateString();
  const quantityRange = quantityMonthDates(quantityDate);
  const from = section === 'volume' ? quantityRange.first : rangeFrom;
  const to = section === 'volume' ? quantityRange.end : rangeTo;
  const [comparing, setComparing] = useState(false);
  const [comparisonSelection, setComparisonSelection] = useState<ComparisonSelection>(() => ({
    preset: 'previous', custom: comparisonRange(initial, 'previous'),
  }));
  const [detail, setDetail] = useState<DetailQuery | null>(null);
  const [detailLabel, setDetailLabel] = useState<string | null>(null);
  const [detailPage, setDetailPage] = useState(0);
  const [detailData, setDetailData] = useState<{ total: number; rows: ReportRow[] } | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<ReportInvoice | null>(null);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [debtorName, setDebtorName] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const reportRequest = useRef(0);
  const detailRequest = useRef(0);
  const invoiceRequest = useRef(0);
  const dialogRef = useRef<HTMLElement>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const detailTriggerShop = useRef<string | null>(null);
  const reportHeading = useRef<HTMLHeadingElement | null>(null);
  const debtorListPage = useRef(0);
  const rangeError = reportRangeError(from, to);
  const shownReport = !rangeError && report && report.from === from && report.to === to ? report : null;
  const detailFrom = detail?.dateRange?.from ?? from;
  const detailTo = detail?.dateRange?.to ?? to;

  useEffect(() => {
    if (section === 'volume') setHasViewedVolume(true);
  }, [section]);

  const refresh = useCallback(() => {
    if (section !== 'volume' && preset !== 'custom') {
      const dates = presetDates(preset);
      if (dates.from !== from || dates.to !== to) {
        setFrom(dates.from); setTo(dates.to); setDetail(null);
      }
    }
    setRefreshKey((value) => value + 1);
  }, [section, preset, from, to]);

  useEffect(() => {
    if (!isActive || rangeError) return;
    if (demoReport) {
      setReport(demoComparisonReport(demoReport, { from, to }));
      setLoading(false);
      return;
    }
    const request = ++reportRequest.current;
    setLoading(true);
    setError(null);
    if (!supabase) {
      setError('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase');
      setLoading(false);
      return;
    }
    void supabase.rpc('get_executive_report', { p_from: from, p_to: to }).then(({ data, error: rpcError }) => {
      if (request !== reportRequest.current) return;
      if (rpcError) setError(rpcError.message);
      else setReport(data as ExecutiveReport);
      setLoading(false);
    }, (cause: unknown) => {
      if (request !== reportRequest.current) return;
      setError(cause instanceof Error ? cause.message : 'โหลดรายงานไม่สำเร็จ');
      setLoading(false);
    });
    return () => { reportRequest.current += 1; };
  }, [isActive, from, to, refreshKey, rangeError, demoReport]);

  useEffect(() => {
    if (!isActive || demoReport) return;
    const doRefresh = () => {
      if (document.visibilityState !== 'visible') return;
      refresh();
    };
    const timer = window.setInterval(doRefresh, 60_000);
    window.addEventListener('focus', doRefresh);
    window.addEventListener('online', doRefresh);
    document.addEventListener('visibilitychange', doRefresh);
    const unsubscribe = subscribeToDataChange(['accounting', 'payment', 'receivable', 'refund', 'stock', 'pos'], doRefresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', doRefresh);
      window.removeEventListener('online', doRefresh);
      document.removeEventListener('visibilitychange', doRefresh);
      unsubscribe();
    };
  }, [isActive, refresh, demoReport, preset, from, to]);

  useEffect(() => {
    if (!detail || !isActive || rangeError) return;
    const request = ++detailRequest.current;
    setDetailData(null);
    setDetailError(null);
    if (demoRows) {
      const rows = (demoRows[detail.metric] ?? []).filter((row) =>
        (!detail.dateRange || (row.day >= detailFrom && row.day <= detailTo))
        && (!detail.bucket || row.day === detail.bucket)
        && (!detail.shopId || row.shopId === detail.shopId)
        && (!detail.agingBucket || (() => {
          const days = Math.floor((Date.parse(toBangkokDateString(new Date(report?.asOf ?? new Date())))
            - Date.parse(row.dueDate ?? row.day)) / 86400000);
          return detail.agingBucket === 'notDue' ? days <= 0
            : detail.agingBucket === 'days1to7' ? days >= 1 && days <= 7
              : detail.agingBucket === 'days8to30' ? days >= 8 && days <= 30 : days > 30;
        })())
        && (!detail.areaKind || row.area === report?.areas.find((area) => area.kind === detail.areaKind && area.id === detail.areaId)?.name));
      setDetailData({ total: rows.length, rows: rows.slice(detailPage * 50, (detailPage + 1) * 50) });
      return;
    }
    void fetchDetails(detailFrom, detailTo, detail, detailPage * 50).then((result) => {
      if (request === detailRequest.current) setDetailData(result);
    }, (cause: unknown) => {
      if (request === detailRequest.current) setDetailError(cause instanceof Error ? cause.message : 'โหลดรายการไม่สำเร็จ');
    });
    return () => { detailRequest.current += 1; };
  }, [detail, detailPage, detailFrom, detailTo, isActive, rangeError, refreshKey, demoRows, report?.areas, report?.asOf]);

  useEffect(() => {
    if (!invoiceId) return;
    const request = ++invoiceRequest.current;
    setInvoice(null);
    setInvoiceError(null);
    if (demoReport) {
      setInvoice({ number: 'C-DEMO-001', shop: 'ร้านกาแฟลานเล่า', serviceDate: to,
        area: 'อาคาร A', dueDate: to, salesAmount: 28000, vatAmount: 1960, total: 29960, paid: 23200,
        items: [{ name: 'น้ำแข็งหลอดเล็ก', unit: 'ถุง', quantity: 100 }], payments: [] });
      return;
    }
    if (!supabase) { setInvoiceError('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase'); return; }
    void supabase.rpc('get_executive_report_invoice', { p_charge_id: invoiceId }).then(({ data, error: rpcError }) => {
      if (request !== invoiceRequest.current) return;
      if (rpcError) setInvoiceError(rpcError.message);
      else if (!data) setInvoiceError('ไม่พบบิลนี้แล้ว');
      else setInvoice(data as ReportInvoice);
    }, (cause: unknown) => {
      if (request === invoiceRequest.current) setInvoiceError(cause instanceof Error ? cause.message : 'โหลดบิลไม่สำเร็จ');
    });
    return () => { invoiceRequest.current += 1; };
  }, [invoiceId, demoReport, to]);

  useEffect(() => {
    if (!detail) return;
    dialogRef.current?.focus();
  }, [detail, invoiceId]);

  const choosePreset = (next: Exclude<Preset, 'custom'>) => {
    const dates = presetDates(next);
    setPreset(next); setFrom(dates.from); setTo(dates.to); setDetail(null);
  };
  const openDetail = (query: DetailQuery, label?: string, trigger?: HTMLElement) => {
    if (!detail) {
      detailTrigger.current = trigger ?? document.activeElement as HTMLElement | null;
      detailTriggerShop.current = detailTrigger.current?.getAttribute('data-follow-up-shop') ?? null;
    }
    setDetail(query); setDetailPage(0); setInvoiceId(null); setDetailLabel(label ?? null);
    if (!query.shopId) setDebtorName(null);
  };
  const closeDetail = () => {
    setDetail(null); setInvoiceId(null); setDetailLabel(null); setDebtorName(null);
    window.requestAnimationFrame(() => {
      const currentShop = detailTriggerShop.current ? [...document.querySelectorAll<HTMLElement>('[data-follow-up-shop]')]
        .find((button) => button.getAttribute('data-follow-up-shop') === detailTriggerShop.current) : null;
      (detailTrigger.current?.isConnected ? detailTrigger.current : currentShop ?? reportHeading.current)?.focus();
    });
  };
  const backDetail = () => {
    if (invoiceId) { setInvoiceId(null); return; }
    if (detail?.shopId && (detail.metric === 'debt' || detail.metric === 'overdue')) {
      setDetail({ ...detail, shopId: undefined });
      setDetailPage(debtorListPage.current);
      setDebtorName(null);
      setDetailLabel(detail.agingBucket ? agingLabels[detail.agingBucket] : null);
      return;
    }
    closeDetail();
  };

  const handleExport = async () => {
    if (!shownReport || exporting || loading || error || rangeError) return;
    setExporting(true);
    try {
      const metrics: ReportMetric[] = ['sales', 'receipts', 'refunds', 'debt'];
      const all: Partial<Record<ReportMetric, ReportRow[]>> = {};
      for (const metric of metrics) {
        if (demoRows) { all[metric] = demoRows[metric] ?? []; continue; }
        const rows: ReportRow[] = [];
        let total = 0;
        do {
          const page = await fetchDetails(from, to, { metric }, rows.length);
          total = page.total;
          rows.push(...page.rows);
          if (page.rows.length === 0) break;
        } while (rows.length < total);
        all[metric] = rows;
      }
      if (!demoRows) {
        const amount = (metric: ReportMetric) => (all[metric] ?? []).reduce((sum, row) => sum + Number(row.amount), 0);
        const expected = { sales: shownReport.sales, receipts: shownReport.receipts,
          refunds: shownReport.refunds, debt: shownReport.outstanding };
        if ((Object.keys(expected) as Array<keyof typeof expected>).some((metric) =>
          Math.abs(amount(metric) - Number(expected[metric])) > 0.01)) {
          throw new Error('ข้อมูลเปลี่ยนระหว่างสร้างไฟล์ กรุณารีเฟรชรายงานแล้วลองอีกครั้ง');
        }
      }
      await exportExecutiveReport(shownReport, all, Boolean(demoReport));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ส่งออก Excel ไม่สำเร็จ');
    } finally {
      setExporting(false);
    }
  };

  const receiptPoint = detail?.bucket ? shownReport?.trend.find((row) => row.date === detail.bucket) : null;
  const receiptGross = detail?.bucket ? receiptPoint?.receipts ?? 0 : shownReport?.receipts ?? 0;
  const receiptRefunds = detail?.bucket ? receiptPoint?.refunds ?? 0 : shownReport?.refunds ?? 0;
  const rangeFilters = <section className="executive-filters" aria-label={translateUi('เลือกช่วงเวลารายงาน')}>
      <div className="executive-filter-controls"><div aria-label={translateUi('ช่วงวันที่ลัด')} className="executive-presets">{(Object.keys(presetNames) as Array<keyof typeof presetNames>).map((key) =>
        <button aria-pressed={preset === key} key={key} onClick={() => choosePreset(key)} type="button">{translateUi(presetNames[key])}</button>)}</div>
      <div className="executive-dates"><label>{translateUi('จาก')}<input max={toBangkokDateString()} onChange={(event) => { setPreset('custom'); setFrom(event.target.value); setDetail(null); }} type="date" value={from} /></label>
        <label>{translateUi('ถึง')}<input max={toBangkokDateString()} onChange={(event) => { setPreset('custom'); setTo(event.target.value); setDetail(null); }} type="date" value={to} /></label></div></div>
      {rangeError ? <p className="executive-error" role="alert">{translateUi(rangeError)}</p> : null}
      {shownReport ? <p className="executive-asof">{translateUi('ข้อมูล ณ ')}{uiDateTimeString(new Date(shownReport.asOf), { timeZone: 'Asia/Bangkok' })} · {formatReportDate(from)} – {formatReportDate(to)}</p> : null}
    </section>;

  return <div className={`executive-report${section === 'volume' ? ' executive-report--volume' : ''}`}>
    <header className="executive-report__heading">
      <div><h1 ref={reportHeading} tabIndex={-1}>{translateUi(section === 'volume' ? 'ปริมาณน้ำแข็ง' : 'รายงานผู้บริหาร')}</h1><p>{translateUi(section === 'volume' ? 'ติดตามยอดขายรายวัน แยกตามชนิดและหน่วย' : 'ยอดขาย เงินรับ ลูกหนี้ และปริมาณส่ง')}</p></div>
      <div className="executive-report__actions">
        <button aria-label={translateUi('รีเฟรชรายงาน')} disabled={loading || Boolean(rangeError)} onClick={refresh} type="button"><ArrowClockwise size={19} />{translateUi(' รีเฟรช')}</button>
        {section !== 'volume' && !(section === 'sales' && comparing) ? <button disabled={!shownReport || loading || exporting || Boolean(error)} onClick={() => void handleExport()} type="button"><DownloadSimple size={19} /> {exporting ? translateUi('กำลังสร้าง Excel…') : translateUi('ส่งออก Excel ตามช่วงวันที่หลัก')}</button> : null}
      </div>
    </header>

    {section !== 'volume' ? rangeFilters : null}

    {demoReport && section !== 'volume' ? <p className="executive-panel-note" role="note">{translateUi('ข้อมูลจำลอง · ใช้ตรวจหน้าจอ ไม่ใช่ผลประกอบการจริง')}</p> : null}
    {shownReport && shownReport.salesBasis !== 'excluding_vat' ? <p className="executive-error" role="status">
      {translateUi('รายงานยังใช้ยอดขายรวม VAT จึงยังเทียบกับบัญชีไม่ได้ กรุณาอัปเดตระบบรายงานแล้วรีเฟรช')}
    </p> : null}
    {error ? <div className="executive-error" role="alert">{translateUi('โหลดรายงานไม่สำเร็จ: ')}{translateUi(error)} <button onClick={refresh} type="button">{translateUi('ลองใหม่')}</button></div> : null}
    {section !== 'volume' && loading && !shownReport ? <p className="executive-status" role="status">{translateUi('กำลังโหลดรายงาน…')}</p> : null}
    <ReportTabs active={section} onChange={setSection} />
    {section === 'sales' ? <div className="executive-segment" aria-label={translateUi('รูปแบบรายงานยอดขาย')}>
      <button type="button" aria-pressed={!comparing} onClick={() => setComparing(false)}>{translateUi('ช่วงเดียว')}</button>
      <button type="button" aria-pressed={comparing} onClick={() => setComparing(true)}>{translateUi('เปรียบเทียบสองช่วง')}</button>
    </div> : null}
    {section === 'sales' && comparing ? <ReportComparison from={from} to={to}
      report={!loading && !error ? shownReport : null} refreshKey={refreshKey} isActive={isActive}
      demoReport={demoReport} reportError={error} openDetail={openDetail}
      selection={comparisonSelection} onSelectionChange={setComparisonSelection}
      rangePreset={preset} onChoosePreset={choosePreset} /> : null}
    {shownReport && !(section === 'sales' && comparing) ? <>
      {section === 'overview' ? <>
      <section className="executive-business-overview" aria-label={translateUi('ผลประกอบการตามช่วงวันที่')}>
        <div className="executive-business-overview__heading"><h2>{translateUi('ภาพรวมธุรกิจ')}</h2><p>{formatReportDate(from)} – {formatReportDate(to)}</p></div>
        <p className="executive-panel-note">{translateUi('เทียบช่วงก่อนหน้าเท่ากัน')} · {formatReportDate(shownReport.previousFrom)} – {formatReportDate(shownReport.previousTo)}
          {to === toBangkokDateString() ? ` · ${translateUi('วันนี้ยังไม่จบวัน')}` : ''}</p>
        <div className="executive-metrics executive-metrics--period" aria-label={translateUi('ตัวเลขสำคัญ')}>
          <MetricCard title={translateUi('ยอดขายสุทธิ')} value={shownReport.sales} previous={shownReport.previousSales} icon={ChartBar}
            description={translateUi('ตามวันที่ขาย')} note={translateUi(shownReport.salesBasis === 'excluding_vat' ? 'ไม่รวม VAT · รวมค่าเช่าถัง' : 'ฐานเดิมรวม VAT')}
            onClick={(trigger) => openDetail({ metric: 'sales' }, undefined, trigger)} />
          <MetricCard title={translateUi('เงินรับสุทธิ')} value={shownReport.netReceipts} previous={shownReport.previousNetReceipts} icon={CreditCard} tone="green"
            description={translateUi('ตามวันที่รับเงิน หลังหักเงินคืน')} note={translateUi('อาจรวมเงินเก็บจากยอดขายช่วงก่อน')}
            onClick={(trigger) => openDetail({ metric: 'receipts' }, undefined, trigger)} />
        </div>
      </section>
      <section className="executive-current-balances" aria-label={translateUi('สถานะลูกหนี้ปัจจุบัน')}>
        <div className="executive-business-overview__heading"><h2>{translateUi('สถานะลูกหนี้ปัจจุบัน')}</h2>
          <p>{translateUi('ยอด ณ')} {formatReportDate(toBangkokDateString(new Date(shownReport.asOf)))}</p></div>
        <p className="executive-panel-note">{translateUi('ไม่ขึ้นกับช่วงวันที่เลือก')}</p>
        <div className="executive-metrics executive-metrics--balance">
          <MetricCard description={`${number(shownReport.debtors)} ${translateUi('ร้าน')}`}
            onClick={(trigger) => openDetail({ metric: 'debt' }, undefined, trigger)} title={translateUi('หนี้ค้างปัจจุบัน')} icon={Receipt} tone="amber" value={shownReport.outstanding} />
          <MetricCard description={translateUi('เป็นส่วนหนึ่งของหนี้ค้างทั้งหมด')} onClick={(trigger) => openDetail({ metric: 'overdue' }, undefined, trigger)}
            title={translateUi('หนี้เกินกำหนด')} icon={Warning} tone="red" value={shownReport.overdue} />
        </div>
      </section>
      </> : null}
    </> : null}
    {section === 'volume' || hasViewedVolume ? <div className="executive-volume-daily" hidden={section !== 'volume'}><ReportDailyQuantities
      report={section === 'volume' ? shownReport : null} demo={Boolean(demoReport)}
      reportLoading={loading} reportError={error}
      selectedDate={quantityDate}
      onDateChange={setQuantitySelection} /></div> : null}
    {section === 'volume' ? <section className="quantity-period" aria-label={translateUi('รายงานปริมาณเดือนที่เลือก')}>
      <div className="quantity-period__heading"><div><h2>{translateUi('ปริมาณรวมและแยกตามตึก')}</h2><p>{translateUi('รวมเดือนของวันที่เลือก')} · {formatReportDate(from)} – {formatReportDate(to)}</p></div>
        <button disabled={!shownReport || loading || exporting || Boolean(error)} onClick={() => void handleExport()} type="button"><DownloadSimple size={18} aria-hidden="true" />{exporting ? translateUi('กำลังสร้าง Excel…') : translateUi('ส่งออก Excel ปริมาณเดือนที่เลือก')}</button></div>
    </section> : null}
    {shownReport && !(section === 'sales' && comparing) ? <>
      <ReportSections
        onNavigateSection={(nextSection, targetId) => {
          if (nextSection === 'sales') setComparing(false);
          setSection(nextSection);
          if (targetId) {
            window.requestAnimationFrame(() => {
              const target = document.getElementById(targetId);
              target?.scrollIntoView({ behavior: 'smooth' });
              target?.focus({ preventScroll: true });
            });
          }
        }}
        openDetail={openDetail}
        report={shownReport}
        section={section}
        showTrendTable={showTrendTable}
        toggleTrendTable={() => setShowTrendTable((value) => !value)}
      />

      {section === 'finance' ? <ExecutiveFollowUps report={shownReport} isActive={isActive} demoRows={demoReport ? demoRows?.overdue ?? [] : undefined}
        onOpenAll={(trigger) => openDetail({ metric: 'overdue' }, undefined, trigger)}
        onOpenShop={(row, trigger) => {
          debtorListPage.current = 0;
          setDebtorName(row.label);
          openDetail({ metric: 'overdue', shopId: row.shopId ?? undefined }, row.label, trigger);
        }} /> : null}
    </> : null}

    {detail ? <div className="executive-detail-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDetail(); }}><section aria-label={invoiceId ? translateUi('รายละเอียดบิล') : translateUi('รายละเอียด{0}', { 0: translateUi(metricNames[detail.metric]) })} aria-modal="true" className="executive-detail" onKeyDown={(event) => {
      if (event.key === 'Escape') { backDetail(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      if (!focusable.length) return;
      if (event.shiftKey && (document.activeElement === focusable[0] || document.activeElement === dialogRef.current)) { event.preventDefault(); focusable[focusable.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) { event.preventDefault(); focusable[0].focus(); }
    }} ref={dialogRef} role="dialog" tabIndex={-1}>
      <header><button aria-label={invoiceId || detail.shopId ? translateUi('กลับไปยังรายการ') : translateUi('ย้อนกลับไปยังรายงาน')} onClick={backDetail} type="button"><CaretLeft size={21} /></button><div><h2>{invoiceId ? (invoice?.number ?? translateUi('รายละเอียดบิล')) : debtorName ?? detailLabel ?? translateUi(metricNames[detail.metric])}</h2><p>{invoiceId ? invoice?.shop : detail.metric === 'debt' || detail.metric === 'overdue' ? translateUi('ยอดปัจจุบัน') : `${formatReportDate(detailFrom)} – ${formatReportDate(detailTo)}`}{detail.agingBucket ? ` · ${translateUi(agingLabels[detail.agingBucket])}` : ''}{!invoiceId && detail.metric === 'receipts' ? translateUi(' · ก่อนหักเงินคืน') : ''}</p></div><button aria-label={translateUi('ปิดรายละเอียด')} onClick={closeDetail} type="button"><X size={21} /></button></header>
      {invoiceId ? <>
        {invoiceError ? <p className="executive-error" role="alert">{translateUi(invoiceError)}</p> : null}
        {!invoice && !invoiceError ? <p className="executive-status">{translateUi('กำลังโหลดบิล…')}</p> : null}
        {invoice ? <div className="executive-invoice">
          <p>{translateUi('วันที่ขาย ')}{formatReportDate(invoice.serviceDate)} · {invoice.area}</p>
          <p>{translateUi('ครบกำหนด ')}{formatReportDate(invoice.dueDate)}</p>
          {invoice.salesAmount !== undefined ? <div><span>{translateUi('ยอดขายสุทธิไม่รวม VAT')}</span><strong>{baht(invoice.salesAmount)}</strong></div> : null}
          {invoice.vatAmount !== undefined ? <div><span>{translateUi('VAT')}</span><strong>{baht(invoice.vatAmount)}</strong></div> : null}
          <div><span>{translateUi('ยอดบิลรวม VAT')}</span><strong>{baht(invoice.total)}</strong></div>
          <div><span>{translateUi('รับชำระแล้ว')}</span><strong>{baht(invoice.paid)}</strong></div>
          <div><span>{translateUi('คงค้าง')}</span><strong>{baht(Math.max(0, invoice.total - invoice.paid))}</strong></div>
          <h3>{translateUi('รายการสินค้า')}</h3>{invoice.items.map((item, index) => <div key={`${item.name}-${index}`}><span>{item.name}</span><strong>{number(item.quantity)} {item.unit}</strong></div>)}
          <h3>{translateUi('ประวัติรับชำระ')}</h3>{invoice.payments.length ? invoice.payments.map((payment, index) => <div key={`${payment.date}-${index}`}><span>{uiDateTimeString(new Date(payment.date), { timeZone: 'Asia/Bangkok' })} · {translateUi(payment.method === 'cash' ? 'เงินสด' : 'โอน/QR')}</span><strong>{baht(payment.amount)}</strong></div>) : <p>{translateUi('ยังไม่มีรายการรับชำระ')}</p>}
        </div> : null}
      </> : <>
      {detail.shopId ? <ReportShopProfile key={detail.shopId} shopId={detail.shopId} demo={Boolean(demoReport)}
        demoArea={Object.values(demoRows ?? {}).flat().find((row) => row.shopId === detail.shopId && row.area)?.area} /> : null}
      {detail.metric === 'receipts' && shownReport ? <div className="executive-receipt-breakdown">
        <span>{translateUi('รับจริง ')}{baht(receiptGross)}</span>
        <button onClick={() => openDetail({ metric: 'refunds', bucket: detail.bucket })} type="button">{translateUi('คืนเงิน ')}{baht(receiptRefunds)}{translateUi(' · ดูรายการ')}</button>
        <strong>{translateUi('รับสุทธิ ')}{baht(receiptGross - receiptRefunds)}</strong>
      </div> : null}
      {detailError ? <p className="executive-error" role="alert">{translateUi(detailError)} <button onClick={refresh} type="button">{translateUi('ลองใหม่')}</button></p> : null}
      {!detailData && !detailError ? <p className="executive-status">{translateUi('กำลังโหลดรายการ…')}</p> : null}
      {detailData ? <><div className="executive-detail__list-heading">{detail.shopId ? <h3>{translateUi(detail.metric === 'overdue' ? 'บิลเกินกำหนด' : detail.metric === 'debt' ? 'บิลค้างชำระ' : 'รายการขาย')}</h3> : null}<p className="executive-detail__count">{translateUi('ทั้งหมด ')}{number(detailData.total)}{translateUi(' รายการ')}</p></div>
        {detailData.rows.length ? <div className="executive-detail__rows">{detailData.rows.map((row) => (detail.metric === 'sales' || detail.metric === 'debt' || detail.metric === 'overdue') && row.shopId
          ? <button className={`executive-detail__row-button${detail.shopId ? ' executive-detail__row-button--invoice' : ''}`} key={`${row.id}-${row.day}`} onClick={() => {
            if ((detail.metric === 'debt' || detail.metric === 'overdue') && !detail.shopId) {
              debtorListPage.current = detailPage;
              setDebtorName(row.label);
              openDetail({ ...detail, shopId: row.shopId ?? undefined });
            } else setInvoiceId(row.id);
          }} type="button">{detail.shopId ? <>
            <Receipt className="executive-detail__bill-icon" size={22} aria-hidden="true" />
            <span className="executive-detail__bill-info"><strong>{translateUi('บิลวันที่ ')}{formatReportDate(row.day)}</strong>
              <small className={detail.metric === 'overdue' ? 'executive-detail__due--overdue' : undefined}>{row.dueDate ? translateUi('ครบกำหนด {0}', { 0: formatReportDate(row.dueDate) }) : translateUi('ไม่ระบุวันครบกำหนด')}</small>
            </span><span className="executive-detail__bill-amount"><b>{baht(row.amount)}</b><small>{translateUi('ดูบิล')}</small></span>
            <CaretRight size={16} aria-hidden="true" />
          </> : <><span><strong>{row.label}</strong><small>{detail.metric === 'sales' ? formatReportDate(row.day) : translateUi('ดูบิลค้าง')}{row.area ? ` · ${row.area}` : ''}{row.dueDate ? translateUi(' · ครบกำหนด {0}', { 0: formatReportDate(row.dueDate) }) : ''}</small></span><b>{baht(row.amount)}</b></>}</button>
          : <article key={`${row.id}-${row.day}`}><div><strong>{row.label}</strong><small>{formatReportDate(row.day)}{row.area ? ` · ${row.area}` : ''}{paymentMethod(row.method) ? ` · ${paymentMethod(row.method)}` : ''}</small></div><b>{baht(row.amount)}</b></article>)}</div> : <p className="executive-empty">{translateUi('ไม่มีรายการ')}</p>}
        <footer><button disabled={detailPage === 0} onClick={() => setDetailPage((page) => page - 1)} type="button">{translateUi('ก่อนหน้า')}</button><span>{translateUi('หน้า ')}{detailPage + 1} / {Math.max(1, Math.ceil(detailData.total / 50))}</span><button disabled={(detailPage + 1) * 50 >= detailData.total} onClick={() => setDetailPage((page) => page + 1)} type="button">{translateUi('ถัดไป')}</button></footer>
      </> : null}
      </>}
    </section></div> : null}
  </div>;
}
