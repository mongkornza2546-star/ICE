import { describe, expect, it, vi } from 'vitest';
import { printDailyCreditAcknowledgement, printDailyCreditAcknowledgementForCurrentPlatform } from '../src/lib/dailyCreditAcknowledgementPrint';

describe('daily credit delivery slip printing', () => {
  it('prints the additional version with the pre-VAT total while preserving the stored amounts', async () => {
    const printDocument = document.implementation.createHTMLDocument();
    const printWindow = {
      document: printDocument, addEventListener: vi.fn(), close: vi.fn(), focus: vi.fn(), print: vi.fn(),
    } as unknown as Window;
    const payload = {
      document_id: 'vat-document', document_title: 'ใบส่งของ', version: 1,
      generated_at: '2026-10-14T06:38:00.000Z', service_date: '2026-10-14',
      shop_code: 'BB27', shop_name: 'ร้านเครดิต', invoices: [],
      item_totals: [{ name: 'หลอดเล็ก', unit: 'ถุง', quantity: 3, line_total: 180 }],
      subtotal_amount: 180, vat_amount: 12.6, total_amount: 192.6,
    };
    expect(await printDailyCreditAcknowledgementForCurrentPlatform(payload, printWindow, { showVat: false })).toBe(true);
    const text = printDocument.body.textContent ?? '';
    expect(text).not.toContain('VAT');
    expect(text).toContain('หลอดเล็ก 3 ถุง฿180.00');
    expect(text).toContain('ยอดเครดิตวันนี้฿180.00');
    expect(text).not.toContain('192.60');
    expect(text).toContain('ชื่อผู้รับ ____________________');
    expect(payload.vat_amount).toBe(12.6);
    expect(printWindow.print).toHaveBeenCalledOnce();

    printDailyCreditAcknowledgement(payload, printWindow);
    expect(printDocument.body.textContent).toContain('VAT ฿12.60');
    expect(printDocument.body.textContent).toContain('ยอดเครดิตวันนี้฿192.60');
  });

  it('prints stored VAT separately from the full goods total', () => {
    const printDocument = document.implementation.createHTMLDocument();
    const printWindow = {
      document: printDocument, addEventListener: vi.fn(), close: vi.fn(), focus: vi.fn(), print: vi.fn(),
    } as unknown as Window;
    printDailyCreditAcknowledgement({
      document_id: 'vat-document', document_title: 'ใบส่งของ', version: 1,
      generated_at: '2026-09-24T12:59:00.000Z', service_date: '2026-09-24',
      shop_code: 'VAT', shop_name: 'ร้านเครดิต', invoices: [],
      item_totals: [{ name: 'น้ำแข็ง', unit: 'ถุง', quantity: 40, line_total: 1000 }],
      subtotal_amount: 1000, vat_amount: 70, total_amount: 1070,
    }, printWindow);
    const text = printDocument.body.textContent ?? '';
    expect(text).toContain('ค่าสินค้าก่อน VAT ฿1,000.00');
    expect(text).toContain('VAT ฿70.00');
    expect(text).toContain('ยอดเครดิตวันนี้฿1,070.00');
  });

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
    expect(text).toContain('วันที่ 24/09/2026');
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
