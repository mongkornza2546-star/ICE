import type { PaymentMethod } from '../types/app';
import type { SalesDocumentItem } from './salesDocumentPrint';

const receiptDateTime = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Asia/Bangkok',
});

export const methodLabels: Record<PaymentMethod, string> = {
  cash: 'เงินสด',
  bank_transfer: 'โอนเงิน',
  qr: 'QR',
};

export const receiptMethodLabels: Record<PaymentMethod, string> = {
  cash: 'เงินสด (Cash)',
  bank_transfer: 'โอนเงิน (Bank Transfer)',
  qr: 'QR',
};

export const receiptReceivedLabels: Record<PaymentMethod, string> = {
  cash: 'รับเงินสด (Cash Received)',
  bank_transfer: 'รับเงินโอน (Bank Transfer Received)',
  qr: 'รับเงิน QR (QR Received)',
};

export function formatReceiptDateTime(value: string) {
  return receiptDateTime.format(new Date(value)).replace(',', '');
}

export function formatReceiptDate(value: string) {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  return receiptDateTime.format(new Date(value)).split(',')[0];
}

export function compactDocumentNumbers(numbers: string[]) {
  if (numbers.length < 2) return numbers;
  const first = /^(.*-)([^-]+)$/.exec(numbers[0]);
  if (!first) return numbers;
  const rest = numbers.slice(1).map((number) => /^(.*-)([^-]+)$/.exec(number));
  if (rest.some((number) => number?.[1] !== first[1])) return numbers;
  return [numbers[0], ...rest.map((number) => number![2])];
}

export function consolidatedReceiptItems(items: SalesDocumentItem[]) {
  const consolidated = new Map<string, SalesDocumentItem>();
  for (const item of items) {
    const key = `${item.name}\u0000${item.unit}`;
    const current = consolidated.get(key);
    if (current) {
      current.quantity += item.quantity;
      current.lineTotal += item.lineTotal;
    } else {
      consolidated.set(key, { ...item });
    }
  }
  return [...consolidated.values()];
}
