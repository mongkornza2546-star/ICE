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
      shop_location: 'B · ซุ้มโดม 1',
      invoices: [],
      item_totals: [{ name: 'หลอดเล็ก', unit: 'ถุง', quantity: 2, line_total: 120 }],
      total_amount: 120,
      printed_by_nickname: 'นิด',
    }, printWindow);

    const text = printDocument.body.textContent ?? '';
    expect(printed).toBe(true);
    expect(text).toContain('Super Ice');
    expect(text).toContain('ใบสรุปส่งของเครดิตประจำวัน');
    expect(text).toContain('วันที่ 2026-09-24');
    expect(text).not.toContain('ฉบับที่ 1');
    expect(text).toContain('หลอดเล็ก 2 ถุง');
    expect(text).toContain('พนักงาน: นิด');
    expect(text).not.toContain('ผู้พิมพ์:');
    expect(text).toContain('จุดส่ง: B · ซุ้มโดม 1');
    expect(text.indexOf('Super Ice')).toBeLessThan(text.indexOf('ใบสรุปส่งของเครดิตประจำวัน'));
    expect(text.indexOf('จุดส่ง: B · ซุ้มโดม 1')).toBeLessThan(text.indexOf('พนักงาน: นิด'));
    expect(text.indexOf('พนักงาน: นิด')).toBeLessThan(text.indexOf('รวมสินค้าวันนี้'));
    expect(printDocument.querySelector('style')?.textContent).toContain('.totals .row { font-size: 9.5pt;');
    expect(text).toContain('ชื่อผู้รับ ____________________');
    expect(text).not.toContain('ลายเซ็นร้าน');
    expect(text).not.toContain('วันที่ / เวลา');
    expect(printWindow.print).toHaveBeenCalledOnce();
  });
});
