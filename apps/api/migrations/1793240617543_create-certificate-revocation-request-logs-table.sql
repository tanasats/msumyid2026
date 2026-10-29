-- Up Migration

-- ประวัติคำขอเพิกถอนใบรับรอง เขียนใน transaction เดียวกับการเปลี่ยนสถานะ และห้ามแก้/ลบ (append-only)
-- submit = ส่งคำขอ, approve = อนุมัติ (เพิกถอนแล้ว), reject = ปฏิเสธ, cancel = ยกเลิก
-- PDPA: ไม่เก็บบันทึกของผู้อนุมัติ (อยู่ในตารางคำขอ ซึ่งล้างได้) เพราะ log ลบไม่ได้
CREATE TABLE certificate_revocation_request_logs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  request_id  uuid NOT NULL REFERENCES certificate_revocation_requests (id),
  -- NULL = ระบบทำเอง (ยกเลิกคำขอเมื่อบัญชีหมดอายุ)
  actor_id    uuid REFERENCES users (id),
  action      text NOT NULL CHECK (action IN ('submit', 'approve', 'reject', 'cancel')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX revocation_request_logs_request_id_idx ON certificate_revocation_request_logs (request_id, created_at);
CREATE INDEX revocation_request_logs_actor_id_idx ON certificate_revocation_request_logs (actor_id);

-- ใช้ฟังก์ชันกลาง prevent_append_only_mutation() (สร้างใน migration ของ user_audit_logs)
CREATE TRIGGER trg_revocation_request_logs_append_only
  BEFORE UPDATE OR DELETE ON certificate_revocation_request_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER trg_revocation_request_logs_no_truncate
  BEFORE TRUNCATE ON certificate_revocation_request_logs
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- Down Migration

DROP TABLE IF EXISTS certificate_revocation_request_logs;
