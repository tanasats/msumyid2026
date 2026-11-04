-- Up Migration

-- ประวัติการเปิด/ปิด "บังคับ MFA" ของ role ที่หน้า /admin/roles (docs/design/mfa.md)
-- action = mfa_required, detail = { from, to } (boolean) — ไม่ผูก permission (CHECK permission_chk ยังใช้ได้)
ALTER TABLE role_permission_logs DROP CONSTRAINT role_permission_logs_action_check;
ALTER TABLE role_permission_logs ADD CONSTRAINT role_permission_logs_action_check
  CHECK (action IN ('create', 'rename', 'grant', 'revoke', 'mfa_required'));

-- Down Migration

-- ถ้ามี log ของ mfa_required อยู่แล้ว migration จะล้ม (ตั้งใจ — log ลบไม่ได้)
ALTER TABLE role_permission_logs DROP CONSTRAINT role_permission_logs_action_check;
ALTER TABLE role_permission_logs ADD CONSTRAINT role_permission_logs_action_check
  CHECK (action IN ('create', 'rename', 'grant', 'revoke'));
