# Phase 2: บัตรร้านและการบันทึกส่งสำหรับพนักงาน

สถานะ: เริ่มพัฒนา — มีทั้ง server contract และ frontend scaffold สำหรับหัวหน้ารอบ/พนักงานแล้ว

## สิ่งที่เริ่มทำแล้ว

- migration `0002_phase_2_delivery_operations.sql` เพิ่ม RPC `create_delivery_round` ให้หัวหน้ารอบหรือแอดมินเปิดรอบแบบ atomic
- migration `0006_rounds_without_routes.sql` ปรับ RPC ให้เปิดรอบโดยสร้างสมาชิก คัดลอกร้านที่เปิดใช้งานทั้งหมดเป็น `round_stops` และสร้างยอดยกออกของชนิดน้ำแข็งที่ยัง active โดยไม่ต้องกำหนดเส้นทาง
- RPC `record_delivery` ให้พนักงานที่เป็นสมาชิกของรอบ (หรือหัวหน้ารอบ/แอดมิน) บันทึกน้ำแข็งหรือสถานะปัญหาแบบ atomic พร้อม idempotency key, audit log และอัปเดตสถานะบัตรร้าน โดยตอบข้อมูลรายการและรายการน้ำแข็งเดิมในการ retry
- RPC `get_round_shop_cards` คืนบัตรร้านเรียงตามอาคาร/โซน/รหัสร้าน กรองอาคารได้ และมีประวัติพร้อมยอดรวมของวันเดียวกันจากทุกรอบ
- migration `0003_phase_2_round_assignment_helpers.sql` เพิ่ม RPC `get_assignable_round_members` เพื่อให้หัวหน้ารอบ/แอดมินดึงรายชื่อผู้ใช้ active ไปเลือกผู้ร่วมรอบได้โดยไม่ต้องเปิด `public.users` ทั้งตารางผ่าน RLS
- frontend Vite + React ใน root ของ repo: login ด้วย Supabase Auth, เปิดรอบส่ง, เลือกรอบ, ดูบัตรร้านตามลำดับ, แสดงรูป/สถานะ/สถานะจ่ายเงิน และบันทึก `record_delivery` จากมือถือได้
- บัตรสถานะ `full_bin`, `closed_shop`, `no_access` และ `issue` ต้องมีหมายเหตุ; สถานะ `delivered` ต้องมีรายการน้ำแข็งอย่างน้อยหนึ่งประเภท

## สิ่งที่ยังไม่ทำ

- ยังไม่ได้เชื่อม Supabase project จริงใน workspace นี้ จึงยังไม่ได้ทดสอบกับ Auth/RLS/RPC ของฐานข้อมูลจริง
- การแก้ไขรายการล่าสุด: ค่า edit window ยังไม่ได้อนุมัติใน Phase 0 จึงไม่เปิดสิทธิ์แก้ไขแก่พนักงาน
- ปิดรอบและตรวจยอดของหัวหน้า เป็นขอบเขต Phase 3
- ยังไม่มีสถานะ offline queue, installable PWA, หรือ sync retry UI ซึ่งเป็นขอบเขต Phase 4

## สัญญาเรียกใช้งาน

เปิดรอบโดยเรียก `create_delivery_round(service_date, name, member_ids, loaded_quantities)` โดย `loaded_quantities` เป็น JSON array เช่น:

```json
[{"ice_type_id":"UUID","quantity":20}]
```

บันทึกการส่งด้วย `record_delivery(round_stop_id, items, stop_status, note, client_recorded_at, idempotency_key)` โดย `items` เป็น JSON array รูปแบบเดียวกัน และ `idempotency_key` หนึ่งค่าใช้ต่อการกดยืนยันหนึ่งครั้งเท่านั้น

เมื่อสร้าง frontend ให้เรียก `get_round_shop_cards(round_id, building_id)` เพื่อแสดงบัตรร้านทั้งหมดในรอบและยอดรวมของวัน แทนการประกอบประวัติหลายรอบบนอุปกรณ์เอง พนักงานเป็นผู้เลือกร้านที่จะไปส่งเอง

## วิธีรัน frontend scaffold

1. คัดลอก `.env.example` เป็น `.env.local`
2. ใส่ `VITE_SUPABASE_URL` และ `VITE_SUPABASE_ANON_KEY`
3. รัน `npm install`
4. รัน `npm run dev`

หน้าจอที่เริ่มใช้ได้ในรอบนี้:

- เข้าสู่ระบบด้วย Supabase Auth
- หัวหน้ารอบ/แอดมินเปิดรอบใหม่จาก RPC `create_delivery_round` โดยไม่ต้องเลือกเส้นทาง
- พนักงานเลือกบัตรร้านที่ต้องไปส่งเองและบันทึกส่งผ่าน RPC `record_delivery`
- เห็นประวัติและยอดรวมของวันจาก RPC `get_round_shop_cards`
