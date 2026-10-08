import { isAndroidApp, printThermalImage } from './thermalPrinter';
import { renderDailyCreditRaster } from './thermalReceiptRaster';

export type DailyCreditAcknowledgementItem = {
  ice_type_name: string;
  ice_type_unit: string;
  quantity: number | string;
  unit_price: number | string | null;
  line_total: number | string;
};

export type DailyCreditAcknowledgementDocument = {
  document_id: string;
  document_title: string;
  version: number;
  generated_at: string;
  service_date: string;
  shop_code: string;
  shop_name: string;
  shop_location?: string | null;
  invoices: Array<{
    document_number: string;
    recorded_at: string;
    recorded_by: string;
    due_date?: string | null;
    items: DailyCreditAcknowledgementItem[];
    total_amount: number | string;
  }>;
  item_totals: Array<{
    name: string;
    unit: string;
    quantity: number | string;
    line_total: number | string;
  }>;
  total_amount: number | string;
  printed_by_nickname?: string | null;
};

const money = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 2,
});

export function printDailyCreditAcknowledgement(
  payload: DailyCreditAcknowledgementDocument,
  existingPrintWindow?: Window | null,
) {
  const heightMm = Math.max(90, 70 + payload.item_totals.length * 9);
  const printWindow = existingPrintWindow
    ?? window.open('', '_blank', `popup,width=360,height=${Math.ceil(heightMm * 3.78)}`);
  if (!printWindow) return false;

  const printDocument = printWindow.document;
  const style = printDocument.createElement('style');
  style.textContent = `
    @page { size: 57mm ${heightMm}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { width: 57mm; min-height: ${heightMm}mm; margin: 0; }
    body { padding: 2.5mm 2.5mm; color: #000; background: #fff; font-family: "Noto Sans Thai", Tahoma, sans-serif; font-size: 8.5pt; line-height: 1.45; }
    main { display: grid; gap: 1.4mm; }
    h1 { margin: 0; font-size: 12pt; text-align: center; line-height: 1.35; }
    h2 { margin: 0; font-size: 9pt; line-height: 1.35; }
    p { margin: 0; }
    small { font-size: 8pt; line-height: 1.4; }
    .center { text-align: center; }
    .document-title { font-size: 10pt; font-weight: 700; line-height: 1.4; }
    .totals, .grand-total { border-top: .25mm dashed #000; padding-top: 1.3mm; margin-top: .5mm; }
    .row, .grand-total { display: flex; justify-content: space-between; gap: 1mm; }
    .totals .row { font-size: 9.5pt; line-height: 1.45; }
    .totals .row span:first-child { min-width: 0; }
    .totals .row span:last-child { flex-shrink: 0; }
    .grand-total { font-size: 10pt; font-weight: 700; line-height: 1.35; }
  `;
  printDocument.head.replaceChildren(style);

  const root = printDocument.createElement('main');
  const line = (text: string, className?: string, tag: 'p' | 'small' = 'p') => {
    const element = printDocument.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    root.append(element);
  };
  const title = printDocument.createElement('h1');
  title.textContent = 'Super Ice';
  root.append(title);
  line('ใบสรุปส่งของเครดิตประจำวัน', 'center document-title');
  line(`วันที่ ${payload.service_date}`, 'center');
  line(`${payload.shop_code} · ${payload.shop_name}`);
  if (payload.shop_location) line(`จุดส่ง: ${payload.shop_location}`, undefined, 'small');
  if (payload.printed_by_nickname?.trim()) line(`พนักงาน: ${payload.printed_by_nickname.trim()}`);

  const totals = printDocument.createElement('section');
  totals.className = 'totals';
  const totalsHeading = printDocument.createElement('h2');
  totalsHeading.textContent = 'รวมสินค้าวันนี้';
  totals.append(totalsHeading);
  for (const item of payload.item_totals) {
    const row = printDocument.createElement('div');
    row.className = 'row';
    const label = printDocument.createElement('span');
    label.textContent = `${item.name} ${Number(item.quantity)} ${item.unit}`;
    const amount = printDocument.createElement('span');
    amount.textContent = money.format(Number(item.line_total));
    row.append(label, amount);
    totals.append(row);
  }
  root.append(totals);

  const grandTotal = printDocument.createElement('div');
  grandTotal.className = 'grand-total';
  const grandTotalLabel = printDocument.createElement('span');
  grandTotalLabel.textContent = 'ยอดเครดิตวันนี้';
  const grandTotalAmount = printDocument.createElement('span');
  grandTotalAmount.textContent = money.format(Number(payload.total_amount));
  grandTotal.append(grandTotalLabel, grandTotalAmount);
  root.append(grandTotal);
  line('ร้านได้รับสินค้าตามรายการและรับทราบยอดเครดิตข้างต้น', undefined, 'small');

  line('ชื่อผู้รับ ____________________', 'center');

  printDocument.body.replaceChildren(root);
  printWindow.addEventListener('afterprint', () => printWindow.close(), { once: true });
  printWindow.focus();
  printWindow.print();
  return true;
}

export async function printDailyCreditAcknowledgementForCurrentPlatform(
  payload: DailyCreditAcknowledgementDocument,
  existingPrintWindow?: Window | null,
) {
  if (!isAndroidApp()) return printDailyCreditAcknowledgement(payload, existingPrintWindow);
  existingPrintWindow?.close();
  const imageBase64 = await renderDailyCreditRaster(payload);
  await printThermalImage(imageBase64);
  return true;
}
