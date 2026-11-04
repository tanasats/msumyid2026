-- Up Migration

-- บังคับ MFA ต่อ role (docs/design/mfa.md, ตัดสินใจ 2026-11-04) — ผู้ถือ role ที่บังคับต้องตั้งค่า MFA ก่อนใช้ระบบ
-- และปิด MFA เองไม่ได้ ค่าเริ่มต้นบังคับ super_admin และ admin ส่วน role อื่น super_admin เปิดได้ที่หน้า /admin/roles
-- โค้ดอ่านจากคอลัมน์นี้ ไม่เช็คชื่อ role
ALTER TABLE roles ADD COLUMN mfa_required boolean NOT NULL DEFAULT false;

UPDATE roles SET mfa_required = true WHERE code IN ('super_admin', 'admin');

-- Down Migration

ALTER TABLE roles DROP COLUMN IF EXISTS mfa_required;
