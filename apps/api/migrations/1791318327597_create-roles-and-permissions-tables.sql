-- Up Migration

CREATE TABLE roles (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  code           text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name_th        text NOT NULL,
  -- role ตั้งต้นของระบบ ห้ามลบหรือเปลี่ยน code
  is_system      boolean NOT NULL DEFAULT false,
  -- role สิทธิ์สูง ให้/ถอนได้เฉพาะ super_admin
  is_privileged  boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_roles_set_updated_at
  BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- กันลบ/เปลี่ยน code ของ role ระบบที่ระดับฐานข้อมูล (กันพลาดแม้เขียน SQL ตรง)
CREATE FUNCTION protect_system_roles() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.is_system THEN
    RAISE EXCEPTION 'ห้ามลบ role ระบบ: %', OLD.code;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_system AND (NEW.code <> OLD.code OR NOT NEW.is_system) THEN
    RAISE EXCEPTION 'ห้ามเปลี่ยน code หรือ is_system ของ role ระบบ: %', OLD.code;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_roles_protect_system
  BEFORE UPDATE OR DELETE ON roles
  FOR EACH ROW EXECUTE FUNCTION protect_system_roles();

-- permission รูปแบบ resource:action เช่น user:approve
CREATE TABLE permissions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  code            text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$'),
  description_th  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_permissions_set_updated_at
  BEFORE UPDATE ON permissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ตารางเชื่อม role ↔ permission (แถวไม่ถูกแก้ มีแค่เพิ่ม/ลบ จึงไม่มี updated_at)
CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_id  uuid NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

-- PK เริ่มด้วย role_id อยู่แล้ว จึงเพิ่ม index ฝั่ง permission_id สำหรับค้น "role ไหนมี permission นี้"
CREATE INDEX role_permissions_permission_id_idx ON role_permissions (permission_id);

-- Down Migration

DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;
DROP FUNCTION IF EXISTS protect_system_roles();
