# APK เฉพาะพนักงาน

สร้างจากโค้ดพนักงานชุดเดียวกับเว็บและค่าการเชื่อมต่อ Supabase ที่ตั้งไว้ในโปรเจกต์:

```sh
npm run android:apk:employee
```

ไฟล์ติดตั้งปัจจุบัน: `outputs/android/ice-delivery-employee-1.0.12.apk`

- Android 7.0 ขึ้นไป (`minSdkVersion 24`)
- เวอร์ชัน 1.0.12 (`versionCode 13`), package `com.superice.delivery`
- ใช้ debug signing เดิมของโปรเจกต์สำหรับแจกติดตั้งภายใน สามารถอัปเดตทับ APK เดิมที่ใช้ package และใบรับรองเดียวกัน โดยไม่ถอนการติดตั้ง/ล้างข้อมูล
- บัญชีที่เปิดงานได้คือพนักงาน (`courier`) ที่ยังใช้งานอยู่; แอดมินและหัวหน้าใช้งานผ่านเว็บ
- เก็บงาน POS, ลูกค้าจร, เติม/คืน/ละลายน้ำแข็ง, อีเวนต์, รับชำระตามสิทธิ์, ประวัติรับเงิน, ใบเซ็นเครดิต และเครื่องพิมพ์ Bluetooth เดิม
- สิทธิ์รับชำระยังมาจากข้อมูลบัญชีที่ตรวจสอบกับเซิร์ฟเวอร์ ไม่ได้ให้สิทธิ์เพิ่มจากการติดตั้ง APK
- ฟอนต์ไทยและเมียนมารวมอยู่ในแอปสำหรับใช้งานและพิมพ์ ไม่ต้องโหลดฟอนต์จากอินเทอร์เน็ต
- การแยก APK ไม่ได้เพิ่มความสามารถบันทึกธุรกรรมแบบออฟไลน์; ใช้พฤติกรรมเครือข่ายและการกู้รายการเดิม

## การแยกส่วน

`vite build --mode employee` ใช้ `src/main.employee.tsx` และสร้าง `dist-employee` โดยไม่รวมโหมดสาธิตหรือ service worker ของเว็บ ส่วนหน้าจัดการโหลดผ่านโมดูลแยกในเว็บและถูกตัดออกจาก employee build ตั้งแต่ตอน build ไม่ใช่แค่ซ่อนเมนู

ขั้นตอน build ตรวจรายชื่อโมดูลที่ถูกบรรจุจริงและหยุดหากพบหน้าจัดการที่ห้ามรวม บันทึกรายชื่อไว้ใน `dist-employee/employee-build.json` ซึ่งถูกบรรจุใน APK ด้วย ไฟล์รูปพื้นหลังแอดมินและเทมเพลตนำเข้าร้านค้าไม่ถูกบรรจุในรุ่นพนักงาน

คำสั่ง `npm run build` และ `npm run android:apk` ยังคงสร้างระบบเต็มตามเดิม อย่าใช้คำสั่งหลังเพื่อแจก APK เฉพาะพนักงาน

## ตรวจสอบรุ่น 1.0.12 (27 ตุลาคม 2026)

- สร้างใหม่จากโค้ดล่าสุดในโปรเจกต์; TypeScript และ production build สำหรับ employee ผ่าน
- ชุดทดสอบ employee router, รีเฟรชร้าน และการโหลด/กู้คืนแคชรูปร้านผ่าน 123 เคส; การบรรจุฟอนต์ไทย, CSS พนักงาน และ runtime cache ผ่านอีก 6 เคส
- Gradle build และ Android unit test task ผ่าน; สร้าง instrumentation test APK ได้ แต่ยังไม่ได้รันบนอุปกรณ์
- ตรวจไฟล์เว็บใน APK ตรงกับ `dist-employee` ทั้ง 12 ไฟล์ และตรวจ employee target กับ Capacitor config ผ่าน
- ตรวจ APK signature ผ่าน และ certificate SHA-256 ตรงกับรุ่น 1.0.11; package เดิมและ versionCode เพิ่มจาก 12 เป็น 13
- SHA-256 ของ APK: `a48a9569c52fbef4c2bdd6957bca71eeff92bdb268d1edff9eafbf680e60960a`
- ขั้นตอนนี้ไม่ได้ deploy migration และยังไม่ได้ทดสอบติดตั้งทับหรือพิมพ์ Bluetooth บนมือถือจริง

## ตรวจสอบรุ่น 1.0.11 (26 ตุลาคม 2026)

