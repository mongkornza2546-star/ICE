import { expect, it } from 'vitest';
import { financialChange, financialReconciliation, money } from '../src/features/reports/financialReport';
import { previousPeriod } from '../src/features/reports/reportDates';
import { attentionItems } from '../src/features/reports/reportInsights';
import type { ExecutiveReport } from '../src/features/reports/types';

const report: ExecutiveReport = {
  from: '2026-09-01', to: '2026-09-02', previousFrom: '2026-08-30', previousTo: '2026-08-31', asOf: '2026-10-13T00:00:00Z',
  sales: 100.25, receipts: 107.25, refunds: 5, netReceipts: 102.25,
  previousSales: 90, previousNetReceipts: 110, previousReceipts: 110,
  outstanding: 50, overdue: 20, debtors: 2, deliveryCount: 1,
  trend: [{ date: '2026-09-01', sales: 100.25, receipts: 107.25, refunds: 5 }],
  areas: [{ kind: 'building', id: 'a', name: 'A', sales: 100.25 }], shops: [], products: [],
  debtAging: [{ bucket: 'notDue', amount: 30, shops: 1 }, { bucket: 'days1to7', amount: 20, shops: 1 }],
  receiptMethods: [{ method: 'cash', amount: 107.25 }],
};

it('compares equal-length adjacent periods across leap days and years', () => {
  expect(previousPeriod('2024-03-01', '2024-03-02')).toEqual({ previousFrom: '2024-02-28', previousTo: '2024-02-29' });
  expect(previousPeriod('2026-01-01', '2026-01-01')).toEqual({ previousFrom: '2025-12-31', previousTo: '2025-12-31' });
});
it('does not color growing cost or debt as an improvement', () => {
  expect(financialChange(120, 100, 'lower').tone).toBe('bad');
  expect(financialChange(80, 100, 'lower').tone).toBe('good');
  expect(financialChange(120, 100).tone).toBe('good');
  expect(financialChange(-20, -100).tone).toBe('good');
  expect(financialChange(120, 100, 'neutral').tone).toBe('neutral');
});
it('distinguishes zero baselines, missing history and unchanged values', () => {
  expect(financialChange(100, 0).text).toContain('ฐานเดิมเป็นศูนย์');
  expect(financialChange(100, undefined).text).toContain('ยังเปรียบเทียบไม่ได้');
  expect(financialChange(0, 0).text).toContain('เท่าเดิม');
  expect(financialChange(100, NaN).tone).toBe('neutral');
  expect(money(100.25)).toBe('฿100.25');
});
it('reconciles all complete aggregates and catches mismatched debt, cash or sales', () => {
  expect(financialReconciliation(report)).toBe(true);
  expect(financialReconciliation({ ...report, outstanding: 0 })).toBe(false);
  expect(financialReconciliation({ ...report, receipts: 100 })).toBe(false);
  expect(financialReconciliation({ ...report, sales: 100 })).toBe(false);
  expect(financialReconciliation({ ...report, netReceipts: NaN })).toBe(false);
  expect(financialReconciliation({ ...report, shops: [{ id: 's', name: 'Top customer', sales: 10 }] })).toBe(true);
});
it('uses actual amounts for collection alerts and does not infer zero old debt when aging is missing', () => {
  expect(attentionItems(report).find((item) => item.id === 'collection-down')?.value).toBe('฿2.75');
  expect(attentionItems({ ...report, debtAging: undefined }).find((item) => item.id === 'overdue')?.detail).toContain('ข้อมูลอายุหนี้ยังไม่พร้อม');
  expect(attentionItems(report).length).toBeLessThanOrEqual(5);
});
