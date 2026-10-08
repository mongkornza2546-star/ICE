import { describe, expect, it, vi } from 'vitest';
import { printDailyCreditAcknowledgement } from '../src/lib/dailyCreditAcknowledgementPrint';

describe('daily credit delivery slip printing', () => {
  it('prints the date, enlarged item rows, and the current printer nickname', () => {
    const printDocument = document.implementation.createHTMLDocument();
    const printWindow = {
      document: printDocument,
      addEventListener: vi.fn(),
      close: vi.fn(),
      focus: vi.fn(),
      print: vi.fn(),
    } as unknown as Window;

    const printed = printDailyCreditAcknowledgement({
      document_id: 'document-1',
      document_title: 'ใบส่งของ',
      version: 1,
      generated_at: '2026-09-24T12:59:00.000Z',
      service_date: '2026-09-24',
      shop_code: 'B-ISO-01',
      shop_name: 'วิน',
      invoices: [],
      item_totals: [{ name: 'หลอดเล็ก', unit: 'ถุง', quantity: 2, line_total: 120 }],
      total_amount: 120,
      printed_by_nickname: 'นิด',
    }, printWindow);

    const text = printDocument.body.textContent ?? '';
    expect(printed).toBe(true);
    expect(text).toContain('ใบส่งของ');
    expect(text).toContain('2026-09-24');
    expect(text).not.toContain('ฉบับที่ 1');
    expect(text).toContain('หลอดเล็ก 2 ถุง');
    expect(text).toContain('ผู้พิมพ์: นิด');
    expect(printDocument.querySelector('style')?.textContent).toContain('.totals .row { font-size: 9.5pt;');
    expect(text).toContain('ชื่อผู้รับ ____________________');
    expect(text).not.toContain('ลายเซ็นร้าน');
    expect(text).not.toContain('วันที่ / เวลา');
    expect(printWindow.print).toHaveBeenCalledOnce();
  });
});