- แก้ regression จาก 1.0.10: cache timeout จะพักเฉพาะงานอ่านหรือเขียนที่ยังค้าง และกลับมาใช้ได้เมื่อ operation จริงจบ; งานเขียนช้าไม่ปิดการอ่านรูปเก่าบนเครื่อง
- กลับหน้าด้วยข้อมูล workspace ที่มีเฉพาะ image_path จะร่วมดาวน์โหลดเดิม รวมช่วงเขียนแคชค้าง โดยไม่ต้องขอ URL ใหม่หรือโหลดรูปซ้ำ
- ถ้าโหลดเดิมนานเกิน 8 วินาทีและไม่มี URL จะยังรับผลรูปที่มาถึงภายหลัง ไม่ตัดไปเรียก signer จนรูปที่โหลดสำเร็จถูกซ่อน
- ปฏิเสธ path ที่กำกวมระหว่าง origin/version ของข้อมูลในแคชและงานดาวน์โหลด; ใช้แคชและคิวเดิม ไม่เพิ่มคลังรูปในหน่วยความจำถาวร
- ชุดทดสอบที่เกี่ยวข้องผ่าน 89 เคส (regression ใหม่ 12 เคส), runtime-cache/layout อีก 7 เคส; TypeScript และ employee production build ผ่าน
- Chromium + Cache Storage จริง: ออกจากหน้าแล้วกลับมาระหว่างโหลด แสดงรูปสำเร็จด้วยดาวน์โหลดเดิมหนึ่งครั้ง; reload หน้าอ่านรูปเดิมจากดิสก์โดยนับดาวน์โหลดใหม่ได้ 0
- Gradle build ผ่าน; Android unit test task ใช้ผลที่ยังเป็นปัจจุบันจาก Gradle cache; instrumentation APK สร้างได้ แต่ยังไม่ได้รันบนอุปกรณ์
- ตรวจไฟล์เว็บทั้ง 12 ไฟล์ใน APK ตรงกับ dist-employee และ employee target; signature ผ่านและ certificate ตรงกับ 1.0.9/1.0.10, versionCode เพิ่มเป็น 12
- SHA-256 ของ APK: `7a78620905a488ad605e7056b2e45418533781ee939450f2b194ba1260bb520f`
- ยังไม่มีการทดสอบบนมือถือจริง: native HTTP จำลองใน regression tests; ยังไม่ได้ยืนยันอาการของเครื่องในรูปหรือทดสอบติดตั้งทับ/Bluetooth

## ตรวจสอบรุ่น 1.0.10 (26 ตุลาคม 2026)

- แก้อาการรูปร้านค้างว่าง: แสดงรูปทันทีเมื่อได้ bytes โดยเขียนแคชแยกภายหลัง; งานเขียนแคชไม่ยึดช่องดาวน์โหลด
- ร้านที่เลื่อนพ้นระยะโหลดจะถอนงานที่ยังอยู่ในคิว; งานดาวน์โหลดที่เริ่มแล้วทำต่อและแชร์ผลเมื่อกลับมา
- จำกัดเวลารอแต่ละ Cache Storage operation 1.5 วินาที และพักการใช้แคชใน session เมื่อค้าง; ถ้ารอรูปผ่านคิว/แคช/native bridge เกิน 8 วินาที จะใช้ URL ผ่าน img โดยตรง
- รูปที่มี path แต่ไม่มี URL และไม่พบในแคช จะเรียกขอลิงก์ใหม่หนึ่งครั้ง พร้อมป้องกัน retry ซ้อน
- ชุดทดสอบที่เกี่ยวข้องผ่าน 77 เคส (รวม regression ใหม่ 7 เคส), runtime-cache/layout ผ่านอีก 7 เคส; TypeScript และ employee production build ผ่าน
- ตรวจใน Chromium ด้วย Cache Storage จริงและจำลอง cache.put ค้าง: รูป decode สำเร็จ naturalWidth 160 ขณะที่ write ยัง pending
- Gradle build ผ่าน; Android unit test task ผ่านโดยใช้ผลที่ยังเป็นปัจจุบันจาก Gradle cache และสร้าง instrumentation APK ได้ แต่ไม่ได้รันบนอุปกรณ์
- ตรวจไฟล์เว็บทั้ง 12 ไฟล์ใน APK ตรงกับ dist-employee, employee target และโค้ดแก้ cache อยู่ใน APK
- ตรวจ APK signature ผ่าน; certificate SHA-256 ตรงกับรุ่น 1.0.9, package เดิมและ versionCode เพิ่มจาก 10 เป็น 11
- SHA-256 ของ APK: `8134295859dbdb654dc61522c8167077eb822543714994b2b2f790fd7629fc44`
- ยังไม่มีอุปกรณ์ Android เชื่อมต่อ จึงยังไม่ได้ยืนยันอาการของเครื่องในรูปหรือติดตั้งทับ/ทดสอบ Bluetooth บนมือถือจริง

