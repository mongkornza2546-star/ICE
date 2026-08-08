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
};

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

export function printDailyCreditAcknowledgement(
  payload: DailyCreditAcknowledgementDocument,
  existingPrintWindow?: Window | null,
) {
  const itemCount = payload.invoices.reduce((total, invoice) => total + invoice.items.length, 0);
  const heightMm = Math.max(90, 61 + payload.invoices.length * 8 + itemCount * 5 + payload.item_totals.length * 4);
  const printWindow = existingPrintWindow
    ?? window.open('', '_blank', `popup,width=360,height=${Math.ceil(heightMm * 3.78)}`);
  if (!printWindow) return false;

  const printDocument = printWindow.document;
  const style = printDocument.createElement('style');
  style.textContent = `
    @page { size: 57mm ${heightMm}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { width: 57mm; min-height: ${heightMm}mm; margin: 0; }
    body { padding: 2mm 2.5mm; color: #000; background: #fff; font-family: "Noto Sans Thai", Tahoma, sans-serif; font-size: 7.5pt; line-height: 1.18; }
    main { display: grid; gap: .9mm; }
    h1 { margin: 0; font-size: 10pt; text-align: center; }
    h2 { margin: 0; font-size: 8pt; }
    p { margin: 0; }
    small { font-size: 6.5pt; }
    .center { text-align: center; }
    .invoice, .totals, .grand-total { border-top: .25mm dashed #000; padding-top: .8mm; }
    .invoice-head, .row, .grand-total { display: flex; justify-content: space-between; gap: 1mm; }
    .invoice-head { align-items: baseline; }
    .item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1mm; margin-top: .45mm; }
    .item span:last-child { white-space: nowrap; }
    .grand-total { font-size: 9pt; font-weight: 700; }
    .signature { margin-top: 5mm; display: grid; gap: 4mm; }
    .signature p { padding-top: 1mm; border-top: .25mm solid #000; text-align: center; }
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
  title.textContent = payload.document_title;
  root.append(title);
  line(`ฉบับที่ ${payload.version} · ${payload.service_date}`, 'center');
  line(`${payload.shop_code} · ${payload.shop_name}`);
  if (payload.shop_location) line(payload.shop_location, undefined, 'small');
  line(`สร้างเอกสาร ${dateTime.format(new Date(payload.generated_at))}`, undefined, 'small');

  for (const invoice of payload.invoices) {
    const section = printDocument.createElement('section');
    section.className = 'invoice';
    const heading = printDocument.createElement('div');
    heading.className = 'invoice-head';
    const invoiceTitle = printDocument.createElement('h2');
    invoiceTitle.textContent = `${dateTime.format(new Date(invoice.recorded_at))} · ${invoice.document_number}`;
    const invoiceTotal = printDocument.createElement('strong');
    invoiceTotal.textContent = money.format(Number(invoice.total_amount));
    heading.append(invoiceTitle, invoiceTotal);
    section.append(heading);

    const employee = printDocument.createElement('small');
    employee.textContent = `ผู้ส่ง ${invoice.recorded_by}${invoice.due_date ? ` · ครบกำหนด ${invoice.due_date}` : ''}`;
    section.append(employee);
    for (const item of invoice.items) {
      const row = printDocument.createElement('div');
      row.className = 'item';
      const label = printDocument.createElement('span');
      label.textContent = `${item.ice_type_name} × ${Number(item.quantity)} ${item.ice_type_unit}${item.unit_price == null ? '' : ` @ ${money.format(Number(item.unit_price))}`}`;
      const amount = printDocument.createElement('span');
      amount.textContent = money.format(Number(item.line_total));
      row.append(label, amount);
      section.append(row);
    }
    root.append(section);
  }

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

  const signature = printDocument.createElement('section');
  signature.className = 'signature';
  for (const text of ['ชื่อผู้รับ ____________________', 'ลายเซ็นร้าน ____________________', 'วันที่ / เวลา ____________________']) {
    const field = printDocument.createElement('p');
    field.textContent = text;
    signature.append(field);
  }
  root.append(signature);

  printDocument.body.replaceChildren(root);
  printWindow.addEventListener('afterprint', () => printWindow.close(), { once: true });
  printWindow.focus();
  printWindow.print();
  return true;
}
