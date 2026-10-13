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
  { demo }: { demo: boolean },
) {
  const { default: writeXlsxFile } = await import('write-excel-file');
  const summary = sheet([
    ['รายงานผู้บริหาร', `${report.from} ถึง ${report.to}`],
    ['ขอบเขตข้อมูล', report.scopeName ?? 'ทั้งกิจการ'],
    ['ฐานยอดขาย', report.financialVersion ? 'ไม่รวม VAT · รวมค่าเช่าถัง · หลังปรับปรุง' : 'ข้อมูลเดิมรวม VAT'],
    ['ต้นทุนขาย', 'ยังคำนวณไม่ได้ · ขาดต้นทุนสินค้า'],
    ['กำไรขั้นต้น', 'ยังคำนวณไม่ได้ · ขาดต้นทุนสินค้า'],
    ['ค่าใช้จ่ายดำเนินงาน', 'ยังคำนวณไม่ได้ · ขาดรายการค่าใช้จ่าย'],
    ['กำไรจากการดำเนินงาน', 'ยังคำนวณไม่ได้ · ขาดต้นทุนและค่าใช้จ่าย'],
    ['เงินจ่ายจริง / กระแสเงินสดสุทธิ', 'ยังคำนวณไม่ได้ · เงินคืนไม่ใช่เงินจ่ายทั้งหมด'],
    ['เงินคงเหลือ', 'ยังคำนวณไม่ได้ · ขาดยอดยกมาและรายการเคลื่อนไหวครบถ้วน'],
    ['ช่วงก่อนหน้า', `${report.previousFrom} ถึง ${report.previousTo}`],
    ['ยอดขายช่วงก่อน', report.previousSales],
    ['เงินรับจริงช่วงก่อน', report.previousReceipts ?? 'ยังเปรียบเทียบไม่ได้'],
    ['ยอดลูกหนี้ ณ', new Date(report.asOf).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })],
    ['สร้างเมื่อ', new Date(report.asOf).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })],
    ['ยอดขายสุทธิช่วงนี้', report.sales],
    ['เงินรับจริงช่วงนี้', report.receipts],
    ['เงินคืนจริงช่วงนี้', report.refunds],
    ['เงินรับสุทธิช่วงนี้', report.netReceipts],
    ['หนี้ค้างปัจจุบัน', report.outstanding],
    ['เกินกำหนดปัจจุบัน', report.overdue],
    ['จำนวนลูกหนี้ปัจจุบัน', report.debtors],
    ['จำนวนรายการส่งช่วงนี้', report.deliveryCount],
    ...(report.scopeShopId ? [['ปริมาณและของเสียรายร้าน', 'ยังแยกข้อมูลไม่ได้']] : []),
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
  const worksheets = [summary, trend, areas, details, volume, volumeAreas].map((rows) => demo ? [
    ...sheet([
      ['ข้อมูลสมมติ · ไม่ใช่รายงานการเงินจริง'],
      ['รายการประกอบเป็นตัวอย่างบางส่วน ยอดรวมจึงอาจไม่ตรงกับสรุป'],
    ]),
    ...rows,
  ] : rows);
  await writeXlsxFile(worksheets, {
    sheets: ['สรุป', 'แนวโน้ม', 'พื้นที่', 'รายการ', 'ปริมาณรวม', 'ปริมาณแยกตึก'],
    columns: [
      [{ width: 32 }, { width: 24 }],
      Array.from({ length: 5 }, () => ({ width: 20 })),
      Array.from({ length: 3 }, () => ({ width: 24 })),
      Array.from({ length: 8 }, () => ({ width: 22 })),
      Array.from({ length: 4 }, () => ({ width: 22 })),
      Array.from({ length: 6 }, () => ({ width: 22 })),
    ],
    fileName: `${demo ? 'demo-' : ''}executive-report-${report.from}-${report.to}.xlsx`,
  });
}
