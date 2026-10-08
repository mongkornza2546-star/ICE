import type { DailyCreditAcknowledgementDocument } from './dailyCreditAcknowledgementPrint';
import type { SalesDocumentPayload } from './salesDocumentPrint';
import {
  compactDocumentNumbers,
  consolidatedReceiptItems,
  formatReceiptDate,
  formatReceiptDateTime,
  methodLabels,
  receiptMethodLabels,
  receiptReceivedLabels,
} from './salesDocumentPresentation';

const PRINT_WIDTH = 384;
const PADDING = 16;
const MAX_HEIGHT = 8192;

const money = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 2,
});

const dateTime = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

const DEFAULT_LINE_HEIGHT_RATIO = 1.55;

type TextOptions = {
  align?: CanvasTextAlign;
  bold?: boolean;
  size?: number;
  lineHeight?: number;
};

type SegmenterLike = {
  segment(value: string): Iterable<{ segment: string }>;
};

type SegmenterConstructor = new (
  locale: string,
  options: { granularity: 'word' | 'grapheme' },
) => SegmenterLike;

function segmented(value: string, granularity: 'word' | 'grapheme') {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
  if (Segmenter) return [...new Segmenter('th', { granularity }).segment(value)].map(({ segment }) => segment);
  if (granularity === 'word') return value.split(/(\s+)/).filter(Boolean);

  const graphemes: string[] = [];
  for (const character of [...value]) {
    if (/\p{Mark}/u.test(character) && graphemes.length > 0) graphemes[graphemes.length - 1] += character;
    else graphemes.push(character);
  }
  return graphemes;
}

export function wrapReceiptText(value: string, maxWidth: number, measure: (value: string) => number) {
  const text = value.trim();
  if (!text) return [''];
  const tokens = segmented(text, 'word');
  const lines: string[] = [];
  let line = '';
  for (const token of tokens) {
    const candidate = `${line}${token}`;
    if (measure(candidate) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line.trimEnd());
    const nextToken = token.trimStart();
    if (!nextToken) {
      line = '';
      continue;
    }
    if (measure(nextToken) <= maxWidth) {
      line = nextToken;
      continue;
    }
    line = '';
    for (const grapheme of segmented(nextToken, 'grapheme')) {
      if (line && measure(`${line}${grapheme}`) > maxWidth) {
        lines.push(line);
        line = grapheme;
      } else {
        line += grapheme;
      }
    }
  }
  if (line) lines.push(line.trimEnd());
  return lines.length > 0 ? lines : [''];
}

class ReceiptRaster {
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private y = PADDING;

  constructor() {
    this.canvas.width = PRINT_WIDTH;
    this.canvas.height = MAX_HEIGHT;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('อุปกรณ์นี้ไม่รองรับการสร้างภาพใบเสร็จ');
    this.context = context;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.fillStyle = '#000';
    context.textBaseline = 'top';
  }

  gap(height = 8) {
    this.assertSpace(height);
    this.y += height;
  }

  rule(topSpacing = 8, bottomSpacing = 10) {
    this.assertSpace(topSpacing + bottomSpacing + 2);
    this.y += topSpacing;
    this.context.save();
    this.context.strokeStyle = '#000';
    this.context.lineWidth = 2;
    this.context.setLineDash([6, 5]);
    this.context.beginPath();
    this.context.moveTo(PADDING, this.y);
    this.context.lineTo(PRINT_WIDTH - PADDING, this.y);
    this.context.stroke();
    this.context.restore();
    this.y += bottomSpacing;
  }

  text(value: string, options: TextOptions = {}) {
    const size = options.size ?? 21;
    const align = options.align ?? 'left';
    this.setFont(size, options.bold ?? false);
    const lines = this.wrap(value, PRINT_WIDTH - PADDING * 2);
    const lineHeight = options.lineHeight ?? Math.ceil(size * DEFAULT_LINE_HEIGHT_RATIO);
    this.assertSpace(lines.length * lineHeight);
    this.context.textAlign = align;
    const x = align === 'center' ? PRINT_WIDTH / 2 : align === 'right' ? PRINT_WIDTH - PADDING : PADDING;
    for (const line of lines) {
      this.context.fillText(line, x, this.y);
      this.y += lineHeight;
    }
  }

