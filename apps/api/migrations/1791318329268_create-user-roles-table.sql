-- Up Migration

-- 1 ผู้ใช้มีได้หลาย role (สิทธิ์จริง = union ของ permission จากทุก role)
-- แถวไม่ถูกแก้ มีแค่ให้ (INSERT) / ถอน (DELETE) จึงไม่มี updated_at — ประวัติอยู่ใน role_change_logs
CREATE TABLE user_roles (
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  -- NULL = ระบบให้อัตโนมัติ (ตอน login / seed)
  granted_by  uuid REFERENCES users (id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

-- ค้น "ผู้ใช้ที่ถือ role นี้" เช่น นับ super_admin ที่เหลือก่อนถอน
CREATE INDEX user_roles_role_id_idx ON user_roles (role_id);

-- Down Migration

DROP TABLE IF EXISTS user_roles;
