import type { BillingStatement } from '../features/financial-operations/types';
import { billingStatementDailyTotals } from './billingStatementSummary';
import { formatReceiptDate } from './salesDocumentPresentation';
import { isAndroidApp, printThermalImage } from './thermalPrinter';
import { renderBillingStatementSummaryRaster } from './thermalReceiptRaster';

const money = new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB', minimumFractionDigits: 2 });

export async function printEmployeeBillingStatement(statement: BillingStatement, existingPrintWindow?: Window | null) {
  if (isAndroidApp()) {
    existingPrintWindow?.close();
    await printThermalImage(await renderBillingStatementSummaryRaster(statement));
    return true;
  }
  const days = billingStatementDailyTotals(statement);
  const heightMm = Math.max(100, 85 + days.length * 8);
  const printWindow = existingPrintWindow ?? window.open('', '_blank', 'popup,width=360,height=720');
  if (!printWindow) return false;
  const doc = printWindow.document;
  const style = doc.createElement('style');
  style.textContent = `
    @page { size: 57mm ${heightMm}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { width: 57mm; margin: 0; }
    body { padding: 2mm 2.5mm; color: #000; background: #fff; font: 8.5pt/1.45 "Noto Sans Thai", Tahoma, sans-serif; }
    main { display: grid; gap: 1.4mm; overflow-wrap: anywhere; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 12pt; text-align: center; }
    h2 { font-size: 10pt; text-align: center; }
    .row { display: flex; justify-content: space-between; gap: 1mm; }
    .row span:last-child { white-space: nowrap; }
    .days, .total { border-top: .25mm dashed #000; padding-top: 1.4mm; }
    .total { font-weight: 700; font-size: 10pt; }
    .signature { margin-top: 5mm; text-align: center; }
  `;
  doc.head.replaceChildren(style);
  doc.documentElement.lang = 'th';
  doc.title = `ใบวางบิล ${statement.statement_number}`;
  const root = doc.createElement('main');
  const line = (text: string, tag = 'p', className = '') => {
    const node = doc.createElement(tag);
    node.textContent = text;
    node.className = className;
    root.append(node);
  };
  const row = (parent: HTMLElement, label: string, amount: number, className = '') => {
    const node = doc.createElement('p');
    node.className = `row ${className}`;
    const left = doc.createElement('span');
    left.textContent = label;
    const right = doc.createElement('span');
    right.textContent = money.format(amount);
    node.append(left, right);
    parent.append(node);
  };
  line('Super Ice', 'h1');
  line('ใบวางบิล', 'h2');
  line(`เลขที่ ${statement.statement_number}`);
  line(`วันที่ออก ${formatReceiptDate(statement.issued_service_date)}`);
  if (statement.status === 'voided') line(`ยกเลิกแล้ว · ${statement.void_reason ?? ''}`);
  line(`${statement.shop_code} · ${statement.shop_name}`);
  if (statement.shop_location) line(statement.shop_location);
  const daily = doc.createElement('section');
  daily.className = 'days';
  for (const day of days) row(daily, formatReceiptDate(day.serviceDate), day.amount);
  root.append(daily);
  row(root, 'ยอดวางบิลทั้งสิ้น', Number(statement.total_amount), 'total');
  line('เอกสารนี้เป็นใบวางบิล ไม่ใช่ใบเสร็จรับเงิน');
  line('ผู้รับวางบิล ____________________', 'p', 'signature');
  doc.body.replaceChildren(root);
  printWindow.addEventListener('afterprint', () => printWindow.close(), { once: true });
  printWindow.focus();
  printWindow.print();
  return true;
}
