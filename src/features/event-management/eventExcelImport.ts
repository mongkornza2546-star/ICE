import type { EventJob, EventNewShopInput } from './types';

export interface EventExcelRow {
  rowNumber: number;
  input: EventNewShopInput;
  tankCount: number | null;
}

const text = (value: unknown) => value == null ? '' : String(value).trim();

export function parseEventExcelRows(rows: unknown[][], event: Pick<EventJob, 'start_date' | 'end_date'>): EventExcelRow[] {
  const headers = (rows[0] ?? []).map(text);
  const column = (...names: string[]) => headers.findIndex((header) => names.includes(header));
  const booth = column('เลขที่บูธ', 'เลขบูธ', 'บูธ', 'booth_number');
  const name = column('ชื่อร้านค้า', 'ชื่อร้าน', 'name');
  const tanks = column('ถังน้ำแข็ง', 'จำนวนถัง', 'จำนวนถังน้ำแข็ง');
  if (booth < 0 || name < 0) throw new Error('แถวแรกต้องมีคอลัมน์ เลขที่บูธ และ ชื่อร้านค้า');
  const seen = new Map<string, number>();
  const errors: string[] = [];
  const result: EventExcelRow[] = [];
  rows.slice(1).forEach((cells, index) => {
    if (cells.every((cell) => !text(cell))) return;
    const rowNumber = index + 2;
    const boothNumber = text(cells[booth]).toUpperCase();
    const shopName = text(cells[name]);
    const zone = text(cells[column('โซน', 'event_zone')]);
    const tankText = text(cells[tanks]);
    const tankCount = tankText ? Number(tankText) : null;
    if (!boothNumber || !shopName) errors.push(`แถว ${rowNumber}: ต้องระบุเลขบูธและชื่อร้าน`);
    if (tankCount !== null && (!Number.isSafeInteger(tankCount) || tankCount < 0)) errors.push(`แถว ${rowNumber}: จำนวนถังต้องเป็นจำนวนเต็มตั้งแต่ 0`);
    const key = JSON.stringify([zone.toUpperCase(), boothNumber]);
    if (seen.has(key)) errors.push(`แถว ${rowNumber}: บูธ ${boothNumber} ซ้ำกับแถว ${seen.get(key)}`);
    seen.set(key, rowNumber);
    const note = text(cells[column('หมายเหตุ', 'จุดสังเกต', 'landmark')]);
    result.push({ rowNumber, tankCount, input: {
      name: shopName,
      booth_number: boothNumber,
      event_zone: zone,
      landmark: [note, tankCount === null ? '' : `ถังน้ำแข็ง ${tankCount} ถัง (จาก Excel)`].filter(Boolean).join(' · '),
      contact_name: text(cells[column('ผู้ติดต่อ', 'contact_name')]),
      contact_phone: text(cells[column('เบอร์โทร', 'contact_phone')]),
      start_date: event.start_date,
      end_date: event.end_date,
    } });
  });
  if (!result.length) throw new Error('ไม่พบรายการร้านค้าในไฟล์');
  if (result.length > 1000) errors.push('นำเข้าได้สูงสุดครั้งละ 1,000 ร้าน');
  if (errors.length) throw new Error(errors.slice(0, 8).join('\n'));
  return result;
}

export async function readEventExcel(file: File, event: Pick<EventJob, 'start_date' | 'end_date'>) {
  if (!/\.xlsx$/i.test(file.name)) throw new Error('กรุณาเลือกไฟล์ Excel นามสกุล .xlsx');
  if (file.size > 10 * 1024 * 1024) throw new Error('ไฟล์ต้องมีขนาดไม่เกิน 10 MB');
  const { default: readXlsxFile } = await import('read-excel-file');
  let rows;
  try {
    rows = await readXlsxFile(file);
  } catch {
    throw new Error('อ่านไฟล์ Excel ไม่สำเร็จ กรุณาตรวจสอบว่าเป็นไฟล์ .xlsx ที่เปิดได้');
  }
  return parseEventExcelRows(rows, event);
}
