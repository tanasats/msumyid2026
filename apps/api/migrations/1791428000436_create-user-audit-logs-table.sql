-- Up Migration

-- ประวัติการจัดการบัญชีผู้ใช้ (นอกเหนือจากการให้/ถอน role ซึ่งอยู่ที่ role_change_logs)
-- เขียนใน transaction เดียวกับการเปลี่ยนข้อมูล และห้ามแก้/ลบ (append-only)
-- PDPA: changes ห้ามเก็บค่าข้อมูลส่วนบุคคล (ชื่อ, email) เพราะ log ลบไม่ได้แม้ผู้ใช้ขอลบข้อมูล
--       ช่องที่เป็นข้อมูลส่วนบุคคลให้บันทึกแค่ว่า "เปลี่ยน" ไม่บันทึกค่า
CREATE TABLE user_audit_logs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  -- NULL = ระบบทำเอง (เช่น ผูกบัญชี Google ตอน login)
  actor_id        uuid REFERENCES users (id),
  target_user_id  uuid NOT NULL REFERENCES users (id),
  action          text NOT NULL CHECK (action IN (
                    'create', 'update', 'deactivate', 'activate', 'delete',
                    'approve', 'reject', 'link_google'
                  )),
  changes         jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- หน้ารายละเอียดผู้ใช้แสดงประวัติล่าสุดก่อน
CREATE INDEX user_audit_logs_target_user_id_idx ON user_audit_logs (target_user_id, created_at DESC);
CREATE INDEX user_audit_logs_actor_id_idx ON user_audit_logs (actor_id);

-- ฟังก์ชันกลางสำหรับตาราง log ที่ห้ามแก้/ลบ (ใช้ชื่อตารางจาก TG_TABLE_NAME ในข้อความ)
CREATE FUNCTION prevent_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% แก้ไขหรือลบไม่ได้', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER trg_user_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON user_audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

-- TRUNCATE ไม่ผ่าน trigger ระดับแถว จึงต้องกันแยก
CREATE TRIGGER trg_user_audit_logs_no_truncate
  BEFORE TRUNCATE ON user_audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- Down Migration

DROP TABLE IF EXISTS user_audit_logs;
DROP FUNCTION IF EXISTS prevent_append_only_mutation();
