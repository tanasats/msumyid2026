-- Up Migration

-- กลุ่มรายการสำคัญที่ต้องยืนยันตัวตนซ้ำ (step-up) ภายใน 10 นาทีก่อนทำ (ตัดสินใจ 2026-11-04 — docs/design/mfa.md)
-- super_admin เปิด/ปิดรายกลุ่มที่ /admin/settings — เก็บเป็นรายชื่อกลุ่มที่ "เปิด" ค่าเริ่มต้นเปิดทุกกลุ่ม
--   certificate     = ขอใบรับรอง / ดาวน์โหลด .p12 จาก key สำรอง / รับใบจากคำขอที่อนุมัติแล้ว
--   role            = ให้/ถอน role ของผู้ใช้ และแก้ role/สิทธิ์ของ role
--   system_settings = แก้ค่าตั้งของระบบ
--   user_admin      = ลบบัญชีผู้ใช้ และรีเซ็ต MFA ของผู้อื่น
-- (ตั้ง PIN ลงนามใหม่โดยไม่ใส่ PIN เดิม และการแก้ค่านี้เอง ต้องยืนยันซ้ำเสมอ จึงไม่อยู่ในรายการ)
-- CHECK แบบ <@ = ทุกค่าต้องอยู่ในชุดที่รู้จัก (ว่างได้ = ปิดทุกกลุ่ม) — เพิ่มคอลัมน์พร้อม DEFAULT จึงไม่กระทบแถวเดิม
ALTER TABLE system_settings
  ADD COLUMN mfa_step_up_actions text[] NOT NULL
    DEFAULT ARRAY['certificate', 'role', 'system_settings', 'user_admin']::text[]
    CONSTRAINT system_settings_mfa_step_up_actions_check
      CHECK (mfa_step_up_actions <@ ARRAY['certificate', 'role', 'system_settings', 'user_admin']::text[]);

-- Down Migration

ALTER TABLE system_settings DROP COLUMN IF EXISTS mfa_step_up_actions;
