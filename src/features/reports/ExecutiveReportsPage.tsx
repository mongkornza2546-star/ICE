import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, CaretLeft, DownloadSimple, X } from '@phosphor-icons/react';
import { supabase } from '../../lib/supabase';
import { subscribeToDataChange } from '../../lib/dataChange';
import { toBangkokDateString } from '../../lib/serviceDate';
import { translateUi, uiDateTimeString, useLanguage } from '../../i18n';
import { exportExecutiveReport } from './exportExecutiveReport';
import { ReportSections, ReportTabs, type ReportSection } from './ExecutiveReportSections';
import { formatReportDate, presetDates, reportRangeError, type Preset } from './reportDates';
import type { DetailQuery, ExecutiveReport, ReportInvoice, ReportMetric, ReportRow } from './types';
import './executiveReports.css';

const baht = (value: number) => new Intl.NumberFormat('th-TH', {
  style: 'currency', currency: 'THB', maximumFractionDigits: 0,
}).format(value);
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

function comparison(current: number, previous: number) {
  if (previous <= 0) return translateUi('ไม่มีฐานเปรียบเทียบ');
  const percent = Math.abs((current - previous) / previous * 100);
  return `${translateUi(current >= previous ? 'เพิ่มขึ้น' : 'ลดลง')} ${number(percent)}% ${translateUi('จากช่วงก่อน')}`;
}

async function fetchDetails(from: string, to: string, query: DetailQuery, offset: number) {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase');
  const { data, error } = await supabase.rpc('get_executive_report_details', {
    p_from: from, p_to: to, p_metric: query.metric,
    p_limit: 50, p_offset: offset, p_bucket: query.bucket ?? null,
    p_area_kind: query.areaKind ?? null, p_area_id: query.areaId ?? null,
    p_shop_id: query.shopId ?? null,
  });
  if (error) throw new Error(error.message);
  return data as { total: number; rows: ReportRow[] };
}

function MetricCard({ title, value, note, previous, onClick, tone }: {
  title: string; value: number; note?: string; previous?: number; onClick: (trigger: HTMLButtonElement) => void; tone?: string;
}) {
  useLanguage();
  return <button className={`executive-metric ${tone ? `executive-metric--${tone}` : ''}`}
    onClick={(event) => onClick(event.currentTarget)} type="button"><span>{title}</span><strong>{baht(value)}</strong>
    {previous !== undefined ? <small>{translateUi('ช่วงก่อน')} {baht(previous)} · {comparison(value, previous)}</small> : note ? <small>{note}</small> : null}
    <span className="executive-metric__action">{translateUi('ดูรายการ ›')}</span></button>;
}

