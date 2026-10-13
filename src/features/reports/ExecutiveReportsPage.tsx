import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, CaretLeft, CaretRight, DownloadSimple, Receipt, X } from '@phosphor-icons/react';
import { supabase } from '../../lib/supabase';
import { subscribeToDataChange } from '../../lib/dataChange';
import { toBangkokDateString } from '../../lib/serviceDate';
import { translateUi, uiDateTimeString, useLanguage } from '../../i18n';
import { exportExecutiveReport } from './exportExecutiveReport';
import { ReportSections, ReportTabs, type ReportSection } from './ExecutiveReportSections';
import { ExecutiveFollowUps } from './ExecutiveFollowUps';
import { ReportShopProfile } from './ReportShopProfile';
import { formatReportDate, presetDates, previousPeriod, reportRangeError, type Preset } from './reportDates';
import type { DetailQuery, ExecutiveReport, ReportInvoice, ReportMetric, ReportRow } from './types';
import { FinancialOverview } from './FinancialOverview';
import { financialReconciliation, money as baht } from './financialReport';
import { agingLabels } from './reportInsights';
import './executiveReports.css';

const number = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value);
const metricNames: Record<ReportMetric, string> = {
  sales: 'ยอดขายสุทธิ', receipts: 'เงินรับจริง', refunds: 'เงินคืนจริง',
  debt: 'หนี้ค้างปัจจุบัน', overdue: 'เกินกำหนดปัจจุบัน',
};
const paymentMethod = (method?: string | null) => method === 'cash' ? 'เงินสด'
  : method === 'bank_transfer' ? 'โอนเงิน' : method === 'qr' ? 'QR' : null;
const presetNames: Record<Exclude<Preset, 'custom'>, string> = {
  today: 'วันนี้', week: '7 วัน', month: 'เดือนนี้', year: 'ปีนี้',
};

async function fetchDetails(from: string, to: string, query: DetailQuery, offset: number) {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase');
  if (query.agingBucket) {
    const { data, error } = await supabase.rpc('get_executive_report_aged_details', {
      p_bucket: query.agingBucket, p_shop_id: query.shopId ?? null, p_limit: 50, p_offset: offset,
    });
    if (error) throw new Error(error.message);
    return data as { total: number; rows: ReportRow[] };
  }
  const { data, error } = await supabase.rpc('get_executive_report_details', {
    p_from: from, p_to: to, p_metric: query.metric,
    p_limit: 50, p_offset: offset, p_bucket: query.bucket ?? null,
    p_area_kind: query.areaKind ?? null, p_area_id: query.areaId ?? null,
    p_shop_id: query.shopId ?? null,
  });
  if (error) throw new Error(error.message);
  return data as { total: number; rows: ReportRow[] };
}

