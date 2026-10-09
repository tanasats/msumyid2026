-- Up Migration

-- CRL ที่ระบบออก (ทุกฉบับ ไม่ลบ — ใช้ตรวจย้อนหลังว่าใบใดอยู่ใน CRL เมื่อไร)
-- ฉบับล่าสุด (crl_number มากที่สุด) คือฉบับที่เผยแพร่ที่ GET /crl/msu-ca.crl ให้ cdp.msu.ac.th ดึงไป
CREATE TABLE crls (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  -- เลข CRL เพิ่มขึ้นเสมอ (RFC 5280) — ระบบใช้เวลา Unix (วินาที) จึงมากกว่าเลขจาก crlnumber ของระบบเดิมเสมอ
  -- UNIQUE ให้ index สำหรับหาฉบับล่าสุดด้วย ORDER BY crl_number DESC LIMIT 1
  crl_number     bigint NOT NULL UNIQUE CHECK (crl_number > 0),
  this_update    timestamptz NOT NULL,
  next_update    timestamptz NOT NULL,
  -- จำนวนใบที่เพิกถอนตอนออกฉบับนี้ — ถ้าจำนวนปัจจุบันมากกว่า แปลว่ามีการเพิกถอนที่ยังไม่อยู่ใน CRL (ต้องออกใหม่)
  revoked_count  integer NOT NULL CHECK (revoked_count >= 0),
  crl_der        bytea NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crls_update_order_chk CHECK (next_update > this_update)
);

CREATE TRIGGER trg_crls_set_updated_at
  BEFORE UPDATE ON crls
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS crls;
