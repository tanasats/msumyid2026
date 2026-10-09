-- Up Migration

-- วันหมดอายุของบัญชี (ใช้กับบัญชีหน่วยงาน เช่น บัญชีกิจกรรม) — NULL = ไม่หมดอายุ
-- ถึงเวลาแล้วระบบถือว่าใช้งานไม่ได้ทันที และ job ปิดบัญชี (is_active = false) พร้อมเขียน audit log
ALTER TABLE users ADD COLUMN account_expires_at timestamptz;

-- job ค้นบัญชีที่ถึงกำหนดแต่ยังเปิดอยู่ — partial index เก็บเฉพาะบัญชีที่มีวันหมดอายุและยังเปิด จึงเล็กมาก
CREATE INDEX users_account_expires_at_idx ON users (account_expires_at)
  WHERE account_expires_at IS NOT NULL AND is_active AND deleted_at IS NULL;

-- Down Migration

DROP INDEX IF EXISTS users_account_expires_at_idx;
ALTER TABLE users DROP COLUMN IF EXISTS account_expires_at;