  row(left: string, right: string, options: TextOptions = {}) {
    const size = options.size ?? 20;
    this.setFont(size, options.bold ?? false);
    const rightWidth = Math.min(150, Math.ceil(this.context.measureText(right).width));
    const leftLines = this.wrap(left, PRINT_WIDTH - PADDING * 2 - rightWidth - 10);
    const lineHeight = options.lineHeight ?? Math.ceil(size * DEFAULT_LINE_HEIGHT_RATIO);
    this.assertSpace(leftLines.length * lineHeight);
    this.context.textAlign = 'right';
    this.context.fillText(right, PRINT_WIDTH - PADDING, this.y);
    this.context.textAlign = 'left';
    for (const line of leftLines) {
      this.context.fillText(line, PADDING, this.y);
      this.y += lineHeight;
    }
  }

  itemRow(name: string, quantity: string, amount: string, bold = false) {
    const size = 18;
    this.setFont(size, bold);
    const nameWidth = 190;
    const lines = this.wrap(name, nameWidth);
    const lineHeight = Math.ceil(size * DEFAULT_LINE_HEIGHT_RATIO);
    this.assertSpace(lines.length * lineHeight);
    this.context.textAlign = 'right';
    this.context.fillText(quantity, 290, this.y);
    this.context.fillText(amount, PRINT_WIDTH - PADDING, this.y);
    this.context.textAlign = 'left';
    for (const line of lines) {
      this.context.fillText(line, PADDING, this.y);
      this.y += lineHeight;
    }
  }

  finish() {
    this.assertSpace(24);
    const height = Math.max(80, this.y + 24);
    const result = document.createElement('canvas');
    result.width = PRINT_WIDTH;
    result.height = height;
    const context = result.getContext('2d');
    if (!context) throw new Error('อุปกรณ์นี้ไม่รองรับการสร้างภาพใบเสร็จ');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, result.width, result.height);
    context.drawImage(this.canvas, 0, 0, PRINT_WIDTH, height, 0, 0, PRINT_WIDTH, height);
    return result.toDataURL('image/png');
  }

  private setFont(size: number, bold: boolean) {
    this.context.font = `${bold ? 700 : 400} ${size}px "Noto Sans Thai", sans-serif`;
  }

  private wrap(value: string, maxWidth: number) {
    return wrapReceiptText(value, maxWidth, (candidate) => this.context.measureText(candidate).width);
  }

  private assertSpace(height: number) {
    if (this.y + height > MAX_HEIGHT) {
      throw new Error('ใบเสร็จยาวเกินขนาด กรุณาลดจำนวนรายการหรือแบ่งพิมพ์');
    }
  }
}

async function loadReceiptFonts() {
  if (!document.fonts) return;
  await Promise.all([
    document.fonts.load('400 21px "Noto Sans Thai"'),
    document.fonts.load('700 21px "Noto Sans Thai"'),
  ]);
}

