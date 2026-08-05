import type { CreditDueRule } from '../types/app';

const THAI_WEEKDAYS: Record<number, string> = {
  1: 'วันจันทร์',
  2: 'วันอังคาร',
  3: 'วันพุธ',
  4: 'วันพฤหัสบดี',
  5: 'วันศุกร์',
  6: 'วันเสาร์',
  7: 'วันอาทิตย์',
};

export const CREDIT_COLLECTION_WEEKDAY_OPTIONS = Object.entries(THAI_WEEKDAYS).map(([value, label]) => ({
  value: Number(value),
  label,
}));

export function formatCreditCollectionCycle(profile: {
  credit_due_rule?: CreditDueRule | null;
  credit_days?: number | null;
  credit_collection_weekday?: number | null;
}) {
  if (profile.credit_due_rule === 'weekly') {
    const weekday = profile.credit_collection_weekday
      ? THAI_WEEKDAYS[profile.credit_collection_weekday]
      : null;
    return `รอบเก็บเงิน: ${weekday ? `ทุก${weekday}` : 'ยังไม่ได้กำหนดวัน'}`;
  }
  if (profile.credit_due_rule === 'end_of_month') return 'รอบเก็บเงิน: ทุกสิ้นเดือน';
  if (profile.credit_due_rule === 'net_days') {
    return `รอบเก็บเงิน: หลังส่งสินค้า ${profile.credit_days ?? 0} วัน`;
  }
  return 'รอบเก็บเงิน: ยังไม่ได้กำหนด';
}
