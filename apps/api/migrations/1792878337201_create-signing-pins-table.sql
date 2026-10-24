-- Up Migration

-- PIN ลงนามเอกสาร (ยืนยัน 2026-10-25) — ผู้ใช้ตั้งเอง แยกจากรหัสผ่านไฟล์ .p12
-- เก็บเฉพาะ hash (scrypt + salt ต่อผู้ใช้) ใส่ผิดครบ 5 ครั้งติดกัน ล็อก 15 นาที (ตรวจใน signing-pin-service)
CREATE TABLE signing_pins (
  user_id          uuid PRIMARY KEY REFERENCES users (id),
  -- รูปแบบ scrypt$<N>$<r>$<p>$<salt base64>$<hash base64> — เปลี่ยนค่าความยากภายหลังได้โดยไม่ต้อง migrate
  pin_hash         text NOT NULL,
  failed_attempts  integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_signing_pins_set_updated_at
  BEFORE UPDATE ON signing_pins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS signing_pins;
