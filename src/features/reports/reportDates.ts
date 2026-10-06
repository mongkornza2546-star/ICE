import { shiftServiceDate, toBangkokDateString } from '../../lib/serviceDate';

export type Preset = 'today' | 'week' | 'month' | 'year' | 'custom';

export function presetDates(preset: Exclude<Preset, 'custom'>, today = toBangkokDateString()) {
  const [year, month] = today.split('-');
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'week') return { from: shiftServiceDate(today, -6), to: today };
  if (preset === 'month') return { from: `${year}-${month}-01`, to: today };
  return { from: `${year}-01-01`, to: today };
}

export function reportRangeError(from: string, to: string, today = toBangkokDateString()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)
    || Number.isNaN(Date.parse(`${from}T12:00:00Z`))
    || Number.isNaN(Date.parse(`${to}T12:00:00Z`))) return 'กรุณาเลือกวันที่ให้ครบ';
  if (from > to) return 'วันเริ่มต้นต้องไม่เกินวันสิ้นสุด';
  if (to > today) return 'เลือกวันในอนาคตไม่ได้';
  const days = (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000 + 1;
  if (days > 366) return 'เลือกช่วงได้สูงสุด 366 วัน';
  return null;
}

export function formatReportDate(date: string) {
  return new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(`${date}T12:00:00+07:00`));
}
