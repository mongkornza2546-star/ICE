import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, CaretLeft, DownloadSimple, X } from '@phosphor-icons/react';
import { supabase } from '../../lib/supabase';
import { subscribeToDataChange } from '../../lib/dataChange';
import { toBangkokDateString } from '../../lib/serviceDate';
import { exportExecutiveReport } from './exportExecutiveReport';
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
  if (!previous) return 'ไม่มีฐานเปรียบเทียบ';
  const percent = Math.abs((current - previous) / previous * 100);
  return `${current >= previous ? 'เพิ่ม' : 'ลด'} ${number(percent)}% จากช่วงก่อน`;
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

function MetricCard({ title, value, note, onClick, tone }: {
  title: string; value: number; note: string; onClick: () => void; tone?: string;
}) {
  return <button className={`executive-metric ${tone ? `executive-metric--${tone}` : ''}`}
    onClick={onClick} type="button"><span>{title}</span><strong>{baht(value)}</strong><small>{note}</small></button>;
}

export function ExecutiveReportsPage({ isActive, demoReport, demoRows }: {
  isActive: boolean; demoReport?: ExecutiveReport;
  demoRows?: Partial<Record<ReportMetric, ReportRow[]>>;
}) {
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
  const [detail, setDetail] = useState<DetailQuery | null>(null);
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
    }).catch((cause: unknown) => {
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
  const openDetail = (query: DetailQuery) => {
    if (!detail) detailTrigger.current = document.activeElement as HTMLElement | null;
    setDetail(query); setDetailPage(0); setInvoiceId(null);
    if (!query.shopId) setDebtorName(null);
  };
  const closeDetail = () => {
    setDetail(null);
    window.requestAnimationFrame(() => detailTrigger.current?.focus());
  };
  const backDetail = () => {
    if (invoiceId) { setInvoiceId(null); return; }
    if (detail?.shopId && (detail.metric === 'debt' || detail.metric === 'overdue')) {
      setDetail({ metric: detail.metric });
      setDetailPage(debtorListPage.current);
      setDebtorName(null);
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
  const maxTrend = Math.max(1, ...((shownReport?.trend ?? []).map((row) => trendMetric === 'sales' ? row.sales : row.receipts - row.refunds)));
  const maxArea = Math.max(1, ...((shownReport?.areas ?? []).map((row) => row.sales)));
  return <div className="executive-report">
    <header className="executive-report__heading">
      <div><h1>รายงานผู้บริหาร</h1><p>ภาพรวมยอดขาย เงินรับ และลูกหนี้</p></div>
      <div className="executive-report__actions">
        <button aria-label="รีเฟรชรายงาน" disabled={loading || Boolean(rangeError)} onClick={refresh} type="button"><ArrowClockwise size={19} /> รีเฟรช</button>
        <button disabled={!shownReport || loading || exporting || Boolean(error)} onClick={() => void handleExport()} type="button"><DownloadSimple size={19} /> {exporting ? 'กำลังสร้าง Excel…' : 'ส่งออก Excel'}</button>
      </div>
    </header>

    <section className="executive-filters" aria-label="เลือกช่วงเวลารายงาน">
      <div className="executive-presets">{(Object.keys(presetNames) as Array<Exclude<Preset, 'custom'>>).map((key) =>
        <button aria-pressed={preset === key} key={key} onClick={() => choosePreset(key)} type="button">{presetNames[key]}</button>)}</div>
      <div className="executive-dates"><label>จาก<input max={toBangkokDateString()} onChange={(event) => { setPreset('custom'); setFrom(event.target.value); setDetail(null); }} type="date" value={from} /></label>
        <label>ถึง<input max={toBangkokDateString()} onChange={(event) => { setPreset('custom'); setTo(event.target.value); setDetail(null); }} type="date" value={to} /></label></div>
      {rangeError ? <p className="executive-error" role="alert">{rangeError}</p> : null}
      {shownReport ? <p className="executive-asof">ข้อมูล ณ {new Date(shownReport.asOf).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })} · {formatReportDate(from)} – {formatReportDate(to)}{to === toBangkokDateString() ? ' · วันนี้ยังไม่สิ้นสุด' : ''}</p> : null}
    </section>

    {error ? <div className="executive-error" role="alert">โหลดรายงานไม่สำเร็จ: {error} <button onClick={refresh} type="button">ลองใหม่</button></div> : null}
    {loading && !shownReport ? <p className="executive-status" role="status">กำลังโหลดรายงาน…</p> : null}
    {shownReport ? <>
      <section className="executive-metrics" aria-label="ตัวเลขสำคัญ">
        <MetricCard title="ยอดขายสุทธิช่วงนี้" value={shownReport.sales} note={comparison(shownReport.sales, shownReport.previousSales)} onClick={() => openDetail({ metric: 'sales' })} />
        <MetricCard title="เงินรับสุทธิช่วงนี้" value={shownReport.netReceipts} note={`${comparison(shownReport.netReceipts, shownReport.previousNetReceipts)} · คืน ${baht(shownReport.refunds)}`} onClick={() => openDetail({ metric: 'receipts' })} />
        <MetricCard title="หนี้ค้างปัจจุบัน" value={shownReport.outstanding} note={`${number(shownReport.debtors)} ร้าน · ณ ${formatReportDate(toBangkokDateString())}`} tone="amber" onClick={() => openDetail({ metric: 'debt' })} />
        <MetricCard title="เกินกำหนดปัจจุบัน" value={shownReport.overdue} note="แตะเพื่อดูบิลที่ต้องติดตาม" tone="red" onClick={() => openDetail({ metric: 'overdue' })} />
      </section>
      {shownReport.refunds > 0 ? <button className="executive-text-button" onClick={() => openDetail({ metric: 'refunds' })} type="button">ดูรายการคืนเงินจริง {baht(shownReport.refunds)}</button> : null}

      <div className="executive-report__grid">
        <section className="executive-panel" aria-label="แนวโน้มยอดขายและเงินรับ">
          <div className="executive-panel__head"><div><h2>แนวโน้ม</h2><p>แตะแท่งเพื่อดูรายการในช่วงนั้น</p></div><div className="executive-segment"><button aria-pressed={trendMetric === 'sales'} onClick={() => setTrendMetric('sales')} type="button">ยอดขาย</button><button aria-pressed={trendMetric === 'receipts'} onClick={() => setTrendMetric('receipts')} type="button">เงินรับสุทธิ</button></div></div>
          {shownReport.trend.length ? <>
            <div className="executive-chart" role="group" aria-label={`กราฟ${trendMetric === 'sales' ? 'ยอดขาย' : 'เงินรับสุทธิ'}`}>
              {shownReport.trend.map((point) => {
                const value = trendMetric === 'sales' ? point.sales : point.receipts - point.refunds;
                return <button aria-label={`${formatReportDate(point.date)} ${baht(value)}`} className="executive-chart__item" key={point.date}
                  onClick={() => openDetail({ metric: trendMetric, bucket: point.date })} title={`${formatReportDate(point.date)}: ${baht(value)}`} type="button">
                  <span className="executive-chart__bar" style={{ height: `${Math.max(3, Math.max(0, value) / maxTrend * 100)}%` }} />
                  <small>{shownReport.trend.length <= 10 ? formatReportDate(point.date) : point.date.slice(5)}</small>
                </button>;
              })}
            </div>
            <button className="executive-text-button" onClick={() => setShowTrendTable((value) => !value)} type="button">{showTrendTable ? 'ซ่อนตารางตัวเลข' : 'ดูตารางตัวเลข'}</button>
            {showTrendTable ? <div className="executive-table-scroll"><table><thead><tr><th>ช่วง</th><th>ยอดขาย</th><th>เงินรับจริง</th><th>คืนเงินจริง</th></tr></thead><tbody>{shownReport.trend.map((row) => <tr key={row.date}><td>{formatReportDate(row.date)}</td><td>{baht(row.sales)}</td><td>{baht(row.receipts)}</td><td>{baht(row.refunds)}</td></tr>)}</tbody></table></div> : null}
          </> : <p className="executive-empty">ยังไม่มีรายการในช่วงนี้</p>}
        </section>

        <section className="executive-panel" aria-label="ยอดขายตามพื้นที่"><div className="executive-panel__head"><div><h2>ยอดขายตามพื้นที่</h2><p>อาคาร อีเวนต์ และขายหน้ารถ</p></div></div>
          {shownReport.areas.length ? <div className="executive-rank-list">{shownReport.areas.map((area) => <button key={`${area.kind}-${area.id ?? 'casual'}`} onClick={() => openDetail({ metric: 'sales', areaKind: area.kind, areaId: area.id })} type="button"><span><strong>{area.name}</strong><small>{area.kind === 'event' ? 'อีเวนต์' : area.kind === 'casual' ? 'ขายหน้ารถ' : 'อาคาร'}</small></span><b>{baht(area.sales)}</b><i style={{ width: `${Math.max(2, area.sales / maxArea * 100)}%` }} /></button>)}</div> : <p className="executive-empty">ยังไม่มียอดขายตามพื้นที่</p>}
        </section>

        <section className="executive-panel" aria-label="ร้านค้ายอดขายสูงสุด"><div className="executive-panel__head"><div><h2>ร้านค้ายอดขายสูงสุด</h2><p>10 อันดับในช่วงที่เลือก</p></div></div>
          {shownReport.shops.length ? <div className="executive-shop-list">{shownReport.shops.map((shop, index) => <button key={shop.id} onClick={() => openDetail({ metric: 'sales', shopId: shop.id })} type="button"><span><em>{index + 1}</em>{shop.name}</span><strong>{baht(shop.sales)}</strong></button>)}</div> : <p className="executive-empty">ยังไม่มีร้านที่มียอดขาย</p>}
        </section>

        <section className="executive-panel" aria-label="ปริมาณงานและน้ำแข็ง"><div className="executive-panel__head"><div><h2>ปริมาณงาน</h2><p>{number(shownReport.deliveryCount)} รายการส่งร้าน · แยกชนิดและหน่วย</p></div></div>
          {shownReport.products.length ? <div className="executive-product-list">{shownReport.products.map((product) => <div key={product.id}><strong>{product.name}</strong><span>ส่ง {number(product.delivered)} {product.unit}</span><small>เสียหาย {number(product.damaged)} {product.unit}</small></div>)}</div> : <p className="executive-empty">ยังไม่มีปริมาณน้ำแข็งในช่วงนี้</p>}
        </section>
      </div>
    </> : null}

    {detail ? <div className="executive-detail-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDetail(); }}><section aria-label={invoiceId ? 'รายละเอียดบิล' : `รายละเอียด${metricNames[detail.metric]}`} aria-modal="true" className="executive-detail" onKeyDown={(event) => {
      if (event.key === 'Escape') { backDetail(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      if (!focusable.length) return;
      if (event.shiftKey && (document.activeElement === focusable[0] || document.activeElement === dialogRef.current)) { event.preventDefault(); focusable[focusable.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) { event.preventDefault(); focusable[0].focus(); }
    }} ref={dialogRef} role="dialog" tabIndex={-1}>
      <header><button aria-label={invoiceId || detail.shopId ? 'กลับไปยังรายการ' : 'ย้อนกลับไปยังรายงาน'} onClick={backDetail} type="button"><CaretLeft size={21} /></button><div><h2>{invoiceId ? (invoice?.number ?? 'รายละเอียดบิล') : debtorName ?? metricNames[detail.metric]}</h2><p>{invoiceId ? invoice?.shop : detail.metric === 'debt' || detail.metric === 'overdue' ? 'ยอดปัจจุบัน' : `${formatReportDate(from)} – ${formatReportDate(to)}`}{!invoiceId && detail.metric === 'receipts' ? ' · ก่อนหักเงินคืน' : ''}</p></div><button aria-label="ปิดรายละเอียด" onClick={closeDetail} type="button"><X size={21} /></button></header>
      {invoiceId ? <>
        {invoiceError ? <p className="executive-error" role="alert">{invoiceError}</p> : null}
        {!invoice && !invoiceError ? <p className="executive-status">กำลังโหลดบิล…</p> : null}
        {invoice ? <div className="executive-invoice">
          <p>วันที่ขาย {formatReportDate(invoice.serviceDate)} · {invoice.area}</p>
          <p>ครบกำหนด {formatReportDate(invoice.dueDate)}</p>
          <div><span>ยอดขายสุทธิ</span><strong>{baht(invoice.total)}</strong></div>
          <div><span>รับชำระแล้ว</span><strong>{baht(invoice.paid)}</strong></div>
          <div><span>คงค้าง</span><strong>{baht(Math.max(0, invoice.total - invoice.paid))}</strong></div>
          <h3>รายการสินค้า</h3>{invoice.items.map((item, index) => <div key={`${item.name}-${index}`}><span>{item.name}</span><strong>{number(item.quantity)} {item.unit}</strong></div>)}
          <h3>ประวัติรับชำระ</h3>{invoice.payments.length ? invoice.payments.map((payment, index) => <div key={`${payment.date}-${index}`}><span>{new Date(payment.date).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })} · {payment.method === 'cash' ? 'เงินสด' : 'โอน/QR'}</span><strong>{baht(payment.amount)}</strong></div>) : <p>ยังไม่มีรายการรับชำระ</p>}
        </div> : null}
      </> : <>
      {detail.metric === 'receipts' && shownReport ? <div className="executive-receipt-breakdown">
        <span>รับจริง {baht(receiptGross)}</span>
        <button onClick={() => openDetail({ metric: 'refunds', bucket: detail.bucket })} type="button">คืนเงิน {baht(receiptRefunds)} · ดูรายการ</button>
        <strong>รับสุทธิ {baht(receiptGross - receiptRefunds)}</strong>
      </div> : null}
      {detailError ? <p className="executive-error" role="alert">{detailError} <button onClick={refresh} type="button">ลองใหม่</button></p> : null}
      {!detailData && !detailError ? <p className="executive-status">กำลังโหลดรายการ…</p> : null}
      {detailData ? <><p className="executive-detail__count">ทั้งหมด {number(detailData.total)} รายการ</p>
        {detailData.rows.length ? <div className="executive-detail__rows">{detailData.rows.map((row) => (detail.metric === 'sales' || detail.metric === 'debt' || detail.metric === 'overdue') && row.shopId
          ? <button className="executive-detail__row-button" key={`${row.id}-${row.day}`} onClick={() => {
            if ((detail.metric === 'debt' || detail.metric === 'overdue') && !detail.shopId) {
              debtorListPage.current = detailPage;
              setDebtorName(row.label);
              openDetail({ ...detail, shopId: row.shopId ?? undefined });
            } else setInvoiceId(row.id);
          }} type="button"><span><strong>{row.label}</strong><small>{detail.shopId || detail.metric === 'sales' ? formatReportDate(row.day) : 'ดูบิลค้าง'}{row.area ? ` · ${row.area}` : ''}{row.dueDate ? ` · ครบกำหนด ${formatReportDate(row.dueDate)}` : ''}</small></span><b>{baht(row.amount)}</b></button>
          : <article key={`${row.id}-${row.day}`}><div><strong>{row.label}</strong><small>{formatReportDate(row.day)}{row.area ? ` · ${row.area}` : ''}{paymentMethod(row.method) ? ` · ${paymentMethod(row.method)}` : ''}</small></div><b>{baht(row.amount)}</b></article>)}</div> : <p className="executive-empty">ไม่มีรายการ</p>}
        <footer><button disabled={detailPage === 0} onClick={() => setDetailPage((page) => page - 1)} type="button">ก่อนหน้า</button><span>หน้า {detailPage + 1} / {Math.max(1, Math.ceil(detailData.total / 50))}</span><button disabled={(detailPage + 1) * 50 >= detailData.total} onClick={() => setDetailPage((page) => page + 1)} type="button">ถัดไป</button></footer>
      </> : null}
      </>}
    </section></div> : null}
  </div>;
}
