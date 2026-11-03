-- Up Migration

-- บันทึกว่าเตือนใบใกล้หมดอายุรอบไหนไปแล้ว (docs/design/email.md ระยะที่ 2) — กันส่งซ้ำ ไม่พึ่งคิวอีเมลที่ถูกลบตามระยะเก็บ
-- ไม่มีข้อมูลส่วนบุคคล (มีแค่ id ของใบ) จึงไม่ต้องลบตอนลบบัญชี
CREATE TABLE certificate_expiry_notices (
  certificate_id  uuid NOT NULL REFERENCES certificates (id) ON DELETE CASCADE,
  -- รอบที่เตือน: จำนวนวันก่อนหมดอายุ (30 / 7)
  days_before     integer NOT NULL CHECK (days_before > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (certificate_id, days_before)
);

-- ใบใกล้หมดอายุที่ยังใช้งานอยู่ — job ตรวจตามช่วง not_after (partial index เล็กกว่าทั้งตาราง)
CREATE INDEX certificates_active_not_after_idx ON certificates (not_after) WHERE revoked_at IS NULL;

-- Down Migration

DROP INDEX IF EXISTS certificates_active_not_after_idx;
DROP TABLE IF EXISTS certificate_expiry_notices;
