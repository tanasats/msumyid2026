-- Up Migration

-- ประวัติการให้/ถอน role — เขียนใน transaction เดียวกับการเปลี่ยน user_roles และห้ามแก้/ลบ
-- ไม่มี updated_at/deleted_at เพราะแถวต้องไม่เปลี่ยนเลย
CREATE TABLE role_change_logs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  -- NULL = ระบบทำเอง (ให้ role ตอน login / seed)
  actor_id        uuid REFERENCES users (id),
  target_user_id  uuid NOT NULL REFERENCES users (id),
  role_id         uuid NOT NULL REFERENCES roles (id),
  action          text NOT NULL CHECK (action IN ('grant', 'revoke')),
  reason          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX role_change_logs_target_user_id_idx ON role_change_logs (target_user_id, created_at DESC);
CREATE INDEX role_change_logs_actor_id_idx ON role_change_logs (actor_id);
CREATE INDEX role_change_logs_role_id_idx ON role_change_logs (role_id);

-- บังคับที่ระดับฐานข้อมูลว่าห้ามแก้/ลบ log (append-only)
CREATE FUNCTION prevent_role_change_log_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'role_change_logs แก้ไขหรือลบไม่ได้';
END;
$$;

CREATE TRIGGER trg_role_change_logs_append_only
  BEFORE UPDATE OR DELETE ON role_change_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_role_change_log_mutation();

-- TRUNCATE ไม่ผ่าน trigger ระดับแถว จึงต้องกันแยก
CREATE TRIGGER trg_role_change_logs_no_truncate
  BEFORE TRUNCATE ON role_change_logs
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_role_change_log_mutation();

-- Down Migration

DROP TABLE IF EXISTS role_change_logs;
DROP FUNCTION IF EXISTS prevent_role_change_log_mutation();
