import { beforeEach, expect, it, vi } from 'vitest';
import type { BillingStatement } from '../src/features/financial-operations/types';
import { printEmployeeBillingStatement } from '../src/lib/employeeBillingStatementPrint';
import { isAndroidApp, printThermalImage } from '../src/lib/thermalPrinter';

vi.mock('../src/lib/thermalPrinter', () => ({ isAndroidApp: vi.fn(() => false), printThermalImage: vi.fn() }));
const statement: BillingStatement = {
  id: 'statement', statement_number: 'BIL2610-00001', shop_id: 'shop', shop_code: 'BB1',
  shop_name: '<img src=x onerror=alert(1)>', shop_location: 'B', status: 'active',
  issued_service_date: '2026-10-15', issued_at: '2026-10-15T08:00:00+07:00',
  created_by_name: null, voided_at: null, void_reason: null, total_amount: 170.3, outstanding_amount: 70,
  items: [
    { charge_id: 'a', charge_number: 'INV-1', service_date: '2026-10-14', due_date: '2026-10-20', billed_amount: 100.1, outstanding_amount: 0 },
    { charge_id: 'b', charge_number: 'INV-2', service_date: '2026-10-13', due_date: '2026-10-20', billed_amount: 20, outstanding_amount: 20 },
    { charge_id: 'c', charge_number: 'INV-3', service_date: '2026-10-14', due_date: '2026-10-20', billed_amount: 50.2, outstanding_amount: 50 },
  ],
};

beforeEach(() => vi.mocked(isAndroidApp).mockReturnValue(false));

it('prints one row per delivery day on receipt-width paper with frozen billed totals', async () => {
  const doc = document.implementation.createHTMLDocument();
  const printWindow = { document: doc, print: vi.fn(), focus: vi.fn(), close: vi.fn(), addEventListener: vi.fn() } as unknown as Window;
  expect(await printEmployeeBillingStatement(statement, printWindow)).toBe(true);
  expect(doc.querySelector('style')?.textContent).toContain('@page { size: 57mm');
  expect(Array.from(doc.querySelectorAll('.days .row'), (row) => row.textContent)).toEqual([
    '13/10/2026฿20.00', '14/10/2026฿150.30',
  ]);
  expect(doc.querySelector('.total')?.textContent).toBe('ยอดวางบิลทั้งสิ้น฿170.30');
  expect(doc.body.textContent).not.toContain('INV-');
  expect(doc.body.textContent).not.toContain('VAT');
  expect(doc.querySelector('img')).toBeNull();
  expect(printWindow.print).toHaveBeenCalledOnce();
});

it('prints daily totals on Android using the receipt 384-dot raster without a popup', async () => {
  vi.mocked(isAndroidApp).mockReturnValue(true);
  const texts: string[] = [];
  const context = {
    fillRect: vi.fn(), drawImage: vi.fn(), fillText: (value: string) => texts.push(value),
    measureText: (value: string) => ({ width: value.length * 5 }),
    save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement) {
    expect(this.width).toBe(384);
    return 'data:image/png;base64,summary';
  });
  const open = vi.spyOn(window, 'open');
  await printEmployeeBillingStatement(statement);
  expect(texts.join('')).toContain('฿150.3014/10/2026');
  expect(texts.filter((text) => text === '14/10/2026')).toHaveLength(1);
  expect(texts.join('')).not.toContain('INV-');
  expect(printThermalImage).toHaveBeenCalledWith('data:image/png;base64,summary');
  expect(open).not.toHaveBeenCalled();
});

it('reports blocked popups and printer failures to the caller', async () => {
  vi.spyOn(window, 'open').mockReturnValue(null);
  expect(await printEmployeeBillingStatement(statement)).toBe(false);
  vi.mocked(isAndroidApp).mockReturnValue(true);
  // Rendering can fail before Bluetooth, and must still reject rather than report success.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  await expect(printEmployeeBillingStatement(statement)).rejects.toThrow();
});
