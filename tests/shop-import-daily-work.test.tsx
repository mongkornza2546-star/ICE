import { beforeEach, expect, it, vi } from 'vitest';
import { parseShopImportFile } from '../src/lib/shopImport';

const { readRows } = vi.hoisted(() => ({ readRows: vi.fn() }));
vi.mock('read-excel-file', () => ({ default: readRows }));

const headers = ['รหัสตึก', 'ชื่อตึก', 'รหัสโซน', 'ชื่อโซนย่อย', 'ลำดับโซน', 'รหัสร้าน', 'รหัสล็อก/พื้นที่ขาย', 'ชื่อร้าน', 'ผู้ติดต่อ', 'เบอร์โทร', 'จำนวนครั้งที่ส่งต่อวัน', 'หมายเหตุการเข้าถึง', 'สถานะ'];
const row = ['A', 'อาคาร A', 'Z', 'โซน Z', 1, 'A01', 'S01', 'ร้านหนึ่ง', '', '', 2, '', 'ใช้งาน'];
beforeEach(() => readRows.mockReset());

it.each(['จำนวนครั้งที่ส่งต่อวัน', 'รอบปกติต่อวัน'])('imports the delivery count using %s', async (header) => {
  readRows.mockResolvedValue([headers.map((name) => name === 'จำนวนครั้งที่ส่งต่อวัน' ? header : name), row]);
  const result = await parseShopImportFile(new File([], 'shops.xlsx'));
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ shop_code: 'A01', normal_rounds_per_day: 2 });
});

it('rejects conflicting old and new delivery count columns', async () => {
  readRows.mockResolvedValue([[...headers, 'รอบปกติต่อวัน'], [...row, 3]]);
  await expect(parseShopImportFile(new File([], 'shops.xlsx'))).rejects.toThrow('พบคอลัมน์จำนวนครั้งที่ส่งต่อวันซ้ำ');
});
