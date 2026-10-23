-- Up Migration

-- เพิ่มประเภทบัญชี 'unclassified' = รอจำแนกประเภท
-- บัญชี มมส. ใหม่ที่ไม่ใช่นิสิตและ ERP-HR ไม่พบ (หรือเรียกไม่สำเร็จ) อาจเป็นบุคลากรภายนอก (อาจารย์พิเศษ, ผู้เชี่ยวชาญ)
-- หรือบัญชีหน่วยงาน — ระบบไม่เดา ให้ผู้มี user:approve เลือกประเภทก่อนอนุมัติ (บัญชีนี้อนุมัติไม่ได้จนกว่าจะเลือก)
-- แก้ CHECK constraint ต้องลบแล้วสร้างใหม่ — แถวเดิมมีแต่ 4 ค่าเดิมจึงผ่านเงื่อนไขใหม่ทุกแถว ไม่มีข้อมูลเปลี่ยน
ALTER TABLE users DROP CONSTRAINT users_account_type_check;
ALTER TABLE users ADD CONSTRAINT users_account_type_check
  CHECK (account_type IN ('student', 'staff', 'external', 'service', 'unclassified'));

-- Down Migration

-- ถ้ายังมีบัญชีประเภท 'unclassified' อยู่ migration จะล้ม (ตั้งใจ) — ต้องจำแนกบัญชีเหล่านั้นก่อน ไม่แก้ข้อมูลให้เอง
ALTER TABLE users DROP CONSTRAINT users_account_type_check;
ALTER TABLE users ADD CONSTRAINT users_account_type_check
  CHECK (account_type IN ('student', 'staff', 'external', 'service'));
