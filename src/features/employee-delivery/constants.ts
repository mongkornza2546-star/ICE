import type { ShopRoundStatus, ShopCard } from '../../types/app';

export const PROBLEM_STATUSES: Array<{ value: Exclude<ShopRoundStatus, 'pending' | 'delivered'>; label: string }> = [
  { value: 'full_bin', label: 'ถังเต็ม' },
  { value: 'closed_shop', label: 'ปิดร้าน' },
  { value: 'no_access', label: 'เข้าไม่ได้' },
  { value: 'issue', label: 'มีปัญหา' },
];

export const STATUS_LABELS: Record<ShopRoundStatus, string> = {
  pending: 'ยังไม่ส่ง',
  delivered: 'ส่งแล้ว',
  full_bin: 'ถังเต็ม',
  closed_shop: 'ปิดร้าน',
  no_access: 'เข้าไม่ได้',
  issue: 'มีปัญหา',
};

export const PAYMENT_LABELS: Record<ShopCard['payment_status'], string> = {
  unknown: 'ไม่ทราบการชำระ',
  paid: 'จ่ายแล้ว',
  unpaid: 'ค้างจ่าย',
};
