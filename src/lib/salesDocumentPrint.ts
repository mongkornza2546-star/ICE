import type { PaymentMethod, PaymentTerm } from '../types/app';

export type SalesDocumentItem = {
  name: string;
  unit: string;
  quantity: number;
  unitPrice: number | null;
  lineTotal: number;
};

export type SalesDocumentAllocation = {
  documentNumber: string | null;
  amount: number;
};

export type SalesDocumentPayload = {
  documentType: 'INV' | 'REC';
  documentNumber: string;
  title: string;
  status: 'active' | 'voided';
  issuedAt: string;
  serviceDate: string | null;
  dueDate?: string | null;
  shop: { code: string; name: string; location: string | null };
  paymentTerm: PaymentTerm | null;
  paymentMethod?: PaymentMethod | null;
  items: SalesDocumentItem[];
  allocations: SalesDocumentAllocation[];
  totals: { total: number; received: number | null; change: number | null };
  voidInfo: { voidedAt: string; reason: string; voidedBy?: string | null } | null;
};

type StoredItem = {
  ice_type_name: string;
  ice_type_unit: string;
  quantity: number | string;
  unit_price?: number | string | null;
  line_total: number | string;
};

type StoredCharge = {
  charge_number: string | null;
  payment_term?: PaymentTerm | null;
  received_amount: number | string;
  items: StoredItem[];
};