export function ExecutiveReportsPage({ isActive, demoReport, demoRows }: {
  isActive: boolean; demoReport?: ExecutiveReport;
  demoRows?: Partial<Record<ReportMetric, ReportRow[]>>;
}) {
  useLanguage();
  const initial = presetDates('month');
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
  const debtorListPage = useRef(0);
  const rangeError = reportRangeError(from, to);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    if (!isActive || rangeError) return;
    if (demoReport) {
      setReport({ ...demoReport, from, to });
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
      const rows = (demoRows[detail.metric] ?? []).filter((row) =>
        (!detail.bucket || row.day === detail.bucket)
        && (!detail.shopId || row.shopId === detail.shopId)
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
  const openDetail = (query: DetailQuery, label?: string, trigger?: HTMLElement) => {
    if (!detail) detailTrigger.current = trigger ?? document.activeElement as HTMLElement | null;
    setDetail(query); setDetailPage(0); setInvoiceId(null); setDetailLabel(label ?? null);
    if (!query.shopId) setDebtorName(null);
  };
  const closeDetail = () => {
    setDetail(null); setInvoiceId(null); setDetailLabel(null); setDebtorName(null);
    window.requestAnimationFrame(() => detailTrigger.current?.focus());
  };
  const backDetail = () => {
    if (invoiceId) { setInvoiceId(null); return; }
    if (detail?.shopId && (detail.metric === 'debt' || detail.metric === 'overdue')) {
      setDetail({ metric: detail.metric });
      setDetailPage(debtorListPage.current);
      setDebtorName(null);
      setDetailLabel(null);
      return;
    }
    closeDetail();
  };

  const handleExport = async () => {
    if (!report || exporting || loading || error || rangeError) return;
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
        const expected = { sales: report.sales, receipts: report.receipts,
          refunds: report.refunds, debt: report.outstanding };
        if ((Object.keys(expected) as Array<keyof typeof expected>).some((metric) =>
          Math.abs(amount(metric) - Number(expected[metric])) > 0.01)) {
          throw new Error('ข้อมูลเปลี่ยนระหว่างสร้างไฟล์ กรุณารีเฟรชรายงานแล้วลองอีกครั้ง');
        }
      }
      await exportExecutiveReport(report, all);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ส่งออก Excel ไม่สำเร็จ');
    } finally {
      setExporting(false);
    }
  };

  const shownReport = report && report.from === from && report.to === to ? report : null;
  const receiptPoint = detail?.bucket ? shownReport?.trend.find((row) => row.date === detail.bucket) : null;
  const receiptGross = detail?.bucket ? receiptPoint?.receipts ?? 0 : shownReport?.receipts ?? 0;
  const receiptRefunds = detail?.bucket ? receiptPoint?.refunds ?? 0 : shownReport?.refunds ?? 0;
  return <div className="executive-report">
    <header className="executive-report__heading">
      <div><h1>{translateUi('รายงานผู้บริหาร')}</h1><p>{translateUi('ยอดขาย เงินรับ ลูกหนี้ และปริมาณส่ง')}</p></div>
      <div className="executive-report__actions">
        <button aria-label={translateUi('รีเฟรชรายงาน')} disabled={loading || Boolean(rangeError)} onClick={refresh} type="button"><ArrowClockwise size={19} />{translateUi(' รีเฟรช')}</button>
        <button disabled={!shownReport || loading || exporting || Boolean(error)} onClick={() => void handleExport()} type="button"><DownloadSimple size={19} /> {exporting ? translateUi('กำลังสร้าง Excel…') : translateUi('ส่งออก Excel')}</button>
      </div>
    </header>

    <section className="executive-filters" aria-label={translateUi('เลือกช่วงเวลารายงาน')}>
      <div className="executive-filter-controls"><div aria-label={translateUi('ช่วงวันที่ลัด')} className="executive-presets">{(Object.keys(presetNames) as Array<Exclude<Preset, 'custom'>>).map((key) =>
        <button aria-pressed={preset === key} key={key} onClick={() => choosePreset(key)} type="button">{translateUi(presetNames[key])}</button>)}</div>
      <div className="executive-dates"><label>{translateUi('จาก')}<input max={toBangkokDateString()} onChange={(event) => { setPreset('custom'); setFrom(event.target.value); setDetail(null); }} type="date" value={from} /></label>
        <label>{translateUi('ถึง')}<input max={toBangkokDateString()} onChange={(event) => { setPreset('custom'); setTo(event.target.value); setDetail(null); }} type="date" value={to} /></label></div></div>
      {rangeError ? <p className="executive-error" role="alert">{translateUi(rangeError)}</p> : null}
      {shownReport ? <p className="executive-asof">{translateUi('ข้อมูล ณ ')}{uiDateTimeString(new Date(shownReport.asOf), { timeZone: 'Asia/Bangkok' })} · {formatReportDate(from)} – {formatReportDate(to)}{to === toBangkokDateString() ? ` · ${translateUi('วันนี้ยังไม่สิ้นสุด')}` : ''}</p> : null}
    </section>

    {error ? <div className="executive-error" role="alert">{translateUi('โหลดรายงานไม่สำเร็จ: ')}{translateUi(error)} <button onClick={refresh} type="button">{translateUi('ลองใหม่')}</button></div> : null}
    {loading && !shownReport ? <p className="executive-status" role="status">{translateUi('กำลังโหลดรายงาน…')}</p> : null}
    {shownReport ? <>
      <section className="executive-metrics" aria-label={translateUi('ตัวเลขสำคัญ')}>
        <MetricCard title={translateUi('ยอดขายสุทธิช่วงนี้')} value={shownReport.sales} previous={shownReport.previousSales} onClick={(trigger) => openDetail({ metric: 'sales' }, undefined, trigger)} />
        <MetricCard title={translateUi('เงินรับสุทธิช่วงนี้')} value={shownReport.netReceipts} previous={shownReport.previousNetReceipts} onClick={(trigger) => openDetail({ metric: 'receipts' }, undefined, trigger)} />
        <MetricCard title={translateUi('หนี้ค้างปัจจุบัน')} value={shownReport.outstanding} note={`${number(shownReport.debtors)} ${translateUi('ร้าน')} · ${translateUi('ณ')} ${formatReportDate(toBangkokDateString())}`} tone="amber" onClick={(trigger) => openDetail({ metric: 'debt' }, undefined, trigger)} />
        <MetricCard title={translateUi('เกินกำหนดปัจจุบัน')} value={shownReport.overdue} note="บิลที่ต้องติดตาม" tone="red" onClick={(trigger) => openDetail({ metric: 'overdue' }, undefined, trigger)} />
      </section>
      <p className="executive-period-note">{translateUi('ยอดขายและเงินรับอิงช่วงวันที่เลือก · หนี้ค้างและเกินกำหนดเป็นยอดปัจจุบัน')}</p>

      <ReportTabs active={section} onChange={setSection} />
      <ReportSections section={section} report={shownReport} trendMetric={trendMetric}
        setTrendMetric={setTrendMetric} showTrendTable={showTrendTable}
        toggleTrendTable={() => setShowTrendTable((value) => !value)} openDetail={openDetail} />
    </> : null}

    {detail ? <div className="executive-detail-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDetail(); }}><section aria-label={invoiceId ? translateUi('รายละเอียดบิล') : translateUi('รายละเอียด{0}', { 0: translateUi(metricNames[detail.metric]) })} aria-modal="true" className="executive-detail" onKeyDown={(event) => {
      if (event.key === 'Escape') { backDetail(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      if (!focusable.length) return;
      if (event.shiftKey && (document.activeElement === focusable[0] || document.activeElement === dialogRef.current)) { event.preventDefault(); focusable[focusable.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) { event.preventDefault(); focusable[0].focus(); }
    }} ref={dialogRef} role="dialog" tabIndex={-1}>
      <header><button aria-label={invoiceId || detail.shopId ? translateUi('กลับไปยังรายการ') : translateUi('ย้อนกลับไปยังรายงาน')} onClick={backDetail} type="button"><CaretLeft size={21} /></button><div><h2>{invoiceId ? (invoice?.number ?? translateUi('รายละเอียดบิล')) : debtorName ?? detailLabel ?? translateUi(metricNames[detail.metric])}</h2><p>{invoiceId ? invoice?.shop : detail.metric === 'debt' || detail.metric === 'overdue' ? translateUi('ยอดปัจจุบัน') : `${formatReportDate(from)} – ${formatReportDate(to)}`}{!invoiceId && detail.metric === 'receipts' ? translateUi(' · ก่อนหักเงินคืน') : ''}</p></div><button aria-label={translateUi('ปิดรายละเอียด')} onClick={closeDetail} type="button"><X size={21} /></button></header>
      {invoiceId ? <>
        {invoiceError ? <p className="executive-error" role="alert">{translateUi(invoiceError)}</p> : null}
        {!invoice && !invoiceError ? <p className="executive-status">{translateUi('กำลังโหลดบิล…')}</p> : null}
        {invoice ? <div className="executive-invoice">
          <p>{translateUi('วันที่ขาย ')}{formatReportDate(invoice.serviceDate)} · {invoice.area}</p>
          <p>{translateUi('ครบกำหนด ')}{formatReportDate(invoice.dueDate)}</p>
          <div><span>{translateUi('ยอดขายสุทธิ')}</span><strong>{baht(invoice.total)}</strong></div>
          <div><span>{translateUi('รับชำระแล้ว')}</span><strong>{baht(invoice.paid)}</strong></div>
          <div><span>{translateUi('คงค้าง')}</span><strong>{baht(Math.max(0, invoice.total - invoice.paid))}</strong></div>
          <h3>{translateUi('รายการสินค้า')}</h3>{invoice.items.map((item, index) => <div key={`${item.name}-${index}`}><span>{item.name}</span><strong>{number(item.quantity)} {item.unit}</strong></div>)}
          <h3>{translateUi('ประวัติรับชำระ')}</h3>{invoice.payments.length ? invoice.payments.map((payment, index) => <div key={`${payment.date}-${index}`}><span>{uiDateTimeString(new Date(payment.date), { timeZone: 'Asia/Bangkok' })} · {translateUi(payment.method === 'cash' ? 'เงินสด' : 'โอน/QR')}</span><strong>{baht(payment.amount)}</strong></div>) : <p>{translateUi('ยังไม่มีรายการรับชำระ')}</p>}
        </div> : null}
      </> : <>
      {detail.metric === 'receipts' && shownReport ? <div className="executive-receipt-breakdown">
        <span>{translateUi('รับจริง ')}{baht(receiptGross)}</span>
        <button onClick={() => openDetail({ metric: 'refunds', bucket: detail.bucket })} type="button">{translateUi('คืนเงิน ')}{baht(receiptRefunds)}{translateUi(' · ดูรายการ')}</button>
        <strong>{translateUi('รับสุทธิ ')}{baht(receiptGross - receiptRefunds)}</strong>
      </div> : null}
      {detailError ? <p className="executive-error" role="alert">{translateUi(detailError)} <button onClick={refresh} type="button">{translateUi('ลองใหม่')}</button></p> : null}
      {!detailData && !detailError ? <p className="executive-status">{translateUi('กำลังโหลดรายการ…')}</p> : null}
      {detailData ? <><p className="executive-detail__count">{translateUi('ทั้งหมด ')}{number(detailData.total)}{translateUi(' รายการ')}</p>
        {detailData.rows.length ? <div className="executive-detail__rows">{detailData.rows.map((row) => (detail.metric === 'sales' || detail.metric === 'debt' || detail.metric === 'overdue') && row.shopId
          ? <button className="executive-detail__row-button" key={`${row.id}-${row.day}`} onClick={() => {
            if ((detail.metric === 'debt' || detail.metric === 'overdue') && !detail.shopId) {
              debtorListPage.current = detailPage;
              setDebtorName(row.label);
              openDetail({ ...detail, shopId: row.shopId ?? undefined });
            } else setInvoiceId(row.id);
          }} type="button"><span><strong>{row.label}</strong><small>{detail.shopId || detail.metric === 'sales' ? formatReportDate(row.day) : translateUi('ดูบิลค้าง')}{row.area ? ` · ${row.area}` : ''}{row.dueDate ? translateUi(' · ครบกำหนด {0}', { 0: formatReportDate(row.dueDate) }) : ''}</small></span><b>{baht(row.amount)}</b></button>
          : <article key={`${row.id}-${row.day}`}><div><strong>{row.label}</strong><small>{formatReportDate(row.day)}{row.area ? ` · ${row.area}` : ''}{paymentMethod(row.method) ? ` · ${paymentMethod(row.method)}` : ''}</small></div><b>{baht(row.amount)}</b></article>)}</div> : <p className="executive-empty">{translateUi('ไม่มีรายการ')}</p>}
        <footer><button disabled={detailPage === 0} onClick={() => setDetailPage((page) => page - 1)} type="button">{translateUi('ก่อนหน้า')}</button><span>{translateUi('หน้า ')}{detailPage + 1} / {Math.max(1, Math.ceil(detailData.total / 50))}</span><button disabled={(detailPage + 1) * 50 >= detailData.total} onClick={() => setDetailPage((page) => page + 1)} type="button">{translateUi('ถัดไป')}</button></footer>
      </> : null}
      </>}
    </section></div> : null}
  </div>;
}
