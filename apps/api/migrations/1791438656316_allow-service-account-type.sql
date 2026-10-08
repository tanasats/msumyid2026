-- Up Migration

-- เพิ่มประเภทบัญชี 'service' = บัญชีหน่วยงาน (บัญชีที่ออกให้ระบบสารสนเทศ คณะ/หน่วยงาน หรือกิจกรรม ไม่ใช่ของบุคคล)
-- แก้ CHECK constraint ต้องลบแล้วสร้างใหม่ — แถวเดิมมีแต่ 3 ค่าเดิมจึงผ่านเงื่อนไขใหม่ทุกแถว ไม่มีข้อมูลเปลี่ยน
ALTER TABLE users DROP CONSTRAINT users_account_type_check;
ALTER TABLE users ADD CONSTRAINT users_account_type_check
  CHECK (account_type IN ('student', 'staff', 'external', 'service'));

-- Down Migration

-- ถ้ายังมีบัญชีประเภท 'service' อยู่ migration จะล้ม (ตั้งใจ) — ต้องเปลี่ยนประเภทบัญชีเหล่านั้นก่อน ไม่แก้ข้อมูลให้เอง
ALTER TABLE users DROP CONSTRAINT users_account_type_check;
ALTER TABLE users ADD CONSTRAINT users_account_type_check
  CHECK (account_type IN ('student', 'staff', 'external'));
