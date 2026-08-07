import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseShopImportFile } from '../src/lib/shopImport';

const mocks = vi.hoisted(() => ({ readXlsxFile: vi.fn() }));

vi.mock('read-excel-file', () => ({ default: mocks.readXlsxFile }));

const NEW_STALL_HEADER = 'รหัสล็อก/พื้นที่ขาย';
const LEGACY_STALL_HEADER = 'รหัสศูนย์ราชการ';
const baseHeaders = [
  'รหัสตึก', 'ชื่อตึก', 'รหัสโซน', 'ชื่อโซนย่อย', 'ลำดับโซน', 'รหัสร้าน', NEW_STALL_HEADER,
  'ชื่อร้าน', 'ผู้ติดต่อ', 'เบอร์โทร', 'รอบปกติต่อวัน', 'หมายเหตุการเข้าถึง', 'สถานะ',
];

function row({
  shopCode,
  stallCode,
  status = 'ใช้งาน',
}: {
  shopCode: string;
  stallCode: string;
  status?: string;
}) {
  return ['BB', 'อาคาร B', 'DOME-1', 'ซุ้มโดม 1', 1, shopCode, stallCode, `ร้าน ${shopCode}`, '', '', 1, '', status];
}

describe('shop import parser stall codes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['หัวคอลัมน์ใหม่', NEW_STALL_HEADER],
    ['หัวคอลัมน์เดิม', LEGACY_STALL_HEADER],
  ])('accepts %s', async (_label, stallHeader) => {
    const headers = baseHeaders.map((header) => header === NEW_STALL_HEADER ? stallHeader : header);
    mocks.readXlsxFile.mockResolvedValue([headers, row({ shopCode: 'BB27', stallCode: 'BMFD-0309' })]);

    const parsed = await parseShopImportFile(new File(['xlsx'], 'shops.xlsx'));

    expect(parsed).toHaveLength(1);
    expect(parsed[0].government_shop_code).toBe('BMFD-0309');
  });

  it('rejects a workbook containing both stall header names', async () => {
    mocks.readXlsxFile.mockResolvedValue([
      [...baseHeaders, LEGACY_STALL_HEADER],
      [...row({ shopCode: 'BB27', stallCode: 'BMFD-0309' }), 'BMFD-0310'],
    ]);

    await expect(parseShopImportFile(new File(['xlsx'], 'shops.xlsx')))
      .rejects.toThrow(`พบทั้งหัวคอลัมน์ ${NEW_STALL_HEADER} และ ${LEGACY_STALL_HEADER}`);
  });

  it('rejects normalized duplicate active stalls with row numbers', async () => {
    mocks.readXlsxFile.mockResolvedValue([
      baseHeaders,
      row({ shopCode: 'BB27', stallCode: ' BMFD-0309 ' }),
      row({ shopCode: 'BB28', stallCode: 'bmfd-0309' }),
    ]);

    await expect(parseShopImportFile(new File(['xlsx'], 'shops.xlsx')))
      .rejects.toThrow('แถว 3: รหัสล็อก/พื้นที่ขาย bmfd-0309 ซ้ำกับแถว 2 ในไฟล์');
  });

  it('allows an active shop and inactive history to share a stall', async () => {
    mocks.readXlsxFile.mockResolvedValue([
      baseHeaders,
      row({ shopCode: 'BB27', stallCode: 'BMFD-0309', status: 'พักใช้งาน' }),
      row({ shopCode: 'BB28', stallCode: ' bmfd-0309 ', status: 'ใช้งาน' }),
    ]);

    const parsed = await parseShopImportFile(new File(['xlsx'], 'shops.xlsx'));
    expect(parsed.map((item) => item.status)).toEqual(['inactive', 'active']);
  });
});
