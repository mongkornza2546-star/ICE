import assert from 'node:assert/strict';
import test from 'node:test';
import readXlsxFile from 'read-excel-file/node';

const templatePath = new URL('../public/templates/shop-import-template.xlsx', import.meta.url);

test('shop import template uses the stall label and documents active-stall conflicts', async () => {
  const shopRows = await readXlsxFile(templatePath, { sheet: 1 });
  const instructionRows = await readXlsxFile(templatePath, { sheet: 2 });

  assert.equal(shopRows[2][6], 'รหัสล็อก/พื้นที่ขาย');
  assert.equal(instructionRows[7][0], 'รหัสล็อก/พื้นที่ขาย');
  assert.match(instructionRows[7][1], /ใช้ซ้ำได้เมื่อร้านเดิมพักใช้งาน/);
  assert.match(instructionRows[12][0], /มีร้านใช้งานใช้รหัสล็อกซ้ำ ระบบจะยกเลิกทั้งไฟล์/);
});
