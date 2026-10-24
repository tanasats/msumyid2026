-- Up Migration

-- คำขอใบรับรองประจำตัวแบบรออนุมัติ (ผู้ใช้มี certificate:apply แต่ไม่มี certificate:request — ตัดสินใจ 2026-10-24)
-- ผู้ใช้ส่งคำขอ → ผู้มี certificate:approve อนุมัติ → ผู้ใช้กด "รับใบรับรอง" ตั้งรหัส .p12 เอง ระบบจึงออกใบ (อายุตามนโยบาย)
-- "หมดเวลารับใบ" (อนุมัติแล้วไม่รับภายใน 30 วัน) คำนวณใน query จาก decided_at ไม่เก็บเป็นสถานะ จึงไม่ต้องมี job
-- แยกจาก supplementary_certificate_requests เพราะใบประจำตัวไม่มีช่วงวันที่ (ตารางนั้นบังคับไว้)
CREATE TABLE primary_certificate_requests (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id         uuid NOT NULL REFERENCES users (id),
  -- วัตถุประสงค์ (ไม่บังคับ) — ลบข้อมูลส่วนบุคคล (PDPA) ล้างเป็น NULL
  purpose         text CHECK (char_length(purpose) <= 1000),
  -- pending = รออนุมัติ, approved = อนุมัติแล้ว รอผู้ขอรับใบ, issued = ออกใบแล้ว,
  -- rejected = ปฏิเสธ, cancelled = ผู้ขอยกเลิก หรือระบบยกเลิกเมื่อปิดบัญชี
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'issued', 'rejected', 'cancelled')),
  decided_by      uuid REFERENCES users (id),
  decided_at      timestamptz,
  -- บันทึกของผู้อนุมัติ (บังคับเมื่อปฏิเสธ — ผู้ขอเห็น) — PDPA ล้างเป็น NULL
  decision_note   text CHECK (char_length(decision_note) <= 1000),
  certificate_id  uuid UNIQUE REFERENCES certificates (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT primary_requests_decided_pair_chk CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT primary_requests_decided_chk CHECK (status NOT IN ('approved', 'issued', 'rejected') OR decided_at IS NOT NULL),
  CONSTRAINT primary_requests_issued_chk CHECK ((status = 'issued') = (certificate_id IS NOT NULL))
);

-- คิวของผู้อนุมัติ (เฉพาะที่รออนุมัติ เก่าก่อน) — partial index เล็กกว่าทั้งตาราง
CREATE INDEX primary_requests_pending_idx ON primary_certificate_requests (created_at) WHERE status = 'pending';
-- คำขอของฉัน และการหาคำขอที่ค้างของผู้ใช้
CREATE INDEX primary_requests_user_id_idx ON primary_certificate_requests (user_id, created_at DESC);

CREATE TRIGGER trg_primary_certificate_requests_set_updated_at
  BEFORE UPDATE ON primary_certificate_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS primary_certificate_requests;
