import { safeSpreadsheetText } from '../accounting/exportAccounting';
import type { ExecutiveReport, ReportMetric, ReportRow } from './types';

const cell = (value: string | number) => typeof value === 'number'
  ? { value, type: Number }
  : { value: safeSpreadsheetText(value), type: String };

const sheet = (rows: Array<Array<string | number>>) => rows.map((row, index) => row.map((value) => ({
  ...cell(value), ...(index === 0 ? { fontWeight: 'bold' as const, backgroundColor: '#DBEAFE' } : {}),
})));

export async function exportExecutiveReport(
  report: ExecutiveReport,
  detailRows: Partial<Record<ReportMetric, ReportRow[]>>,
) {
  const { default: writeXlsxFile } = await import('write-excel-file');
  const summary = sheet([
    ['รายงานผู้บริหาร', `${report.from} ถึง ${report.to}`],
    ['สร้างเมื่อ', new Date(report.asOf).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })],
    ['ยอดขายสุทธิช่วงนี้', report.sales],
    ['เงินรับจริงช่วงนี้', report.receipts],
    ['เงินคืนจริงช่วงนี้', report.refunds],
    ['เงินรับสุทธิช่วงนี้', report.netReceipts],
    ['หนี้ค้างปัจจุบัน', report.outstanding],
    ['เกินกำหนดปัจจุบัน', report.overdue],
    ['จำนวนลูกหนี้ปัจจุบัน', report.debtors],
    ['จำนวนรายการส่งช่วงนี้', report.deliveryCount],
  ]);
  const trend = sheet([
    ['วัน / เดือน', 'ยอดขายสุทธิ', 'เงินรับจริง', 'เงินคืนจริง', 'เงินรับสุทธิ'],
    ...report.trend.map((row) => [row.date, row.sales, row.receipts, row.refunds, row.receipts - row.refunds]),
  ]);
  const areas = sheet([
    ['ประเภทพื้นที่', 'ชื่อพื้นที่', 'ยอดขายสุทธิ'],
    ...report.areas.map((row) => [row.kind === 'event' ? 'อีเวนต์' : row.kind === 'casual' ? 'ขายหน้ารถ' : 'อาคาร', row.name, row.sales]),
  ]);
  const details = sheet([
    ['ประเภท', 'วันที่', 'ร้าน / รายการ', 'พื้นที่', 'วิธีชำระ', 'ครบกำหนด', 'จำนวนเงิน', 'รหัสรายการ'],
    ...(['sales', 'receipts', 'refunds', 'debt'] as ReportMetric[]).flatMap((metric) =>
      (detailRows[metric] ?? []).map((row) => [metric, row.day, row.label, row.area ?? '',
        row.method ?? '', row.dueDate ?? '', row.amount, row.id])),
  ]);
  await writeXlsxFile([summary, trend, areas, details], {
    sheets: ['สรุป', 'แนวโน้ม', 'พื้นที่', 'รายการ'],
    columns: [
      [{ width: 32 }, { width: 24 }],
      Array.from({ length: 5 }, () => ({ width: 20 })),
      Array.from({ length: 3 }, () => ({ width: 24 })),
      Array.from({ length: 8 }, () => ({ width: 22 })),
    ],
    fileName: `executive-report-${report.from}-${report.to}.xlsx`,
  });
}
