import type { EmployeeStockState, IceTypeOption, ShopRoundStatus } from '../../types/app';

export function normalizeSearch(value: string) {
  return value.toLocaleLowerCase('th-TH').replace(/\s+/g, ' ').trim();
}

export function statusTone(status: ShopRoundStatus) {
  if (status === 'delivered') return 'success';
  if (status === 'full_bin' || status === 'issue') return 'warning';
  if (status === 'closed_shop' || status === 'no_access') return 'danger';
  return 'neutral';
}

export function formatShortTime(value: string) {
  return new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function renderTotals(totals: Record<string, number>, iceTypes: IceTypeOption[]) {
  const labels = iceTypes
    .map((iceType) => {
      const quantity = totals[iceType.id];
      return typeof quantity === 'number' && quantity > 0 ? `${iceType.name} ${quantity} ${iceType.unit}` : null;
    })
    .filter((value): value is string => Boolean(value));
  return labels.length > 0 ? labels.join(' · ') : 'ไม่มีรายการ';
}

export function toTotals(items: Array<{ ice_type_id: string; quantity: number }>) {
  return Object.fromEntries(items.map((item) => [item.ice_type_id, item.quantity]));
}

export function stockQuantity(
  balances: EmployeeStockState['truck_location']['balances'] | undefined,
  iceTypeId: string,
) {
  return balances?.find((balance) => balance.ice_type_id === iceTypeId)?.quantity ?? 0;
}

export function employeeErrorMessage(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object' && error && 'message' in error
      ? String(error.message)
      : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('none is configured')) return 'ยังไม่มีจุดถือครองที่ผูกกับบัญชีนี้ กรุณาแจ้งหัวหน้า';
  if (normalized.includes('multiple are configured')) return 'พบจุดถือครองของบัญชีนี้หลายจุด ให้หัวหน้ากำหนดเหลือหนึ่งจุด';
  if (normalized.includes('truck does not have enough stock')) return 'น้ำแข็งบนรถมีไม่พอตามยอดที่รับเพิ่ม ตรวจยอดแล้วลองอีกครั้ง';
  if (normalized.includes('not enough stock')) return 'สต๊อกต้นทางมีไม่พอตามยอดนี้ แจ้งหัวหน้าก่อนบันทึกอีกครั้ง';
  if (normalized.includes('no active truck')) return 'ยังไม่มีรถหลักที่เปิดใช้งาน กรุณาแจ้งหัวหน้า';
  if (normalized.includes('multiple active trucks')) return 'พบรถหลายคันแต่ยังไม่ได้กำหนดรถหลัก กรุณาแจ้งหัวหน้า';
  if (normalized.includes('active stock source')) return 'ยังไม่พบสต๊อกต้นทางที่ใช้งาน กรุณาแจ้งหัวหน้า';
  if (normalized.includes('already closed') || normalized.includes('round is closed')) return 'รอบส่งนี้ปิดแล้ว จึงบันทึกเพิ่มไม่ได้';
  if (normalized.includes('not assigned') || normalized.includes('permission') || normalized.includes('jwt')) return 'บัญชีนี้ไม่มีสิทธิ์ในรอบส่งที่เลือก';
  if (normalized.includes('fetch') || normalized.includes('network') || normalized.includes('timeout')) return 'เชื่อมต่อไม่สำเร็จ ตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง';
  return message || 'เกิดข้อผิดพลาด กรุณาลองอีกครั้ง';
}
