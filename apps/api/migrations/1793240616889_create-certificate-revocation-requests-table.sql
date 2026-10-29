-- Up Migration

-- คำขอเพิกถอนใบรับรองประจำตัว (ตัดสินใจ 2026-10-29 — docs/design/certificates.md หัวข้อ "การควบคุมการเพิกถอน")
-- เหตุผลที่ไม่เร่งด่วนต้องรอผู้มี certificate:revoke อนุมัติ ส่วน keyCompromise ผู้ใช้เพิกถอนเองได้ทันที (ไม่ผ่านตารางนี้)
-- อนุมัติ = เพิกถอนใบทันทีใน transaction เดียวกัน จึงไม่มีสถานะ "อนุมัติแล้วรอดำเนินการ"
-- ผู้ขอไม่ต้องพิมพ์ข้อความเอง (เลือกเหตุผลอย่างเดียว) — ไม่เก็บข้อมูลส่วนบุคคลเพิ่มจากที่ประกาศไว้
CREATE TABLE certificate_revocation_requests (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  certificate_id  uuid NOT NULL REFERENCES certificates (id),
  -- ผู้ขอ = เจ้าของใบตอนส่งคำขอ
  user_id         uuid NOT NULL REFERENCES users (id),
  reason          text NOT NULL CHECK (reason IN ('superseded', 'affiliationChanged', 'cessationOfOperation')),
  -- pending = รออนุมัติ, approved = อนุมัติและเพิกถอนแล้ว, rejected = ปฏิเสธ,
  -- cancelled = ผู้ขอยกเลิก หรือระบบยกเลิกเมื่อใบถูกเพิกถอนด้วยทางอื่น/ปิดบัญชี
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by      uuid REFERENCES users (id),
  decided_at      timestamptz,
  -- บันทึกของผู้อนุมัติ (บังคับเมื่อปฏิเสธ — ผู้ขอเห็น) — ลบข้อมูลส่วนบุคคล (PDPA) ล้างเป็น NULL
  decision_note   text CHECK (char_length(decision_note) <= 1000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revocation_requests_decided_pair_chk CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT revocation_requests_decided_chk CHECK (status NOT IN ('approved', 'rejected') OR decided_at IS NOT NULL)
);

-- ใบหนึ่งมีคำขอที่รออนุมัติได้ 1 รายการ — ฐานข้อมูลกันไว้อีกชั้นแม้ service ตรวจแล้ว
CREATE UNIQUE INDEX revocation_requests_one_pending_idx
  ON certificate_revocation_requests (certificate_id) WHERE status = 'pending';
-- คิวของผู้อนุมัติ (เฉพาะที่รออนุมัติ เก่าก่อน) — partial index เล็กกว่าทั้งตาราง
CREATE INDEX revocation_requests_pending_idx ON certificate_revocation_requests (created_at) WHERE status = 'pending';
-- คำขอของฉัน และการยกเลิกคำขอที่ค้างของผู้ใช้เมื่อปิดบัญชี
CREATE INDEX revocation_requests_user_id_idx ON certificate_revocation_requests (user_id, created_at DESC);

CREATE TRIGGER trg_certificate_revocation_requests_set_updated_at
  BEFORE UPDATE ON certificate_revocation_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS certificate_revocation_requests;