export async function renderSalesDocumentRaster(payload: SalesDocumentPayload) {
  await loadReceiptFonts();
  const receipt = new ReceiptRaster();
  if (payload.documentType === 'REC') {
    receipt.text('Super Ice', { align: 'center', bold: true, size: 27 });
    receipt.text('ใบเสร็จรับเงิน / RECEIPT', { align: 'center', bold: true, size: 22 });
    receipt.gap(6);
    receipt.text(`เลขที่เอกสาร: ${payload.documentNumber}`, { size: 20 });
    if (payload.receivedDate) {
      receipt.text(`วันที่รับเงิน: ${formatReceiptDate(payload.receivedDate)}`, { size: 20 });
      if (payload.enteredAt) receipt.text(`บันทึกเมื่อ: ${formatReceiptDateTime(payload.enteredAt)}`, { size: 19 });
    }
    if (payload.serviceDate) receipt.text(`วันที่จัดส่ง: ${formatReceiptDate(payload.serviceDate)}`, { size: 20 });
    if (payload.status === 'voided') {
      receipt.gap(4);
      receipt.text(`ยกเลิก · ${payload.voidInfo?.reason ?? 'ไม่ระบุเหตุ'}`, { align: 'center', bold: true, size: 21 });
    }
    receipt.rule();
    receipt.text('[ข้อมูลลูกค้า / ผู้รับของ]', { bold: true, size: 21 });
    receipt.gap(4);
    receipt.text(`ลูกค้า: ${payload.shop.code} · ${payload.shop.name}`, { size: 21 });
    receipt.text(`สาขา: ${payload.shop.location ?? '—'}`, { size: 20 });
    if (payload.paymentMethod) {
      receipt.text(`วิธีชำระ: ${receiptMethodLabels[payload.paymentMethod]}`, { size: 20 });
    }
    receipt.rule();

    const items = consolidatedReceiptItems(payload.items);
    const itemTotal = items.reduce((total, item) => total + item.lineTotal, 0);
    const allocationsOnly = Math.abs(itemTotal - payload.totals.total) >= 0.005;
    receipt.itemRow(allocationsOnly ? 'รายการรับชำระ' : 'รายการสินค้า', 'จำนวน', 'รวม(฿)', true);
    receipt.gap(5);
    if (allocationsOnly) {
      for (const allocation of payload.allocations) {
        receipt.itemRow(allocation.documentNumber ? `รับชำระ ${allocation.documentNumber}` : 'รับชำระ', '—', allocation.amount.toFixed(2));
        receipt.gap(3);
      }
    } else {
      for (const item of items) {
        receipt.itemRow(item.name, `${item.quantity} ${item.unit}`, item.lineTotal.toFixed(2));
        receipt.gap(3);
      }
    }
    const documentNumbers = compactDocumentNumbers(payload.allocations
      .flatMap((allocation) => allocation.documentNumber ? [allocation.documentNumber] : []));
    if (!allocationsOnly && documentNumbers.length > 0) {
      receipt.gap(4);
      receipt.text(`(อ้างอิงใบสั่งซื้อ: ${documentNumbers.join(', ')})`, { size: 18 });
    }
    receipt.rule();
    receipt.row('ยอดรวมสุทธิ (Total)', money.format(payload.totals.total), { bold: true, size: 22 });
    receipt.gap(4);
    receipt.row(payload.paymentMethod ? receiptReceivedLabels[payload.paymentMethod] : 'รับเงิน (Received)', money.format(payload.totals.received ?? payload.totals.total), { size: 20 });
    receipt.row('เงินทอน (Change)', money.format(payload.totals.change ?? 0), { size: 20 });
    if (payload.voidInfo) {
      receipt.gap(6);
      receipt.text(`ยกเลิกเมื่อ ${dateTime.format(new Date(payload.voidInfo.voidedAt))}${payload.voidInfo.voidedBy ? ` · ${payload.voidInfo.voidedBy}` : ''}`, { size: 18 });
    }
  } else {
    receipt.text(payload.title, { align: 'center', bold: true, size: 27 });
    receipt.text(payload.documentNumber, { align: 'center', bold: true, size: 22 });
    receipt.gap(6);
    if (payload.status === 'voided') {
      receipt.text(`ยกเลิก · ${payload.voidInfo?.reason ?? 'ไม่ระบุเหตุ'}`, { align: 'center', bold: true, size: 21 });
      receipt.gap(4);
    }
    receipt.text(`${payload.shop.code} · ${payload.shop.name}`, { bold: true, size: 22 });
    if (payload.shop.location) receipt.text(payload.shop.location, { size: 20 });
    if (payload.serviceDate) receipt.text(`วันที่ส่ง ${payload.serviceDate}`, { size: 20 });
    if (payload.dueDate) receipt.text(`ครบกำหนด ${payload.dueDate}`, { size: 20 });
    if (payload.paymentMethod) {
      receipt.text(`วิธีชำระ ${methodLabels[payload.paymentMethod]}`, { size: 19 });
    }
    if (payload.recordedByName) receipt.text(`ผู้รับเงิน ${payload.recordedByName}`, { size: 19 });
    receipt.rule();
    for (const item of payload.items) {
      receipt.row(`${item.name} × ${item.quantity} ${item.unit}${item.unitPrice == null ? '' : ` @ ${money.format(item.unitPrice)}`}`, money.format(item.lineTotal), { size: 20 });
      receipt.gap(3);
    }
    for (const allocation of payload.allocations.filter((item) => item.documentNumber)) {
      receipt.row(`รายการสั่งซื้อ ${allocation.documentNumber!}`, money.format(allocation.amount), { size: 20 });
      receipt.gap(3);
    }
    receipt.rule();
    receipt.row('ยอดรวม', money.format(payload.totals.total), { bold: true, size: 24 });
    if (payload.totals.received != null) {
      receipt.gap(4);
      receipt.row('รับเงิน', money.format(payload.totals.received), { size: 20 });
      if (payload.totals.change != null && payload.totals.change > 0) receipt.row('เงินทอน', money.format(payload.totals.change), { size: 20 });
    }
    if (payload.voidInfo) {
      receipt.gap(6);
      receipt.text(`ยกเลิกเมื่อ ${dateTime.format(new Date(payload.voidInfo.voidedAt))}${payload.voidInfo.voidedBy ? ` · ${payload.voidInfo.voidedBy}` : ''}`, { size: 18 });
    }
    receipt.gap(34);
    receipt.text('ลายเซ็นผู้รับสินค้า ____________________', { align: 'center', size: 21 });
  }
  return receipt.finish();
}

