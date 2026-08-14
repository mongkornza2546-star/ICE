import type { AccountingShopDailyResponse, AccountingShopSummaryRow, AccountingTransaction } from './types';

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

function truncateSheetName(value: string, maxLength: number) {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > maxLength) break;
    result += character;
  }
  return result;
}

function safeSheetName(value: string, used: Set<string>) {
  const sanitized = value.replace(/[\\/?*:[\]&<>"'\u0000-\u001F]/g, '-').trim();
  const base = truncateSheetName(sanitized, 31) || 'พื้นที่';
  let name = base;
  let suffix = 2;
  while (used.has(name.toLowerCase())) {
    const label = `-${suffix}`;
    name = `${truncateSheetName(base, 31 - label.length)}${label}`;
    suffix += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function exportAccountingShopDaily(
  shops: AccountingShopSummaryRow[],
  daily: AccountingShopDailyResponse,
  fromDate: string,
  toDate: string,
) {
  const { default: writeXlsxFile } = await import('write-excel-file');
  const dailyRows = new Map(daily.rows.map((row) => [row.shop_id, row]));
  const iceTypes = [...daily.ice_types].sort((left, right) => compareText(left.code, right.code)
    || compareText(left.name, right.name)
    || compareText(left.ice_type_id, right.ice_type_id));
  const dates: string[] = [];
  for (let date = fromDate; date <= toDate;) {
    dates.push(date);
    const next = new Date(`${date}T12:00:00+07:00`);
    next.setDate(next.getDate() + 1);
    date = next.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  }
  const statusLabels = {
    purchased: 'ซื้อแล้ว', no_purchase: 'ไม่ซื้อ', closed_shop: 'ปิดร้าน',
    recorded_no_sale: 'มีบันทึกแต่ไม่มีการขาย', not_recorded: 'ยังไม่บันทึก',
    not_scheduled: 'ไม่อยู่ในรอบ', skipped: 'ข้ามร้าน',
  } as const;
  const unavailableLabel = 'ไม่มีข้อมูล';
  const headerStyle = { fontWeight: 'bold' as const, backgroundColor: '#DCE9E3', align: 'center' as const, wrap: true, borderStyle: 'thin' as const, borderColor: '#B7C9C0' };
  const bodyBorder = { borderStyle: 'thin' as const, borderColor: '#DCE5E0' };
  const textCell = (value: unknown, wrap = false) => ({ value: safeSpreadsheetText(value), type: String, wrap, ...bodyBorder });
  const numberCell = (value: number, format: string) => ({ value, type: Number, format, ...bodyBorder });
  const totalStyle = { fontWeight: 'bold' as const, backgroundColor: '#EAF3EE', ...bodyBorder };
  const totalTextCell = (value: unknown) => ({ value: safeSpreadsheetText(value), type: String, ...totalStyle });
  const totalNumberCell = (value: number, format: string) => ({ value, type: Number, format, ...totalStyle });
  const headings = [
    'ลำดับส่ง', 'รหัสร้าน', 'ชื่อร้าน', 'เงื่อนไขชำระ',
    ...dates.flatMap((date) => [
      ...iceTypes.map((iceType) => `${date} · ${iceType.name}`),
      `${date} · ยอดขาย`, `${date} · รับเงินจริง`,
    ]),
    'ยอดขายรวม', 'รับเงินจริงรวม', 'ค้างวันนี้', 'ค้างสะสม', 'เกินกำหนด', 'สถานะชำระ', 'หมายเหตุ',
  ];
  const paymentStatusLabels = { paid: 'ชำระครบ', outstanding: 'รอชำระ', overdue: 'เกินกำหนด' } as const;

  const buildSheet = (rows: AccountingShopSummaryRow[], title: string) => {
    const rowContexts = rows.map((shop) => {
      const dailyRow = dailyRows.get(shop.shop_id);
      const days = new Map((dailyRow?.days ?? []).map((day) => [day.service_date, day]));
      return { shop, dailyRow, days, hasCompleteDays: dates.every((date) => days.has(date)) };
    });
    const body = rowContexts.map(({ shop, dailyRow, days, hasCompleteDays }) => {
      const cashReceived = hasCompleteDays
        ? dates.reduce((sum, date) => sum + Number(days.get(date)?.cash_received ?? 0), 0)
        : null;
      const cells = [
        shop.delivery_sequence == null ? textCell('') : numberCell(shop.delivery_sequence, '#,##0'),
        textCell(shop.shop_code), textCell(shop.shop_name, true), textCell(dailyRow?.payment_condition ?? unavailableLabel),
      ];
      dates.forEach((date) => {
        const day = days.get(date);
        if (!day) {
          iceTypes.forEach((_, index) => cells.push(textCell(index === 0 ? unavailableLabel : '—')));
          cells.push(textCell(unavailableLabel), textCell(unavailableLabel));
          return;
        }
        iceTypes.forEach((iceType, index) => {
          const quantity = Number(day.items.find((item) => item.ice_type_id === iceType.ice_type_id)?.quantity ?? 0);
          if (day.status !== 'purchased' && index === 0) {
            cells.push(textCell(statusLabels[day.status]));
          } else {
            cells.push(quantity ? numberCell(quantity, '#,##0.0') : textCell('—'));
          }
        });
        cells.push(numberCell(Number(day.sales_amount), '#,##0.00'));
        cells.push(numberCell(Number(day.cash_received), '#,##0.00'));
      });
      const note = shop.delivery_sequence == null ? 'ยังไม่ได้กำหนดลำดับส่ง'
        : shop.historical_zone_name && shop.current_zone_name && shop.historical_zone_name !== shop.current_zone_name
          ? 'พื้นที่ล่าสุดต่างจากพื้นที่ประจำ' : '';
      cells.push(numberCell(Number(shop.sales_amount), '#,##0.00'));
      cells.push(cashReceived == null ? textCell(unavailableLabel) : numberCell(cashReceived, '#,##0.00'));
      cells.push(numberCell(Number(shop.outstanding_amount), '#,##0.00'));
      cells.push(numberCell(Number(shop.cumulative_outstanding_amount), '#,##0.00'));
      cells.push(numberCell(Number(shop.cumulative_overdue_amount), '#,##0.00'));
      cells.push(textCell(paymentStatusLabels[shop.payment_status]));
      cells.push(textCell(note, true));
      return cells;
    });
    const salesTotal = rowContexts.reduce((sum, { shop }) => sum + Number(shop.sales_amount), 0);
    const cashTotal = rowContexts.every(({ hasCompleteDays }) => hasCompleteDays)
      ? rowContexts.reduce((sum, { days }) => sum
        + dates.reduce((daySum, date) => daySum + Number(days.get(date)?.cash_received ?? 0), 0), 0)
      : null;
    const titleRow = [{ value: safeSpreadsheetText(title), type: String, fontWeight: 'bold' as const, fontSize: 15, color: '#173F32', span: headings.length }];
    const periodRow = [{ value: `ช่วงวันที่ ${fromDate} ถึง ${toDate}`, color: '#526B61', span: headings.length }];
    const totalsRow: Array<ReturnType<typeof totalTextCell> | ReturnType<typeof totalNumberCell>> = [
      totalTextCell('รวม'), totalTextCell(''), totalTextCell(''), totalTextCell(''),
    ];
    dates.forEach((date) => {
      if (!rowContexts.every(({ days }) => days.has(date))) {
        iceTypes.forEach(() => totalsRow.push(totalTextCell(unavailableLabel)));
        totalsRow.push(totalTextCell(unavailableLabel), totalTextCell(unavailableLabel));
        return;
      }
      iceTypes.forEach((iceType) => {
        const quantity = rowContexts.reduce((sum, { days }) => sum
          + Number(days.get(date)?.items.find((item) => item.ice_type_id === iceType.ice_type_id)?.quantity ?? 0), 0);
        totalsRow.push(totalNumberCell(quantity, '#,##0.0'));
      });
      totalsRow.push(totalNumberCell(rowContexts.reduce((sum, { days }) => sum + Number(days.get(date)?.sales_amount ?? 0), 0), '#,##0.00'));
      totalsRow.push(totalNumberCell(rowContexts.reduce((sum, { days }) => sum + Number(days.get(date)?.cash_received ?? 0), 0), '#,##0.00'));
    });
    totalsRow.push(totalNumberCell(salesTotal, '#,##0.00'));
    totalsRow.push(cashTotal == null ? totalTextCell(unavailableLabel) : totalNumberCell(cashTotal, '#,##0.00'));
    totalsRow.push(totalNumberCell(rowContexts.reduce((sum, { shop }) => sum + Number(shop.outstanding_amount), 0), '#,##0.00'));
    totalsRow.push(totalNumberCell(rowContexts.reduce((sum, { shop }) => sum + Number(shop.cumulative_outstanding_amount), 0), '#,##0.00'));
    totalsRow.push(totalNumberCell(rowContexts.reduce((sum, { shop }) => sum + Number(shop.cumulative_overdue_amount), 0), '#,##0.00'));
    totalsRow.push(totalTextCell(''), totalTextCell(''));
    return [titleRow, periodRow, headings.map((value) => ({ value, ...headerStyle })), ...body, totalsRow];
  };

  const groups = new Map<string, {
    buildingSortOrder: number;
    zoneSortOrder: number;
    title: string;
    rows: AccountingShopSummaryRow[];
  }>();
  shops.forEach((shop) => {
    const key = `${shop.building_id}:${shop.current_zone_id ?? 'none'}`;
    const group = groups.get(key);
    if (group) {
      group.rows.push(shop);
    } else {
      groups.set(key, {
        buildingSortOrder: shop.building_sort_order ?? Number.MAX_SAFE_INTEGER,
        zoneSortOrder: shop.zone_sort_order ?? Number.MAX_SAFE_INTEGER,
        title: `${shop.building_name}-${shop.current_zone_name ?? 'ไม่มีโซน'}`,
        rows: [shop],
      });
    }
  });
  const orderedGroups = [...groups.entries()].sort(([leftKey, left], [rightKey, right]) => left.buildingSortOrder - right.buildingSortOrder
    || left.zoneSortOrder - right.zoneSortOrder
    || compareText(left.title, right.title)
    || compareText(leftKey, rightKey)).map(([, group]) => group);
  const usedNames = new Set<string>(['สรุปทุกพื้นที่'.toLowerCase()]);
  const sheets = ['สรุปทุกพื้นที่', ...orderedGroups.map((group) => safeSheetName(group.title, usedNames))];
  const data = [
    buildSheet(shops, 'สรุปรายร้านทุกพื้นที่'),
    ...orderedGroups.map((group) => buildSheet(group.rows, group.title)),
  ];
  const columnWidths = headings.map((_, index) => ({ width: index === 2 ? 28 : index === 3 || index === headings.length - 1 ? 20 : index < 4 ? 12 : 15 }));
  await writeXlsxFile(data, {
    columns: data.map(() => columnWidths),
    fileName: `accounting-daily-${fromDate}-${toDate}.xlsx`,
    sheets,
    stickyColumnsCount: 4,
    stickyRowsCount: 3,
  });
}