## ตรวจสอบรุ่น 1.0.9 (26 ตุลาคม 2026)

- สร้างจากโค้ดปัจจุบันใน working tree รวมการปรับข้อความหน้าบันทึกส่งและเลือกร้าน; TypeScript และ production build สำหรับ employee ผ่าน
- ทดสอบ employee router, เลือกร้าน และโหลดร้านแบบ progressive ผ่าน 19 เคส; การบรรจุฟอนต์ไทยและการกรอง CSS พนักงานผ่านอีก 3 เคส
- Gradle build และ Android unit test task ผ่าน; สร้าง instrumentation test APK ได้ แต่ยังไม่ได้รันบนอุปกรณ์
- ตรวจไฟล์เว็บใน APK ตรงกับ `dist-employee` ทั้ง 12 ไฟล์ และตรวจ employee target กับ Capacitor config ผ่าน
- ตรวจ APK signature ผ่าน และ certificate SHA-256 ตรงกับรุ่น 1.0.8; package เดิมและ versionCode เพิ่มจาก 9 เป็น 10
- SHA-256 ของ APK: `de968ad671d93b7e9fd6ccaf50f45f2c6983e1b2c73fa0bb528c74c3b914c117`
- ขั้นตอนนี้ไม่ได้ deploy migration และยังไม่ได้ทดสอบติดตั้งทับหรือพิมพ์ Bluetooth บนมือถือจริง

## ตรวจสอบรุ่น 1.0.8 (26 ตุลาคม 2026)

- สร้างจากโค้ดปัจจุบัน รวมการแสดงและพิมพ์ปริมาณน้ำแข็งในใบวางบิลพนักงาน; TypeScript และ production build สำหรับ employee ผ่าน
- ทดสอบ employee router, ใบวางบิลพนักงาน และพิมพ์ใบวางบิลผ่าน 14 เคส; การบรรจุฟอนต์ไทยและการกรอง CSS พนักงานผ่านอีก 3 เคส
- Gradle build และ Android unit test task ผ่าน; สร้าง instrumentation test APK ได้ แต่ยังไม่ได้รันบนอุปกรณ์
- ตรวจไฟล์เว็บใน APK ตรงกับ `dist-employee` ทั้ง 12 ไฟล์ และตรวจ employee target กับ Capacitor config ผ่าน
- ตรวจ APK signature ผ่าน และ certificate SHA-256 ตรงกับรุ่น 1.0.7; package เดิมและ versionCode เพิ่มจาก 8 เป็น 9
- SHA-256 ของ APK: `1c4e7dd034d20b8af58b21a4c43d81074706535fb803c61e276fb71647f44ae8`
- ขั้นตอนนี้ไม่ได้ deploy migration และยังไม่ได้ทดสอบติดตั้งทับหรือพิมพ์ Bluetooth บนมือถือจริง

## ตรวจสอบรุ่น 1.0.7 (24 ตุลาคม 2026)

- สร้างจากโค้ดปัจจุบันในโปรเจกต์; TypeScript และ production build สำหรับ employee ผ่าน
- ทดสอบ employee router ผ่าน 5 เคส และการบรรจุฟอนต์ไทยกับการกรอง CSS พนักงานผ่านอีก 3 เคส
- Gradle build และ Android unit test task ผ่าน (unit test ใช้ผลที่ยังเป็นปัจจุบันจาก Gradle cache); สร้าง instrumentation test APK ได้ แต่ยังไม่ได้รันบนอุปกรณ์
- ตรวจไฟล์เว็บใน APK ตรงกับ `dist-employee` ทั้ง 12 ไฟล์ และตรวจ employee target กับ Capacitor config ผ่าน
- ตรวจ APK signature ผ่าน และ certificate SHA-256 ตรงกับรุ่น 1.0.6; package เดิมและ versionCode เพิ่มจาก 7 เป็น 8
- SHA-256 ของ APK: `5623bac462c58f4eb77af2cef50d6e26cc2eed8982d90b7c64f8b7814fdf76d7`
- ขั้นตอนนี้ไม่ได้ deploy migration และยังไม่ได้ทดสอบติดตั้งทับหรือพิมพ์ Bluetooth บนมือถือจริง