export async function renderDailyCreditRaster(payload: DailyCreditAcknowledgementDocument) {
  await loadReceiptFonts();
  const receipt = new ReceiptRaster();
  receipt.text('Super Ice', { align: 'center', bold: true, size: 31 });
  receipt.text('ใบสรุปส่งของเครดิตประจำวัน', { align: 'center', bold: true, size: 26 });
  receipt.text(`วันที่ ${payload.service_date}`, { align: 'center', size: 22 });
  receipt.gap(6);
  receipt.text(`${payload.shop_code} · ${payload.shop_name}`, { bold: true, size: 23 });
  if (payload.shop_location) receipt.text(`จุดส่ง: ${payload.shop_location}`, { size: 21 });
  if (payload.printed_by_nickname?.trim()) receipt.text(`พนักงาน: ${payload.printed_by_nickname.trim()}`, { size: 22 });
  receipt.rule();
  receipt.text('รวมสินค้าวันนี้', { bold: true, size: 23 });
  receipt.gap(6);
  for (const item of payload.item_totals) receipt.row(`${item.name} ${Number(item.quantity)} ${item.unit}`, money.format(Number(item.line_total)), { size: 25 });
  receipt.rule();
  receipt.row('ยอดเครดิตวันนี้', money.format(Number(payload.total_amount)), { bold: true, size: 26 });
  receipt.gap(8);
  receipt.text('ร้านได้รับสินค้าตามรายการและรับทราบยอดเครดิตข้างต้น', { size: 20 });
  receipt.gap(26);
  receipt.text('ชื่อผู้รับ ____________________', { align: 'center', size: 22 });
  return receipt.finish();
}

export async function renderPrinterTestRaster(printerName: string) {
  await loadReceiptFonts();
  const receipt = new ReceiptRaster();
  receipt.text('Super Ice', { align: 'center', bold: true, size: 29 });
  receipt.text('ทดสอบเครื่องพิมพ์', { align: 'center', bold: true, size: 25 });
  receipt.rule();
  receipt.text(`เครื่อง: ${printerName}`);
  receipt.text(`วันเวลา: ${dateTime.format(new Date())}`);
  receipt.text('ภาษาไทย: น้ำแข็ง ใบเสร็จรับเงิน');
  receipt.text('English: Bluetooth ESC/POS');
  receipt.rule();
  receipt.text('ทดสอบสำเร็จ', { align: 'center', bold: true });
  return receipt.finish();
}
