# Phase 1: ระบบพื้นฐานและจัดการข้อมูล

สถานะ: เริ่มพัฒนา — ฐานข้อมูลและสิทธิ์พร้อมตรวจทาน

## สิ่งที่เริ่มทำแล้ว

- migration ที่สร้างตารางตาม database contract และ template ข้อมูลตั้งต้นของ Phase 0 รวม `image_path`, `payment_status` และ `normal_rounds_per_day` ของร้าน
- เชื่อมบัญชี Supabase Auth กับ `public.users` อัตโนมัติ โดยบัญชีใหม่เป็น `courier` ที่ยังไม่ active เสมอ
- RLS สำหรับบทบาท `courier`, `round_lead`, และ `admin`; สิทธิ์อ้างอิงบทบาทจากฐานข้อมูล ไม่เชื่อค่าจากเครื่องผู้ใช้
- bucket รูปร้านแบบ private (`shop-images`) และให้แอดมินเท่านั้นอัปโหลด แก้ไข หรือลบรูปได้
- audit log สำหรับการแก้ไขข้อมูลผู้ใช้ อาคาร ร้าน ประเภทน้ำแข็ง และรายการส่ง
- ปิดสิทธิ์ `DELETE` ทาง API ทุกตาราง: ร้านและผู้ใช้จึงต้องเปลี่ยนเป็น inactive แทนการลบจริง ส่วนรายการส่งใช้สถานะ `cancelled`

ไฟล์ migration: [0001_phase_1_foundation.sql](../../supabase/migrations/0001_phase_1_foundation.sql)

## วิธีเริ่มใช้ฐานข้อมูล

1. สร้าง Supabase project และเชื่อม CLI กับ project นั้น
2. รัน `supabase db push` จาก root ของ repository เพื่อใช้ migration
3. สร้างบัญชีคนแรกผ่าน Supabase Auth แล้วนำ UUID ไปเปิดใช้งานเป็นแอดมินด้วย SQL Editor:

   ```sql
   update public.users
   set display_name = 'ชื่อผู้ดูแล', role = 'admin', is_active = true
   where id = 'AUTH_USER_UUID';
   ```

4. แอดมินจึงเพิ่ม/เปิดใช้งานผู้ใช้คนอื่น กำหนดบทบาท และจัดการข้อมูลอ้างอิงผ่านแอปในขั้นต่อไปได้

## ขอบเขตที่เหลือของ Phase 1

- สร้างเว็บแอดมินสำหรับเข้าสู่ระบบและจัดการผู้ใช้ อาคาร ร้าน รูปร้าน และประเภทน้ำแข็ง
- เพิ่มการตรวจสอบ migration บน Supabase project ที่เชื่อมจริง
- ทำ test ของ RLS ด้วยบัญชีทั้งสามบทบาท

ยังไม่มี frontend หรือการตั้งค่า Supabase project ใน workspace นี้ จึงยังไม่สามารถทดสอบการเข้าสู่ระบบหรือใช้ migration กับฐานข้อมูลจริงได้
