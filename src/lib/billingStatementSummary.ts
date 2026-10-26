import type { BillingStatement, ReceivableCharge } from '../features/financial-operations/types';

// Use the amount frozen at issuance, so reprints retain the original billed total.
export function billingStatementDailyTotals(statement: BillingStatement) {
  const totals = new Map<string, number>();
  for (const item of statement.items) {
    totals.set(item.service_date, (totals.get(item.service_date) ?? 0) + Math.round(Number(item.billed_amount) * 100));
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b))
    .map(([serviceDate, cents]) => ({ serviceDate, amount: cents / 100 }));
}

const quantityFormat = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 3 });

export function billingStatementIceSummary(statement: BillingStatement, charges: ReceivableCharge[]) {
  const chargesById = new Map(charges.map((charge) => [charge.charge_id, charge]));
  const days = new Map<string, Map<string, { name: string; unit: string; quantity: number }>>();
  const totals = new Map<string, number>();
  const missingDays = new Set<string>();
  for (const item of statement.items) {
    const products = chargesById.get(item.charge_id)?.items ?? [];
    if (!products.length) missingDays.add(item.service_date);
    const day = days.get(item.service_date) ?? new Map();
    for (const product of products) {
      const key = JSON.stringify([product.ice_type_id, product.unit]);
      const total = day.get(key) ?? { name: product.name, unit: product.unit, quantity: 0 };
      total.quantity += Number(product.quantity);
      day.set(key, total);
      totals.set(product.unit, (totals.get(product.unit) ?? 0) + Number(product.quantity));
    }
    days.set(item.service_date, day);
  }
  return {
    dayLines: (serviceDate: string) => [
      ...[...(days.get(serviceDate)?.values() ?? [])].map((item) => `${item.name} ${quantityFormat.format(item.quantity)} ${item.unit}`),
      ...(missingDays.has(serviceDate) ? ['ไม่พบข้อมูลจำนวนน้ำแข็งบางรายการ'] : []),
    ],
    totalLines: [...totals].map(([unit, quantity]) =>
      `${missingDays.size ? 'รวมจำนวนที่มีข้อมูล' : 'รวมจำนวนน้ำแข็ง'} ${quantityFormat.format(quantity)} ${unit}`),
  };
}
