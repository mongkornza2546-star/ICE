import { describe, expect, it, vi } from 'vitest';
import { printBillingStatement } from '../src/lib/billingStatementPrint';
import type { BillingStatement, ReceivableCharge } from '../src/features/financial-operations/types';

const statement: BillingStatement = {
  id: 'statement-1', statement_number: 'BIL2610-00002', shop_id: 'shop-1',
  shop_code: 'BB53', shop_name: 'ร้านกาแฟพันธุ์ไทย (ซุ้ม 4)', shop_location: 'B · ซุ้มโดม 4',
  status: 'active', issued_service_date: '2026-10-11', issued_at: '2026-10-11T08:00:00+07:00',
  created_by_name: null, voided_at: null, void_reason: null,
  total_amount: 150, outstanding_amount: 100,
  items: [
    { charge_id: 'one', charge_number: 'INV2610-00264', service_date: '2026-10-05', due_date: '2026-10-09', billed_amount: 120, outstanding_amount: 70 },
    { charge_id: 'two', charge_number: 'INV2610-00279', service_date: '2026-10-06', due_date: '2026-10-10', billed_amount: 30, outstanding_amount: 30 },
  ],
};
const charges: ReceivableCharge[] = statement.items.map((item) => ({
  ...item, original_amount: item.billed_amount, allocated_amount: 0, days_overdue: 0,
  payment_status: 'unpaid', due_status: 'overdue', assigned_collection_run_id: null,
  items: item.charge_id === 'one' ? [
    { ice_type_id: 'small', name: 'หลอดเล็ก', unit: 'ถุง', quantity: 1.5 },
    { ice_type_id: 'large', name: 'หลอดใหญ่', unit: 'ถุง', quantity: 0.5 },
  ] : [{ ice_type_id: 'crushed', name: 'น้ำแข็งบด', unit: 'กระสอบ', quantity: 1 }],
}));

function print(payload = statement, sourceCharges = charges) {
  const printDocument = document.implementation.createHTMLDocument();
  const printWindow = {
    document: printDocument, addEventListener: vi.fn(), close: vi.fn(), focus: vi.fn(), print: vi.fn(),
  } as unknown as Window;
  expect(printBillingStatement(payload, printWindow, sourceCharges)).toBe(true);
  expect(printWindow.print).toHaveBeenCalledOnce();
  return printDocument;
}

describe('billing statement printing', () => {
  it('matches ice details by charge ID and shows each date and amount once for multiple ice types', () => {
    const doc = print(statement, [...charges].reverse());
    expect(doc.documentElement.lang).toBe('th');
    expect(doc.title).toBe('ใบวางบิล BIL2610-00002');
    expect(Array.from(doc.querySelectorAll('th'), (cell) => cell.textContent)).toEqual([
      'ลำดับ', 'เลขที่บิล', 'วันที่บิล / ส่ง', 'ชนิดน้ำแข็ง', 'จำนวน', 'ครบกำหนด', 'ยอดวางบิล',
    ]);
    const bills = doc.querySelectorAll('tbody');
    expect(bills).toHaveLength(2);
    expect(bills[0].textContent).toContain('5 ต.ค. 2569');
    expect(bills[0].textContent).toContain('9 ต.ค. 2569');
    expect(bills[0].textContent).toContain('หลอดเล็ก1.5 ถุง');
    expect(bills[0].textContent).toContain('หลอดใหญ่0.5 ถุง');
    expect(bills[0].querySelector('.amount')?.getAttribute('rowspan')).toBe('2');
    expect(bills[0].querySelectorAll('.amount')).toHaveLength(1);
    expect(bills[0].querySelector('.amount')?.textContent).toBe('฿120.00');
    expect(bills[1].textContent).toContain('6 ต.ค. 2569');
    expect(bills[1].textContent).toContain('น้ำแข็งบด1 กระสอบ');
    expect(doc.querySelector('.total')?.textContent).toBe('ยอดวางบิลทั้งสิ้น฿150.00');
  });

  it('preserves frozen billed amounts and VAT while displaying subsequent payments separately', () => {
    const doc = print({ ...statement, subtotal_amount: 200, vat_amount: 14, gross_amount: 214 });
    const text = doc.querySelector('.summary')?.textContent;
    expect(text).toContain('ค่าสินค้าก่อน VAT฿200.00');
    expect(text).toContain('VAT฿14.00');
    expect(text).toContain('ชำระก่อนออกใบวางบิล฿64.00');
    expect(text).toContain('ยอดวางบิลทั้งสิ้น฿150.00');
    expect(text).toContain('ชำระหลังออกใบวางบิล฿50.00');
    expect(text).toContain('ยอดคงเหลือ฿100.00');
  });

  it('marks unavailable details without inventing quantities and retains the void notice', () => {
    const doc = print({ ...statement, status: 'voided', void_reason: 'ออกใหม่' }, []);
    expect(doc.querySelector('.voided')?.textContent).toBe('ยกเลิกแล้ว · ออกใหม่');
    expect(doc.querySelector('tbody')?.textContent).toContain('ไม่พบรายละเอียด');
    expect(doc.querySelector('tbody .quantity')?.textContent).toBe('—');
    expect(doc.querySelector('.total')?.textContent).toContain('฿150.00');
  });

  it('prints stored names as text rather than HTML', () => {
    const name = '<img src=x onerror=alert(1)>';
    const doc = print({ ...statement, shop_name: name }, [{ ...charges[0], items: [{ ice_type_id: 'x', name, quantity: 1, unit: 'ถุง' }] }]);
    expect(doc.querySelector('.customer-name')?.textContent).toBe(name);
    expect(doc.querySelector('tbody')?.textContent).toContain(name);
    expect(doc.querySelector('img')).toBeNull();
  });

  it('returns false if the browser blocks the print popup', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(printBillingStatement(statement, undefined, charges)).toBe(false);
  });
});
