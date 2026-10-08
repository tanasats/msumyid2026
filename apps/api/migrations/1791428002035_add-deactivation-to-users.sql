-- Up Migration

-- ใครปิดบัญชีและเมื่อไร (แสดงบนหน้าจอ) — เหตุผลอยู่ใน user_audit_logs
-- เปิดบัญชีคืน = ล้างทั้งสองคอลัมน์เป็น NULL
ALTER TABLE users
  ADD COLUMN deactivated_at timestamptz,
  ADD COLUMN deactivated_by uuid REFERENCES users (id);

-- Down Migration

ALTER TABLE users
  DROP COLUMN IF EXISTS deactivated_by,
  DROP COLUMN IF EXISTS deactivated_at;
