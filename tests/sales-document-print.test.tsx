import { describe, expect, it, vi } from 'vitest';
import { printSalesDocument } from '../src/lib/salesDocumentPrint';

describe('receipt printing', () => {
  it('prints the requested bilingual receipt layout and consolidates product rows', () => {
    const printDocument = document.implementation.createHTMLDocument();
    const printWindow = {
      document: printDocument,
      addEventListener: vi.fn(),
      close: vi.fn(),
      focus: vi.fn(),
      print: vi.fn(),
    } as unknown as Window;

    const printed = printSalesDocument({
      documentType: 'REC',
      documentNumber: 'REC2608-00006',
      title: 'ใบเสร็จรับเงิน',
      status: 'active',
      issuedAt: '2026-08-21T06:36:00.000Z',
      serviceDate: '2026-08-21',
      shop: { code: 'BB61', name: 'Fuku matcha', location: 'B · Food World' },
      paymentTerm: 'immediate',
      paymentMethod: 'cash',
      items: [
        { name: 'หลอดเล็ก', unit: 'ถุง', quantity: 2, unitPrice: 60, lineTotal: 120 },
        { name: 'หลอดเล็ก', unit: 'ถุง', quantity: 3, unitPrice: 60, lineTotal: 180 },
      ],
      allocations: [
        { documentNumber: 'INV2608-00035', amount: 75 },
        { documentNumber: 'INV2608-00045', amount: 75 },
        { documentNumber: 'INV2608-00051', amount: 75 },
        { documentNumber: 'INV2608-00054', amount: 75 },
      ],
      totals: { total: 300, received: 300, change: 0 },
      voidInfo: null,
    }, printWindow);

    const text = printDocument.body.textContent ?? '';
    expect(printed).toBe(true);
    expect(text).toContain('Super Ice');
    expect(text).toContain('ใบเสร็จรับเงิน / RECEIPT');
    expect(text).toContain('เลขที่เอกสาร: REC2608-00006');
    expect(text).toContain('วันที่ออกเอกสาร: 21/08/2026 13:36');
    expect(text).toContain('วันที่จัดส่ง: 21/08/2026');
    expect(text).toContain('ลูกค้า: BB61 · Fuku matcha');
    expect(text).toContain('สาขา: B · Food World');
    expect(text).toContain('วิธีชำระ: เงินสด (Cash)');
    expect(text).toContain('หลอดเล็ก5 ถุง300.00');
    expect(text).toContain('(อ้างอิงใบสั่งซื้อ: INV2608-00035, 00045, 00051, 00054)');
    expect(text).toContain('ยอดรวมสุทธิ (Total)฿300.00');
    expect(text).toContain('รับเงินสด (Cash Received)฿300.00');
    expect(text).toContain('เงินทอน (Change)฿0.00');
    expect(text).toContain('ลงชื่อผู้รับของ:');
    expect(printWindow.print).toHaveBeenCalledOnce();
  });

  it('prints allocation amounts instead of full product totals for a partial payment', () => {
    const printDocument = document.implementation.createHTMLDocument();
    const printWindow = {
      document: printDocument,
      addEventListener: vi.fn(),
      close: vi.fn(),
      focus: vi.fn(),
      print: vi.fn(),
    } as unknown as Window;

    printSalesDocument({
      documentType: 'REC',
      documentNumber: 'REC2608-00007',
      title: 'ใบเสร็จรับเงิน',
      status: 'active',
      issuedAt: '2026-08-21T06:36:00.000Z',
      serviceDate: '2026-08-21',
      shop: { code: 'BB61', name: 'Fuku matcha', location: 'B · Food World' },
      paymentTerm: 'credit',
      paymentMethod: 'cash',
      items: [{ name: 'หลอดเล็ก', unit: 'ถุง', quantity: 5, unitPrice: 60, lineTotal: 300 }],
      allocations: [{ documentNumber: 'INV2608-00035', amount: 100 }],
      totals: { total: 100, received: 100, change: 0 },
      voidInfo: null,
    }, printWindow);

    const text = printDocument.body.textContent ?? '';
    expect(text).toContain('รายการรับชำระ');
    expect(text).toContain('รับชำระ INV2608-00035—100.00');
    expect(text).not.toContain('หลอดเล็ก');
    expect(text).toContain('ยอดรวมสุทธิ (Total)฿100.00');
  });

  it('keeps every document number complete when references have different prefixes', () => {
    const printDocument = document.implementation.createHTMLDocument();
    const printWindow = {
      document: printDocument,
      addEventListener: vi.fn(),
      close: vi.fn(),
      focus: vi.fn(),
      print: vi.fn(),
    } as unknown as Window;

    printSalesDocument({
      documentType: 'REC',
      documentNumber: 'REC2608-00008',
      title: 'ใบเสร็จรับเงิน',
      status: 'active',
      issuedAt: '2026-08-21T06:36:00.000Z',
      serviceDate: '2026-08-21',
      shop: { code: 'BB61', name: 'Fuku matcha', location: 'B · Food World' },
      paymentTerm: 'credit',
      paymentMethod: 'cash',
      items: [{ name: 'หลอดเล็ก', unit: 'ถุง', quantity: 3, unitPrice: 100, lineTotal: 300 }],
      allocations: [
        { documentNumber: 'INV2608-00035', amount: 100 },
        { documentNumber: 'INV2607-00045', amount: 100 },
        { documentNumber: 'INV2608-00051', amount: 100 },
      ],
      totals: { total: 300, received: 300, change: 0 },
      voidInfo: null,
    }, printWindow);

    expect(printDocument.body.textContent).toContain(
      '(อ้างอิงใบสั่งซื้อ: INV2608-00035, INV2607-00045, INV2608-00051)',
    );
  });
});
