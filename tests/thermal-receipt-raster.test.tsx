import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyCreditAcknowledgementDocument } from '../src/lib/dailyCreditAcknowledgementPrint';
import type { SalesDocumentPayload } from '../src/lib/salesDocumentPrint';
import {
  renderDailyCreditRaster,
  renderSalesDocumentRaster,
  wrapReceiptText,
} from '../src/lib/thermalReceiptRaster';

const drawnText: string[] = [];
const drawnFonts: Array<{ text: string; font: string }> = [];

const context = {
  beginPath: vi.fn(),
  drawImage: vi.fn(),
  fillRect: vi.fn(),
  fillText: vi.fn((value: string) => {
    drawnText.push(value);
    drawnFonts.push({ text: value, font: context.font });
  }),
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

it('prints a backdated receipt with date-only receipt day and actual entry time', async () => {
  await renderSalesDocumentRaster({
    ...receipt,
    issuedAt: '2026-09-30T00:00:00+07:00',
    receivedDate: '2026-09-30',
    enteredAt: '2026-10-03T13:43:00+07:00',
  });
  const text = drawnText.join('');
  expect(text).toContain('วันที่รับเงิน: 30/09/2026');
  expect(text).toContain('บันทึกเมื่อ: 03/10/2026 13:43');
  expect(text).not.toContain('00:00');
});

beforeEach(() => {
  drawnText.length = 0;
  drawnFonts.length = 0;
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

  it('prints the daily delivery slip with a larger item row and printer nickname', async () => {
    const daily: DailyCreditAcknowledgementDocument = {
      document_id: 'document-1',
      document_title: 'ใบส่งของ',
      version: 1,
      generated_at: '2026-08-21T08:00:00.000Z',
      service_date: '2026-08-21',
      shop_code: 'BB61',
      shop_name: 'Fuku matcha',
      shop_location: 'B · ซุ้มโดม 1',
      invoices: [],
      item_totals: [{ name: 'หลอดเล็ก', unit: 'ถุง', quantity: 2, line_total: 120 }],
      total_amount: 120,
      printed_by_nickname: 'นิด',
    };

    await renderDailyCreditRaster(daily);

    expect(drawnText).toContain('Super Ice');
    expect(drawnText.join('')).toContain('ใบสรุปส่งของเครดิตประจำวัน');
    expect(drawnText).toContain('วันที่ 2026-08-21');
    expect(drawnText.join('')).not.toContain('ฉบับที่ 1');
    expect(drawnText).toContain('พนักงาน: นิด');
    expect(drawnText).not.toContain('ผู้พิมพ์: นิด');
    expect(drawnText).toContain('จุดส่ง: B · ซุ้มโดม 1');
    expect(drawnText.indexOf('Super Ice')).toBeLessThan(drawnText.indexOf('วันที่ 2026-08-21'));
    expect(drawnText.indexOf('จุดส่ง: B · ซุ้มโดม 1')).toBeLessThan(drawnText.indexOf('พนักงาน: นิด'));
    expect(drawnText.indexOf('พนักงาน: นิด')).toBeLessThan(drawnText.indexOf('รวมสินค้าวันนี้'));
    expect(drawnFonts.find(({ text }) => text.includes('หลอดเล็ก'))?.font).toContain('25px');
    expect(drawnText).toContain('ชื่อผู้รับ ____________________');
    expect(drawnText).not.toContain('ลายเซ็นร้าน ____________________');
    expect(drawnText).not.toContain('วันที่ / เวลา ____________________');
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
