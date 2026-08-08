import type { AccountingTransaction } from './types';

export function safeSpreadsheetText(value: unknown) {
  const text = value == null ? '' : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export async function exportAccountingTransactions(
  rows: AccountingTransaction[],
  fromDate: string,
  toDate: string,
) {
  const { default: writeXlsxFile } = await import('write-excel-file');
  const headings = [
    'วันที่', 'เวลา', 'เอกสาร', 'ประเภท', 'ร้าน', 'จุดถือครอง', 'พนักงาน', 'ชนิดน้ำแข็ง',
    'รับเข้า', 'จ่ายออก', 'ยอดขาย', 'เงินเข้า', 'เงินออก', 'ลูกหนี้เปลี่ยน', 'สถานะ', 'หมายเหตุ',
    'Source table', 'Source ID', 'Group ID', 'Delivery event ID', 'Payment ID', 'เลขอ้างอิง',
  ];
  const data = [
    headings.map((value) => ({ value, fontWeight: 'bold' as const, backgroundColor: '#DCE9E3' })),
    ...rows.map((row) => {
      const occurredAt = new Date(row.occurred_at);
      const values: Array<string | number> = [
        row.service_date,
        Number.isNaN(occurredAt.getTime()) ? '' : occurredAt.toLocaleTimeString('th-TH'),
        row.document_number,
        row.type,
        [row.shop_code, row.shop_name].filter(Boolean).join(' '),
        row.holder_name ?? '',
        row.employee_name ?? '',
        row.ice_type_name ?? '',
        Number(row.quantity_in), Number(row.quantity_out), Number(row.sales_amount),
        Number(row.cash_in), Number(row.cash_out), Number(row.receivable_delta),
        row.status, row.note ?? '', row.source_table, row.source_id, row.group_id,
        row.delivery_event_id ?? '', row.payment_id ?? '', row.reference_number ?? '',
      ];
      return values.map((value) => typeof value === 'number'
        ? { value, type: Number }
        : { value: safeSpreadsheetText(value), type: String });
    }),
  ];
  await writeXlsxFile(data, {
    columns: headings.map((_, index) => ({ width: index < 8 ? 18 : 14 })),
    fileName: `accounting-${fromDate}-${toDate}.xlsx`,
  });
}
