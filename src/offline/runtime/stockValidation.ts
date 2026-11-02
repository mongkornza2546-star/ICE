import { translateUi } from '../../i18n';

// Only foreground requests known not to have committed may release a form's
// retry identity. Never use this marker for uncertain or queued offline work.
export class StockRejectedError extends Error {
  readonly stockRejectedBeforeCommit = true;
}

export function isStockRejectedError(error: unknown): error is StockRejectedError {
  return error instanceof Error && 'stockRejectedBeforeCommit' in error && error.stockRejectedBeforeCommit === true;
}

export function isServerStockRejection(error: unknown) {
  const e = error as { code?: string; message?: string } | null;
  return e?.code === 'P0001' && /^(?:The )?(?:employee holding|truck|daily aggregate stock) (?:does not have enough stock|is not sufficient)$/i.test(e.message ?? '');
}

export function checkStockQuantities(
  items: Array<{ ice_type_id: string; quantity: number }>,
  available: Array<{ ice_type_id: string; quantity: number; name: string; unit: string }>,
) {
  for (const item of items) {
    const stock = available.find(entry => entry.ice_type_id === item.ice_type_id);
    const quantity = stock && Number.isFinite(stock.quantity) ? Math.max(0, stock.quantity) : 0;
    if (item.quantity > quantity) throw new StockRejectedError(translateUi(
      'สต๊อก {0} ไม่พอ ต้องการ {1} {2} เหลือ {3} {2} กรุณาแก้จำนวน',
      { 0: stock?.name ?? item.ice_type_id, 1: item.quantity, 2: stock?.unit ?? '', 3: quantity },
    ));
  }
}