export type StoredSalesDocument = {
  document_type: 'INV' | 'REC';
  document_number: string;
  document_title: string;
  status?: 'active' | 'voided';
  issued_at?: string;
  recorded_at?: string;
  service_date?: string | null;
  due_date?: string | null;
  shop_code: string;
  shop_name: string;
  shop_location?: string | null;
  payment_term?: PaymentTerm | null;
  payment_method?: PaymentMethod | null;
  received_amount?: number | string | null;
  allocated_amount?: number | string | null;
  change_amount?: number | string | null;
  total_amount?: number | string | null;
  items?: StoredItem[];
  charges?: StoredCharge[];
  void_info?: { voided_at: string; reason: string; voided_by?: string | null } | null;
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

const methodLabels: Record<PaymentMethod, string> = {
  cash: 'เงินสด',
  bank_transfer: 'โอนเงิน',
  qr: 'QR',
};

export function salesDocumentFromStored(document: StoredSalesDocument): SalesDocumentPayload {
  const charges = document.charges ?? [];
  const storedItems = document.items ?? charges.flatMap((charge) => charge.items);
  return {
    documentType: document.document_type,
    documentNumber: document.document_number,
    title: document.document_title,
    status: document.status ?? 'active',
    issuedAt: document.issued_at ?? document.recorded_at ?? new Date().toISOString(),
    serviceDate: document.service_date ?? null,
    dueDate: document.due_date ?? null,
    shop: {
      code: document.shop_code,
      name: document.shop_name,
      location: document.shop_location ?? null,
    },
    paymentTerm: document.payment_term ?? charges[0]?.payment_term ?? null,
    paymentMethod: document.payment_method ?? null,
    items: storedItems.map((item) => ({
      name: item.ice_type_name,
      unit: item.ice_type_unit,
      quantity: Number(item.quantity),
      unitPrice: item.unit_price == null ? null : Number(item.unit_price),
      lineTotal: Number(item.line_total),
    })),
    allocations: charges.map((charge) => ({
      documentNumber: charge.charge_number,
      amount: Number(charge.received_amount),
    })),
    totals: {
      total: Number(document.total_amount ?? document.allocated_amount ?? 0),
      received: document.received_amount == null ? null : Number(document.received_amount),
      change: document.change_amount == null ? null : Number(document.change_amount),
    },
    voidInfo: document.void_info ? {
      voidedAt: document.void_info.voided_at,
      reason: document.void_info.reason,
      voidedBy: document.void_info.voided_by,
    } : null,
  };
}

export function printSalesDocument(
  payload: SalesDocumentPayload,
  existingPrintWindow?: Window | null,
) {
  const heightMm = Math.min(220, Math.max(58, 48 + payload.items.length * 5
    + payload.allocations.length * 4 + (payload.voidInfo ? 12 : 0)));
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
    main { display: grid; gap: .8mm; }
    h1 { margin: 0; font-size: 10pt; text-align: center; }
    p { margin: 0; }
    .center { text-align: center; }
    .voided { border: .4mm solid #000; padding: 1mm; font-weight: 700; text-align: center; }
    .items, .allocations, .total { border-top: .25mm dashed #000; padding-top: .8mm; }
    .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1mm; }
    .total { display: flex; justify-content: space-between; font-size: 9pt; font-weight: 700; }
    .signature { margin-top: 5mm; padding-top: 1mm; border-top: .25mm solid #000; text-align: center; }
    small { font-size: 6.5pt; }
  `;
  printDocument.head.replaceChildren(style);

  const root = printDocument.createElement('main');
  const line = (text: string, className?: string, tag: 'p' | 'small' = 'p') => {
    const element = printDocument.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    root.append(element);
  };
  const heading = printDocument.createElement('h1');
  heading.textContent = payload.title;
  root.append(heading);
  line(payload.documentNumber, 'center');
  if (payload.status === 'voided') {
    line(`ยกเลิก · ${payload.voidInfo?.reason ?? 'ไม่ระบุเหตุผล'}`, 'voided');
  }
  line(`${payload.shop.code} · ${payload.shop.name}`);
  if (payload.shop.location) line(payload.shop.location, undefined, 'small');
  line(`ออกเอกสาร ${dateTime.format(new Date(payload.issuedAt))}`, undefined, 'small');
  if (payload.serviceDate) line(`วันที่ส่ง ${payload.serviceDate}`, undefined, 'small');
  if (payload.dueDate) line(`ครบกำหนด ${payload.dueDate}`, undefined, 'small');
  if (payload.paymentMethod) line(`วิธีชำระ ${methodLabels[payload.paymentMethod]}`, undefined, 'small');

  const items = printDocument.createElement('section');
  items.className = 'items';
  for (const item of payload.items) {
    const row = printDocument.createElement('div');
    row.className = 'row';
    const label = printDocument.createElement('span');
    label.textContent = `${item.name} × ${item.quantity} ${item.unit}${item.unitPrice == null ? '' : ` @ ${money.format(item.unitPrice)}`}`;
    const amount = printDocument.createElement('span');
    amount.textContent = money.format(item.lineTotal);
    row.append(label, amount);
    items.append(row);
  }
  root.append(items);

  const visibleAllocations = payload.allocations.filter((allocation) => allocation.documentNumber);
  if (visibleAllocations.length > 0) {
    const allocationSection = printDocument.createElement('section');
    allocationSection.className = 'allocations';
    for (const allocation of visibleAllocations) {
      const row = printDocument.createElement('div');
      row.className = 'row';
      const number = printDocument.createElement('span');
      number.textContent = `รายการสั่งซื้อ ${allocation.documentNumber!}`;
      const amount = printDocument.createElement('span');
      amount.textContent = money.format(allocation.amount);
      row.append(number, amount);
      allocationSection.append(row);
    }
    root.append(allocationSection);
  }

  const total = printDocument.createElement('div');
  total.className = 'total';
  const totalLabel = printDocument.createElement('span');
  totalLabel.textContent = payload.documentType === 'REC' ? 'ยอดชำระ' : 'ยอดรวม';
  const totalAmount = printDocument.createElement('span');
  totalAmount.textContent = money.format(payload.totals.total);
  total.append(totalLabel, totalAmount);
  root.append(total);
  if (payload.totals.received != null) {
    line(`รับเงิน ${money.format(payload.totals.received)}${
      payload.totals.change != null && payload.totals.change > 0
        ? ` · เงินทอน ${money.format(payload.totals.change)}`
        : ''
    }`, undefined, 'small');
  }
  if (payload.voidInfo) {
    line(`ยกเลิกเมื่อ ${dateTime.format(new Date(payload.voidInfo.voidedAt))}${payload.voidInfo.voidedBy ? ` · ${payload.voidInfo.voidedBy}` : ''}`, undefined, 'small');
  }
  if (payload.documentType === 'INV') line('ลายเซ็นผู้รับสินค้า ____________________', 'signature');

  printDocument.body.replaceChildren(root);
  printWindow.addEventListener('afterprint', () => printWindow.close(), { once: true });
  printWindow.focus();
  printWindow.print();
  return true;
}
