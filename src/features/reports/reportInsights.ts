import type { DebtAgingBucket, ExecutiveReport } from './types';

export const baht = (value: number) => new Intl.NumberFormat('th-TH', {
  style: 'currency', currency: 'THB', maximumFractionDigits: 0,
}).format(value);
export const number = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value);
export const percent = (value: number) => `${number(value)}%`;

/** Share of delivered quantity that was damaged; null when nothing was delivered. */
export function damageRate(delivered: number, damaged: number) {
  return delivered > 0 ? damaged / delivered * 100 : null;
}

// An area is flagged when its damage rate is clearly above the business-wide
// rate for the same ice type. Units differ between ice types, so compare per product.
export const DAMAGE_ALERT_RATIO = 1.5;

export type DamageFlag = {
  areaKind: string; areaId: string | null; areaName: string;
  productId: string; productName: string; rate: number; average: number;
};

export function damageFlags(report: ExecutiveReport): DamageFlag[] {
  const averages = new Map(report.products.map((product) => [product.id, damageRate(product.delivered, product.damaged)]));
  return (report.volumeAreas ?? []).flatMap((area) => area.products.flatMap((product) => {
    const rate = damageRate(product.delivered, product.damaged);
    const average = averages.get(product.id);
    if (rate === null || !average || product.damaged <= 0 || rate < average * DAMAGE_ALERT_RATIO) return [];
    return [{ areaKind: area.kind, areaId: area.id, areaName: area.name,
      productId: product.id, productName: product.name, rate, average }];
  })).sort((a, b) => b.rate / b.average - a.rate / a.average || b.rate - a.rate);
}

export const agingLabels: Record<DebtAgingBucket['bucket'], string> = {
  notDue: 'ยังไม่ถึงกำหนด',
  days1to7: 'เกิน 1–7 วัน',
  days8to30: 'เกิน 8–30 วัน',
  days31plus: 'เกิน 30 วัน',
};

export const receiptMethodLabels: Record<string, string> = {
  cash: 'เงินสด', bank_transfer: 'โอนเงิน', qr: 'QR', other: 'อื่น ๆ',
};

export type ReportSectionTarget = 'overview' | 'sales' | 'finance' | 'volume';

export type AttentionItem = {
  id: string;
  tone: 'danger' | 'warning';
  title: string;
  titleValues?: Record<string, string | number>;
  value: string;
  detail: string;
  detailValues?: Record<string, string | number>;
  section: ReportSectionTarget;
  target: string;
};

/** Plain-language list of the few things an owner should look at first. */
export function attentionItems(report: ExecutiveReport): AttentionItem[] {
  const items: AttentionItem[] = [];
  const oldDebt = report.debtAging?.find((bucket) => bucket.bucket === 'days31plus');
  if (oldDebt && oldDebt.amount > 0) {
    items.push({ id: 'old-debt', tone: 'danger', title: 'หนี้ค้างเกิน 30 วัน', value: baht(oldDebt.amount),
      detail: '{0} ร้าน · ควรโทรตามก่อน', detailValues: { 0: number(oldDebt.shops) },
      section: 'finance', target: 'executive-aging' });
  } else if (report.overdue > 0) {
    items.push({ id: 'overdue', tone: 'warning', title: 'มีหนี้เกินกำหนด', value: baht(report.overdue),
      detail: 'ยังไม่มีหนี้ค้างเกิน 30 วัน', section: 'finance', target: 'executive-aging' });
  }
  if (report.quietShops && report.quietShops.total > 0) {
    items.push({ id: 'quiet-shops', tone: 'warning', title: '{0} ร้านไม่ได้สั่งนานกว่าปกติ',
      titleValues: { 0: number(report.quietShops.total) },
      value: baht(report.quietShops.monthlySales), detail: 'ยอดซื้อเฉลี่ยต่อเดือนที่อาจหายไป',
      section: 'sales', target: 'executive-quiet-shops' });
  }
  const flags = damageFlags(report);
  if (flags.length) {
    const worst = flags[0];
    const places = new Set(flags.map((flag) => `${flag.areaKind}:${flag.areaId ?? ''}`)).size;
    items.push({ id: 'damage', tone: 'warning', title: 'ของเสียสูงกว่าเฉลี่ย · {0}',
      titleValues: { 0: worst.areaName }, value: percent(worst.rate),
      detail: places > 1 ? '{0} เฉลี่ย {1} · และอีก {2} จุด' : '{0} เฉลี่ย {1}',
      detailValues: { 0: worst.productName, 1: percent(worst.average), 2: number(places - 1) },
      section: 'volume', target: 'executive-volume-areas' });
  }
  return items;
}
