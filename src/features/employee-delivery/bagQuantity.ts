export interface BagQuantity { fullBags: number; halfBags: number }
export const emptyBags = (): BagQuantity => ({ fullBags: 0, halfBags: 0 });
export const bagTotal = (value: BagQuantity) => value.fullBags + value.halfBags * 0.5;
export const formatBags = (value: number) => Number(value.toFixed(1)).toString();
// Old recovery drafts stored only the total; historical splits cannot be recovered.
export function restoreBags(value: BagQuantity | number): BagQuantity {
  return typeof value === 'number'
    ? { fullBags: Math.floor(value), halfBags: Math.round((value % 1) * 2) }
    : value;
}
