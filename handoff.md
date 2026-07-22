# Handoff: POS Financial Foundation & Shop Settings (Step 3)

## Status
ขั้นตอนที่ 3 ตามแผน `docs/pos-delivery-and-payment-plan.md` ได้ถูกพัฒนาและทดสอบเสร็จสมบูรณ์แล้ว 100% (Integration และ UI Tests ทั้งหมด 194 tests ผ่านเรียบร้อย) ระบบพร้อมสำหรับการตั้งค่าข้อมูลตั้งต้น (Step 4) และการพัฒนาหน้าจอ POS สำหรับพนักงาน (Step 5)

## สิ่งที่พัฒนาสำเร็จใน Phase นี้ (Implemented Features)

### 1. ระบบจัดการราคากลาง (Master Ice Pricing)
- คอมโพเนนต์ `IceTypePriceEditor` (ที่เมนูตั้งค่าระบบของ Admin)
- รองรับการกำหนดราคามาตรฐานแบบระบุช่วงเวลา (`valid_from`, `valid_to`) และระบบประวัติราคาย้อนหลัง

### 2. โปรไฟล์การชำระเงินของร้านค้า (Shop Payment Profiles)
- เพิ่ม `ShopPaymentProfileEditor` ในหน้าแก้ไขข้อมูลร้านค้า
- รองรับการระบุเงื่อนไขการชำระเงิน: `immediate` (จ่ายทันที), `end_of_day` (สิ้นวัน), `credit` (เครดิต)
- รองรับการกำหนดช่องทางที่ยอมรับ (เงินสด, โอนเงิน, QR), การอนุญาตให้ค้างยอด, กฎการเก็บเงิน (Net Days / End of Month) และวงเงินเครดิต

### 3. ราคาพิเศษเฉพาะร้าน (Shop Special Prices)
- คอมโพเนนต์ `ShopSpecialPriceEditor` เพื่อกำหนดราคาพิเศษสำหรับลูกค้าเฉพาะราย
- ใช้โครงสร้าง Effective-dated (ช่วงเวลาที่มีผล) เช่นเดียวกับราคากลาง หากราคาพิเศษหมดอายุ ระบบจะ fallback ไปใช้ราคากลางอัตโนมัติ

### 4. เครื่องมือจัดการข้อมูลแบบกลุ่ม (Bulk Payment Setup)
- Modal `BulkPaymentSetupModal` สำหรับค้นหาและกรองร้านค้าด้วย ตึก/โซนย่อย
- ช่วยให้ Admin สามารถกำหนดโปรไฟล์การเงินตั้งต้นให้ร้านค้าหลายสิบร้านได้ในคลิกเดียว

### 5. รายงานตรวจสอบความพร้อม (POS Readiness Report)
- แดชบอร์ด `ShopReadinessPanel` แสดงสถิติและสถานะร้านค้าที่ยังไม่มี Payment Profile หรือสินค้าน้ำแข็งที่ยังไม่ได้กำหนดราคากลาง
- เป็น Checkpoint สำคัญก่อนทำการเปิดใช้งาน POS App อย่างเต็มรูปแบบ

## ข้อมูลทางเทคนิคและ Testing
- **Types**: สร้าง Type Definitions ที่เกี่ยวข้องครบถ้วนใน `src/types/app.ts`
- **Service Layer**: สร้างฟังก์ชัน RPC และตาราง Database ใน `adminReferenceSettingsService.ts`
- **Tests**: เพิ่ม UI tests สำหรับราคากลาง (`tests/admin-ice-type-pricing.test.tsx`) และฟอร์มร้านค้า (`tests/shop-payment-and-pricing-settings.test.tsx`) โดย Mock ข้อมูลทั้งหมดถูกต้อง และรันผ่าน 100%

## แผนงานและขั้นตอนถัดไป (Next Steps)
1. **Step 4: ข้อมูลตั้งต้น (Data Initialization)**
   - ผู้ดูแลระบบ (Admin) เข้าหน้าแอปเพื่อใช้ Bulk Setup กำหนดโปรไฟล์การเงินให้ร้านค้าทั้งหมด
   - กำหนดราคากลาง (Master Prices) ให้กับน้ำแข็งทุกชนิด
2. **Step 5: หน้าจอ POS พนักงาน (Employee POS UI)**
   - ปรับปรุง `EmployeeDeliveryWorkspace.tsx` ให้เป็น 3-Column Layout สำหรับ Desktop/Tablet และ 3-Step Wizard สำหรับ Mobile
   - เพิ่ม Keypad แบบสัมผัสสำหรับการคีย์ตัวเลขที่รวดเร็ว
   - เชื่อมต่อการคำนวณราคารวม (Unit Price × Quantity) และการบันทึกการส่ง (`record_delivery`) พร้อมแนบรูปแบบการชำระเงิน
