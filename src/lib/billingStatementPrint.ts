import type { BillingStatement, ReceivableCharge } from '../features/financial-operations/types';

const money = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 2,
});
const quantity = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 3 });
const date = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });

function parseServiceDate(value: string) {
  return new Date(`${value}T12:00:00+07:00`);
}

export function printBillingStatement(
  statement: BillingStatement,
  existingPrintWindow?: Window | null,
  charges: ReceivableCharge[] = [],
) {
  const printWindow = existingPrintWindow ?? window.open('', '_blank', 'popup,width=900,height=720');
  if (!printWindow) return false;
  const doc = printWindow.document;
  const style = doc.createElement('style');
  style.textContent = `
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #18354c; background: #fff; font-family: Tahoma, "Noto Sans Thai", sans-serif; font-size: 9pt; line-height: 1.45; }
    main { max-width: 186mm; margin: 0 auto; }
    header { display: flex; justify-content: space-between; gap: 20px; padding-bottom: 10px; border-bottom: 2px solid #17679b; }
    h1 { margin: 0; color: #125d90; font-size: 23pt; line-height: 1.3; }
    p { margin: 2px 0; }
    .brand { font-size: 12pt; font-weight: 700; letter-spacing: .5px; }
    .subtitle, .muted { color: #53697a; font-size: 8pt; }
    .number { text-align: right; font-variant-numeric: tabular-nums; }
    .document-number { font-size: 11pt; font-weight: 700; }
    .customer { display: flex; justify-content: space-between; gap: 16px; margin: 12px 0; padding: 10px 12px; border: 1px solid #c9d8e3; border-left: 3px solid #17679b; }
    .customer-name { font-size: 11pt; font-weight: 700; }
    .customer-count { flex-shrink: 0; text-align: right; align-self: center; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 5px 5px; border-bottom: 1px solid #d6e0e7; vertical-align: top; overflow-wrap: anywhere; }
    th { padding: 7px 5px; color: #254a65; background: #eaf2f7; border-top: 1px solid #abc0cf; border-bottom: 1px solid #abc0cf; text-align: left; font-size: 8pt; }
    thead { display: table-header-group; }
    tbody, tr { break-inside: avoid; page-break-inside: avoid; }
    tbody:nth-of-type(even) { background: #f7f9fb; }
    .center { text-align: center; }
    .amount, .quantity { text-align: right; font-variant-numeric: tabular-nums; }
    .bill-number { font-size: 8.5pt; }
    .bill-date { font-size: 8pt; }
    .amount { white-space: nowrap; font-weight: 700; }
    .closing { break-inside: avoid; page-break-inside: avoid; padding-top: 10px; }
    .summary { margin-left: auto; width: 78mm; }
    .summary-row { display: flex; justify-content: space-between; gap: 10px; padding: 2px 0; }
    .summary-row span:last-child { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .total { margin-top: 5px; padding: 8px 0; border-top: 2px solid #17679b; border-bottom: 1px solid #c9d8e3; font-size: 13pt; font-weight: 700; color: #125d90; }
    .remaining { margin-top: 5px; font-size: 8pt; }
    .notice { margin-top: 10px; color: #53697a; font-size: 8pt; }
    .voided { color: #a52f36; border: 2px solid #a52f36; padding: 5px 10px; font-weight: 700; }
    footer { display: grid; grid-template-columns: 1fr 1fr; gap: 28mm; margin: 28px 12mm 0; text-align: center; }
    .signature { border-top: 1px solid #7f94a3; padding-top: 5px; }
    .signature p { margin: 4px 0; }
    @media screen { body { padding: 24px; background: #edf1f5; } main { padding: 12mm; max-width: 210mm; background: white; box-shadow: 0 2px 16px #18354c18; } }
    @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
  `;
  doc.head.replaceChildren(style);
  doc.documentElement.lang = 'th';
  doc.title = `ใบวางบิล ${statement.statement_number}`;

  // Use textContent throughout: customer and product names are stored user input.
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const node = doc.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const main = element('main');
  const header = element('header');
  const title = element('div');
  title.append(element('p', 'SUPER ICE', 'brand'), element('h1', 'ใบวางบิล'), element('p', 'BILLING STATEMENT', 'subtitle'));
  const number = element('div', undefined, 'number');
  number.append(
    element('p', 'เลขที่ใบวางบิล', 'muted'),
    element('p', statement.statement_number, 'document-number'),
    element('p', `วันที่ออก ${date.format(parseServiceDate(statement.issued_service_date))}`),
  );
  if (statement.status === 'voided') {
    number.append(element('p', `ยกเลิกแล้ว · ${statement.void_reason ?? ''}`, 'voided'));
  }
  header.append(title, number);
  main.append(header);

  const customer = element('section', undefined, 'customer');
  const customerDetails = element('div');
  customerDetails.append(
    element('p', `ลูกค้า / รหัส ${statement.shop_code}`, 'muted'),
    element('p', statement.shop_name, 'customer-name'),
    element('p', `สถานที่: ${statement.shop_location || '—'}`),
  );
  const count = element('div', undefined, 'customer-count');
  count.append(element('p', 'จำนวนบิล', 'muted'), element('strong', `${statement.items.length} บิล`));
  customer.append(customerDetails, count);
  main.append(customer);

  const table = element('table');
  const columns = element('colgroup');
  for (const width of [6, 21, 14, 20, 11, 14, 14]) {
    const column = element('col');
    column.style.width = `${width}%`;
    columns.append(column);
  }
  const thead = element('thead');
  const headerRow = element('tr');
  for (const [label, className] of [
    ['ลำดับ', 'center'], ['เลขที่บิล', ''], ['วันที่บิล / ส่ง', ''],
    ['ชนิดน้ำแข็ง', ''], ['จำนวน', 'quantity'], ['ครบกำหนด', ''], ['ยอดวางบิล', 'amount'],
  ]) {
    const th = element('th', label, className);
    th.scope = 'col';
    headerRow.append(th);
  }
  thead.append(headerRow);
  table.append(columns, thead);
  const chargesById = new Map(charges.map((charge) => [charge.charge_id, charge]));
  for (const [index, item] of statement.items.entries()) {
    const products = chargesById.get(item.charge_id)?.items ?? [];
    const tbody = element('tbody');
    // Keep multiple ice types under one bill, with its amount printed only once.
    for (let productIndex = 0; productIndex < Math.max(products.length, 1); productIndex += 1) {
      const row = element('tr');
      const billCell = (value: string, className?: string) => {
        const td = element('td', value, className);
        td.rowSpan = Math.max(products.length, 1);
        row.append(td);
      };
      if (productIndex === 0) {
        billCell(String(index + 1), 'center');
        billCell(item.charge_number ?? '—', 'bill-number');
        billCell(date.format(parseServiceDate(item.service_date)), 'bill-date');
      }
      const product = products[productIndex];
      row.append(
        element('td', product?.name ?? 'ไม่พบรายละเอียด', product ? undefined : 'muted'),
        element('td', product ? `${quantity.format(Number(product.quantity))} ${product.unit}` : '—', 'quantity'),
      );
      if (productIndex === 0) {
        billCell(date.format(parseServiceDate(item.due_date)), 'bill-date');
        billCell(money.format(Number(item.billed_amount)), 'amount');
      }
      tbody.append(row);
    }
    table.append(tbody);
  }
  main.append(table);

  const closing = element('section', undefined, 'closing');
  const summary = element('div', undefined, 'summary');
  const summaryRow = (label: string, amount: number, className = '') => {
    const row = element('p', undefined, `summary-row ${className}`);
    row.append(element('span', label), element('span', money.format(amount)));
    summary.append(row);
  };
  // Full amounts and prior payments were frozen when the statement was issued.
  if (statement.gross_amount != null) {
    summaryRow('ค่าสินค้าก่อน VAT', Number(statement.subtotal_amount));
    summaryRow('VAT', Number(statement.vat_amount));
    summaryRow('ยอดรวมสุทธิ', Number(statement.gross_amount));
    summaryRow('ชำระก่อนออกใบวางบิล', Number(statement.gross_amount) - Number(statement.total_amount));
  }
  summaryRow('ยอดวางบิลทั้งสิ้น', Number(statement.total_amount), 'total');
  if (statement.gross_amount != null) {
    summaryRow('ชำระหลังออกใบวางบิล', Math.max(Number(statement.total_amount) - Number(statement.outstanding_amount), 0), 'remaining');
    summaryRow('ยอดคงเหลือ', Number(statement.outstanding_amount));
  }
  closing.append(summary, element('p', 'เอกสารนี้เป็นใบวางบิล ไม่ใช่ใบเสร็จรับเงิน', 'notice'));
  const footer = element('footer');
  for (const label of ['ผู้วางบิล', 'ผู้รับวางบิล']) {
    const signature = element('div', undefined, 'signature');
    signature.append(
      element('strong', label),
      element('p', '(........................................................)'),
      element('p', 'วันที่ ............ / ............ / ............', 'muted'),
    );
    footer.append(signature);
  }
  closing.append(footer);
  main.append(closing);

  doc.body.replaceChildren(main);
  printWindow.addEventListener('afterprint', () => printWindow.close(), { once: true });
  printWindow.focus();
  printWindow.print();
  return true;
}
