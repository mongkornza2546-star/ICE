import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyCreditAcknowledgementDocument } from '../src/lib/dailyCreditAcknowledgementPrint';
import type { SalesDocumentPayload } from '../src/lib/salesDocumentPrint';
import {
  renderDailyCreditRaster,
  renderSalesDocumentRaster,
  wrapReceiptText,
} from '../src/lib/thermalReceiptRaster';

const drawnText: string[] = [];

const context = {
  beginPath: vi.fn(),
  drawImage: vi.fn(),
  fillRect: vi.fn(),
  fillText: vi.fn((value: string) => drawnText.push(value)),
  lineTo: vi.fn(),
  measureText: vi.fn((value: string) => ({ width: [...value].length * 10 })),
  moveTo: vi.fn(),
  restore: vi.fn(),
  save: vi.fn(),
  setLineDash: vi.fn(),
  stroke: vi.fn(),
  fillStyle: '#000',
  font: '',
  lineWidth: 1,
  strokeStyle: '#000',
  textAlign: 'left' as CanvasTextAlign,
  textBaseline: 'top' as CanvasTextBaseline,
};

const receipt: SalesDocumentPayload = {
  documentType: 'REC',
  documentNumber: 'REC2608-00006',
  title: 'ใบเสร็จรับเงิน',
  status: 'active',
  issuedAt: '2026-08-21T06:36:00.000Z',
  serviceDate: '2026-08-21',
  shop: { code: 'BB61', name: 'Fuku matcha', location: 'B · Food World' },
  paymentTerm: 'immediate',
  paymentMethod: 'cash',
  recordedByName: null,
  items: [{ name: 'หลอดเล็ก', unit: 'ถุง', quantity: 5, unitPrice: 60, lineTotal: 300 }],
  allocations: [{ documentNumber: 'INV2608-00035', amount: 300 }],
  totals: { total: 300, received: 500, change: 200 },
  voidInfo: null,
};

beforeEach(() => {
  drawnText.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,test');
});

describe('thermal receipt raster', () => {
  it('keeps receipt references and payment-specific totals in Android output', async () => {
    await renderSalesDocumentRaster(receipt);

    const text = drawnText.join('\n');
    const compactText = drawnText.join('');
    expect(compactText).toContain('อ้างอิงใบสั่งซื้อ: INV2608-00035');
    expect(text).toContain('รับเงินสด (Cash Received)');
    expect(text).toContain('เงินทอน (Change)');
  });

  it('keeps invoice payment, allocation, operator, received, change, and void audit fields', async () => {
    await renderSalesDocumentRaster({
      ...receipt,
      documentType: 'INV',
      documentNumber: 'INV2608-00035',
      title: 'ใบสั่งซื้อ',
      status: 'voided',
      paymentMethod: 'qr',
      recordedByName: 'พนักงาน หนึ่ง',
      allocations: [{ documentNumber: 'INV2608-00012', amount: 120 }],
      totals: { total: 300, received: 500, change: 200 },
      voidInfo: {
        voidedAt: '2026-08-21T07:00:00.000Z',
        reason: 'ลงยอดผิด',
        voidedBy: 'หัวหน้า สอง',
      },
    });

    const text = drawnText.join('\n');
    const compactText = drawnText.join('');
    for (const expected of [
      'วิธีชำระ QR',
      'ผู้รับเงิน พนักงาน หนึ่ง',
      'รับเงิน',
      'เงินทอน',
      'ยกเลิกเมื่อ',
    ]) expect(text).toContain(expected);
    expect(compactText).toContain('รายการสั่งซื้อ INV2608-00012');
    expect(text).toContain('หัวหน้า');
    expect(text).toContain('สอง');
  });

  it('keeps every daily-credit signature field', async () => {
    const daily: DailyCreditAcknowledgementDocument = {
      document_id: 'document-1',
      document_title: 'ใบสรุปยอดเครดิต',
      version: 1,
      generated_at: '2026-08-21T08:00:00.000Z',
      service_date: '2026-08-21',
      shop_code: 'BB61',
      shop_name: 'Fuku matcha',
      invoices: [],
      item_totals: [],
      total_amount: 0,
    };

    await renderDailyCreditRaster(daily);

    expect(drawnText).toContain('วันที่ / เวลา ____________________');
  });

  it('never separates a Thai combining mark from its base character', () => {
    expect(wrapReceiptText('ก้ก้', 10, (value) => [...value].length * 10)).toEqual(['ก้', 'ก้']);
  });

  it('rejects oversized receipts instead of returning a truncated image', async () => {
    const items = Array.from({ length: 400 }, (_, index) => ({
      name: `item-${index}`,
      unit: 'ถุง',
      quantity: 1,
      unitPrice: 1,
      lineTotal: 1,
    }));

    await expect(renderSalesDocumentRaster({
      ...receipt,
      items,
      totals: { total: 400, received: 400, change: 0 },
    })).rejects.toThrow('ใบเสร็จยาวเกินขนาด');
  });
});
