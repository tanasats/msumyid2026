-- Up Migration

-- ผู้รับผิดชอบบัญชีหน่วยงาน (บุคลากรตัวจริงที่มีบัญชีในระบบ) — บังคับก่อนอนุมัติ ตรวจที่ service
-- บัญชีประเภทอื่นเป็น NULL เสมอ
ALTER TABLE users ADD COLUMN responsible_user_id uuid REFERENCES users (id);

-- หาบัญชีหน่วยงานที่บุคลากรคนหนึ่งรับผิดชอบ (เช่น ก่อนปิดหรือลบบัญชีของบุคลากรคนนั้น)
CREATE INDEX users_responsible_user_id_idx ON users (responsible_user_id)
  WHERE responsible_user_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS users_responsible_user_id_idx;
ALTER TABLE users DROP COLUMN IF EXISTS responsible_user_id;
