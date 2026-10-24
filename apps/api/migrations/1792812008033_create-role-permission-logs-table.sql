-- Up Migration

-- ประวัติการกำหนด role และสิทธิ์ (หน้า /admin/roles — super_admin เท่านั้น, ตัดสินใจ 2026-10-24)
-- เขียนใน transaction เดียวกับการเปลี่ยน roles / role_permissions และห้ามแก้/ลบ (append-only)
-- create = สร้าง role, rename = เปลี่ยนชื่อไทย, grant/revoke = ผูก/ถอน permission กับ role
CREATE TABLE role_permission_logs (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  actor_id       uuid NOT NULL REFERENCES users (id),
  role_id        uuid NOT NULL REFERENCES roles (id),
  -- มีค่าเฉพาะ grant/revoke
  permission_id  uuid REFERENCES permissions (id),
  action         text NOT NULL CHECK (action IN ('create', 'rename', 'grant', 'revoke')),
  -- create = { code, nameTh, isPrivileged }, rename = { from, to } (ชื่อ role ไม่ใช่ข้อมูลส่วนบุคคล)
  detail         jsonb,
  reason         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_permission_logs_permission_chk CHECK ((permission_id IS NOT NULL) = (action IN ('grant', 'revoke')))
);

-- ประวัติล่าสุดในหน้า /admin/roles และประวัติของ role หนึ่ง
CREATE INDEX role_permission_logs_created_at_idx ON role_permission_logs (created_at DESC);
CREATE INDEX role_permission_logs_role_id_idx ON role_permission_logs (role_id, created_at DESC);
CREATE INDEX role_permission_logs_actor_id_idx ON role_permission_logs (actor_id);

-- ใช้ฟังก์ชันกลาง prevent_append_only_mutation() (สร้างใน migration ของ user_audit_logs)
CREATE TRIGGER trg_role_permission_logs_append_only
  BEFORE UPDATE OR DELETE ON role_permission_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER trg_role_permission_logs_no_truncate
  BEFORE TRUNCATE ON role_permission_logs
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- Down Migration

DROP TABLE IF EXISTS role_permission_logs;
