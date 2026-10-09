-- Up Migration

-- ประวัติการใช้งานใบรับรอง เขียนใน transaction เดียวกับการเปลี่ยนข้อมูล และห้ามแก้/ลบ (append-only)
-- issue = ออกใบใหม่, recover = กู้ key/ดาวน์โหลด .p12 ใหม่, revoke = เพิกถอน, import = นำเข้าจากระบบเดิม,
-- sign = ลงนามเอกสาร (docs/design/document-signing.md)
-- PDPA: ไม่เก็บชื่อ/อีเมลใน log (ดูได้จาก certificates) เพราะ log ลบไม่ได้
CREATE TABLE certificate_audit_logs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  certificate_id  uuid NOT NULL REFERENCES certificates (id),
  -- NULL = ระบบทำเอง (เช่น นำเข้า, เพิกถอนอัตโนมัติเมื่อปิดบัญชี)
  actor_id        uuid REFERENCES users (id),
  action          text NOT NULL CHECK (action IN ('issue', 'recover', 'revoke', 'import', 'sign')),
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX certificate_audit_logs_certificate_id_idx ON certificate_audit_logs (certificate_id, created_at DESC);
CREATE INDEX certificate_audit_logs_actor_id_idx ON certificate_audit_logs (actor_id);

-- ใช้ฟังก์ชันกลาง prevent_append_only_mutation() (สร้างใน migration ของ user_audit_logs)
CREATE TRIGGER trg_certificate_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON certificate_audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

-- TRUNCATE ไม่ผ่าน trigger ระดับแถว จึงต้องกันแยก
CREATE TRIGGER trg_certificate_audit_logs_no_truncate
  BEFORE TRUNCATE ON certificate_audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- Down Migration

DROP TABLE IF EXISTS certificate_audit_logs;
