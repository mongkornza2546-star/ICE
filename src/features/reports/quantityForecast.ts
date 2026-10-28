import { shiftServiceDate, toBangkokDateString } from '../../lib/serviceDate';
import type { ExecutiveReport } from './types';

export type ForecastHorizon = 1 | 7 | 30;
export type ForecastProduct = { id: string; name: string; unit: string; created_at: string };
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const round = (value: number) => Math.round(value * 100) / 100;
const productKey = (product: { id: string; unit: string }) => `${product.id}:${product.unit}`;

export function forecastWindow(anchor: string, today = toBangkokDateString()) {
  const historyTo = anchor < today ? anchor : shiftServiceDate(today, -1);
  return { historyFrom: shiftServiceDate(historyTo, -27), historyTo, first: shiftServiceDate(anchor, 1) };
}

/** A transparent baseline: same weekday mean, falling back to the observed daily mean.
 * Missing dates stay unknown; zero-sale days count only after product availability.
 * Never train on the unfinished current day or dates after the forecast anchor.
 */
export function forecastQuantities(report: ExecutiveReport, products: ForecastProduct[], anchor: string, horizon: ForecastHorizon, today = toBangkokDateString()) {
  const window = forecastWindow(anchor, today);
  const days = Array.from({ length: horizon }, (_, index) => shiftServiceDate(window.first, index));
  const history = new Map(report.dailyTrend?.filter(day => day.date >= window.historyFrom && day.date <= window.historyTo)
    .map(day => [day.date, day]));
  const rows = products.map(product => {
    const createdOn = toBangkokDateString(new Date(product.created_at));
    // Imported sales can predate catalog creation; explicit records establish earlier availability.
    const availableFrom = [...history.values()].reduce((first, day) =>
      day.date < first && day.products.some(item => productKey(item) === productKey(product)
        && Number.isFinite(item.delivered) && item.delivered >= 0) ? day.date : first, createdOn);
    const samples = [...history.values()].flatMap(day => {
      if (day.date < availableFrom) return [];
      const item = day.products.find(item => productKey(item) === productKey(product));
      const quantity = item ? item.delivered : 0;
      return Number.isFinite(quantity) && quantity >= 0 ? [{ date: day.date, quantity }] : [];
    });
    const values = days.map(date => {
      if (samples.length < 7) return { date, quantity: null, method: 'insufficient' as const };
      const matching = samples.filter(sample => weekday(sample.date) === weekday(date));
      const basis = matching.length >= 2 ? matching : samples;
      return { date, quantity: round(basis.reduce((sum, sample) => sum + sample.quantity, 0) / basis.length),
        method: matching.length >= 2 ? 'weekday' as const : 'average' as const };
    });
    return { id: product.id, name: product.name, unit: product.unit, observedDays: samples.length, values,
      total: values.some(value => value.quantity === null) ? null : round(values.reduce((sum, value) => sum + (value.quantity ?? 0), 0)),
      method: samples.length < 7 ? 'insufficient' : values.every(value => value.method === 'weekday') ? 'weekday' : 'average',
    };
  });
  return { ...window, days, rows };
}
