import type { Row } from 'read-excel-file';

export interface ShopImportRow {
  building_code: string;
  building_name: string;
  zone_code: string;
  zone_name: string;
  zone_sort_order: number;
  shop_code: string;
  government_shop_code: string;
  shop_name: string;
  contact_name: string;
  contact_phone: string;
  normal_rounds_per_day: number;
  access_note: string;
  status: 'active' | 'inactive';
}

const HEADERS = [
  'รหัสตึก', 'ชื่อตึก', 'รหัสโซน', 'ชื่อโซนย่อย', 'ลำดับโซน', 'รหัสร้าน', 'รหัสศูนย์ราชการ',
  'ชื่อร้าน', 'ผู้ติดต่อ', 'เบอร์โทร', 'รอบปกติต่อวัน', 'หมายเหตุการเข้าถึง', 'สถานะ',
] as const;

const REQUIRED_TEXT_COLUMNS = [0, 1, 2, 3, 5, 7] as const;

export async function parseShopImportFile(file: File): Promise<ShopImportRow[]> {
  const { default: readXlsxFile } = await import('read-excel-file');
  const rows: Row[] = await readXlsxFile(file);
  if (rows.length === 0) throw new Error('ไฟล์ไม่มีข้อมูล');

  const headerIndex = rows.findIndex((cells) => {
    const values = cells.map(toText);
    return HEADERS.every((name) => values.includes(name));
  });
  if (headerIndex < 0) throw new Error('ไม่พบหัวตาราง กรุณาใช้ไฟล์แม่แบบของระบบ');

  const header = rows[headerIndex].map(toText);
  const missingHeaders = HEADERS.filter((name) => !header.includes(name));
  if (missingHeaders.length > 0) {
    throw new Error(`หัวตารางไม่ตรงกับแม่แบบ: ขาด ${missingHeaders.join(', ')}`);
  }

  const column = Object.fromEntries(HEADERS.map((name) => [name, header.indexOf(name)]));
  const parsed: ShopImportRow[] = [];
  const shopCodes = new Set<string>();
  const errors: string[] = [];

  rows.slice(headerIndex + 1).forEach((cells, index) => {
    const rowNumber = headerIndex + index + 2;
    if (cells.every((cell) => toText(cell) === '')) return;

    for (const position of REQUIRED_TEXT_COLUMNS) {
      const name = HEADERS[position];
      if (!toText(cells[column[name]])) errors.push(`แถว ${rowNumber}: กรุณากรอก ${name}`);
    }

    const zoneSortOrder = toPositiveInteger(cells[column['ลำดับโซน']]);
    const normalRounds = toPositiveInteger(cells[column['รอบปกติต่อวัน']]);
    if (!zoneSortOrder) errors.push(`แถว ${rowNumber}: ลำดับโซนต้องเป็นจำนวนเต็มตั้งแต่ 1`);
    if (!normalRounds) errors.push(`แถว ${rowNumber}: รอบปกติต่อวันต้องเป็นจำนวนเต็มตั้งแต่ 1`);

    const shopCode = toCode(cells[column['รหัสร้าน']]);
    const normalizedShopCode = shopCode;
    if (normalizedShopCode && shopCodes.has(normalizedShopCode)) {
      errors.push(`แถว ${rowNumber}: รหัสร้าน ${shopCode} ซ้ำในไฟล์`);
    }
    shopCodes.add(normalizedShopCode);

    const rawStatus = toText(cells[column['สถานะ']]).toLocaleLowerCase('th') || 'active';
    const status = rawStatus === 'active' || rawStatus === 'ใช้งาน'
      ? 'active'
      : rawStatus === 'inactive' || rawStatus === 'พักใช้งาน'
        ? 'inactive'
        : null;
    if (!status) errors.push(`แถว ${rowNumber}: สถานะต้องเป็น ใช้งาน หรือ พักใช้งาน`);

    parsed.push({
      building_code: toCode(cells[column['รหัสตึก']]),
      building_name: toText(cells[column['ชื่อตึก']]),
      zone_code: toCode(cells[column['รหัสโซน']]),
      zone_name: toText(cells[column['ชื่อโซนย่อย']]),
      zone_sort_order: zoneSortOrder || 0,
      shop_code: shopCode,
      government_shop_code: toText(cells[column['รหัสศูนย์ราชการ']]),
      shop_name: toText(cells[column['ชื่อร้าน']]),
      contact_name: toText(cells[column['ผู้ติดต่อ']]),
      contact_phone: toText(cells[column['เบอร์โทร']]),
      normal_rounds_per_day: normalRounds || 0,
      access_note: toText(cells[column['หมายเหตุการเข้าถึง']]),
      status: status ?? 'active',
    });
  });

  if (parsed.length === 0) throw new Error('ไม่พบรายการร้านค้าในไฟล์');
  if (parsed.length > 1000) errors.push('นำเข้าได้สูงสุดครั้งละ 1,000 ร้าน');
  if (errors.length > 0) throw new Error(errors.slice(0, 8).join('\n'));
  return parsed;
}

function toText(value: unknown) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toCode(value: unknown) {
  return toText(value).toLocaleUpperCase('en');
}

function toPositiveInteger(value: unknown) {
  const number = typeof value === 'number' ? value : Number(toText(value));
  return Number.isInteger(number) && number > 0 ? number : null;
}
