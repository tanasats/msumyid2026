-- Up Migration

-- MFA แบบ TOTP (แอป Authenticator, RFC 6238) — 1 ผู้ใช้มีได้ 1 ชุด (docs/design/mfa.md)
-- secret ต้องนำมาคำนวณรหัสจึงใช้ hash ไม่ได้ → เข้ารหัส AES-256-GCM ด้วย MFA_ENCRYPTION_KEY ของ API (key อยู่นอกฐานข้อมูล
-- backup ฐานข้อมูลที่หลุดจึงใช้ secret ไม่ได้) รูปแบบ = iv(12) + tag(16) + ciphertext
CREATE TABLE user_mfa_totp (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id            uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  secret_ciphertext  bytea NOT NULL CHECK (octet_length(secret_ciphertext) > 28),
  -- key ที่ใช้เข้ารหัส (MFA_ENCRYPTION_KEY_ID) — เปลี่ยน key ภายหลังได้โดยรู้ว่าแถวไหนยังใช้ key เดิม
  key_id             text NOT NULL,
  -- NULL = กำลังตั้งค่า (ยังไม่ยืนยันรหัสแรก) ยังไม่นับว่าเปิด MFA
  confirmed_at       timestamptz,
  -- ช่วงเวลา (unix/30) ของรหัสล่าสุดที่ใช้ผ่าน — รหัสช่วงเดียวกันหรือก่อนหน้าใช้ซ้ำไม่ได้
  last_used_step     bigint,
  failed_attempts    integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_user_mfa_totp_set_updated_at
  BEFORE UPDATE ON user_mfa_totp
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS user_mfa_totp;
