/** Exclusive VAT preview. The database remains authoritative; use minor units for rounding. */
import { roundedLineTotalMinor } from '../offline/contracts';

export const CREDIT_VAT_RATE = 7;
export function deliveryLineTotal(quantity: number, unitPrice: number): number {
  return (roundedLineTotalMinor(quantity, unitPrice) ?? 0) / 100;
}

export function deliverySubtotal(
  items: Array<{ ice_type_id: string; quantity: number }>,
  products: Array<{ ice_type_id: string; unit_price?: number | null }>,
): number {
  const totalMinor = items.reduce((total, item) => {
    const price = products.find((product) => product.ice_type_id === item.ice_type_id)?.unit_price ?? 0;
    return total + (roundedLineTotalMinor(item.quantity, price) ?? 0);
  }, 0);
  return totalMinor / 100;
}

export function exclusiveVat(subtotal: number, rate = CREDIT_VAT_RATE) {
  const subtotalMinor = Math.round(subtotal * 100);
  const vatMinor = Math.round(subtotalMinor * rate / 100);
  return { subtotal: subtotalMinor / 100, vat: vatMinor / 100, total: (subtotalMinor + vatMinor) / 100 };
}
