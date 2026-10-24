-- Up Migration

-- ประวัติคำขอใบรับรองเสริม เขียนใน transaction เดียวกับการเปลี่ยนสถานะ และห้ามแก้/ลบ (append-only)
-- submit = ส่งคำขอ, approve = อนุมัติ (เก็บช่วงที่อนุมัติ), reject = ปฏิเสธ, cancel = ยกเลิก, issue = ออกใบ
-- PDPA: ไม่เก็บวัตถุประสงค์/บันทึกของผู้อนุมัติใน log (อยู่ในตารางคำขอ ซึ่งล้างได้) เพราะ log ลบไม่ได้
CREATE TABLE supplementary_certificate_request_logs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  request_id      uuid NOT NULL REFERENCES supplementary_certificate_requests (id),
  -- NULL = ระบบทำเอง (ยกเลิกคำขอเมื่อปิดบัญชี/บัญชีหมดอายุ)
  actor_id        uuid REFERENCES users (id),
  action          text NOT NULL CHECK (action IN ('submit', 'approve', 'reject', 'cancel', 'issue')),
  -- ช่วงวันที่ ณ ตอนนั้น (submit = ที่ขอ, approve = ที่อนุมัติ) ดูย้อนหลังได้ว่าผู้อนุมัติแก้ช่วงหรือไม่
  range_start     date,
  range_end       date,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX supplementary_request_logs_request_id_idx
  ON supplementary_certificate_request_logs (request_id, created_at);
CREATE INDEX supplementary_request_logs_actor_id_idx ON supplementary_certificate_request_logs (actor_id);

-- ใช้ฟังก์ชันกลาง prevent_append_only_mutation() (สร้างใน migration ของ user_audit_logs)
CREATE TRIGGER trg_supplementary_request_logs_append_only
  BEFORE UPDATE OR DELETE ON supplementary_certificate_request_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER trg_supplementary_request_logs_no_truncate
  BEFORE TRUNCATE ON supplementary_certificate_request_logs
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- Down Migration

DROP TABLE IF EXISTS supplementary_certificate_request_logs;
