import { shiftServiceDate } from '../../lib/serviceDate';
import { comparisonRange, rangeDays, type DateRange } from './comparisonData';
import type { ExecutiveReport } from './types';

/** Demo-only daily fixtures. Never called as a fallback for a failed live RPC. */
export function demoComparisonReport(report: ExecutiveReport, range: DateRange): ExecutiveReport {
  const days = Array.from({ length: rangeDays(range) }, (_, index) => shiftServiceDate(range.from, index));
  const weights = days.map((date) => [5, 10, 8, 12, 9, 14, 7][new Date(`${date}T12:00:00Z`).getUTCDay()]);
  const total = weights.reduce((sum, value) => sum + value, 0);
  let before = 0;
  const dailyTrend = days.map((date, index) => {
    const after = before + weights[index];
    const part = (value: number) => (Math.round(value * 100 * after / total) - Math.round(value * 100 * before / total)) / 100;
    const point = { date, sales: part(report.sales), products: report.products.map((product) => ({
      id: product.id, name: product.name, unit: product.unit, delivered: part(product.delivered),
    })) };
    before = after;
    return point;
  });
  const previous = comparisonRange(range, 'previous');
  return { ...report, ...range, previousFrom: previous.from, previousTo: previous.to, dailyTrend };
}
