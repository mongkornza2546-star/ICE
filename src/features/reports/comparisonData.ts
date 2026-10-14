import { shiftServiceDate } from '../../lib/serviceDate';
import { presetDates } from './reportDates';
import type { ExecutiveReport } from './types';

export type DateRange = { from: string; to: string };
export type ComparePreset = 'previous' | 'week' | 'month' | 'year' | 'custom';
export type ComparisonSelection = { preset: ComparePreset; custom: DateRange };
export type ComparisonRow = {
  key: string; name: string; unit: string; current: number | null; previous: number | null;
  area?: { kind: string; id: string | null }; product?: string;
};
export const rangeDays = ({ from, to }: DateRange) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000) + 1;

function shiftMonth(date: string, months: number) {
  const [year, month, day] = date.split('-').map(Number);
  const end = new Date(Date.UTC(year, month + months, 0));
  return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), Math.min(day, end.getUTCDate())))
    .toISOString().slice(0, 10);
}
export function comparisonRange(range: DateRange, preset: Exclude<ComparePreset, 'custom'>): DateRange {
  if (preset === 'previous') return { from: shiftServiceDate(range.from, -rangeDays(range)), to: shiftServiceDate(range.from, -1) };
  if (preset === 'week') return { from: shiftServiceDate(range.from, -7), to: shiftServiceDate(range.to, -7) };
  const months = preset === 'month' ? -1 : -12;
  return { from: shiftMonth(range.from, months), to: shiftMonth(range.to, months) };
}
export function weekToDate(today: string): DateRange {
  return presetDates('calendarWeek', today);
}
export function changePercent(current: number | null, previous: number | null) {
  return current === null || previous === null || previous === 0 ? null : (current - previous) / Math.abs(previous) * 100;
}
const areaKey = (area: { kind: string; id: string | null }) => JSON.stringify([area.kind, area.id]);
const productKey = (product: { id: string; unit: string }) => JSON.stringify([product.id, product.unit]);

/** Merge by stable identity, including rows present only in the comparison period. */
export function comparisonRows(current: ExecutiveReport, previous: ExecutiveReport) {
  const areas = new Map<string, ComparisonRow>();
  const products = new Map<string, ComparisonRow>();
  const volumeAreas = new Map<string, ComparisonRow>();
  for (const [side, report] of [['current', current], ['previous', previous]] as const) {
    for (const area of report.areas) {
      const key = areaKey(area);
      const row = areas.get(key) ?? { key, name: area.name, unit: 'บาท', current: 0, previous: 0, area };
      row[side] = (row[side] ?? 0) + area.sales;
      areas.set(key, row);
    }
    for (const product of report.products) {
      const key = productKey(product);
      const row = products.get(key) ?? { key, name: product.name, unit: product.unit, current: 0, previous: 0, product: product.id };
      row[side] = (row[side] ?? 0) + product.delivered;
      products.set(key, row);
    }
    for (const area of report.volumeAreas ?? []) for (const product of area.products) {
      const key = JSON.stringify([areaKey(area), productKey(product)]);
      const row = volumeAreas.get(key) ?? { key, name: `${area.name} · ${product.name}`, unit: product.unit,
        current: current.volumeAreas ? 0 : null, previous: previous.volumeAreas ? 0 : null, area, product: product.id };
      row[side] = (row[side] ?? 0) + product.delivered;
      volumeAreas.set(key, row);
    }
  }
  return { areas: [...areas.values()], products: [...products.values()], volumeAreas: [...volumeAreas.values()] };
}

export type TimelineMetric = { kind: 'sales' } | { kind: 'volume'; productId: string; unit: string };
export type TimelinePoint = { day: number; currentDate: string | null; previousDate: string | null;
  current: number | null; previous: number | null };

export function timelineProducts(current: ExecutiveReport, previous: ExecutiveReport) {
  const products = new Map<string, { id: string; name: string; unit: string }>();
  for (const report of [current, previous]) for (const product of [
    ...report.products, ...(report.dailyTrend ?? []).flatMap((day) => day.products),
  ]) products.set(productKey(product), product);
  return [...products.values()];
}

/** Align day 1 with day 1; never pad a shorter range or missing series with zero. */
export function comparisonTimeline(current: ExecutiveReport, previous: ExecutiveReport, metric: TimelineMetric): TimelinePoint[] {
  const series = (report: ExecutiveReport) => {
    if (report.dailyTrend) return new Map(report.dailyTrend.map((day) => [day.date, metric.kind === 'sales' ? day.sales
      : day.products.filter((product) => product.id === metric.productId && product.unit === metric.unit)
        .reduce((sum, product) => sum + product.delivered, 0)]));
    // Legacy trend changes to monthly buckets after 31 inclusive days.
    if (metric.kind === 'sales' && rangeDays(report) <= 31) return new Map(report.trend.map((day) => [day.date, day.sales]));
    return new Map<string, number>();
  };
  const currentSeries = series(current), previousSeries = series(previous);
  return Array.from({ length: Math.max(rangeDays(current), rangeDays(previous)) }, (_, index) => {
    const currentDate = index < rangeDays(current) ? shiftServiceDate(current.from, index) : null;
    const previousDate = index < rangeDays(previous) ? shiftServiceDate(previous.from, index) : null;
    return { day: index + 1, currentDate, previousDate,
      current: currentDate ? currentSeries.get(currentDate) ?? null : null,
      previous: previousDate ? previousSeries.get(previousDate) ?? null : null };
  });
}
