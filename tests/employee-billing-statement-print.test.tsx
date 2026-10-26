import { beforeEach, expect, it, vi } from 'vitest';
import type { BillingStatement, ReceivableCharge } from '../src/features/financial-operations/types';
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

const charges: ReceivableCharge[] = statement.items.map((item, index) => ({
  ...item, original_amount: item.billed_amount, allocated_amount: 0, days_overdue: 0,
  payment_status: 'unpaid', due_status: 'not_due', assigned_collection_run_id: null,
  items: [{ ice_type_id: 'ice', name: 'หลอดเล็ก', unit: 'ถุง', quantity: index + 0.5 }],
}));

beforeEach(() => vi.mocked(isAndroidApp).mockReturnValue(false));

it('prints one row per delivery day on receipt-width paper with frozen billed totals', async () => {
  const doc = document.implementation.createHTMLDocument();
  const printWindow = { document: doc, print: vi.fn(), focus: vi.fn(), close: vi.fn(), addEventListener: vi.fn() } as unknown as Window;
  expect(await printEmployeeBillingStatement(statement, printWindow, charges)).toBe(true);
  expect(doc.querySelector('style')?.textContent).toContain('@page { size: 57mm');
  expect(Array.from(doc.querySelectorAll('.days .row'), (row) => row.textContent)).toEqual([
    '13/10/2026฿20.00', '14/10/2026฿150.30',
  ]);
  expect(doc.querySelector('.total')?.textContent).toBe('ยอดวางบิลทั้งสิ้น฿170.30');
  expect(doc.body.textContent).not.toContain('INV-');
  expect(doc.body.textContent).not.toContain('VAT');
  expect(doc.querySelector('h2')?.textContent).toBe('ใบวางบิลแบบย่อ');
  expect(Array.from(doc.querySelectorAll('.ice-detail'), (row) => row.textContent)).toEqual(['หลอดเล็ก 1.5 ถุง', 'หลอดเล็ก 3 ถุง']);
  expect(doc.body.textContent).toContain('รวมจำนวนน้ำแข็ง 4.5 ถุง');
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
  await printEmployeeBillingStatement(statement, undefined, charges);
  expect(texts.join('')).toContain('฿150.3014/10/2026');
  expect(texts.filter((text) => text === '14/10/2026')).toHaveLength(1);
  expect(texts).toContain('ใบวางบิลแบบย่อ');
  expect(texts).toContain('หลอดเล็ก 3 ถุง');
  expect(texts).toContain('รวมจำนวนน้ำแข็ง 4.5 ถุง');
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

it('keeps mixed units separate and identifies missing quantity details', async () => {
  const doc = document.implementation.createHTMLDocument();
  const printWindow = { document: doc, print: vi.fn(), focus: vi.fn(), close: vi.fn(), addEventListener: vi.fn() } as unknown as Window;
  await printEmployeeBillingStatement(statement, printWindow, [charges[0], {
    ...charges[1], items: [{ ice_type_id: 'block', name: 'น้ำแข็งก้อน', unit: 'กก.', quantity: 10 }],
  }]);
  expect(doc.body.textContent).toContain('รวมจำนวนที่มีข้อมูล 0.5 ถุง');
  expect(doc.body.textContent).toContain('รวมจำนวนที่มีข้อมูล 10 กก.');
  expect(doc.body.textContent).toContain('ไม่พบข้อมูลจำนวนน้ำแข็งบางรายการ');
});

function longStatement(dayCount: number) {
  const items = Array.from({ length: dayCount }, (_, index) => ({
    ...statement.items[0], charge_id: String(index), billed_amount: 100,
    service_date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
  }));
  return {
    statement: { ...statement, items, total_amount: dayCount * 100 },
    charges: items.map((item) => ({
      ...charges[0], charge_id: item.charge_id,
      items: [
        { ice_type_id: 'small', name: 'หลอดเล็ก', unit: 'ถุง', quantity: 1 },
        { ice_type_id: 'large', name: 'หลอดใหญ่', unit: 'ถุง', quantity: 2 },
      ],
    })),
  };
}

function mockPagedCanvas() {
  const texts: string[] = [];
  const images: string[] = [];
  const context = {
    fillRect: vi.fn(), drawImage: vi.fn(),
    fillText: (text: string, _x: number, y: number) => {
      expect(y).toBeLessThan(8192);
      texts.push(text);
    },
    measureText: (value: string) => ({ width: value.length * 5 }),
    save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement) {
    expect(this.width).toBe(384);
    expect(this.height).toBeLessThanOrEqual(8192);
    const image = `data:image/png;base64,page${images.length + 1}`;
    images.push(image);
    return image;
  });
  return { texts, images };
}

it.each([90, 240])('prints all %i days across bounded images in sequence with totals only once', async (days) => {
  vi.mocked(isAndroidApp).mockReturnValue(true);
  const { texts, images } = mockPagedCanvas();
  const data = longStatement(days);
  let printing = false;
  vi.mocked(printThermalImage).mockImplementation(async () => {
    expect(printing).toBe(false);
    printing = true;
    await Promise.resolve();
    printing = false;
    return { printed: true };
  });
  expect(await printEmployeeBillingStatement(data.statement, undefined, data.charges)).toBe(true);
  expect(images.length).toBeGreaterThan(1);
  expect(vi.mocked(printThermalImage).mock.calls.map(([image]) => image)).toEqual(images);
  expect(texts.filter((text) => /^\d{2}\/\d{2}\/\d{4}$/.test(text))).toHaveLength(days);
  expect(texts.filter((text) => text === 'หลอดเล็ก 1 ถุง')).toHaveLength(days);
  expect(texts.filter((text) => text === 'หลอดใหญ่ 2 ถุง')).toHaveLength(days);
  expect(texts.filter((text) => text === 'ยอดวางบิลทั้งสิ้น')).toHaveLength(1);
  expect(texts.filter((text) => text === `รวมจำนวนน้ำแข็ง ${days * 3} ถุง`)).toHaveLength(1);
});

it('stops sending pages after a printer failure and reports it', async () => {
  vi.mocked(isAndroidApp).mockReturnValue(true);
  mockPagedCanvas();
  const data = longStatement(240);
  vi.mocked(printThermalImage).mockResolvedValueOnce({ printed: true }).mockRejectedValueOnce(new Error('connection lost'));
  await expect(printEmployeeBillingStatement(data.statement, undefined, data.charges)).rejects.toThrow('connection lost');
  expect(printThermalImage).toHaveBeenCalledTimes(2);
});