## ตรวจสอบรุ่น 1.0.6 (20 ตุลาคม 2026)

- สร้างจากโค้ดปัจจุบันในโปรเจกต์ รวมการปรับหน้าต่างใบวางบิลให้เลื่อนแนวตั้งได้
- TypeScript และ production build สำหรับ employee ผ่าน; ไฟล์เว็บใน APK ตรงกับ `dist-employee` ทั้ง 12 ไฟล์
- ชุดทดสอบ employee router, ใบวางบิลพนักงาน, พิมพ์ใบวางบิล และเลือกบิลรับชำระผ่าน 34 เคส; ทดสอบ layout หน้ารับเงินผ่านอีก 1 เคส
- Gradle build และ Android unit test task ผ่าน (ใช้ผลที่ยังเป็นปัจจุบันจาก Gradle cache); สร้าง instrumentation test APK ได้ แต่ยังไม่ได้รันบนอุปกรณ์
- ตรวจ APK signature ผ่าน และ certificate SHA-256 ตรงกับรุ่น 1.0.5; package เดิมและ versionCode เพิ่มจาก 6 เป็น 7
- SHA-256 ของ APK: `a01b94048dbb2ea53417a89e872a11ce9d24bb6c7893f26230f4486996669fcd`
- การกรองร้านในหน้าใบวางบิลตาม migration `0240_employee_billing_account_eligibility.sql` เป็นการเปลี่ยนฝั่งเซิร์ฟเวอร์; ขั้นตอนสร้าง APK นี้ไม่ได้ deploy migration
- ยังไม่ได้ทดสอบติดตั้งทับและพิมพ์ Bluetooth บนมือถือจริง

## ตรวจสอบรุ่น 1.0.5 (19 ตุลาคม 2026)

- รวมการเลือกชำระเป็นใบวางบิลเดียวต่อฉบับ โดยบิลที่ยังไม่รวมใบวางบิลเลือกแยกได้ และยังจ่ายบางส่วนได้
- เปิดรายละเอียดใบวางบิลเพื่อขอเลื่อนกำหนดของบิลย่อยได้ โดยไม่เปลี่ยนการเลือกชำระหรือยอดรับเงินที่กรอกไว้
- TypeScript และ production build สำหรับ employee ผ่าน; ตรวจไฟล์ใน APK ตรงกับ `dist-employee` ทั้ง 12 ไฟล์ และมีหน้ารับเงินที่แก้ล่าสุด
- ชุดทดสอบรับเงินที่เกี่ยวข้องผ่าน 62 เคส และทดสอบ `employee-apk-router.test.tsx` ผ่าน 5 เคส
- Gradle build และ Android unit test task ผ่าน (4 เคสใช้ผลที่ยังเป็นปัจจุบันจาก Gradle cache); สร้าง instrumentation test APK ได้ แต่ยังไม่ได้รันบนอุปกรณ์
- ตรวจ APK signature ผ่าน และ certificate SHA-256 ตรงกับรุ่น 1.0.4; package เดิมและ versionCode เพิ่มจาก 5 เป็น 6
- SHA-256 ของ APK: `d9a2a8e7265d466f53bea488db46eeb0140eaf1418122c05e0e9b02deea874ac`
- ยังไม่ได้ทดสอบติดตั้งทับและพิมพ์ Bluetooth บนมือถือจริง

## ตรวจสอบรุ่น 1.0.4 (18 ตุลาคม 2026)

- สร้างใหม่จากโค้ดปัจจุบันในโปรเจกต์ พร้อมเพิ่มเลขเวอร์ชันสำหรับอัปเดต
- TypeScript และ production build สำหรับ employee ผ่าน
- ชุดทดสอบ `employee-apk-router.test.tsx` ผ่านทั้ง 5 เคส
- Android unit tests ผ่าน; สร้าง instrumentation test APK ได้ แต่ยังไม่ได้รันบนอุปกรณ์
- ตรวจลายเซ็น APK ตรงกับรุ่น 1.0.3 และไฟล์เว็บภายใน APK ตรงกับ employee build ใหม่ทุกไฟล์
- ต้องทดสอบติดตั้งและพิมพ์ Bluetooth บนมือถือจริงก่อนแจกครบทุกเครื่อง
