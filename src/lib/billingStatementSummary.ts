import type { BillingStatement } from '../features/financial-operations/types';

// Use the amount frozen at issuance, so reprints retain the original billed total.
export function billingStatementDailyTotals(statement: BillingStatement) {
  const totals = new Map<string, number>();
  for (const item of statement.items) {
    totals.set(item.service_date, (totals.get(item.service_date) ?? 0) + Math.round(Number(item.billed_amount) * 100));
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b))
    .map(([serviceDate, cents]) => ({ serviceDate, amount: cents / 100 }));
}
