import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = "/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/store_upload_template";
const outputPath = `${outputDir}/ตัวอย่างอัปโหลดร้านค้า.xlsx`;

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("ร้านค้า");
sheet.showGridLines = false;

sheet.mergeCells("A1:N1");
sheet.getRange("A1").values = [["ตัวอย่างไฟล์อัปโหลดข้อมูลร้านค้า"]];
sheet.getRange("A1:N1").format = {
  fill: "#1F4E78",
  font: { bold: true, color: "#FFFFFF", size: 16 },
  horizontalAlignment: "center",
  verticalAlignment: "center",
};
sheet.getRange("A1:N1").format.rowHeight = 30;

sheet.mergeCells("A2:N2");
sheet.getRange("A2").values = [["กรอกข้อมูล 1 ร้านค้าต่อ 1 แถว • ห้ามแก้ไขชื่อหัวคอลัมน์ • รหัสร้านค้าต้องไม่ซ้ำ"]];
sheet.getRange("A2:N2").format = {
  fill: "#D9EAF7",
  font: { color: "#1F1F1F", italic: true, size: 10 },
  horizontalAlignment: "left",
  verticalAlignment: "center",
};
sheet.getRange("A2:N2").format.rowHeight = 22;

const headers = [[
  "รหัสร้านค้า*", "ชื่อร้านค้า*", "ชื่อผู้ติดต่อ", "เบอร์โทรศัพท์*", "อีเมล",
  "ที่อยู่*", "ตำบล/แขวง", "อำเภอ/เขต", "จังหวัด*", "รหัสไปรษณีย์",
  "พิกัดละติจูด", "พิกัดลองจิจูด", "ประเภทลูกค้า*", "สถานะ*"
]];
sheet.getRange("A4:N4").values = headers;
sheet.getRange("A4:N4").format = {
  fill: "#2F75B5",
  font: { bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  wrapText: true,
  borders: { preset: "outside", style: "thin", color: "#1F4E78" },
};
sheet.getRange("A4:N4").format.rowHeight = 32;

const sampleRows = [
  ["ST001", "ร้านเจริญทรัพย์", "สมชาย ใจดี", "0812345678", "somchai@example.com", "99/1 ถนนสุขุมวิท", "บางนา", "บางนา", "กรุงเทพมหานคร", "10260", 13.6684, 100.6048, "ร้านค้าปลีก", "ใช้งาน"],
  ["ST002", "มินิมาร์ทสุขใจ", "สุภาวดี รักดี", "0898765432", "supawadee@example.com", "45 หมู่ 3", "สุเทพ", "เมืองเชียงใหม่", "เชียงใหม่", "50200", 18.7883, 98.9853, "ร้านค้าปลีก", "ใช้งาน"],
  ["ST003", "ร้านอาหารบ้านสวน", "วิชัย มีสุข", "0865556666", "wichai@example.com", "12/8 ถนนรอบเมือง", "ในเมือง", "เมืองขอนแก่น", "ขอนแก่น", "40000", 16.4322, 102.8236, "ร้านอาหาร", "พักใช้งาน"],
];
sheet.getRange("A5:N7").values = sampleRows;
sheet.getRange("A5:N100").format = {
  verticalAlignment: "center",
  borders: { preset: "inside", style: "thin", color: "#D9E2F3" },
};
sheet.getRange("A5:N7").format.borders = { preset: "all", style: "thin", color: "#D9E2F3" };
sheet.getRange("A5:N100").format.rowHeight = 22;

sheet.getRange("J5:J100").format.numberFormat = "@";
sheet.getRange("K5:L100").format.numberFormat = "0.000000";
sheet.getRange("A5:A100").format.numberFormat = "@";
sheet.getRange("D5:D100").format.numberFormat = "@";

sheet.getRange("M5:M100").dataValidation = { rule: { type: "list", values: ["ร้านค้าปลีก", "ร้านค้าส่ง", "ร้านอาหาร", "โรงแรม", "อื่นๆ"] } };
sheet.getRange("N5:N100").dataValidation = { rule: { type: "list", values: ["ใช้งาน", "พักใช้งาน", "ปิดกิจการ"] } };
sheet.getRange("N5:N100").conditionalFormats.add("containsText", { text: "ใช้งาน", format: { fill: "#E2F0D9", font: { color: "#548235" } } });
sheet.getRange("N5:N100").conditionalFormats.add("containsText", { text: "พักใช้งาน", format: { fill: "#FFF2CC", font: { color: "#BF9000" } } });
sheet.getRange("N5:N100").conditionalFormats.add("containsText", { text: "ปิดกิจการ", format: { fill: "#FCE4D6", font: { color: "#C00000" } } });

const widths = [15, 24, 20, 16, 28, 34, 16, 18, 18, 14, 16, 16, 16, 14];
for (let col = 0; col < widths.length; col += 1) {
  sheet.getRangeByIndexes(0, col, 100, 1).format.columnWidth = widths[col];
}
sheet.freezePanes.freezeRows(4);

const noteSheet = workbook.worksheets.add("คำแนะนำ");
noteSheet.showGridLines = false;
noteSheet.mergeCells("A1:B1");
noteSheet.getRange("A1").values = [["คำแนะนำการเตรียมไฟล์อัปโหลดร้านค้า"]];
noteSheet.getRange("A1:B1").format = { fill: "#1F4E78", font: { bold: true, color: "#FFFFFF", size: 14 }, horizontalAlignment: "center" };
noteSheet.getRange("A1:B1").format.rowHeight = 28;
noteSheet.getRange("A3:B8").values = [
  ["หัวข้อ", "รายละเอียด"],
  ["ช่องบังคับ (*)", "รหัสร้านค้า, ชื่อร้านค้า, เบอร์โทรศัพท์, ที่อยู่, จังหวัด, ประเภทลูกค้า และสถานะ"],
  ["รหัสร้านค้า", "ต้องไม่ซ้ำกัน เช่น ST001"],
  ["เบอร์โทรศัพท์", "กรอกเป็นตัวเลขต่อเนื่อง เช่น 0812345678"],
  ["พิกัด", "กรอกละติจูดและลองจิจูดเป็นตัวเลขทศนิยม หากมี"],
  ["รายการเลือก", "ประเภทลูกค้าและสถานะเลือกจากรายการดรอปดาวน์ในชีต ร้านค้า"],
];
noteSheet.getRange("A3:B3").format = { fill: "#2F75B5", font: { bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", borders: { preset: "all", style: "thin", color: "#1F4E78" } };
noteSheet.getRange("A4:B8").format = { wrapText: true, verticalAlignment: "top", borders: { preset: "all", style: "thin", color: "#D9E2F3" } };
noteSheet.getRange("A4:A8").format.font = { bold: true };
noteSheet.getRange("A1:A8").format.columnWidth = 22;
noteSheet.getRange("B1:B8").format.columnWidth = 78;
noteSheet.getRange("A4:B8").format.rowHeight = 32;

await fs.mkdir(outputDir, { recursive: true });
const check = await workbook.inspect({
  kind: "table",
  range: "ร้านค้า!A1:N7",
  include: "values,formulas",
  tableMaxRows: 7,
  tableMaxCols: 14,
});
console.log(check.ndjson);
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 50 },
  summary: "final formula error scan",
});
console.log(errors.ndjson);
const preview = await workbook.render({ sheetName: "ร้านค้า", range: "A1:N10", scale: 1.4, format: "png" });
await fs.writeFile(`${outputDir}/preview.png`, new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

console.log(JSON.stringify({ outputPath }));