export function ExecutiveReportsPage({ isActive, demoReport, demoRows }: {
  isActive: boolean; demoReport?: ExecutiveReport;
  demoRows?: Partial<Record<ReportMetric, ReportRow[]>>;
}) {
  useLanguage();
  const initial = presetDates('month');
  const [scopeShopId, setScopeShopId] = useState('');
  const [scopeOptions, setScopeOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [preset, setPreset] = useState<Preset>('month');
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [report, setReport] = useState<ExecutiveReport | null>(demoReport ?? null);
  const [loading, setLoading] = useState(!demoReport);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [trendMetric, setTrendMetric] = useState<'sales' | 'receipts'>('sales');
  const [showTrendTable, setShowTrendTable] = useState(false);
  const [section, setSection] = useState<ReportSection>('overview');
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
  const shownReport = !rangeError && report && report.from === from && report.to === to && (report.scopeShopId ?? '') === scopeShopId ? report : null;

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    if (!isActive || rangeError) return;
    if (demoReport) {
      setReport({ ...demoReport, from, to, ...previousPeriod(from, to) });
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
    void supabase.rpc(scopeShopId ? 'get_executive_report_for_shop' : 'get_executive_report', { p_from: from, p_to: to, ...(scopeShopId ? { p_shop_id: scopeShopId } : {}) }).then(({ data, error: rpcError }) => {
      if (request !== reportRequest.current) return;
      if (rpcError) setError(rpcError.message);
      else {
        setReport(data as ExecutiveReport);
        setScopeOptions((data as ExecutiveReport).scopeOptions ?? []);
      }
      setLoading(false);
    }, (cause: unknown) => {
      if (request !== reportRequest.current) return;
      setError(cause instanceof Error ? cause.message : 'โหลดรายงานไม่สำเร็จ');
      setLoading(false);
    });
    return () => { reportRequest.current += 1; };
  }, [isActive, from, to, scopeShopId, refreshKey, rangeError, demoReport]);

  useEffect(() => {
    if (!isActive || demoReport) return;
    const doRefresh = () => {
      if (document.visibilityState !== 'visible') return;
      if (preset !== 'custom') {
        const dates = presetDates(preset);
        if (dates.from !== from || dates.to !== to) {
          setFrom(dates.from);
          setTo(dates.to);
          setDetail(null);
          return;
        }
      }
      refresh();
    };
    const timer = window.setInterval(doRefresh, 60_000);
    window.addEventListener('focus', doRefresh);
    window.addEventListener('online', doRefresh);
    const unsubscribe = subscribeToDataChange(['accounting', 'payment', 'receivable', 'refund', 'stock', 'pos'], doRefresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', doRefresh);
      window.removeEventListener('online', doRefresh);
      unsubscribe();
    };
  }, [isActive, refresh, demoReport, preset, from, to]);

  useEffect(() => {
    if (!detail || !isActive || rangeError) return;
    const request = ++detailRequest.current;
    setDetailData(null);
    setDetailError(null);
    if (demoRows) {
      const snapshot = report ? toBangkokDateString(new Date(report.asOf)) : toBangkokDateString();
      const rows = (demoRows[detail.metric] ?? []).filter((row) =>
        (!detail.bucket || row.day === detail.bucket)
        && (!detail.shopId || row.shopId === detail.shopId)
        && (!detail.agingBucket || (() => {
          const age = (Date.parse(snapshot) - Date.parse(row.dueDate ?? row.day)) / 86400000;
          return (age <= 0 ? 'notDue' : age <= 7 ? 'days1to7' : age <= 30 ? 'days8to30' : 'days31plus') === detail.agingBucket;
        })())
        && (!detail.areaKind || row.area === report?.areas.find((area) => area.kind === detail.areaKind && area.id === detail.areaId)?.name));
      setDetailData({ total: rows.length, rows: rows.slice(detailPage * 50, (detailPage + 1) * 50) });
      return;
    }
    void fetchDetails(from, to, detail, detailPage * 50).then((result) => {
      if (request === detailRequest.current) setDetailData(result);
    }, (cause: unknown) => {
      if (request === detailRequest.current) setDetailError(cause instanceof Error ? cause.message : 'โหลดรายการไม่สำเร็จ');
    });
    return () => { detailRequest.current += 1; };
  }, [detail, detailPage, from, to, isActive, rangeError, refreshKey, demoRows, report?.areas]);

  useEffect(() => {
    if (!invoiceId) return;
    const request = ++invoiceRequest.current;
    setInvoice(null);
    setInvoiceError(null);
    if (demoReport) {
      setInvoice({ number: 'C-DEMO-001', shop: 'ร้านกาแฟลานเล่า', serviceDate: to,
        area: 'อาคาร A', dueDate: to, total: 28000, paid: 23200,
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
  const openDetail = (requested: DetailQuery, label?: string, trigger?: HTMLElement) => {
    const query = { ...requested, shopId: requested.shopId ?? (scopeShopId || undefined) };
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
    if (!scopeShopId && detail?.shopId && (detail.metric === 'debt' || detail.metric === 'overdue')) {
      setDetail({ metric: detail.metric, agingBucket: detail.agingBucket });
      setDetailPage(debtorListPage.current);
      setDebtorName(null);
      setDetailLabel(detail.agingBucket ? agingLabels[detail.agingBucket] : null);
      return;
    }
    closeDetail();
  };

  const handleExport = async () => {
    if (!report || exporting || loading || error || rangeError) return;
    setExporting(true);
    try {
      if (!financialReconciliation(report)) throw new Error('ยอดสรุปไม่ตรงกับข้อมูลแยกย่อย กรุณารีเฟรชก่อนส่งออก');
      const metrics: ReportMetric[] = ['sales', 'receipts', 'refunds', 'debt'];
      const all: Partial<Record<ReportMetric, ReportRow[]>> = {};
      for (const metric of metrics) {
        if (demoRows) { all[metric] = demoRows[metric] ?? []; continue; }
        const rows: ReportRow[] = [];
        let total = 0;
        do {
          const page = await fetchDetails(from, to, { metric, shopId: scopeShopId || undefined }, rows.length);
          total = page.total;
          rows.push(...page.rows);
          if (page.rows.length === 0) break;
        } while (rows.length < total);
        all[metric] = rows;
      }
      if (!demoRows) {
        const amount = (metric: ReportMetric) => (all[metric] ?? []).reduce((sum, row) => sum + Number(row.amount), 0);
        const expected = { sales: report.sales, receipts: report.receipts,
          refunds: report.refunds, debt: report.outstanding };
        if ((Object.keys(expected) as Array<keyof typeof expected>).some((metric) =>
          !Number.isFinite(amount(metric)) || !Number.isFinite(expected[metric])
          || Math.abs(amount(metric) - Number(expected[metric])) > 0.01)) {
          throw new Error('ข้อมูลเปลี่ยนระหว่างสร้างไฟล์ กรุณารีเฟรชรายงานแล้วลองอีกครั้ง');
        }
      }
      await exportExecutiveReport(report, all, { demo: Boolean(demoReport) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ส่งออก Excel ไม่สำเร็จ');
    } finally {
      setExporting(false);
    }
  };

  const receiptPoint = detail?.bucket ? shownReport?.trend.find((row) => row.date === detail.bucket) : null;
  const receiptGross = detail?.bucket ? receiptPoint?.receipts ?? 0 : shownReport?.receipts ?? 0;
  const receiptRefunds = detail?.bucket ? receiptPoint?.refunds ?? 0 : shownReport?.refunds ?? 0;
  return <div className="executive-report">
    <header className="executive-report__heading">
      <div><h1 ref={reportHeading} tabIndex={-1}>{translateUi('รายงานผู้บริหาร')}</h1><p>{translateUi('ภาพรวมที่เข้าใจได้ แล้วเจาะตัวเลขเพื่อสั่งการต่อ')}</p></div>
      <div className="executive-report__actions">
        <button aria-label={translateUi('รีเฟรชรายงาน')} disabled={loading || Boolean(rangeError)} onClick={refresh} type="button"><ArrowClockwise size={19} />{translateUi(' รีเฟรช')}</button>
        <button disabled={!shownReport || loading || exporting || Boolean(error)} onClick={() => void handleExport()} type="button"><DownloadSimple size={19} /> {exporting ? translateUi('กำลังสร้าง Excel…') : translateUi('ส่งออก Excel')}</button>
      </div>
    </header>

    {demoReport ? <p className="executive-demo-notice" role="status">{translateUi('โหมดตัวอย่าง · ตัวเลขสมมติสำหรับทดสอบหน้าจอ ไม่ใช่ข้อมูลจริง')}</p> : null}
    <section className="executive-filters" aria-label={translateUi('เลือกช่วงเวลารายงาน')}>
      <div className="executive-filter-controls"><div aria-label={translateUi('ช่วงวันที่ลัด')} className="executive-presets">{(Object.keys(presetNames) as Array<Exclude<Preset, 'custom'>>).map((key) =>
        <button aria-pressed={preset === key} key={key} onClick={() => choosePreset(key)} type="button">{translateUi(presetNames[key])}</button>)}</div>
      <div className="executive-dates"><label>{translateUi('จาก')}<input max={toBangkokDateString()} onChange={(event) => { setPreset('custom'); setFrom(event.target.value); setDetail(null); }} type="date" value={from} /></label>
        <label>{translateUi('ถึง')}<input max={toBangkokDateString()} onChange={(event) => { setPreset('custom'); setTo(event.target.value); setDetail(null); }} type="date" value={to} /></label></div>
      <label className="executive-scope">{translateUi('ขอบเขตข้อมูล')}<select value={scopeShopId} onChange={(event) => { setScopeShopId(event.target.value); setDetail(null); setSection('overview'); }}><option value="">{translateUi('ทั้งกิจการ')}</option>{scopeOptions.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}</select></label></div>
      {rangeError ? <p className="executive-error" role="alert">{translateUi(rangeError)}</p> : null}
      {shownReport ? <p className="executive-asof">{translateUi('อัปเดตข้อมูลล่าสุด ')}{uiDateTimeString(new Date(shownReport.asOf), { timeZone: 'Asia/Bangkok' })} · {formatReportDate(from)} – {formatReportDate(to)}</p> : null}
      {shownReport?.previousFrom && shownReport.previousTo ? <p className="executive-asof">{translateUi('เทียบช่วงก่อนหน้าเท่ากัน')} {formatReportDate(shownReport.previousFrom)} – {formatReportDate(shownReport.previousTo)} · {translateUi('ยอดลูกหนี้ใช้วันที่อัปเดต ไม่ใช่วันสิ้นช่วง')}</p> : null}
    </section>

    {error ? <div className="executive-error" role="alert">{translateUi('โหลดรายงานไม่สำเร็จ: ')}{translateUi(error)} <button onClick={refresh} type="button">{translateUi('ลองใหม่')}</button></div> : null}
    {loading && !shownReport ? <p className="executive-status" role="status">{translateUi('กำลังโหลดรายงาน…')}</p> : null}
    {shownReport ? <>
      <ReportTabs active={section} onChange={setSection} />
      <FinancialOverview report={shownReport} openDetail={openDetail} onAnalyze={(target) => { setSection('finance'); window.requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth' })); }} />
      {section === 'sales' || section === 'volume' ? <nav className="executive-detail-nav" aria-label={translateUi('รายละเอียดรายงาน')}>
        <button onClick={() => setSection('overview')} type="button"><CaretLeft size={16} />{translateUi('กลับภาพรวม')}</button>
        <button aria-current={section === 'sales' ? 'page' : undefined} onClick={() => setSection('sales')} type="button">{translateUi('ยอดขาย')}</button>
        <button aria-current={section === 'volume' ? 'page' : undefined} onClick={() => setSection('volume')} type="button">{translateUi('ปริมาณส่ง')}</button>
      </nav> : null}
      <ReportSections
        onNavigateSection={(nextSection, targetId) => {
          setSection(nextSection);
          if (targetId) {
            window.requestAnimationFrame(() => {
              document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth' });
            });
          }
        }}
        openDetail={openDetail}
        report={shownReport}
        section={section}
        setTrendMetric={setTrendMetric}
        showTrendTable={showTrendTable}
        toggleTrendTable={() => setShowTrendTable((value) => !value)}
        trendMetric={trendMetric}
      />

      {section === 'finance' && !scopeShopId ? <ExecutiveFollowUps report={shownReport} isActive={isActive} demoRows={demoReport ? demoRows?.overdue ?? [] : undefined}
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
      <header><button aria-label={invoiceId || detail.shopId ? translateUi('กลับไปยังรายการ') : translateUi('ย้อนกลับไปยังรายงาน')} onClick={backDetail} type="button"><CaretLeft size={21} /></button><div><h2>{invoiceId ? (invoice?.number ?? translateUi('รายละเอียดบิล')) : debtorName ?? detailLabel ?? translateUi(metricNames[detail.metric])}</h2><p>{invoiceId ? invoice?.shop : detail.metric === 'debt' || detail.metric === 'overdue' ? `${translateUi('ยอด ณ')} ${shownReport ? formatReportDate(toBangkokDateString(new Date(shownReport.asOf))) : '—'}` : `${formatReportDate(from)} – ${formatReportDate(to)}`}{!invoiceId && detail.metric === 'receipts' ? translateUi(' · ก่อนหักเงินคืน') : ''}</p></div><button aria-label={translateUi('ปิดรายละเอียด')} onClick={closeDetail} type="button"><X size={21} /></button></header>
      {invoiceId ? <>
        {invoiceError ? <p className="executive-error" role="alert">{translateUi(invoiceError)}</p> : null}
        {!invoice && !invoiceError ? <p className="executive-status">{translateUi('กำลังโหลดบิล…')}</p> : null}
        {invoice ? <div className="executive-invoice">
          <p>{translateUi('วันที่ขาย ')}{formatReportDate(invoice.serviceDate)} · {invoice.area}</p>
          <p>{translateUi('ครบกำหนด ')}{formatReportDate(invoice.dueDate)}</p>
          {invoice.sales !== undefined ? <div><span>{translateUi('ยอดขายไม่รวม VAT')}</span><strong>{baht(invoice.sales)}</strong></div> : null}
          {invoice.vat !== undefined ? <div><span>VAT</span><strong>{baht(invoice.vat)}</strong></div> : null}
          <div><span>{translateUi('ยอดบิลรวม VAT')}</span><strong>{baht(invoice.total)}</strong></div>
          <div><span>{translateUi('รับชำระแล้ว')}</span><strong>{baht(invoice.paid)}</strong></div>
          <div><span>{translateUi('คงค้าง')}</span><strong>{baht(Math.max(0, invoice.total - invoice.paid))}</strong></div>
          <h3>{translateUi('รายการสินค้า')}</h3>{invoice.items.map((item, index) => <div key={`${item.name}-${index}`}><span>{item.name}</span><strong>{number(item.quantity)} {item.unit}</strong></div>)}
          <h3>{translateUi('ประวัติรับชำระ')}</h3>{invoice.payments.length ? invoice.payments.map((payment, index) => <div key={`${payment.date}-${index}`}><span>{uiDateTimeString(new Date(payment.date), { timeZone: 'Asia/Bangkok' })} · {translateUi(payment.method === 'cash' ? 'เงินสด' : 'โอน/QR')}</span><strong>{baht(payment.amount)}</strong></div>) : <p>{translateUi('ยังไม่มีรายการรับชำระ')}</p>}
        </div> : null}
      </> : <>
      {detail.shopId ? <ReportShopProfile key={detail.shopId} shopId={detail.shopId} demo={Boolean(demoReport)}
        demoArea={Object.values(demoRows ?? {}).flat().find((row) => row.shopId === detail.shopId && row.area)?.area} /> : null}
      <p className="executive-panel-note">{translateUi('3 · รายการประกอบ')} · {shownReport?.scopeName ?? translateUi('ทั้งกิจการ')}{detail.agingBucket ? ` · ${translateUi(agingLabels[detail.agingBucket])}` : ''}</p>
      {detail.metric === 'receipts' && shownReport && (!detail.bucket || receiptPoint) && !detail.areaKind && (detail.shopId ?? '') === (shownReport.scopeShopId ?? '') ? <div className="executive-receipt-breakdown">
        <span>{translateUi('รับจริง ')}{baht(receiptGross)}</span>
        <button onClick={() => openDetail({ metric: 'refunds', bucket: detail.bucket, shopId: detail.shopId })} type="button">{translateUi('คืนเงิน ')}{baht(receiptRefunds)}{translateUi(' · ดูรายการ')}</button>
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
