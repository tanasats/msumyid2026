-- Up Migration

-- รหัสกู้คืน MFA (ใช้แทนรหัสจากแอปเมื่ออุปกรณ์หาย) ครั้งละ 1 รหัส ใช้ได้ครั้งเดียว — ออกชุดใหม่ = ลบชุดเดิมทั้งหมด
-- เก็บเฉพาะ SHA-256 ของรหัส: รหัสสุ่ม 80 บิต (16 ตัวอักษร base32) เดาย้อนจาก hash ไม่ได้ จึงไม่ต้องใช้ hash ช้าแบบ scrypt
CREATE TABLE user_mfa_recovery_codes (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash   bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  -- NULL = ยังไม่ใช้
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ตรวจ/นับรหัสของผู้ใช้
CREATE INDEX user_mfa_recovery_codes_user_id_idx ON user_mfa_recovery_codes (user_id);

CREATE TRIGGER trg_user_mfa_recovery_codes_set_updated_at
  BEFORE UPDATE ON user_mfa_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS user_mfa_recovery_codes;
