import type { BillingStatement } from '../features/financial-operations/types';

const money = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 2,
});

const date = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });

function parseServiceDate(value: string) {
  return new Date(`${value}T12:00:00+07:00`);
}

export function printBillingStatement(statement: BillingStatement, existingPrintWindow?: Window | null) {
  const printWindow = existingPrintWindow ?? window.open('', '_blank', 'popup,width=900,height=720');
  if (!printWindow) return false;
  const doc = printWindow.document;
  const style = doc.createElement('style');
  style.textContent = `
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #172f48; font-family: "Noto Sans Thai", Tahoma, sans-serif; font-size: 11pt; }
    header { display: flex; justify-content: space-between; gap: 20px; padding-bottom: 14px; border-bottom: 2px solid #1269b8; }
    h1 { margin: 0 0 4px; color: #0b5da7; font-size: 22pt; }
    p { margin: 2px 0; }
    .number { text-align: right; }
    .customer { margin: 18px 0; padding: 12px; border: 1px solid #ccdae6; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 9px 8px; border: 1px solid #ccd9e4; text-align: left; }
    th { color: #264b6d; background: #eff6fb; }
    td:nth-child(4), th:nth-child(4) { text-align: right; }
    .total { display: flex; justify-content: flex-end; gap: 28px; margin-top: 14px; font-size: 14pt; font-weight: 800; }
    .notice { margin-top: 18px; padding: 9px; color: #6a4d08; background: #fff7df; }
    .voided { color: #a52f36; border: 2px solid #a52f36; padding: 5px 10px; font-weight: 800; }
    footer { display: grid; grid-template-columns: 1fr 1fr; gap: 50px; margin-top: 46px; text-align: center; }
    footer span { padding-top: 9px; border-top: 1px solid #526b80; }
  `;
  doc.head.replaceChildren(style);

  const main = doc.createElement('main');
  const header = doc.createElement('header');
  const title = doc.createElement('div');
  const heading = doc.createElement('h1');
  heading.textContent = 'ใบวางบิล';
  const supplier = doc.createElement('p');
  supplier.textContent = 'Super Ice';
  title.append(heading, supplier);
  const number = doc.createElement('div');
  number.className = 'number';
  const numberLine = doc.createElement('p');
  numberLine.textContent = `เลขที่ ${statement.statement_number}`;
  const issuedLine = doc.createElement('p');
  issuedLine.textContent = `วันที่ออก ${date.format(parseServiceDate(statement.issued_service_date))}`;
  number.append(numberLine, issuedLine);
  if (statement.status === 'voided') {
    const voided = doc.createElement('p');
    voided.className = 'voided';
    voided.textContent = `ยกเลิกแล้ว · ${statement.void_reason ?? ''}`;
    number.append(voided);
  }
  header.append(title, number);
  main.append(header);

  const customer = doc.createElement('section');
  customer.className = 'customer';
  const customerName = doc.createElement('p');
  customerName.textContent = `ลูกค้า: ${statement.shop_code} · ${statement.shop_name}`;
  const location = doc.createElement('p');
  location.textContent = `สถานที่: ${statement.shop_location || '—'}`;
  customer.append(customerName, location);
  main.append(customer);

  const table = doc.createElement('table');
  const thead = doc.createElement('thead');
  const headerRow = doc.createElement('tr');
  for (const label of ['เลขที่บิล', 'วันที่ส่ง', 'ครบกำหนด', 'ยอดวางบิล']) {
    const th = doc.createElement('th');
    th.textContent = label;
    headerRow.append(th);
  }
  thead.append(headerRow);
  const tbody = doc.createElement('tbody');
  for (const item of statement.items) {
    const row = doc.createElement('tr');
    for (const value of [
      item.charge_number ?? '—',
      date.format(parseServiceDate(item.service_date)),
      date.format(parseServiceDate(item.due_date)),
      money.format(Number(item.billed_amount)),
    ]) {
      const td = doc.createElement('td');
      td.textContent = value;
      row.append(td);
    }
    tbody.append(row);
  }
  table.append(thead, tbody);
  main.append(table);

  const total = doc.createElement('div');
  total.className = 'total';
  const totalLabel = doc.createElement('span');
  totalLabel.textContent = 'ยอดรวม';
  const totalAmount = doc.createElement('span');
  totalAmount.textContent = money.format(Number(statement.total_amount));
  total.append(totalLabel, totalAmount);
  main.append(total);

  const notice = doc.createElement('p');
  notice.className = 'notice';
  notice.textContent = 'เอกสารนี้เป็นใบวางบิล ไม่ใช่ใบเสร็จรับเงิน';
  main.append(notice);
  const footer = doc.createElement('footer');
  const issuer = doc.createElement('span');
  issuer.textContent = 'ผู้วางบิล';
  const receiver = doc.createElement('span');
  receiver.textContent = 'ผู้รับวางบิล';
  footer.append(issuer, receiver);
  main.append(footer);

  doc.body.replaceChildren(main);
  printWindow.addEventListener('afterprint', () => printWindow.close(), { once: true });
  printWindow.focus();
  printWindow.print();
  return true;
}
