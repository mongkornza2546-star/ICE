import { safeSpreadsheetText } from '../accounting/exportAccounting';
import type { ExecutiveReport, ReportMetric, ReportRow } from './types';
import { changePercent, rangeDays, comparisonTimeline, timelineProducts, type ComparisonRow, type comparisonRows } from './comparisonData';

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
    ...(report.debtAging ? [
      ['--- อายุหนี้ปัจจุบัน ---', '---'],
      ...report.debtAging.map((b) => [
        b.bucket === 'notDue' ? 'ยังไม่ถึงกำหนด' : b.bucket === 'days1to7' ? 'เกิน 1–7 วัน'
          : b.bucket === 'days8to30' ? 'เกิน 8–30 วัน' : 'เกิน 30 วัน',
        b.amount,
      ]),
    ] : []),
    ...(report.receiptMethods ? [
      ['--- สัดส่วนช่องทางรับเงิน ---', '---'],
      ...report.receiptMethods.map((m) => [
        m.method === 'cash' ? 'เงินสด' : m.method === 'bank_transfer' ? 'โอนเงิน' : m.method === 'qr' ? 'QR' : m.method,
        m.amount,
      ]),
    ] : []),
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
  const volume = sheet([
    ['ชนิดน้ำแข็ง', 'หน่วย', 'จำนวนส่ง', 'เสียหาย'],
    ...report.products.map((row) => [row.name, row.unit, row.delivered, row.damaged]),
  ]);
  const volumeAreas = sheet([
    ['ประเภทพื้นที่', 'ตึก / พื้นที่', 'ชนิดน้ำแข็ง', 'หน่วย', 'จำนวนส่ง', 'เสียหาย'],
    ...(report.volumeAreas ?? []).flatMap((area) => area.products.map((row) => [
      area.kind === 'building' ? 'ตึก' : area.kind === 'event' ? 'อีเวนต์'
        : area.kind === 'casual' ? 'ขายหน้ารถ' : area.kind === 'stock' ? 'จุดสต็อก' : 'ไม่ระบุตึก',
      area.name, row.name, row.unit, row.delivered, row.damaged,
    ])),
    ...(report.volumeAreas ? [] : [['ข้อมูลแยกตึกยังไม่พร้อมใช้งาน']]),
  ]);
  await writeXlsxFile([summary, trend, areas, details, volume, volumeAreas], {
    sheets: ['สรุป', 'แนวโน้ม', 'พื้นที่', 'รายการ', 'ปริมาณรวม', 'ปริมาณแยกตึก'],
    columns: [
      [{ width: 32 }, { width: 24 }],
      Array.from({ length: 5 }, () => ({ width: 20 })),
      Array.from({ length: 3 }, () => ({ width: 24 })),
      Array.from({ length: 8 }, () => ({ width: 22 })),
      Array.from({ length: 4 }, () => ({ width: 22 })),
      Array.from({ length: 6 }, () => ({ width: 22 })),
    ],
    fileName: `executive-report-${report.from}-${report.to}.xlsx`,
  });
}

/** Export the same two report snapshots and joined rows shown in comparison mode. */
export async function exportReportComparison(
  current: ExecutiveReport,
  previous: ExecutiveReport,
  rows: ReturnType<typeof comparisonRows>,
  demo = false,
) {
  const { default: writeXlsxFile } = await import('write-excel-file');
  const header = ['รายการ', 'หน่วย', 'ช่วง A', 'ช่วง B', 'ส่วนต่าง A − B', 'เปลี่ยนแปลง (%)', 'เฉลี่ย/วัน A', 'เฉลี่ย/วัน B'];
  const rowValues = (row: ComparisonRow) => [row.name, row.unit,
    row.current ?? 'ข้อมูลไม่พร้อม', row.previous ?? 'ข้อมูลไม่พร้อม',
    row.current === null || row.previous === null ? 'ข้อมูลไม่พร้อม' : row.current - row.previous,
    changePercent(row.current, row.previous) ?? '—',
    row.current === null ? 'ข้อมูลไม่พร้อม' : row.current / rangeDays(current),
    row.previous === null ? 'ข้อมูลไม่พร้อม' : row.previous / rangeDays(previous)];
  const metadata: Array<Array<string | number>> = [
    ...(demo ? [['ข้อมูลจำลอง · ไม่ใช่ข้อมูลจริงตามวันที่']] : []),
    ['ช่วง A', current.from, current.to, rangeDays(current)],
    ['ช่วง B', previous.from, previous.to, rangeDays(previous)],
    ['ข้อมูล ณ A', current.asOf, 'ข้อมูล ณ B', previous.asOf],
    ['หมายเหตุ', 'ปริมาณแยกชนิดและหน่วย · ฐานเป็นศูนย์ไม่คิดเปอร์เซ็นต์'],
  ];
  const summary: ComparisonRow[] = [
    { key: 'sales', name: 'ยอดขายสุทธิ', unit: 'บาท', current: current.sales, previous: previous.sales },
    { key: 'deliveries', name: 'รายการส่ง', unit: 'รายการ', current: current.deliveryCount, previous: previous.deliveryCount },
    ...rows.products,
  ];
  const volumeNote = !current.volumeAreas || !previous.volumeAreas ? [['ข้อมูลแยกพื้นที่ไม่ครบทั้งสองช่วง']] : [];
  const sheets = [summary, rows.areas, rows.products, rows.volumeAreas].map((items, index) =>
    sheet([...metadata, ...(index === 3 ? volumeNote : []), header, ...items.map(rowValues)]));
  const dailyHeader = ['ลำดับวัน', 'วันที่ A', 'ยอด A', 'วันที่ B', 'ยอด B'];
  const dailyValues = (point: ReturnType<typeof comparisonTimeline>[number]) => [point.day,
    point.currentDate ?? 'นอกช่วง', point.current ?? 'ข้อมูลไม่พร้อม',
    point.previousDate ?? 'นอกช่วง', point.previous ?? 'ข้อมูลไม่พร้อม'];
  sheets.push(sheet([...metadata, ['ยอดขายรายวัน', 'บาท'], dailyHeader,
    ...comparisonTimeline(current, previous, { kind: 'sales' }).map(dailyValues)]));
  sheets.push(sheet([...metadata, ['ชนิดน้ำแข็ง', 'หน่วย', ...dailyHeader],
    ...timelineProducts(current, previous).flatMap((product) => comparisonTimeline(current, previous,
      { kind: 'volume', productId: product.id, unit: product.unit }).map((point) => [product.name, product.unit, ...dailyValues(point)]))]));
  await writeXlsxFile(sheets, {
    sheets: ['สรุปเปรียบเทียบ', 'ยอดขายแยกพื้นที่', 'น้ำแข็งแยกชนิด', 'น้ำแข็งแยกพื้นที่', 'ยอดขายรายวัน', 'น้ำแข็งรายวัน'],
    columns: sheets.map(() => Array.from({ length: 8 }, (_, index) => ({ width: index === 0 ? 40 : 23 }))),
    fileName: `${demo ? 'demo-' : ''}sales-comparison-${current.from}-${current.to}-vs-${previous.from}-${previous.to}.xlsx`,
  });
}
