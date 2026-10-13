import type { ExecutiveReport } from './types';

export const money = (value: number) => new Intl.NumberFormat('th-TH', {
  style: 'currency', currency: 'THB', minimumFractionDigits: 0, maximumFractionDigits: 2,
}).format(value);

export function financialChange(current: number, previous: number | undefined, direction: 'higher' | 'lower' | 'neutral' = 'higher') {
  if (previous === undefined || !Number.isFinite(previous) || !Number.isFinite(current)) {
    return { tone: 'neutral', text: 'ยังเปรียบเทียบไม่ได้ · ขาดข้อมูลช่วงก่อน' };
  }
  const delta = Math.round((current - previous) * 100) / 100;
  if (!delta) return { tone: 'neutral', text: '→ เท่าเดิมจากช่วงก่อน' };
  const better = direction === 'higher' ? delta > 0 : delta < 0;
  const change = previous === 0 ? 'ฐานเดิมเป็นศูนย์ จึงไม่คิด %'
    : `${new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(Math.abs(delta) / Math.abs(previous) * 100)}%`;
  return { tone: direction === 'neutral' ? 'neutral' : better ? 'good' : 'bad',
    text: `${delta > 0 ? '↑ เพิ่ม' : '↓ ลด'} ${money(Math.abs(delta))} (${change}) · ${direction === 'neutral' ? 'ต้องดูสาเหตุ' : better ? 'ดีขึ้น' : 'แย่ลง'}` };
}

// Reconcile complete aggregates only: top-ten shops are deliberately incomplete.
export function financialReconciliation(report: ExecutiveReport) {
  const matches = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= 1;
  const checks = [
    matches(report.sales, report.trend.reduce((sum, row) => sum + row.sales, 0)),
    matches(report.sales, report.areas.reduce((sum, row) => sum + row.sales, 0)),
    matches(report.receipts, report.trend.reduce((sum, row) => sum + row.receipts, 0)),
    matches(report.refunds, report.trend.reduce((sum, row) => sum + row.refunds, 0)),
    matches(report.netReceipts, report.receipts - report.refunds),
  ];
  if (report.receiptMethods) checks.push(matches(report.receipts, report.receiptMethods.reduce((sum, row) => sum + row.amount, 0)));
  if (report.debtAging) {
    checks.push(matches(report.outstanding, report.debtAging.reduce((sum, row) => sum + row.amount, 0)));
    checks.push(matches(report.overdue, report.debtAging.filter((row) => row.bucket !== 'notDue').reduce((sum, row) => sum + row.amount, 0)));
  }
  return checks.every(Boolean);
}

export const missingFinancialData = {
  cost: 'ขาดต้นทุนต่อสินค้า ณ วันที่ขาย และวิธีตีราคาสินค้าคงเหลือ',
  expenses: 'ขาดรายการค่าใช้จ่าย วันที่รับรู้ และหมวดค่าใช้จ่าย',
  profit: 'ขาดต้นทุนขายและค่าใช้จ่ายดำเนินงาน จึงยังสรุปกำไรไม่ได้',
  payments: 'มีเฉพาะเงินคืนลูกค้า ยังขาดเงินจ่ายค่าสินค้าและค่าใช้จ่ายอื่น',
  balance: 'ขาดยอดยกมา เงินฝาก/ถอน และรายการเคลื่อนไหวเงินสด/ธนาคารครบถ้วน',
  debtComparison: 'ยังเปรียบเทียบไม่ได้ · ไม่มีภาพยอดลูกหนี้ย้อนหลัง ณ วันสิ้นช่วงก่อน',
};
